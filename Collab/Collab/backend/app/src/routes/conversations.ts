import Busboy from "busboy";
import { asyncRouter } from "../asyncRouter";
const router = asyncRouter();
import { shared, ok, fail, db, config } from "../platform";

function parseMultipartForm(req: any): Promise<{
  body: Record<string, any>;
  files: Record<string, { buffer: Buffer; mime: string; filename: string }>;
}> {
  return new Promise((resolve, reject) => {
    const body: Record<string, any> = {};
    const files: Record<string, { buffer: Buffer; mime: string; filename: string }> = {};

    let bb;
    try {
      bb = Busboy({ headers: req.headers });
    } catch (err) {
      return resolve({ body: req.body || {}, files: {} });
    }

    bb.on("field", (name, val) => {
      if (body[name] !== undefined) {
        if (Array.isArray(body[name])) {
          body[name].push(val);
        } else {
          body[name] = [body[name], val];
        }
      } else {
        body[name] = val;
      }
    });

    bb.on("file", (name, fileStream, info, encoding, mimetype) => {
      let filename = "avatar";
      let mimeType = "image/png";
      if (typeof info === "string") {
        filename = info || filename;
        mimeType = mimetype || mimeType;
      } else if (info && typeof info === "object") {
        filename = (info as any).filename || filename;
        mimeType = (info as any).mimeType || (info as any).mimetype || mimeType;
      }

      const chunks: Buffer[] = [];
      fileStream.on("data", (chunk: Buffer) => chunks.push(chunk));
      fileStream.on("end", () => {
        files[name] = {
          buffer: Buffer.concat(chunks),
          mime: mimeType,
          filename: filename,
        };
      });
      fileStream.on("error", (err: any) => reject(err));
    });

    bb.on("close", () => {
      resolve({ body, files });
    });

    bb.on("error", (err) => {
      reject(err);
    });

    req.pipe(bb);
  });
}

function parseMemberIds(raw: any): string[] {
  if (!raw) return [];
  if (Array.isArray(raw)) {
    return raw.flatMap((item) => parseMemberIds(item));
  }
  if (typeof raw === "string") {
    const trimmed = raw.trim();
    if (trimmed.startsWith("[") && trimmed.endsWith("]")) {
      try {
        const parsed = JSON.parse(trimmed);
        if (Array.isArray(parsed)) return parsed.map((s) => String(s).trim()).filter(Boolean);
      } catch {}
    }
    return trimmed.split(",").map((s) => s.trim()).filter(Boolean);
  }
  return [];
}
import authMiddleware from "../middleware/auth";
import {
  listForUser,
  create,
  createTemporaryGroup,
  addMembers,
  setStar,
  setMute,
  setHidden,
  clearHistory,
  setRead,
  markRead,
  getReceipts,
  update as updateConversation,
  convertTempToPermanent,
  setTempRetention,
  remove as removeConversation,
  members,
  setMemberRole,
  removeMember,
  files,
  links,
} from "../services/conversationService";
import {
  history,
  send,
  getThread,
  edit as editMessage,
  remove as removeMessage,
  toggleBookmark,
  removeForMe,
  toggleReaction,
  pin as pinMessage,
  unpin as unpinMessage,
  listPinned,
  setImportant as setImportantMessage,
  sanitizeClientType,
} from "../services/messageService";
import {
  schedule as scheduleMessage,
  listForConversation as listScheduled,
  reschedule as rescheduleMessage,
  cancel as cancelScheduled,
} from "../services/scheduledMessageService";
import { broadcast, pushPreview, e2eePushFields } from "../realtime/socket";
import { notifyAddedToTempGroup } from "../realtime/notify";
import { record } from "../services/auditService";
import { sendToUsers, isReady as pushReady } from "../services/webPushService";
import { suppressWebPush } from "../realtime/notify";
import { validate } from "../middleware/validate";
const { EVENTS } = shared;
router.use(authMiddleware);

