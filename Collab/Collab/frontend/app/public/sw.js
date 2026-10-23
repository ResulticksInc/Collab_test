// Collab Service Worker — Push + Action-rich notifications
// Chrome, Firefox, Edge, Safari 16.4+, Opera, Samsung Internet.

self.addEventListener("install", function () { self.skipWaiting(); });
self.addEventListener("activate", function (e) { e.waitUntil(self.clients.claim()); });

// Tags shown by the socket path within the last 5 seconds.
// When a web push arrives for the same tag, we skip it to prevent duplicates.
var recentlyShownTags = new Set();

// Client posts TAG_SHOWN after firing a notification via the socket path.
self.addEventListener("message", function (event) {
  if (!event.data) return;
  if (event.data.type === "TAG_SHOWN") {
    var tag = event.data.tag;
    recentlyShownTags.add(tag);
    setTimeout(function () { recentlyShownTags.delete(tag); }, 5000);
  }
});

function actionsFor(type) {
  switch (type) {
    case "call_incoming":
      return [
        { action: "answer",  title: "\u{1F4DE} Answer" },
        { action: "decline", title: "\u{274C} Decline" },
      ];
    case "message":
    case "mention":
    case "reply":
      return [
        { action: "reply",     title: "\u{1F4AC} Reply" },
        { action: "mark-read", title: "\u{2713} Mark read" },
      ];
    case "meeting_invite":
    case "meeting_started":
    case "meeting_reminder":
      return [
        { action: "join",    title: "\u{1F4F9} Join meeting" },
        { action: "dismiss", title: "Dismiss" },
      ];
    case "meeting_cancelled":
    case "meeting_updated":
      return [
        { action: "view",    title: "\u{1F4C5} View calendar" },
        { action: "dismiss", title: "Dismiss" },
      ];
    case "task_assigned":
    case "task_due":
      // task_due deep-links to the task (resolveNavigation handles it) and the
      // "complete" action maps to the existing task-complete handler — so these
      // buttons are live, not a no-op. Mirrors task_assigned (View + Complete).
      return [
        { action: "view",     title: "\u{1F4CB} Open task" },
        { action: "complete", title: "\u{2713} Mark done" },
      ];
    case "task_completed":
      return [
        { action: "view",    title: "\u{1F4CB} Open task" },
        { action: "dismiss", title: "Dismiss" },
      ];
    case "reminder":
      return [
        { action: "complete", title: "\u{2713} Complete" },
        { action: "snooze",   title: "\u{23F0} Snooze 10m" },
      ];
    case "invite":
      return [
        { action: "accept",  title: "\u{2705} Accept" },
        { action: "decline", title: "\u{274C} Decline" },
      ];
    case "reaction":
    case "file_shared":
      return [
        { action: "view",    title: "\u{1F440} View" },
        { action: "dismiss", title: "Dismiss" },
      ];
    // Org-wide announcement from an owner/admin (BA #6).
    case "org_broadcast":
      return [
        { action: "view",    title: "\u{1F4E2} Read" },
        { action: "dismiss", title: "Dismiss" },
      ];
    case "org_join_request":
      return [
        { action: "view",    title: "\u{1F441} Review" },
        { action: "dismiss", title: "Dismiss" },
      ];
    default:
      return [
        { action: "view",    title: "Open" },
        { action: "dismiss", title: "Dismiss" },
      ];
  }
}

