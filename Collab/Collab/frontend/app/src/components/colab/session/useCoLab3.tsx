// CoLab session hook — segment 3 (Messages).
// Mechanical extraction from CoLabV1.tsx (statements 255–272),
// plus statements pulled forward so this hook is self-contained.

import { useEffect, useCallback } from "react";
import { pushPreviewOf, pushPreviewForFile } from "../../../lib/pushPreview";
import { makeVideoThumb } from "../../../lib/videoThumb";
import { api } from "../../../lib/api";
import { extractMentionMeta } from "../../../lib/messageText";
import { EVENTS } from "../../../lib/socket";
import { encryptForUser, encryptForGroup, decryptMessageList, isE2EEEnabled, isRatchetEnabled, rememberSentPlaintext, isConvE2EERequired } from "../../../lib/e2ee/manager";
import { encryptBlob, encryptBlobChunked } from "../../../lib/e2ee/media";
import { ensureVideoSW } from "../../../lib/e2eeVideoStream";

export type CoLabSession3 = {
  loadMessagesRef: any; loadMessages: any; activeId: any; loadScheduled: any;
  conversationsRef: any; tokenRef: any; meRef: any; showToast: any;
  conversations: any; me: any; appendMessage: any; bumpPreview: any;
  setMessagesByConv: any; socketRef: any; connected: any; offlineDemo: any;
  activeIdRef: any; uploadAbortRef: any; sentFileEnvRef: any; setDrafts: any;
};