router.get("/", async (req, res) => {
  try {
    return res.json(ok(await listForUser(req.user.userId)));
  } catch (e: any) {
    // GET /api/conversations is the boot-critical hydration call — a hard 500 here
    // locks the user out of the ENTIRE app. Never let it 500: log the real error,
    // surface a short diagnostic to the caller (self) so the root cause is visible,
    // and return an empty list so the shell still loads and the user can navigate.
    console.error("[conversations] listForUser failed (returning empty list)", e);
    return res.json({
      ok: true,
      data: [],
      _diag: String((e && (e.stack || e.message)) || e).slice(0, 800),
    });
  }
});

router.post("/", validate({
  title: { maxLength: 200 },
  kind: { isOneOf: ["dm", "group", "channel", "self"] },
}), async (req, res) => {
  try {
    let body = req.body || {};
    let avatarUrl: string | null = null;

    const contentType = req.headers["content-type"] || "";
    if (contentType.includes("multipart/form-data")) {
      try {
        const parsed = await parseMultipartForm(req);
        body = parsed.body || {};
        const file = parsed.files?.avatar || parsed.files?.avatarUrl || parsed.files?.icon;
        if (file) {
          avatarUrl = `data:${file.mime || "image/png"};base64,${file.buffer.toString("base64")}`;
        }
      } catch (e: any) {
        return res.status(400).json(fail("BAD_REQUEST", "Failed to parse form data."));
      }
    }

    const kind = body.kind;
    const title = body.title;
    const icon = body.icon;
    const memberIds = parseMemberIds(body.memberIds || body["memberIds[]"]);
    if (!avatarUrl && (body.avatarUrl || body.avatar)) {
      avatarUrl = String(body.avatarUrl || body.avatar);
    }

    if (kind === shared.CONVERSATION.DM) {
      const peerId = (memberIds || []).find((id) => id && id !== req.user.userId);
      if (peerId) {
        const existing = await db.conversations.findDmBetween(req.user.userId, peerId);
        if (!existing) {
          const inv =
            db.invites && db.invites.findBetween
              ? await db.invites.findBetween(req.user.userId, peerId)
              : null;
          if (!inv || inv.status !== "accepted")
            return res
              .status(403)
              .json(fail("NOT_CONNECTED", "Send a connection request first."));
        }
      }
    }
    const { conversation, memberIds: all, systemMessage } = await create({
      kind,
      title,
      icon,
      avatarUrl,
      memberIds: memberIds || [],
      creatorId: req.user.userId,
    });
    const io = req.app.get("io");
    if (io) {
      for (const uid of all) {
        io.in(broadcast.userRoom(uid)).socketsJoin(broadcast.room(conversation.id));
        io.to(broadcast.userRoom(uid)).emit(EVENTS.CONVERSATION_NEW, {
          conversationId: conversation.id,
        });
      }
      if (systemMessage)
        io.to(broadcast.room(conversation.id)).emit(EVENTS.MESSAGE_NEW, systemMessage);
    }
    await record({
      actorId: req.user.userId,
      action: "conversation.create",
      targetType: "conversation",
      targetId: conversation.id,
      detail: { kind, title },
    });
    return res.status(201).json(ok(conversation));
  } catch (err: any) {
    console.error("[POST /api/conversations ERROR]", err);
    return res.status(500).json(fail("INTERNAL", err.message || "Something went wrong. Please try again."));
  }
});