self.addEventListener("push", function (event) {
  if (!event.data) return;

  var payload;
  try { payload = event.data.json(); }
  catch (e) { payload = { title: "Collab", body: event.data.text() }; }

  var title   = payload.title || "Collab";
  var type    = payload.type  || "";
  var tag     = payload.tag   || "colab-push";

  // RING RETRACTION. The caller hung up / the call timed out / it was declined
  // elsewhere. A closed-tab ring is a requireInteraction notification, so without
  // this it stays on screen forever. Same tag as the ring → dismiss exactly that one.
  if (type === "call_cancel") {
    event.waitUntil(
      self.registration.getNotifications({ tag: tag }).then(function (list) {
        var hadRing = list.length > 0;
        list.forEach(function (n) { n.close(); });
        // "missed" is followed by its own call_missed push and "declined" was the
        // user's own action — nothing more to show. For a caller hang-up, swap the
        // ring for a quiet "Missed call from X" (this also honours Chrome's
        // userVisibleOnly contract for the push we just consumed).
        if ((payload.reason === "cancelled" || payload.reason === "ended") && hadRing) {
          return self.registration.showNotification(title, {
            body: "", icon: "/collab.svg", badge: "/collab.svg",
            tag: tag, renotify: false, silent: true,
            data: { type: "call_missed", conversationId: payload.conversationId || "", targetId: payload.targetId || "" },
          });
        }
      }),
    );
    return;
  }

  // Deduplicate: if the socket path already showed this tag, skip.
  // This prevents double-notification in browsers where client.focused is
  // unreliable (Brave) or always false (some Firefox modes).
  if (recentlyShownTags.has(tag)) return;

  var options = {
    body:                payload.body || "",
    icon:                "/collab.svg",
    badge:               "/collab.svg",
    tag:                 tag,
    renotify:            true,
    silent:              false,
    requireInteraction:  type === "call_incoming" || type === "meeting_started",
    data: {
      type:           type,
      conversationId: payload.conversationId || "",
      targetType:     payload.targetType     || "",
      targetId:       payload.targetId       || "",
      id:             payload.id             || "",
    },
    actions: actionsFor(type),
  };

  // SUPPRESS WHEN THE APP IS ALREADY IN FRONT.
  //
  // The TAG_SHOWN dedup above only catches a push whose tag EXACTLY matches one
  // the in-page path just used, within 5s. That misses the common cases: the
  // page and the push can label the same event differently (a mention fires
  // colab-msg-<id> in one path and colab-mention-<notifId> in the other), and
  // it cannot see notifications raised by another surface at all.
  //
  // If an app window is genuinely focused or visible, the user is looking at
  // Collab — the in-page notification path owns that moment, and an OS banner
  // on top of it is the "spam" being reported. It is also what fires a banner
  // for the very conversation being read.
  //
  // Deliberately gated on GENUINE focus, not merely "a tab exists": Chrome's
  // userVisibleOnly contract expects a push to produce a visible notification,
  // and systematically swallowing them costs the origin its push budget. A
  // focused window is the accepted exception, because the user is demonstrably
  // already being informed.
  event.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then(function (clients) {
      // Same /site/* filter as notificationclick below — the SW scope is '/', so
      // matchAll also returns the co-hosted marketing pages, and a visible
      // download page must NOT count as "the user is reading Collab".
      var appClients = clients.filter(function (c) {
        try { return new URL(c.url).pathname.indexOf("/site/") !== 0; }
        catch (e) { return true; }
      });
      for (var i = 0; i < appClients.length; i++) {
        if (appClients[i].focused || appClients[i].visibilityState === "visible") return;
      }
      return self.registration.showNotification(title, options);
    }),
  );
});