export function useCoLab3(ctx: CoLabSession3) {

  const {
  loadMessagesRef, loadMessages, activeId, loadScheduled,
  conversationsRef, tokenRef, meRef, showToast,
  conversations, me, appendMessage, bumpPreview,
  setMessagesByConv, socketRef, connected, offlineDemo,
  activeIdRef, uploadAbortRef, sentFileEnvRef, setDrafts
  } = ctx;

  // ---- CoLabV1.tsx statements 255–272 (and pulled) ----
  loadMessagesRef.current = loadMessages;
  useEffect(() => {
    if (activeId) loadScheduled(activeId);
  }, [activeId, loadScheduled]);
  const encryptScheduledBody = useCallback(
    async (cid: string, text: string): Promise<any[] | null> => {
      const conv = conversationsRef.current.find((c: any) => c.id === cid);
      if (!conv || !tokenRef.current) return null;
      const mustEncrypt = !!(
        isE2EEEnabled() &&
        (conv.kind === "dm" ||
          conv.kind === "self" ||
          conv.kind === "group" ||
          conv.kind === "channel")
      );
      if (!mustEncrypt) return null;
      if (conv.kind === "dm" || conv.kind === "self") {
        const otherId =
          (conv.members || []).find((m: string) => m !== meRef.current?.id) ||
          meRef.current?.id;
        if (!otherId) return null;
        return await encryptForUser(tokenRef.current, otherId, text, cid, {
          useOpk: true,
          useRatchet: false,
        });
      }
      return await encryptForGroup(
        tokenRef.current,
        cid,
        (conv.members || []).filter(Boolean),
        text,
      );
    },
    [],
  );
  const onScheduleMessage = useCallback(
    async (body, sendAt) => {
      if (!activeId || !tokenRef.current) return;
      try {
        const encrypted = await encryptScheduledBody(
          activeId,
          (body || "").trim(),
        );
        await api.scheduleMessage(
          tokenRef.current,
          activeId,
          body,
          sendAt,
          encrypted,
        );
        loadScheduled(activeId);
      } catch (e: any) {
        showToast((e && e.message) || "Couldn't schedule");
      }
    },
    [activeId, loadScheduled, showToast, encryptScheduledBody],
  );
  const onRescheduleMessage = useCallback(
    async (sid, patch) => {
      if (!activeId || !tokenRef.current) return;
      try {
        const p: any = { ...patch };
        // Body changed → re-encrypt so the delivered envelope matches the new text.
        if (typeof patch.body === "string")
          p.encrypted = await encryptScheduledBody(activeId, patch.body.trim());
        await api.rescheduleMessage(tokenRef.current, activeId, sid, p);
        loadScheduled(activeId);
      } catch (e: any) {
        showToast((e && e.message) || "Couldn't reschedule");
      }
    },
    [activeId, loadScheduled, showToast, encryptScheduledBody],
  );
  const onCancelScheduled = useCallback(
    (sid) => {
      if (!activeId || !tokenRef.current) return;
      api
        .cancelScheduled(tokenRef.current, activeId, sid)
        .then(() => loadScheduled(activeId))
        .catch(() => {});
    },
    [activeId, loadScheduled],
  );
  const onSend = useCallback(
    // convOverride lets a SECOND ChatView (the in-call collaboration sidebar)
    // send to ITS conversation instead of the main pane's activeId — everything
    // below is conversation-scoped via `cid`. Default = the main active conv.
    async (text, convOverride?: string, important?: boolean) => {
      const cid = convOverride || activeId;
      if (!cid) return;
      const payload: any = { conversationId: cid, text };
      const conv = conversations.find((c) => c.id === cid);
      // @MENTIONS — carry the RESOLVED user ids as metadata beside the message.
      //
      // Two defects this fixes, both reported as "mentions show/notify the wrong
      // person, and don't work for people in my dm/group/channel":
      //   1. In an E2EE conversation the server sees only ciphertext, so the
      //      server-side gate `if (text && !encrypted)` meant @mentions notified
      //      NOBODY AT ALL — every DM, group and channel is encrypted, so the
      //      feature was dead everywhere.
      //   2. On the plaintext path the server re-resolved "@Name" by FIRST NAME
      //      ("first writer wins" on a tie), so with two people sharing a first
      //      name the mention landed on whichever sorted first — not the person
      //      picked from the composer.
      // The composer already tags each mention with the exact user id
      // (data-user-id, set from the picker), so send THOSE ids. Ids are metadata,
      // not content: no plaintext excerpt leaves the device, preserving E2EE.
      // The server still validates every id against real membership.
      const mentionMeta = extractMentionMeta(text);
      if (mentionMeta.userIds.length) payload.mentionUserIds = mentionMeta.userIds;
      if (mentionMeta.broadcast) payload.mentionBroadcast = mentionMeta.broadcast;
      // E2EE applies to DM/self only. mustEncrypt makes the whole send FAIL-CLOSED:
      // if encryption can't run, we never fall back to plaintext anywhere.
      const mustEncrypt = !!(
        conv &&
        isE2EEEnabled() &&
        tokenRef.current &&
        (conv.kind === "dm" ||
          conv.kind === "self" ||
          conv.kind === "group" ||
          conv.kind === "channel")
      );
      // OPTIMISTIC-FIRST: render the outgoing bubble INSTANTLY — BEFORE any E2EE
      // encryption. encryptForUser/Group do HTTP round-trips (peer device bundles +
      // prekeys) that took ~2s and were gating the render; moving the append ahead
      // makes the bubble appear on the same tick Send is pressed, with a "sending"
      // indicator until it's confirmed. The plaintext lives ONLY in this LOCAL bubble
      // (the sender's own view); the network `payload` still carries { encrypted }
      // once E2EE runs below — no plaintext is ever emitted.
      const clientId = "_opt_" + Math.random().toString(36).slice(2);
      // Ride the client-local id on the network payload so the server echoes it
      // back and we reconcile the EXACT optimistic bubble (#1).
      payload.clientId = clientId;
      const optimistic = {
        id: clientId,
        _clientId: clientId,
        _status: "sending" as const,
        conversationId: cid,
        me: true,
        sender: meRef.current
          ? {
              id: meRef.current.id,
              name: meRef.current.name,
              initials: meRef.current.initials,
              color: meRef.current.color,
              avatarUrl: meRef.current.avatarUrl,
            }
          : { name: "You", initials: "?", color: "#1a1a2e", avatarUrl: "" },
        text: text,
        time: new Date().toLocaleTimeString([], {
          hour: "numeric",
          minute: "2-digit",
        }),
        createdAt: new Date().toISOString(),
        file: null,
        reactions: [],
        _payload: payload,
      };
      appendMessage(optimistic);
      bumpPreview(optimistic);
      // Downgrade the already-shown bubble to "failed" (used when encryption or a
      // send can't complete). Fail-closed is preserved: we mark + return, never emit.
      const markSendFailed = () =>
        setMessagesByConv((prev) => {
          const arr = prev[cid];
          if (!arr) return prev;
          return {
            ...prev,
            [cid]: arr.map((m) =>
              m._clientId === clientId ? { ...m, _status: "failed" } : m,
            ),
          };
        });

      if (mustEncrypt) {
        try {
          // encryptFor* THROW (never return plaintext) if they can't encrypt for
          // a peer who HAS devices (MITM/changed identity). For a DM peer who has
          // NO E2EE device yet, encryptForUser returns null (B1 sentinel) — we
          // then fall back to a normal plaintext send below (NO pin), so the next
          // send after the peer publishes a device encrypts automatically.
          let encryptedEnvelopes: any[] | null = null;
          if (conv!.kind === "dm" || conv!.kind === "self") {
            const otherId =
              conv!.members.find((m) => m !== meRef.current?.id) ||
              meRef.current?.id;
            if (!otherId) throw new Error("No recipient");
            encryptedEnvelopes = await encryptForUser(
              tokenRef.current!,
              otherId,
              text,
              cid,
              { useOpk: true, useRatchet: isRatchetEnabled() },
            );
          } else {
            encryptedEnvelopes = await encryptForGroup(
              tokenRef.current!,
              cid,
              (conv!.members || []).filter(Boolean),
              text,
            );
          }
          // null = peer not set up for E2EE yet → send plaintext (payload.text
          // stays as-is, payload.encrypted stays unset). Otherwise attach the
          // envelopes and drop the plaintext.
          if (encryptedEnvelopes) {
            payload.encrypted = encryptedEnvelopes;
            payload.text = undefined;
            // Push-notification body for the recipient's phone / browser (the
            // server can't read the envelope). Never stored server side.
            payload.pushPreview = pushPreviewOf(text);
          } else if (await isConvE2EERequired(cid)) {
            // The B1 "peer has no device yet" fallback must NOT apply to a
            // conversation that has already carried authenticated E2EE traffic.
            // The recipient pins such a conversation and REJECTS any later
            // plaintext as a forced downgrade — so sending it destroys the
            // message in flight and renders "[Unencrypted message — rejected]"
            // on their screen instead of the text. Fail closed and keep the
            // draft: this is transient (it clears once their device republishes).
            throw new Error(
              "This chat is end-to-end encrypted and the other device isn't ready yet. Your message wasn't sent — please try again in a moment.",
            );
          }
        } catch (e) {
          showToast(
            (e as Error).message || "Couldn't encrypt — message not sent",
          );
          markSendFailed(); // bubble already visible → mark it failed (still fail-closed)
          return; // fail-closed: do NOT send plaintext
        }
      }

      if (socketRef.current && connected) {
        // "Send as important": the server creates the message already flagged, so
        // the MESSAGE_NEW echo carries it — no follow-up call on the socket path.
        // (The HTTP-fallback branch below uses a post-send markImportant instead.)
        if (important) payload.important = true;
        socketRef.current.emit(EVENTS.MESSAGE_SEND, payload);
        // The emit has left this device → advance ○ "Sending" to ✓ "Sent" after a
        // short, PERCEPTIBLE beat (not the old blind 3000ms wait that made every
        // send read as "slow" — the message already rendered optimistically and
        // left the socket). The MESSAGE_NEW echo upgrades this to ✓✓ "Delivered";
        // the "sending" guard makes this a no-op if the echo already won the race.
        setTimeout(() => {
          setMessagesByConv((prev) => {
            const arr = prev[cid];
            if (!arr) return prev;
            const idx = arr.findIndex(
              (m) => m._clientId === clientId && m._status === "sending",
            );
            if (idx === -1) return prev;
            const updated = arr.slice();
            updated[idx] = { ...updated[idx], _status: "sent" };
            return { ...prev, [cid]: updated };
          });
        }, 400);
      } else if (!offlineDemo && tokenRef.current) {
        try {
          // FAIL-CLOSED: encrypted messages go via sendPayload (carries
          // { encrypted }, never the plaintext); only non-E2EE sends use the
          // plaintext sendMessage path.
          const sent: any = payload.encrypted
            ? await api.sendPayload(tokenRef.current, cid, payload)
            : await api.sendMessage(tokenRef.current, cid, text, null);
          // Decrypt the server echo so an E2EE own-message shows plaintext (and is
          // cached) instead of "[Encrypted — could not be verified]". No-op for
          // non-E2EE sends.
          const [sentDec] = sent ? await decryptMessageList([{ ...sent, me: true }]) : [null];
          if (sent) {
            setMessagesByConv((prev) => {
              const arr = prev[cid];
              if (!arr) return prev;
              return {
                ...prev,
                [cid]: arr.map((m) =>
                  m._clientId === clientId
                    ? (sentDec ? { ...sentDec, _status: "delivered" } : { ...sent, me: true, _status: "delivered" })
                    : m,
                ),
              };
            });
            bumpPreview(sentDec || { ...sent, me: true });
            // "Send as important": flag the just-sent message. Reuses the
            // important slice — the MESSAGE_UPDATED broadcast marks it for
            // everyone. Best-effort; a failure just leaves it un-flagged.
            if (important && sent.id) {
              api
                .markImportant(tokenRef.current, cid, sent.id, true)
                .catch(() => {});
            }
          } else {
            setMessagesByConv((prev) => {
              const arr = prev[cid];
              if (!arr) return prev;
              return {
                ...prev,
                [cid]: arr.map((m) =>
                  m._clientId === clientId ? { ...m, _status: "failed" } : m,
                ),
              };
            });
            showToast("Couldn't send — please try again.");
          }
        } catch (e) {
          setMessagesByConv((prev) => {
            const arr = prev[cid];
            if (!arr) return prev;
            return {
              ...prev,
              [cid]: arr.map((m) =>
                m._clientId === clientId ? { ...m, _status: "failed" } : m,
              ),
            };
          });
          showToast("Couldn't send — check your connection and try again.");
        }
      } else {
        const now = new Date().toLocaleTimeString([], {
          hour: "numeric",
          minute: "2-digit",
        });
        const m = {
          id: Math.random().toString(36).slice(2),
          conversationId: cid,
          me: true,
          sender: {
            name: "You",
            initials: "AJ",
            color: "#1a1a2e",
            avatarUrl: "",
          },
          text,
          time: now,
          file: null,
          reactions: [],
        };
        appendMessage(m);
        bumpPreview(m);
      }
    },
    [
      activeId,
      connected,
      conversations,
      showToast,
      offlineDemo,
      appendMessage,
      bumpPreview,
    ],
  );
  const onSendMedia = useCallback(
    (media: any, convOverride?: string) => {
      const cid = convOverride || activeIdRef.current;
      if (!cid || !media || !media.url) return;
      const file = {
        url: String(media.url),
        type: media.type || "image/gif",
        name: media.name || "gif.gif",
        width: Number(media.width) || 0,
        height: Number(media.height) || 0,
      };
      // Carry the message KIND so the renderer shows stickers/GIFs bubble-less
      // and excludes them from photo-album coalescing. Reuses the existing
      // messages.type column (no backend/schema change). undefined → normal media.
      const kind =
        media.kind === "gif" ? "gif" : media.kind === "sticker" ? "sticker" : undefined;
      const payload: any = { conversationId: cid, file, ...(kind ? { type: kind } : {}) };
      const clientId = "_opt_" + Math.random().toString(36).slice(2);
      payload.clientId = clientId; // #1: reconcile the exact optimistic bubble
      const optimistic: any = {
        id: clientId,
        _clientId: clientId,
        _status: "sending",
        conversationId: cid,
        me: true,
        sender: meRef.current
          ? {
              id: meRef.current.id,
              name: meRef.current.name,
              initials: meRef.current.initials,
              color: meRef.current.color,
              avatarUrl: meRef.current.avatarUrl,
            }
          : { name: "You", initials: "?", color: "#1a1a2e", avatarUrl: "" },
        text: "",
        file,
        type: kind,
        time: new Date().toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }),
        createdAt: new Date().toISOString(),
        reactions: [],
        _payload: payload,
      };
      appendMessage(optimistic);
      bumpPreview(optimistic);
      const markFailed = () =>
        setMessagesByConv((prev) => {
          const arr = prev[cid];
          if (!arr) return prev;
          return {
            ...prev,
            [cid]: arr.map((m) =>
              m._clientId === clientId ? { ...m, _status: "failed" } : m,
            ),
          };
        });
      if (socketRef.current && connected) {
        socketRef.current.emit(EVENTS.MESSAGE_SEND, payload);
        // The emit has left this device → advance ○ "Sending" to ✓ "Sent" after a
        // short, PERCEPTIBLE beat (not the old blind 3000ms wait that made every
        // send read as "slow" — the message already rendered optimistically and
        // left the socket). The MESSAGE_NEW echo upgrades this to ✓✓ "Delivered";
        // the "sending" guard makes this a no-op if the echo already won the race.
        setTimeout(() => {
          setMessagesByConv((prev) => {
            const arr = prev[cid];
            if (!arr) return prev;
            const idx = arr.findIndex(
              (m) => m._clientId === clientId && m._status === "sending",
            );
            if (idx === -1) return prev;
            const updated = arr.slice();
            updated[idx] = { ...updated[idx], _status: "sent" };
            return { ...prev, [cid]: updated };
          });
        }, 400);
      } else if (!offlineDemo && tokenRef.current) {
        // Socket down but REST up: reconcile the optimistic bubble with the server
        // echo (no MESSAGE_NEW will arrive). Without this the sticker/GIF stays
        // "sending" forever and later react/reply/delete target a fake _opt_ id.
        // Media isn't E2EE, so the returned message needs no decrypt.
        api
          .sendPayload(tokenRef.current, cid, { file, ...(kind ? { type: kind } : {}) })
          .then((sent: any) => {
            if (!sent) return markFailed();
            setMessagesByConv((prev) => {
              const arr = prev[cid];
              if (!arr) return prev;
              return {
                ...prev,
                [cid]: arr.map((m) =>
                  m._clientId === clientId ? { ...sent, me: true, _status: "sent" } : m,
                ),
              };
            });
          })
          .catch(() => markFailed());
      } else {
        markFailed();
      }
    },
    [connected, offlineDemo, appendMessage, bumpPreview],
  );
  const onSendFile = useCallback(
    async (
      file: File,
      parentId?: string | null,
      caption?: string | null,
      onProgress?: (p: number) => void,
      asLink?: boolean,
      convOverride?: string,
      albumCaption?: boolean,
    ) => {
      // convOverride lets the in-call collaboration sidebar's ChatView upload to
      // ITS conversation instead of the main pane's activeId.
      const cid = convOverride || activeId;
      if (!cid || !file) return;
      const payload: any = { conversationId: cid };
      if (parentId) payload.parentMessageId = parentId;
      // WhatsApp-style caption: ride the typed text on the attachment message.
      const cap = typeof caption === "string" ? caption.trim() : "";
      // albumCaption: this is the lead of a MULTI-image send, so the caption must
      // belong to the ALBUM (rendered as a strip under the grid), NOT to the first
      // image as text — a message with text won't coalesce into the album. Carry it
      // ONLY on file.caption (E2EE also rides it inside the envelope from `cap`), so
      // the lead stays "media" and the N images grid together with one caption.
      if (cap && !albumCaption) payload.text = cap;
      const conv = conversations.find((c) => c.id === cid);

      const fileE2EE = !!(
        conv &&
        isE2EEEnabled() &&
        tokenRef.current &&
        (conv.kind === "dm" ||
          conv.kind === "self" ||
          conv.kind === "group" ||
          conv.kind === "channel")
      );
      // B1 — set true if the DM peer turns out to have no E2EE device yet, so we
      // fall through to the plaintext upload branch below instead of shipping an
      // encrypted blob whose key we can't deliver.
      let fileNeedsPlaintextFallback = false;

      // ISSUE #1: OPTIMISTIC-FIRST for files. Render the attachment bubble with a
      // progress bar the instant Send is pressed — instead of leaving the thread
      // empty until the (possibly long) upload + server echo, which made the file
      // look like it "vanished". The bubble carries a client-local id echoed back
      // by the server so it's swapped for the real message precisely (never
      // mismatched with a concurrent text send). On failure it flips to "failed".
      const fileClientId = "_opt_" + Math.random().toString(36).slice(2);
      payload.clientId = fileClientId;
      // Cancellable upload: the composer's Cancel (X) trips this controller, which
      // aborts the in-flight api.uploadFile (see the signal passed below).
      const uploadCtrl = new AbortController();
      uploadAbortRef.current.set(fileClientId, uploadCtrl);
      const isImgFile = (file.type || "").startsWith("image/");
      const isVideoFile = (file.type || "").startsWith("video/");
      // First-frame poster for a video: shown INSTANTLY on the card and as the
      // <video> poster so playback isn't a black "loading" box. Best-effort, small;
      // carried in the E2EE envelope (and file.thumb for plaintext).
      const videoThumb = isVideoFile
        ? await makeVideoThumb(file).catch(() => null)
        : null;
      const optimisticFile: any = {
        id: fileClientId,
        _clientId: fileClientId,
        _status: "uploading",
        conversationId: cid,
        me: true,
        sender: meRef.current
          ? {
              id: meRef.current.id,
              name: meRef.current.name,
              initials: meRef.current.initials,
              color: meRef.current.color,
              avatarUrl: meRef.current.avatarUrl,
            }
          : { name: "You", initials: "?", color: "#1a1a2e", avatarUrl: "" },
        // Album lead keeps text empty so it coalesces into the grid; its caption
        // rides file.caption below (shown as the album's caption strip).
        text: albumCaption ? "" : cap || "",
        time: new Date().toLocaleTimeString([], {
          hour: "numeric",
          minute: "2-digit",
        }),
        createdAt: new Date().toISOString(),
        file: {
          name: file.name,
          sizeBytes: file.size,
          mime: file.type || "",
          largeFile: !!asLink,
          url: isImgFile ? URL.createObjectURL(file) : undefined,
          // Dedicated caption field so the optimistic bubble wraps media + caption as
          // ONE unit immediately (renderer reads m.file.caption, never the envelope).
          caption: cap || null,
          thumb: videoThumb || undefined,
        },
        reactions: [],
        _payload: payload,
        _fileBlob: file,
        _uploadPct: 0,
      };
      appendMessage(optimisticFile);
      bumpPreview(optimisticFile);
      const markFileFailed = () => {
        // A failed send never reconciles, so drop its stashed envelope + abort
        // handle to keep the maps from leaking across a long session.
        sentFileEnvRef.current.delete(fileClientId);
        uploadAbortRef.current.delete(fileClientId);
        setMessagesByConv((prev) => {
          const arr = prev[cid];
          if (!arr) return prev;
          return {
            ...prev,
            [cid]: arr.map((mm: any) =>
              mm._clientId === fileClientId ? { ...mm, _status: "failed" } : mm,
            ),
          };
        });
      };
      // Cancelled upload → remove the optimistic bubble entirely (not a "failed"
      // state; the user chose to cancel) and clean up its refs.
      const removeOptimistic = () => {
        sentFileEnvRef.current.delete(fileClientId);
        uploadAbortRef.current.delete(fileClientId);
        setMessagesByConv((prev) => {
          const arr = prev[cid];
          if (!arr) return prev;
          return {
            ...prev,
            [cid]: arr.filter((mm: any) => mm._clientId !== fileClientId),
          };
        });
      };
      // Drive the bubble's progress bar (and still forward to any caller-supplied
      // onProgress, e.g. the composer's own indicator).
      const trackProgress = (p: number) => {
        try {
          if (onProgress) onProgress(p);
        } catch (_) {}
        setMessagesByConv((prev) => {
          const arr = prev[cid];
          if (!arr) return prev;
          return {
            ...prev,
            [cid]: arr.map((mm: any) =>
              mm._clientId === fileClientId ? { ...mm, _uploadPct: p } : mm,
            ),
          };
        });
      };

      if (fileE2EE) {
        try {
          // VIDEO → chunked (streamable) encryption so the recipient can play it
          // while it downloads (decrypt-on-play Service Worker). Everything else →
          // the single-blob path. The key encoding is identical either way, so the
          // per-device key-wrapping below is unchanged; only the envelope differs
          // (env.stream manifest for video vs env.iv for a single blob).
          let encryptedBlob: Blob;
          let key: string;
          let iv: string | null = null;
          let streamManifest: any = null;
          if (isVideoFile) {
            const r = await encryptBlobChunked(file);
            encryptedBlob = r.encryptedBlob;
            key = r.key;
            streamManifest = r.manifest;
          } else {
            const r = await encryptBlob(file);
            encryptedBlob = r.encryptedBlob;
            key = r.key;
            iv = r.iv;
          }
          const encryptedFile = new File([encryptedBlob], file.name, {
            type: file.type || "application/octet-stream",
          });
          // Wrap the AES file key (+iv) inside the message envelope. Throws
          // (fail-closed) if it can't encrypt for a peer who HAS devices. Returns
          // null (B1 sentinel) only when the peer has NO E2EE device yet — in
          // which case we upload the file in the clear below instead.
          // Carry the WhatsApp-style caption INSIDE the encrypted envelope. The
          // backend nulls `body` for encrypted messages, and decrypt neutralizes
          // the envelope text to null — so a caption stored as plaintext `text`
          // was silently DROPPED (the "file sends but my caption vanished" bug).
          // Riding it in the envelope makes it end-to-end encrypted AND survive
          // decrypt (extracted back to text on the receiver). Only include when
          // non-empty so plain attachments stay compact.
          const env: any = { type: "file", key };
          // Chunked video → carry the stream manifest (no single-file iv); other
          // files → the single-blob iv.
          if (streamManifest) env.stream = streamManifest;
          else env.iv = iv;
          if (cap) env.caption = cap;
          // Carry the small first-frame poster INSIDE the encrypted envelope so the
          // receiver shows it instantly without any download.
          if (videoThumb) env.thumb = videoThumb;
          const keyPayload = JSON.stringify(env);
          // Stash by clientId so the MESSAGE_NEW echo can re-attach this key to the
          // sender's own attachment (its self-envelope targets other devices) and
          // cache it under the server id for reload. Cleaned up on reconcile.
          sentFileEnvRef.current.set(fileClientId, keyPayload);
          let encryptedEnvelopes: any[] | null = null;
          if (conv!.kind === "dm" || conv!.kind === "self") {
            const otherId =
              conv!.members.find((m) => m !== meRef.current?.id) ||
              meRef.current?.id;
            if (!otherId) throw new Error("No recipient");
            encryptedEnvelopes = await encryptForUser(
              tokenRef.current!,
              otherId,
              keyPayload,
              cid,
            );
          } else {
            encryptedEnvelopes = await encryptForGroup(
              tokenRef.current!,
              cid,
              (conv!.members || []).filter(Boolean),
              keyPayload,
            );
          }
          if (encryptedEnvelopes) {
            // Cancelled during the (non-abortable) key-wrap above? Short-circuit
            // BEFORE uploading so the bubble is removed promptly and no encrypted
            // bytes are sent — the wrap itself can't be aborted, but this stops the
            // upload the instant the wrap returns.
            if (uploadCtrl.signal.aborted)
              throw new DOMException("Upload aborted", "AbortError");
            // Peer is set up for E2EE — upload the ENCRYPTED blob and attach the
            // wrapped key envelopes.
            const uploadedMeta = await api.uploadFile(
              tokenRef.current!,
              encryptedFile,
              cid,
              trackProgress,
              { version: 1, algorithm: "aes-gcm" },
              uploadCtrl.signal,
            );
            payload.file = { ...uploadedMeta, e2ee: true };
            const mime =
              uploadedMeta.mime || uploadedMeta.type || file.type || "";
            if (mime.startsWith("audio/")) {
              payload.type = "voice";
              payload.voice = {
                fileId: uploadedMeta.id,
                duration: (file as any).durationSec || null,
                // Real peaks the recorder computed from the clip (ChatView
                // stopRecording); null → receiver falls back to synthetic bars.
                waveform: (file as any).waveform || null,
                mimeType: mime,
              };
            }
            payload.encrypted = encryptedEnvelopes;
            // The caption now travels ENCRYPTED inside the envelope (above), so
            // never also send it as plaintext `text` — that would leak it AND be
            // dropped by the backend's encrypted-body nulling anyway.
            payload.text = undefined;
            // Push-notification body only (see pushPreview.ts).
            payload.pushPreview = pushPreviewForFile({
              caption: cap,
              fileName: file.name,
              voice: payload.type === "voice",
            });
          } else if (await isConvE2EERequired(cid)) {
            // Same downgrade guard the text/reply send paths use: a conversation
            // that has already carried authenticated E2EE traffic is PINNED by
            // the recipient, who REJECTS any later plaintext. Uploading the file
            // in the clear here would render "[Unencrypted message — rejected]"
            // on their screen instead of the attachment. Fail closed and keep
            // the draft — transient until the peer's device republishes. Tagged
            // so the catch shows it verbatim (not the generic crypto-failure copy).
            throw Object.assign(
              new Error(
                "This chat is end-to-end encrypted and the other device isn't ready yet. Your file wasn't sent — please try again in a moment.",
              ),
              { e2eePending: true },
            );
          } else {
            // Peer genuinely has no E2EE device yet AND this conversation was
            // never pinned → fall through to a plaintext upload (no downgrade).
            fileNeedsPlaintextFallback = true;
          }
        } catch (e) {
          // User cancelled the upload → silently remove the bubble, no error toast.
          if (uploadCtrl.signal.aborted || (e as any)?.name === "AbortError") {
            removeOptimistic();
            return;
          }
          // Distinguish "couldn't reach the server" (dead proxy / offline / a
          // generic 5xx from an upstream that's down — the E2EE key-wrap calls
          // /api/e2ee/* BEFORE the upload) from a genuine encryption failure, so
          // the toast doesn't cry "encryption failed" when the real problem is
          // the network. Otherwise this reads as a scary crypto bug.
          const msg = (e as Error)?.message || "";
          // Deliberate E2EE-not-ready hold (conversation pinned, peer device not
          // republished): show the guidance verbatim, not as a crypto failure.
          if ((e as any)?.e2eePending) {
            showToast(msg);
            markFileFailed();
            return;
          }
          // The server already said exactly what is wrong (object storage is
          // down — nothing to do with encryption or the network): show it as is.
          if ((e as any)?.code === "STORAGE_UNAVAILABLE") {
            showToast(msg);
            markFileFailed();
            return;
          }
          const unreachable =
            /failed to fetch|networkerror|load failed|network request failed|fetch failed|timeout|timed out|econnrefused|502|503|504|bad gateway|gateway timeout|something went wrong/i.test(
              msg,
            );
          showToast(
            unreachable
              ? "Couldn't reach the server to send this file. Check your connection and try again."
              : "File encryption/upload failed: " + msg,
          );
          markFileFailed();
          return;
        }
      }
      if ((!fileE2EE || fileNeedsPlaintextFallback) && !offlineDemo && tokenRef.current) {
        try {
          const uploadedMeta = await api.uploadFile(
            tokenRef.current,
            file,
            cid,
            trackProgress,
            null,
            uploadCtrl.signal,
          );
          // AUDIT P2 (#28): an oversized (non-E2EE) attachment must NOT be turned
          // into a PUBLIC, unauthenticated, non-expiring download link. That
          // silently converts a confidential file dropped into a private channel
          // into anyone-with-the-URL access (the link leaks via forward/history/
          // referrer and never dies). Instead ship it as a normal AUTHENTICATED
          // attachment tagged `largeFile` so the renderer shows a download card
          // (no inline byte-fetch / OOM) whose button mints a short-lived,
          // membership-checked presigned URL on click (GET /files/:id/presigned).
          if (asLink && !fileE2EE) {
            payload.file = {
              ...uploadedMeta,
              largeFile: true,
              sizeBytes: file.size,
            };
          } else {
            payload.file = uploadedMeta;
          }
          // Plaintext album lead: the caption isn't riding `text` (so the images
          // grid together), so carry it on the file object instead.
          if (albumCaption && cap) payload.file = { ...payload.file, caption: cap };
          // Carry the video poster on the file object for the plaintext path.
          if (videoThumb) payload.file = { ...payload.file, thumb: videoThumb };
          const mime =
            uploadedMeta.mime || uploadedMeta.type || file.type || "";
          if (mime.startsWith("audio/")) {
            payload.type = "voice";
            payload.voice = {
              fileId: uploadedMeta.id,
              duration: (file as any).durationSec || null,
              // Real peaks the recorder computed from the clip (ChatView
              // stopRecording); null → receiver falls back to synthetic bars.
              waveform: (file as any).waveform || null,
              mimeType: mime,
            };
          }
        } catch (e) {
          if (uploadCtrl.signal.aborted || (e as any)?.name === "AbortError") {
            removeOptimistic();
            return;
          }
          showToast("File upload failed: " + (e as Error).message);
          markFileFailed();
          return;
        }
      }
      // Upload finished — cancel no longer applies; drop the abort handle.
      uploadAbortRef.current.delete(fileClientId);

      if (socketRef.current && connected) {
        socketRef.current.emit(EVENTS.MESSAGE_SEND, payload);
      } else if (!offlineDemo && tokenRef.current) {
        // FAIL-CLOSED: an encrypted file payload (which carries the wrapped AES
        // key in `encrypted`) must go via sendPayload — the old forwardMessage
        // dropped `encrypted` (losing the key) and leaked the plaintext caption.
        const fileSend = payload.encrypted
          ? api.sendPayload(tokenRef.current, cid, payload)
          : api.forwardMessage(
              tokenRef.current,
              cid,
              payload.text || null,
              payload.file && {
                ...payload.file,
                parentMessageId: payload.parentMessageId,
                type: payload.type,
                voice: payload.voice,
              },
            );
        fileSend
          .then((sent: any) => {
            // Cache the file envelope under the SERVER id so the sender's own
            // attachment survives a reload on this REST path too (there's no socket
            // echo here to run the reconciliation). Mirrors the socket path.
            const env = sentFileEnvRef.current.get(fileClientId);
            if (env && sent && sent.id) void rememberSentPlaintext(sent.id, env);
            sentFileEnvRef.current.delete(fileClientId);
            // No socket echo on this REST path — swap the optimistic bubble in
            // place (mark sent) instead of appending a duplicate.
            setMessagesByConv((prev) => {
              const arr = prev[cid];
              if (!arr) return prev;
              return {
                ...prev,
                [cid]: arr.map((mm: any) =>
                  mm._clientId === fileClientId ? { ...mm, _status: "sent" } : mm,
                ),
              };
            });
            bumpPreview(sent);
          })
          .catch(() => markFileFailed());
      } else {
        showToast("File sharing requires a connected workspace");
        markFileFailed();
      }
    },
    [
      activeId,
      connected,
      conversations,
      showToast,
      offlineDemo,
      appendMessage,
      bumpPreview,
    ],
  );
  const onTyping = useCallback(
    (isTyping) => {
      if (socketRef.current && connected && activeId)
        socketRef.current.emit(
          isTyping ? EVENTS.TYPING_START : EVENTS.TYPING_STOP,
          { conversationId: activeId },
        );
    },
    [connected, activeId],
  );
  const onDraftChange = useCallback((convId: string, text: string) => {
    setDrafts((prev) => {
      const t = (text || "").trim();
      if (!t) {
        if (!(convId in prev)) return prev;
        const next = { ...prev };
        delete next[convId];
        return next;
      }
      if (prev[convId] === text) return prev;
      return { ...prev, [convId]: text };
    });
  }, []);
  const dropDraft = useCallback((id: string) => {
    try {
      window.localStorage.removeItem("clb_draft_" + id);
    } catch (_) {}
    setDrafts((prev) => {
      if (!(id in prev)) return prev;
      const next = { ...prev };
      delete next[id];
      return next;
    });
  }, []);
  useEffect(() => {
    ensureVideoSW().catch(() => {});
  }, []);
  const onCancelUpload = useCallback((m: any) => {
    if (!m || m._status !== "uploading") return;
    const ctrl = uploadAbortRef.current.get(m._clientId);
    if (ctrl) {
      // Bytes still in flight → abort; onSendFile's catch removes the bubble.
      ctrl.abort();
      return;
    }
    // NO controller means the upload already finished and the message is being
    // sent / reconciled — it CANNOT be unsent from here. Do NOT drop the local
    // row: removing it would (socket path) let the echo re-append the message with
    // its E2EE key lost, and the peer has the file regardless. The pending
    // reconcile will settle the bubble to its real sent state.
  }, []);
  const retryMessage = useCallback(
    (msg: any) => {
      if (!msg._payload || !msg.conversationId) return;
      setMessagesByConv((prev) => {
        const arr = prev[msg.conversationId];
        if (!arr) return prev;
        return {
          ...prev,
          [msg.conversationId]: arr.map((m) =>
            m._clientId === msg._clientId ? { ...m, _status: "sending" } : m,
          ),
        };
      });
      if (socketRef.current && connected) {
        socketRef.current.emit(EVENTS.MESSAGE_SEND, msg._payload);
      }
    },
    [connected],
  );

  return {
    encryptScheduledBody,
    onScheduleMessage,
    onRescheduleMessage,
    onCancelScheduled,
    onSend,
    onSendMedia,
    onSendFile,
    onTyping,
    onDraftChange,
    dropDraft,
    onCancelUpload,
    retryMessage,
  };
}