// BA/CEO: preserve a CALL's ephemeral chat (LiveKit data channel — never stored
// server-side) as an auto-expiring temp group when the call ends. The client
// POSTs the captured messages + participant ids at hangup; meetings do this
// server-side (their chat is already persisted). 7-day TTL, swept by the GC.
router.post("/temp-from-session", async (req, res) => {
  const { icon, memberIds, messages, sessionKey, mode, title, seriesKey, targetGroupId } =
    req.body || {};
  const msgs = Array.isArray(messages) ? messages : [];
  const sk =
    typeof sessionKey === "string" && sessionKey ? sessionKey.slice(0, 75) : null;
  // Duplicate-prompt plumbing (spec B/E): "check" reports whether a matching temp
  // group exists without creating; "new" forks a fresh one; default "auto" dedups.
  const md = mode === "check" || mode === "new" ? mode : "auto";
  const tgt =
    typeof targetGroupId === "string" && targetGroupId ? targetGroupId : null;
  // EAGER create ("temp group on first collaboration"): the client opens the
  // session's temp group on the first attachment/recording/message — so in-call
  // content lands in a real conversation LIVE (which grants peers download access
  // + a notification toggle). An empty create is allowed ONLY when it carries a
  // sessionKey, so it dedups into the one shared group. "check" needs nothing;
  // a targeted append (targetGroupId) carries its own group.
  if (md !== "check" && !tgt && !msgs.length && !sk)
    return res.status(400).json(fail("EMPTY", "No messages."));
  const result: any = await createTemporaryGroup({
    // Calls auto-name (title null → participant name) and dedup by PARTICIPANT
    // SET; meetings pass a NAME and dedup by it; a recurring series overrides
    // both via seriesKey so every occurrence lands in one group (spec F).
    title: typeof title === "string" && title.trim() ? title.trim() : null,
    icon,
    memberIds: Array.isArray(memberIds) ? memberIds : [],
    creatorId: req.user.userId,
    messages: msgs,
    // Per-session dedup key (1:1 → callId, group → LiveKit room SID): every
    // participant POSTs the same ended session, and this collapses those into
    // ONE shared temp group (unique-index race-proof in the service). Also the
    // marker that places exactly one session divider (spec D).
    sessionKey: sk,
    mode: md,
    seriesKey:
      typeof seriesKey === "string" && seriesKey.trim() ? seriesKey.trim() : null,
    targetGroupId: tgt,
    sessionMarker: sk,
  });
  // "check" → just report the match; nothing was created or broadcast.
  if (md === "check")
    return res.status(200).json(ok(result || { existingMatch: null }));
  // A targeted append the caller isn't a member of resolves to null → forbid.
  if (!result)
    return res.status(403).json(fail("FORBIDDEN", "Not allowed."));
  const conv = result;
  const io = req.app.get("io");
  // deduped → another participant's POST already created the group and
  // broadcast CONVERSATION_NEW to every member; don't re-announce.
  if (io && conv && !(conv as any).deduped) {
    const all = Array.from(
      new Set(
        [req.user.userId, ...(Array.isArray(memberIds) ? memberIds : [])].filter(
          Boolean,
        ),
      ),
    );
    for (const uid of all) {
      io.in(broadcast.userRoom(uid)).socketsJoin(broadcast.room(conv.id));
      io.to(broadcast.userRoom(uid)).emit(EVENTS.CONVERSATION_NEW, {
        conversationId: conv.id,
      });
    }
    // NOTIFY each OTHER member so the auto-created temp group is actually NOTICED
    // (bell + web push), not just silently added to the sidebar. Only on the FIRST
    // creation — a deduped POST skips this whole block.
    await notifyAddedToTempGroup(io, {
      conversationId: conv.id,
      title: (conv as any).title || null,
      actorId: req.user.userId,
      memberIds: all,
    });
  }
  res.status(201).json(ok(conv));
});