// Map notification action + type to a structured navigation intent.
// RULE: route by TYPE first — conversationId presence must never affect which
// module is opened. A message with an empty conversationId still goes to chats.
function resolveNavigation(data, action) {
  if (action === "dismiss") return { action: "dismiss" };

  var type = data.type           || "";
  var cid  = data.conversationId || "";
  var tid  = data.targetId       || "";
  var mid  = data.id             || tid; // message ID for jump-to-message

  // ---- Calls ----
  if (type === "call_incoming") {
    if (action === "answer")  return { action: "answer-call",  mode: "chats",    conversationId: cid, callId: tid || mid };
    if (action === "decline") return { action: "decline-call", conversationId: cid, callId: tid || mid };
    return { action: "navigate", mode: "chats", conversationId: cid };
  }
  if (type === "call_missed") {
    return { action: "navigate", mode: "chats", conversationId: cid };
  }

  // ---- Messages / mentions / replies / reactions ----
  if (type === "message" || type === "mention" || type === "reply" ||
      type === "reaction") {
    if (action === "mark-read") return { action: "mark-read",    mode: "chats", conversationId: cid };
    if (action === "reply")     return { action: "reply-message", mode: "chats", conversationId: cid, targetId: mid };
    return { action: "navigate", mode: "chats", conversationId: cid, targetId: mid };
  }

  // ---- Files ----
  // A file-share notification (targetType "file") opens the Files module focused
  // on the exact file. It carries targetId (the file id) and NO usable
  // conversation target, so it must NOT route to chats (the old dead-end where
  // file_shared was bundled with messages and fell back to the conversation).
  if (type === "file_shared") {
    return { action: "file-view", mode: "files", targetId: tid };
  }

  // ---- Meetings ----
  if (type === "meeting_invite" || type === "meeting_started" || type === "meeting_reminder") {
    if (action === "join" && tid) return { action: "join-meeting", meetingId: tid, mode: "calendar" };
    return { action: "navigate", mode: "calendar" };
  }
  if (type === "meeting_cancelled" || type === "meeting_updated") {
    return { action: "navigate", mode: "calendar" };
  }

  // ---- Tasks ----
  if (type === "task_assigned" || type === "task_completed" || type === "task_due") {
    if (action === "complete") return { action: "task-complete", mode: "tasks", targetId: tid };
    return { action: "task-view", mode: "tasks", targetId: tid };
  }

  // ---- Reminders ----
  // A reminder notification opens the Reminders module focused on the exact
  // reminder (detail panel / highlight). Complete + Snooze act on it in place.
  if (type === "reminder") {
    if (action === "complete") return { action: "reminder-complete", mode: "reminders", targetId: tid };
    if (action === "snooze")   return { action: "reminder-snooze",   mode: "reminders", targetId: tid };
    return { action: "reminder-view", mode: "reminders", targetId: tid };
  }

  // ---- Invites / contact requests ----
  if (type === "invite" || type === "invite_accepted") {
    if (action === "accept")  return { action: "accept-invite",  mode: "contacts", targetId: tid };
    if (action === "decline") return { action: "decline-invite", mode: "contacts", targetId: tid };
    return { action: "navigate", mode: "contacts" };
  }

  // ---- Organization (BA #6) ----
  // Route to the page the notification is ABOUT: a broadcast opens the
  // Organization module on Broadcasts, an incoming join request on Join
  // requests. Other org news (role change, added/removed, request decided) is
  // personal and has no org page — it belongs in Activity.
  if (type === "org_broadcast")
    return { action: "navigate", mode: "org", orgTab: "broadcasts" };
  if (type === "org_join_request")
    return { action: "navigate", mode: "org", orgTab: "requests" };
  if (type.indexOf("org") === 0) return { action: "navigate", mode: "activity" };

  // ---- Generic fallback ----
  if (cid) return { action: "navigate", mode: "chats", conversationId: cid };
  return { action: "navigate", mode: "chats" };
}

self.addEventListener("notificationclick", function (event) {
  var action = event.action;
  var data   = event.notification.data || {};

  event.notification.close();
  if (action === "dismiss") return;

  var nav = resolveNavigation(data, action);

  event.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then(function (clients) {
      // The SW scope is '/', so matchAll also returns the co-hosted marketing
      // pages under /site/* (e.g. /site/download.html). Focusing one of those was
      // the "notification opened the download page" bug — keep only real app tabs.
      var appClients = clients.filter(function (c) {
        try { return new URL(c.url).pathname.indexOf("/site/") !== 0; }
        catch (e) { return true; }
      });
      // Prefer a visible/focused app tab; otherwise any app tab.
      var target = null;
      for (var i = 0; i < appClients.length; i++) {
        if (appClients[i].focused || appClients[i].visibilityState === "visible") {
          target = appClients[i];
          break;
        }
      }
      if (!target && appClients.length) target = appClients[0];
      if (target && "focus" in target) {
        target.focus();
        target.postMessage({ type: "NOTIFICATION_ACTION", nav: nav, data: data });
        return;
      }
      // No app tab open — open new one, encode intent in URL params
      var params = [];
      if (nav.conversationId) params.push("notif_conv="    + nav.conversationId);
      if (nav.mode)           params.push("notif_mode="    + nav.mode);
      if (nav.orgTab)         params.push("notif_orgtab="  + nav.orgTab);
      if (nav.meetingId)      params.push("notif_meeting=" + nav.meetingId);
      if (nav.targetId)       params.push("notif_target="  + nav.targetId);
      if (nav.action === "answer-call"  && nav.callId) params.push("notif_answer="  + nav.callId);
      if (nav.action === "task-complete")               params.push("notif_action=task-complete");
      if (nav.action === "accept-invite")               params.push("notif_action=accept-invite");
      if (nav.action === "decline-invite")              params.push("notif_action=decline-invite");
      if (nav.action === "reminder-complete")           params.push("notif_action=reminder-complete");
      if (nav.action === "reminder-snooze")             params.push("notif_action=reminder-snooze");
      var url = "/" + (params.length ? "?" + params.join("&") : "");
      return self.clients.openWindow(url);
    }),
  );
});