router.patch("/:id", async (req, res) => {
  const { title, icon, description, avatarUrl, temporary, retentionDays } = req.body || {};
  let conv: any = null;
  // Temp-group lifecycle (member-gated, separate from the owner/admin metadata
  // patch below): promote to permanent, or change the auto-delete window.
  if (temporary === false) {
    conv = await convertTempToPermanent(req.params.id, req.user.userId);
    if (!conv) return res.status(403).json(ok({ updated: false }));
  } else if (retentionDays !== undefined && retentionDays !== null) {
    conv = await setTempRetention(req.params.id, req.user.userId, Number(retentionDays));
    if (!conv) return res.status(403).json(ok({ updated: false }));
  }
  // Metadata patch (owner/admin only) — title / icon / description / avatar.
  const patch: any = {};
  if (title !== undefined) patch.title = title;
  if (icon !== undefined) patch.icon = icon;
  if (description !== undefined) patch.description = typeof description === "string" ? description.slice(0, 500) : null;
  if (avatarUrl !== undefined) patch.avatarUrl = avatarUrl;
  if (Object.keys(patch).length) {
    const updated = await updateConversation(req.params.id, req.user.userId, patch);
    if (updated) conv = updated;
    else if (!conv) return res.status(403).json(ok({ updated: false }));
  }
  if (!conv) return res.status(400).json(ok({ updated: false }));
  const io = req.app.get("io");
  if (io)
    io.to(broadcast.room(req.params.id)).emit(EVENTS.CONVERSATION_UPDATED, conv);
  res.json(ok(conv));
});

router.get("/:id/messages", async (req, res) => {
  // Optional keyset pagination: ?before=<oldest message id> loads the page just
  // older than that message. Omitted → latest page (byte-identical to before).
  const before = req.query.before ? String(req.query.before) : null;
  const limit = Math.min(Number(req.query.limit) || 50, 100);
  try {
    return res.json(
      ok(await history(req.params.id, req.user.userId, { before, limit })),
    );
  } catch (e: any) {
    // Preserve intentional HTTP errors (403 not-a-member, 404) so access control
    // and routing are unchanged. Only swallow UNEXPECTED failures: opening a chat
    // must never hard-500 and trap the user on a thread they can't read. Log the
    // real error, surface a short diagnostic to the caller, and return an empty
    // page so the conversation still opens.
    if (e && e.status && e.status < 500) throw e;
    console.error(`[conversations] history ${req.params.id} failed`, e);
    return res.json({
      ok: true,
      data: [],
      _diag: String((e && (e.stack || e.message)) || e).slice(0, 800),
    });
  }
});
router.post("/:id/messages", async (req, res) => {
  const { text, file, type: rawType, voice, encrypted, forwarded, forwardCount, parentMessageId, pushPreview: pushPreviewRaw } = req.body || {};
  // Coerce spoofed server-only kinds (meeting_invite/task_card/system/call) to text.
  const type = sanitizeClientType(rawType);
  const msg = await send({
    conversationId: req.params.id,
    senderId: req.user.userId,
    text,
    file,
    type,
    voice,
    encrypted,
    forwarded,
    forwardCount,
    parentMessageId,
  });
  const io = req.app.get("io");
  // Fetch members once — reused for the user-room fan-out AND web push below.
  let restMems: any[] = [];
  try {
    restMems = (await members(req.params.id, req.user.userId)) || [];
  } catch (_) {}
  if (io) {
    // Emit to the conversation room AND each member's user room (always joined),
    // in one de-duped emit, so the FIRST message in a brand-new conversation
    // isn't missed by a not-yet-settled room join. Client de-dupes by id.
    const memberRooms = restMems
      .filter((m: any) => m && m.id)
      .map((m: any) => broadcast.userRoom(m.id));
    io.to([broadcast.room(req.params.id), ...memberRooms]).emit(EVENTS.MESSAGE_NEW, msg);
  }
  if (pushReady() && type !== "system" && type !== "call") {
    void (async () => {
      try {
        const mems = restMems;
        // serializeMember returns { id, muted, … }. Drop anyone who MUTED this
        // conversation (muted) — a muted conversation must not raise a closed-tab
        // message push (suppressWebPush below is conversation-agnostic, so the
        // per-conversation mute has to be applied here, where we have the convo).
        const targets = (mems || [])
          .filter((m: any) => m && m.id && m.id !== req.user.userId && !m.muted)
          .map((m: any) => m.id as string);
        if (targets.length) {
          const senderName = (msg.sender && msg.sender.name) || "New message";
          // Same body rules as the socket path (attachment hints; E2EE →
          // client-supplied plaintext preview, else generic).
          const preview = pushPreview({ text, file, voice, type, encrypted, pushPreview: pushPreviewRaw });
          // Route the closed-tab message push through the SAME quiet-hours /
          // notifyLevel="none" gate as reminders/task_due (suppressWebPush is
          // pushNotif-wide). Evaluate each recipient against their own settings
          // and drop only the suppressed ones; fail-open inside suppressWebPush.
          // Per-conversation mute was already applied above.
          const allowed = (
            await Promise.all(targets.map(async (t: string) => ((await suppressWebPush(t)) ? null : t)))
          ).filter((t): t is string => !!t);
          if (allowed.length) {
            // Mobile enrichment (best-effort) — see the socket.ts message push.
            let convMeta: any = null;
            try { convMeta = await db.conversations.getById(req.params.id); } catch (_) {}
            const isDm = convMeta?.kind === "dm";
            const envelopes = encrypted && config.fcm.e2eeCiphertext ? ((msg as any).ciphertext ?? encrypted) : null;
            const base = {
              title: senderName, body: preview, tag: `colab-msg-${msg.id}`, type: "message",
              conversationId: req.params.id, targetType: "message", targetId: msg.id,
              messageId: msg.id, senderId: req.user.userId, senderName,
              senderAvatar: (msg.sender && (msg.sender as any).avatarUrl) || undefined,
              senderInitials: (msg.sender && (msg.sender as any).initials) || undefined,
              senderColor: (msg.sender && (msg.sender as any).color) || undefined,
              conversationKind: convMeta?.kind || undefined, conversationTitle: convMeta?.title || undefined,
            };
            // Per recipient: a DM's ciphertext is trimmed to that user's envelopes.
            await Promise.allSettled(allowed.map((t: string) => {
              const e2ee = envelopes ? e2eePushFields(envelopes, isDm ? t : null) : encrypted ? { encrypted: true } : {};
              return sendToUsers([t], { ...base, ...e2ee });
            }));
          }
        }
      } catch (_) {}
    })();
  }
  res.status(201).json(ok(msg));
});
router.get("/:id/thread/:mid", async (req, res) => {
  const t = await getThread(req.params.mid, req.user.userId);
  res.json(ok(t || { parent: null, replies: [] }));
});

router.patch("/:id/messages/:mid", async (req, res) => {
  const msg = await editMessage({
    messageId: req.params.mid,
    userId: req.user.userId,
    text: (req.body || {}).text,
    encrypted: (req.body || {}).encrypted || null,
  });
  if (!msg) return res.status(403).json(ok({ updated: false }));
  const io = req.app.get("io");
  if (io)
    io.to(broadcast.room(req.params.id)).emit(EVENTS.MESSAGE_UPDATED, msg);
  res.json(ok(msg));
});
router.delete("/:id/messages/:mid", async (req, res) => {
  const r = await removeMessage({
    messageId: req.params.mid,
    userId: req.user.userId,
  });
  const io = req.app.get("io");
  if (io && r.deleted)
    // Soft delete: broadcast the tombstoned message as an UPDATE so every client
    // shows "This message was deleted" in place (WhatsApp "delete for everyone").
    io.to(broadcast.room(req.params.id)).emit(EVENTS.MESSAGE_UPDATED, r);
  if (r.deleted)
    await record({
      actorId: req.user.userId,
      action: "message.delete",
      targetType: "message",
      targetId: req.params.mid,
      detail: { conversationId: req.params.id },
    });
  res.json(ok(r));
});
// REST reaction toggle — durable fallback when the socket is unavailable so a
// reaction is never lost on reload. Broadcasts the update like the socket path.
router.post("/:id/messages/:mid/react", async (req, res) => {
  const msg = await toggleReaction({
    messageId: req.params.mid,
    userId: req.user.userId,
    emoji: (req.body || {}).emoji,
  });
  if (!msg) return res.status(404).json(ok({ reacted: false }));
  const io = req.app.get("io");
  if (io) io.to(broadcast.room(req.params.id)).emit(EVENTS.MESSAGE_UPDATED, msg);
  res.json(ok(msg));
});
router.post("/:id/messages/:mid/bookmark", async (req, res) =>
  res.json(
    ok(
      await toggleBookmark({
        userId: req.user.userId,
        messageId: req.params.mid,
      }),
    ),
  ),
);
router.post("/:id/messages/:mid/delete-me", async (req, res) => {
  const r = await removeForMe({
    messageId: req.params.mid,
    userId: req.user.userId,
  });
  res.json(ok(r));
});