// ─── E2EE video streaming (decrypt-on-play) ──────────────────────────────────
// The page hands us a video's per-file decryption creds via postMessage BEFORE it
// sets <video src="/__e2ee_stream__/<fileId>">. We serve that virtual URL by
// fetching only the ciphertext byte-ranges the player asks for, decrypting the
// covering chunks locally, and returning plaintext 206 responses — so the server
// only ever sees ciphertext, yet the video streams natively. Creds live in memory
// only (never Cache/IDB) and are dropped when the row is evicted.
// Creds live in memory only (never Cache/IDB). The SW can be TERMINATED after ~30s
// idle, which wipes these maps — so on a miss we RE-REQUEST them from the page and
// wait, rather than 404-ing playback. Same for a stale token on a 401.
var E2EE_CREDS = new Map(); // fileId -> { key, ivPrefix, chunkPlain, chunkCipher, count, plainSize, mime, token, url }
var E2EE_KEYS = new Map(); // fileId -> imported CryptoKey
var E2EE_CRED_WAITERS = new Map(); // fileId -> [resolve,...]
var E2EE_TOKEN_WAITERS = new Map(); // fileId -> [resolve,...]

function e2eeB64(s) {
  var bin = atob(s), out = new Uint8Array(bin.length);
  for (var i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
function e2eeNonce(prefix, index) {
  var n = new Uint8Array(12);
  n.set(prefix, 0);
  n[8] = (index >>> 24) & 255;
  n[9] = (index >>> 16) & 255;
  n[10] = (index >>> 8) & 255;
  n[11] = index & 255;
  return n;
}
function e2eeKey(fileId, creds) {
  var k = E2EE_KEYS.get(fileId);
  if (k) return Promise.resolve(k);
  return self.crypto.subtle
    .importKey("raw", e2eeB64(creds.key), { name: "AES-GCM" }, false, ["decrypt"])
    .then(function (kk) {
      E2EE_KEYS.set(fileId, kk);
      return kk;
    });
}
function e2eeBroadcast(msg) {
  self.clients.matchAll().then(function (cs) {
    cs.forEach(function (c) {
      c.postMessage(msg);
    });
  });
}
function e2eeResolveWaiters(map, fileId, val) {
  var ws = map.get(fileId);
  if (!ws) return;
  map.delete(fileId);
  ws.forEach(function (r) {
    try {
      r(val);
    } catch (_) {}
  });
}
// Return this video's creds — re-requesting them from the page (and waiting up to
// 2.5s) if the SW was restarted and lost them.
function e2eeGetCreds(fileId) {
  var c = E2EE_CREDS.get(fileId);
  if (c) return Promise.resolve(c);
  e2eeBroadcast({ type: "E2EE_NEED_CREDS", fileId: fileId });
  return new Promise(function (resolve) {
    var ws = E2EE_CRED_WAITERS.get(fileId) || [];
    ws.push(resolve);
    E2EE_CRED_WAITERS.set(fileId, ws);
    setTimeout(function () {
      resolve(E2EE_CREDS.get(fileId) || null);
    }, 2500);
  });
}
// Ask the page for a FRESH token and wait for the reply (the SW's own token snapshot
// goes stale when the app rotates its access token).
function e2eeGetFreshToken(fileId) {
  e2eeBroadcast({ type: "E2EE_NEED_TOKEN", fileId: fileId });
  return new Promise(function (resolve) {
    var ws = E2EE_TOKEN_WAITERS.get(fileId) || [];
    ws.push(resolve);
    E2EE_TOKEN_WAITERS.set(fileId, ws);
    setTimeout(function () {
      var c = E2EE_CREDS.get(fileId);
      resolve(c ? c.token : null);
    }, 2500);
  });
}

self.addEventListener("message", function (event) {
  var d = event.data;
  if (!d) return;
  if (d.type === "E2EE_VIDEO" && d.fileId && d.creds) {
    E2EE_CREDS.set(d.fileId, d.creds);
    E2EE_KEYS.delete(d.fileId);
    e2eeResolveWaiters(E2EE_CRED_WAITERS, d.fileId, d.creds);
    e2eeResolveWaiters(E2EE_TOKEN_WAITERS, d.fileId, d.creds.token);
    if (event.ports && event.ports[0]) event.ports[0].postMessage({ ok: true });
  } else if (d.type === "E2EE_VIDEO_TOKEN" && d.fileId && d.token) {
    var c = E2EE_CREDS.get(d.fileId);
    if (c) c.token = d.token;
    e2eeResolveWaiters(E2EE_TOKEN_WAITERS, d.fileId, d.token);
  } else if (d.type === "E2EE_VIDEO_DROP" && d.fileId) {
    E2EE_CREDS.delete(d.fileId);
    E2EE_KEYS.delete(d.fileId);
  }
});

self.addEventListener("fetch", function (event) {
  var u;
  try {
    u = new URL(event.request.url);
  } catch (_) {
    return;
  }
  var m = u.pathname.match(/\/__e2ee_stream__\/([^/?#]+)$/);
  if (!m) return; // not our virtual URL — leave every other request untouched
  event.respondWith(e2eeServe(decodeURIComponent(m[1]), event.request));
});

async function e2eeServe(fileId, request) {
  // Re-request creds from the page if the SW was restarted (idle-killed) and lost
  // them, instead of 404-ing playback.
  var creds = await e2eeGetCreds(fileId);
  if (!creds) return new Response("not registered", { status: 404 });
  try {
    var C = creds.chunkPlain,
      CC = creds.chunkCipher,
      count = creds.count,
      total = creds.plainSize;
    var lastCipher = total - (count - 1) * C + 16;
    var bodyLen = (count - 1) * CC + lastCipher;
    var MAX_WINDOW = 4 * 1024 * 1024; // cap each served slice so an open-ended
    //                                    bytes=0- never decrypts the whole file

    var start = 0,
      end = total - 1;
    var rangeHdr = request.headers.get("Range");
    if (rangeHdr) {
      var rm = /bytes=(\d*)-(\d*)/.exec(rangeHdr);
      if (rm) {
        if (rm[1] === "") {
          var n = parseInt(rm[2], 10) || 0;
          start = Math.max(0, total - n);
          end = total - 1;
        } else {
          start = parseInt(rm[1], 10) || 0;
          end = rm[2] === "" ? total - 1 : Math.min(total - 1, parseInt(rm[2], 10));
        }
      }
    }
    if (start < 0 || start > end || start >= total) {
      return new Response(null, { status: 416, headers: { "Content-Range": "bytes */" + total } });
    }
    end = Math.min(end, start + MAX_WINDOW - 1);

    var firstChunk = Math.floor(start / C);
    var lastChunk = Math.floor(end / C);
    var ctStart = firstChunk * CC;
    var ctEndExcl = lastChunk >= count - 1 ? bodyLen : (lastChunk + 1) * CC;

    var key = await e2eeKey(fileId, creds);
    var ctRange = "bytes=" + ctStart + "-" + (ctEndExcl - 1);
    var resp = await fetch(creds.url, {
      headers: { Range: ctRange, Authorization: "Bearer " + creds.token },
    });
    if (resp.status === 401) {
      // Token rotated mid-playback → get a fresh one from the page and retry ONCE,
      // inside this same response, so the <video> range request still succeeds.
      var fresh = await e2eeGetFreshToken(fileId);
      if (fresh) {
        creds.token = fresh;
        resp = await fetch(creds.url, {
          headers: { Range: ctRange, Authorization: "Bearer " + creds.token },
        });
      }
    }
    if (resp.status !== 206 && resp.status !== 200) {
      return new Response("upstream " + resp.status, { status: 502 });
    }
    var ctBuf = new Uint8Array(await resp.arrayBuffer());
    var ivPrefix = e2eeB64(creds.ivPrefix);
    var parts = [];
    var off = 0;
    for (var i = firstChunk; i <= lastChunk; i++) {
      var cipherLen = i === count - 1 ? lastCipher : CC;
      var pt = await self.crypto.subtle.decrypt(
        { name: "AES-GCM", iv: e2eeNonce(ivPrefix, i) },
        key,
        ctBuf.subarray(off, off + cipherLen),
      );
      parts.push(new Uint8Array(pt));
      off += cipherLen;
    }
    var totalPlain = parts.reduce(function (a, p) {
      return a + p.length;
    }, 0);
    var assembled = new Uint8Array(totalPlain);
    var o = 0;
    for (var j = 0; j < parts.length; j++) {
      assembled.set(parts[j], o);
      o += parts[j].length;
    }
    var localStart = start - firstChunk * C;
    var slice = assembled.subarray(localStart, localStart + (end - start + 1));
    return new Response(slice, {
      status: 206,
      headers: {
        "Content-Type": creds.mime || "video/mp4",
        "Content-Range": "bytes " + start + "-" + end + "/" + total,
        "Content-Length": String(slice.length),
        "Accept-Ranges": "bytes",
        "Cache-Control": "no-store",
      },
    });
  } catch (e) {
    return new Response("decrypt failed", { status: 502 });
  }
}