// Pin / unpin messages
router.post("/:id/messages/:mid/pin", async (req, res) => {
  const m = await pinMessage({ messageId: req.params.mid, userId: req.user.userId });
  if (!m) return res.status(404).json(fail("NOT_FOUND", "Message not found"));
  const io = req.app.get("io");
  if (io) io.to(broadcast.room(req.params.id)).emit(EVENTS.MESSAGE_UPDATED, m);
  res.json(ok(m));
});
router.post("/:id/messages/:mid/unpin", async (req, res) => {
  const m = await unpinMessage({ messageId: req.params.mid, userId: req.user.userId });
  if (!m) return res.status(404).json(fail("NOT_FOUND", "Message not found"));
  const io = req.app.get("io");
  if (io) io.to(broadcast.room(req.params.id)).emit(EVENTS.MESSAGE_UPDATED, m);
  res.json(ok(m));
});
router.get("/:id/pinned", async (req, res) => {
  // Membership-gated in listPinned (was a direct db call with no check — IDOR).
  res.json(ok(await listPinned(req.params.id, req.user.userId)));
});

// Mark / unmark a message as important (Teams-style). Author-only, membership-
// gated in the service; broadcast to the room via the existing MESSAGE_UPDATED.
router.post("/:id/messages/:mid/important", async (req, res) => {
  const important = !!(req.body && req.body.important);
  const m = await setImportantMessage({
    messageId: req.params.mid,
    userId: req.user.userId,
    important,
  });
  if (!m) return res.status(404).json(fail("NOT_FOUND", "Message not found"));
  const io = req.app.get("io");
  if (io) io.to(broadcast.room(req.params.id)).emit(EVENTS.MESSAGE_UPDATED, m);
  res.json(ok(m));
});

// Scheduled messages (P1.7): compose now, deliver later. A backend poller
// posts due messages through the normal send path.
const emitScheduled = (req, conversationId) => {
  const io = req.app.get("io");
  if (io)
    io.to(broadcast.userRoom(req.user.userId)).emit(EVENTS.SCHEDULED_CHANGED, {
      conversationId,
    });
};
router.get("/:id/scheduled", async (req, res) =>
  res.json(ok(await listScheduled(req.params.id, req.user.userId))),
);
router.post("/:id/scheduled", async (req, res) => {
  const b = req.body || {};
  const s = await scheduleMessage({
    conversationId: req.params.id,
    senderId: req.user.userId,
    body: b.body,
    sendAt: b.sendAt,
    encrypted: b.encrypted || null,
  });
  emitScheduled(req, req.params.id);
  res.status(201).json(ok(s));
});
router.patch("/:id/scheduled/:sid", async (req, res) => {
  const b = req.body || {};
  const s = await rescheduleMessage({
    id: req.params.sid,
    userId: req.user.userId,
    body: b.body,
    sendAt: b.sendAt,
    encrypted: b.encrypted || null,
  });
  emitScheduled(req, req.params.id);
  res.json(ok(s));
});
router.delete("/:id/scheduled/:sid", async (req, res) => {
  const r = await cancelScheduled({
    id: req.params.sid,
    userId: req.user.userId,
  });
  emitScheduled(req, req.params.id);
  res.json(ok(r));
});

router.post("/:id/members", async (req, res) => {
  const body = req.body || {};
  const userIds = body.userIds || [];
  // #16: default to sharing history (back-compat); only withhold when the
  // client explicitly sends shareHistory:false.
  const shareHistory = body.shareHistory !== false;
  const out = await addMembers(req.params.id, userIds, req.user.userId, shareHistory);
  const ioAdd = req.app.get("io");
  if (ioAdd) {
    // Newly-added members: join their connected sockets to the room server-side
    // (the connect-time join-all predates their membership) and surface the
    // conversation in their list — otherwise they see nothing until reconnect.
    // Only the members actually inserted (out.addedIds), so re-adding an existing
    // member doesn't fire a redundant CONVERSATION_NEW/refetch to them.
    for (const uid of out.addedIds || []) {
      ioAdd.in(broadcast.userRoom(uid)).socketsJoin(broadcast.room(req.params.id));
      ioAdd.to(broadcast.userRoom(uid)).emit(EVENTS.CONVERSATION_NEW, {
        conversationId: req.params.id,
      });
    }
    if (out.systemMessage)
      ioAdd.to(broadcast.room(req.params.id)).emit(EVENTS.MESSAGE_NEW, out.systemMessage);
  }
  if (userIds.length)
    await record({
      actorId: req.user.userId,
      action: "member.add",
      targetType: "conversation",
      targetId: req.params.id,
      detail: { userIds },
    });
  res.json(ok(out));
});
router.get("/:id/members", async (req, res) =>
  res.json(ok(await members(req.params.id, req.user.userId))),
);
// Change a member's role (promote/demote). Owner/admin gated in the service.
router.patch("/:id/members/:uid", async (req, res) => {
  const out = await setMemberRole({
    conversationId: req.params.id,
    requesterId: req.user.userId,
    targetUserId: req.params.uid,
    role: (req.body || {}).role,
  });
  const io = req.app.get("io");
  if (io)
    io.to(broadcast.room(req.params.id)).emit(
      EVENTS.CONVERSATION_UPDATED,
      await db.conversations.getById(req.params.id),
    );
  await record({
    actorId: req.user.userId,
    action: "member.role",
    targetType: "conversation",
    targetId: req.params.id,
    detail: { userId: req.params.uid, role: out.role },
  });
  res.json(ok(out));
});
// Remove a member (admin kick) or leave (uid === "me"). Service enforces roles.
router.delete("/:id/members/:uid", async (req, res) => {
  const targetUserId = req.params.uid === "me" ? req.user.userId : req.params.uid;
  const out = await removeMember({
    conversationId: req.params.id,
    requesterId: req.user.userId,
    targetUserId,
  });
  const io = req.app.get("io");
  if (io && out.removed) {
    // Tell the removed user to drop the conversation; tell remaining members to refresh.
    io.to(broadcast.userRoom(targetUserId)).emit(EVENTS.CONVERSATION_DELETED, {
      conversationId: req.params.id,
    });
    // ...and unsubscribe their live sockets from the room. Sockets join every
    // membership room on connect, so without this a kicked/left member keeps
    // receiving the conversation's realtime events until they reconnect.
    io.in(broadcast.userRoom(targetUserId)).socketsLeave(broadcast.room(req.params.id));
    io.to(broadcast.room(req.params.id)).emit(
      EVENTS.CONVERSATION_UPDATED,
      await db.conversations.getById(req.params.id),
    );
    // Membership line ("X left" / "X removed Y") to remaining members. The
    // removed user already got CONVERSATION_DELETED, so they won't see it.
    if (out.message)
      io.to(broadcast.room(req.params.id)).emit(EVENTS.MESSAGE_NEW, out.message);
  }
  if (out.removed)
    await record({
      actorId: req.user.userId,
      action: req.user.userId === targetUserId ? "member.leave" : "member.remove",
      targetType: "conversation",
      targetId: req.params.id,
      detail: { userId: targetUserId },
    });
  res.json(ok(out));
});
router.post("/:id/star", async (req, res) =>
  res.json(
    ok(await setStar(req.params.id, req.user.userId, !!(req.body || {}).value)),
  ),
);
router.post("/:id/mute", async (req, res) =>
  res.json(
    ok(await setMute(req.params.id, req.user.userId, !!(req.body || {}).value)),
  ),
);
router.post("/:id/hide", async (req, res) =>
  res.json(
    ok(
      await setHidden(req.params.id, req.user.userId, !!(req.body || {}).value),
    ),
  ),
);
// Per-user "Clear chat": empties the caller's OWN view (history cutoff = now) and
// leaves the conversation as a fresh chat in their list. Membership-checked in the
// service; other participants keep their history. Cross-device: tell the caller's
// OTHER sessions to drop this conversation's unread and reload it as empty.
router.post("/:id/clear", async (req, res) => {
  const r = await clearHistory(req.params.id, req.user.userId);
  const io = req.app.get("io");
  if (io)
    io.to(broadcast.userRoom(req.user.userId)).emit(EVENTS.CONVERSATION_READ, {
      conversationId: req.params.id,
      unread: 0,
    });
  res.json(ok(r));
});
router.post("/:id/read", async (req, res) => {
  const read = !!(req.body || {}).read;
  // Read receipts OFF on the reader's side → still clear their own unread, but do
  // NOT tell the other party they were read (WhatsApp-style reciprocal privacy).
  const sendReceipt = (req.body || {}).receipts !== false;
  const io = req.app.get("io");
  if (read) {
    const r = await markRead(req.params.id, req.user.userId);
    if (io && sendReceipt)
      io.to(broadcast.room(req.params.id)).emit(EVENTS.MESSAGE_READ, {
        conversationId: req.params.id,
        userId: req.user.userId,
        lastReadAt: r.lastReadAt,
      });
    // Cross-device: clear this conversation's unread on the reader's OTHER
    // sessions (web + desktop) so their count + badge update live. Unconditional
    // of read-receipts — it's the reader's own state, not a receipt to the peer.
    if (io)
      io.to(broadcast.userRoom(req.user.userId)).emit(EVENTS.CONVERSATION_READ, {
        conversationId: req.params.id,
        unread: 0,
      });
    return res.json(ok(r));
  }
  const r = await setRead(req.params.id, req.user.userId, false);
  // Mark-as-unread → propagate to the user's other sessions as well.
  if (io)
    io.to(broadcast.userRoom(req.user.userId)).emit(EVENTS.CONVERSATION_READ, {
      conversationId: req.params.id,
      unread: 1,
    });
  res.json(ok(r));
});
router.get("/:id/receipts", async (req, res) =>
  res.json(ok(await getReceipts(req.params.id, req.user.userId))),
);
router.delete("/:id", async (req, res) => {
  const r = await removeConversation(req.params.id, req.user.userId);
  const io = req.app.get("io");
  if (io && r.deleted)
    for (const uid of r.memberIds || []) {
      io.to(broadcast.userRoom(uid)).emit(EVENTS.CONVERSATION_DELETED, {
        conversationId: req.params.id,
      });
      // Unsubscribe live sockets from the dead conversation's room (joined at
      // connect via join-all) so no stray events reach ex-members.
      io.in(broadcast.userRoom(uid)).socketsLeave(broadcast.room(req.params.id));
    }
  if (r.deleted)
    await record({
      actorId: req.user.userId,
      action: "conversation.delete",
      targetType: "conversation",
      targetId: req.params.id,
    });
  res.json(ok({ id: r.id, deleted: r.deleted }));
});
router.get("/:id/files", async (req, res) =>
  res.json(ok(await files(req.params.id, req.user.userId))),
);
router.get("/:id/links", async (req, res) =>
  res.json(ok(await links(req.params.id, req.user.userId))),
);
export default router;
