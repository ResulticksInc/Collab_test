// CoLab session hook — segment 4 (Actions).
// Mechanical extraction from CoLabV1.tsx (statements 273–320),
// plus statements pulled forward so this hook is self-contained.

import { useEffect, useRef, useCallback } from "react";
import { otherMemberId } from "../../../lib/identity";
import { confirmDialog } from "../../../lib/dialog";
import { api } from "../../../lib/api";
import { downscaleToDataURL } from "../../../lib/image";
import { messagePreview } from "../../../lib/messageText";
import { EVENTS } from "../../../lib/socket";
import config from "../../../lib/config";
import { encryptForUser, encryptForGroup, decryptMessageList, isE2EEEnabled, isRatchetEnabled, rememberSentPlaintext } from "../../../lib/e2ee/manager";
import { isDesktopApp } from "../../../lib/platform";
import { toggleLocalReaction } from "../helpers";

export type CoLabSession4 = {
  replaceMessage: any; meRef: any; socketRef: any; connected: any;
  tokenRef: any; showToast: any; offlineDemo: any; conversations: any;
  removeMessage: any; setModal: any; modal: any; onSelect: any;
  setBlockedIds: any; setConversations: any; setMobilePane: any; activeId: any;
  setActiveId: any; setMessagesByConv: any; setMsgLoadStatus: any; refetchConversations: any;
  convFlagOverridesRef: any; dropDraft: any; conversationsRef: any; setMeetingTitle: any; setMeetingAttendees: any;
  setMode: any; setManageConvId: any; files: any; users: any;
  refetchInvites: any; setSearch: any; setSearchResults: any; gxScope: any;
  gxQuery: any; mode: any; setSearchSeed: any; setFiles: any;
  setFileCount: any; setFileCursor: any; setFileHasMore: any; search: any;
  fileTabRef: any; setFileTab: any; fileSearchRef: any; setFileSearch: any;
  setFileLoading: any; fileCursor: any; setFileLoadingMore: any; refetchFilesRef: any;
  refetchTasksRef: any; refetchTasks: any; refetchRemindersRef: any; refetchReminders: any;
  me: any; setMe: any; activeIdRef: any;
};

export function useCoLab4(ctx: CoLabSession4) {

  const {
  replaceMessage, meRef, socketRef, connected,
  tokenRef, showToast, offlineDemo, conversations,
  removeMessage, setModal, modal, onSelect,
  setBlockedIds, setConversations, setMobilePane, activeId,
  setActiveId, setMessagesByConv, setMsgLoadStatus, refetchConversations,
  convFlagOverridesRef, dropDraft, conversationsRef, setMeetingTitle, setMeetingAttendees,
  setMode, setManageConvId, files, users,
  refetchInvites, setSearch, setSearchResults, gxScope,
  gxQuery, mode, setSearchSeed, setFiles,
  setFileCount, setFileCursor, setFileHasMore, search,
  fileTabRef, setFileTab, fileSearchRef, setFileSearch,
  setFileLoading, fileCursor, setFileLoadingMore, refetchFilesRef,
  refetchTasksRef, refetchTasks, refetchRemindersRef, refetchReminders,
  me, setMe, activeIdRef
  } = ctx;

  // ---- CoLabV1.tsx statements 273–320 (and pulled) ----
  const onReact = useCallback(
    (message, emoji) => {
      // Optimistic update for instant feedback on every path.
      replaceMessage({
        ...message,
        reactions: toggleLocalReaction(
          message.reactions,
          emoji,
          meRef.current?.id,
          meRef.current?.name || "You",
        ),
      });
      if (socketRef.current && connected) {
        socketRef.current.emit(EVENTS.MESSAGE_REACT, {
          conversationId: message.conversationId,
          messageId: message.id,
          emoji,
        });
      } else if (tokenRef.current && message.conversationId) {
        // Socket down → persist via REST so the reaction survives a reload.
        api
          .reactMessage(
            tokenRef.current,
            message.conversationId,
            message.id,
            emoji,
          )
          .then((updated) => {
            // Merge ONLY the reactions — the server's copy of an E2EE message
            // is the encrypted envelope with no plaintext, so swapping it in
            // would revert the bubble to the "Encrypted message" placeholder.
            if (updated) {
              replaceMessage({
                ...message,
                reactions: Array.isArray(updated.reactions)
                  ? updated.reactions
                  : message.reactions,
              });
            }
          })
          .catch(() => {
            // Roll back the optimistic toggle if persistence failed.
            replaceMessage(message);
            showToast("Couldn't save reaction — check your connection.");
          });
      }
    },
    [connected, replaceMessage, showToast],
  );
  const onPin = useCallback(
    async (message: any) => {
      if (!tokenRef.current || !message.conversationId) return;
      try {
        const updated = await api.pinMessage(
          tokenRef.current,
          message.conversationId,
          message.id,
        );
        // Merge ONLY the pinned metadata — never swap in the server's raw copy.
        // For an E2EE message that copy is the encrypted envelope with no
        // plaintext, so replacing the already-decrypted bubble with it reverts
        // the message to the "Encrypted message" placeholder (same bug class as
        // onMarkImportant's warning comment above).
        if (updated) {
          replaceMessage({
            ...message,
            pinned: !!updated.pinned,
            pinnedBy: updated.pinnedBy || message.pinnedBy,
            pinnedAt: updated.pinnedAt || message.pinnedAt,
          });
        }
        showToast("Message pinned");
      } catch {
        showToast("Failed to pin message");
      }
    },
    [replaceMessage, showToast],
  );
  const onUnpin = useCallback(
    async (message: any) => {
      if (!tokenRef.current || !message.conversationId) return;
      try {
        const updated = await api.unpinMessage(
          tokenRef.current,
          message.conversationId,
          message.id,
        );
        if (updated) {
          replaceMessage({
            ...message,
            pinned: !!updated.pinned,
            pinnedBy: updated.pinnedBy || message.pinnedBy,
            pinnedAt: updated.pinnedAt || message.pinnedAt,
          });
        }
        showToast("Message unpinned");
      } catch {
        showToast("Failed to unpin message");
      }
    },
    [replaceMessage, showToast],
  );
  const onMarkImportant = useCallback(
    async (message: any, important: boolean) => {
      if (!tokenRef.current || !message.conversationId) return;
      // Optimistically flip ONLY the `important` flag on the already-decrypted
      // message. Do NOT swap in the server's returned copy: for an E2EE message
      // that's the encrypted envelope with no plaintext, so replacing the local
      // bubble with it reverts the message to the "Encrypted message" placeholder.
      // (Same merge pattern edit + bookmark already use.)
      replaceMessage({ ...message, important });
      try {
        await api.markImportant(
          tokenRef.current,
          message.conversationId,
          message.id,
          important,
        );
        showToast(important ? "Marked as important" : "Importance removed");
      } catch {
        replaceMessage({ ...message, important: !important }); // revert on failure
        showToast(
          important
            ? "Failed to mark as important"
            : "Failed to remove importance",
        );
      }
    },
    [replaceMessage, showToast],
  );
  const onBookmark = useCallback(
    async (message) => {
      if (!offlineDemo && tokenRef.current) {
        try {
          const r = await api.bookmark(
            tokenRef.current,
            message.conversationId,
            message.id,
          );
          replaceMessage({ ...message, bookmarked: r.bookmarked });
          return;
        } catch (e) {
          showToast((e as any)?.message || "Action failed");
        }
      }
      replaceMessage({ ...message, bookmarked: !message.bookmarked });
    },
    [offlineDemo, replaceMessage, showToast],
  );
  const onEditMessage = useCallback(
    async (message, text) => {
      const clean = (text || "").trim();
      if (!clean || clean === message.text) return;
      replaceMessage({ ...message, text: clean, edited: true });
      // Refresh the sender's own-plaintext cache to the EDITED text. decryptMessageList
      // serves this cache-first for own messages (the self-envelope is often missing/FS),
      // so without this the incoming MESSAGE_UPDATED echo re-decrypts to the STALE original
      // text and the sender's edit visibly reverts (while the recipient, who decrypts the
      // new envelope, correctly shows the edit). Keyed by server id, same as send.
      void rememberSentPlaintext(message.id, clean);
      if (offlineDemo || !tokenRef.current) return;
      // E2EE edit: the original was encrypted (encryptionVersion>0 OR the
      // current conversation is E2EE-enabled). Encrypt the new text the SAME
      // way a fresh send does and submit it as `encrypted`. Fail-closed: never
      // fall back to sending plaintext for a row whose history is encrypted —
      // that would downgrade the message and the receiver would render
      // "[Unencrypted — rejected]" in a pinned E2EE conversation.
      const conv = conversations.find((c) => c.id === message.conversationId);
      const wasEncrypted =
        Number(message.encryptionVersion || 0) > 0 ||
        !!(message as any).encrypted;
      const mustEncrypt = !!(
        conv &&
        isE2EEEnabled() &&
        (wasEncrypted ||
          conv.kind === "dm" ||
          conv.kind === "self" ||
          conv.kind === "group" ||
          conv.kind === "channel")
      );
      try {
        let encrypted: any = null;
        if (mustEncrypt) {
          if (conv!.kind === "dm" || conv!.kind === "self") {
            const otherId =
              conv!.members.find((m) => m !== meRef.current?.id) ||
              meRef.current?.id;
            if (!otherId) throw new Error("No recipient");
            encrypted = await encryptForUser(
              tokenRef.current!,
              otherId,
              clean,
              message.conversationId,
              { useOpk: true, useRatchet: isRatchetEnabled() },
            );
          } else {
            const memberIds = (conv!.members || []).filter(Boolean);
            encrypted = await encryptForGroup(
              tokenRef.current!,
              message.conversationId,
              memberIds,
              clean,
            );
          }
        }
        // B1 — encryptForUser returns null when the DM peer has no E2EE device
        // yet: edit the message in the clear (and don't send envelopes) just like
        // the original plaintext send did. A throw above (MITM/changed identity)
        // stays fail-closed via the catch.
        const sendPlaintextEdit = mustEncrypt && encrypted == null;
        await api.editMessage(
          tokenRef.current,
          message.conversationId,
          message.id,
          mustEncrypt && !sendPlaintextEdit ? "" : clean,
          encrypted,
        );
      } catch (e) {
        showToast((e as any)?.message || "Couldn't edit message");
      }
    },
    [offlineDemo, replaceMessage, showToast, conversations],
  );
  const onDeleteMessage = useCallback(
    async (message, forMe) => {
      if (forMe) {
        removeMessage(message.conversationId, message.id);
        if (!offlineDemo && tokenRef.current) {
          try {
            await api.deleteMessageForMe(
              tokenRef.current,
              message.conversationId,
              message.id,
            );
          } catch (e) {
            showToast((e as any)?.message || "Action failed");
          }
        }
        return;
      }
      replaceMessage({
        ...message,
        deleted: true,
        text: "",
        file: null,
        voice: null,
        reactions: [],
      });
      if (!offlineDemo && tokenRef.current) {
        try {
          await api.deleteMessage(
            tokenRef.current,
            message.conversationId,
            message.id,
          );
        } catch (e) {
          showToast((e as any)?.message || "Action failed");
        }
      }
    },
    [offlineDemo, replaceMessage, removeMessage, showToast],
  );
  const onForwardOpen = useCallback((message) => {
    // Rich-text bodies are HTML (e.g. "<p></p><p>😎</p>"); show readable plain
    // text in the forward preview, never raw tags.
    setModal({
      type: "forward",
      payload: {
        message,
        preview: message.file
          ? "📎 " + (message.file.name || "Attachment")
          : message.type === "voice"
            ? "🎙 Voice message"
            : messagePreview(message.text) || "Message",
      },
    });
  }, []);
  const doForward = useCallback(
    async (targetIds) => {
      const src = modal && modal.payload && modal.payload.message;
      setModal(null);
      if (!src) return;
      // WhatsApp-style: forward to one OR many chats in a single action.
      const ids: string[] = Array.isArray(targetIds) ? targetIds : [targetIds];
      if (!ids.length) return;
      let ok = 0;
      if (!offlineDemo && tokenRef.current) {
        for (const targetId of ids) {
          try {
            await api.forwardMessage(
              tokenRef.current,
              targetId,
              src.text || null,
              {
                file: src.file || null,
                voice: src.voice || null,
                type: src.type || (src.file ? "file" : "text"),
                // Increment the forward chain so the recipient sees "Forwarded" and,
                // past the WhatsApp threshold, "Forwarded many times".
                forwardCount: (Number(src.forwardCount) || 0) + 1,
              },
            );
            ok++;
          } catch (e) {
            showToast((e as any)?.message || "Couldn't forward");
          }
        }
        if (ok)
          showToast(
            ok === 1 ? "Message forwarded" : `Forwarded to ${ok} chats`,
          );
      }
      // Open the destination only when forwarding to a single chat; for many,
      // stay put (like WhatsApp) so the user keeps their place.
      if (ids.length === 1) onSelect(ids[0]);
    },
    [modal, offlineDemo, onSelect, showToast],
  );
  const onBlockUser = useCallback(
    async (userId: string) => {
      if (!userId) return;
      setBlockedIds((prev) => {
        const n = new Set(prev);
        n.add(userId);
        return n;
      });
      if (!offlineDemo && tokenRef.current) {
        try {
          await api.blockUser(tokenRef.current, userId);
          showToast("User blocked");
        } catch (e: any) {
          setBlockedIds((prev) => {
            const n = new Set(prev);
            n.delete(userId);
            return n;
          });
          showToast((e && e.message) || "Couldn't block");
        }
      }
    },
    [offlineDemo, showToast],
  );
  const onUnblockUser = useCallback(
    async (userId: string) => {
      if (!userId) return;
      setBlockedIds((prev) => {
        const n = new Set(prev);
        n.delete(userId);
        return n;
      });
      if (!offlineDemo && tokenRef.current) {
        try {
          await api.unblockUser(tokenRef.current, userId);
          showToast("User unblocked");
        } catch (e: any) {
          setBlockedIds((prev) => {
            const n = new Set(prev);
            n.add(userId);
            return n;
          });
          showToast((e && e.message) || "Couldn't unblock");
        }
      }
    },
    [offlineDemo, showToast],
  );
  const onReportUser = useCallback(
    async (userId: string, reason: string, alsoBlock: boolean) => {
      if (!userId) return;
      if (!offlineDemo && tokenRef.current) {
        try {
          await api.reportUser(tokenRef.current, userId, reason);
        } catch (e: any) {
          showToast((e && e.message) || "Couldn't submit report");
          return;
        }
      }
      if (alsoBlock) await onBlockUser(userId);
      else showToast("Report submitted. Thank you.");
    },
    [offlineDemo, showToast, onBlockUser],
  );
  // Optimistic member-flag toggle (star / mute) that a concurrent, stale list
  // refetch can't undo — see convFlagOverridesRef in useCoLab1. On failure the
  // flag is reverted (it used to stay flipped on screen after "Action failed").
  const setMemberFlag = useCallback(
    async (
      id: string,
      flag: "starred" | "muted",
      value: boolean,
      write: (token: string, id: string, value: boolean) => Promise<any>,
    ) => {
      const key = String(id);
      const overrides: Map<string, any> = convFlagOverridesRef.current;
      const prevEntry = overrides.get(key);
      overrides.set(key, {
        flags: { ...(prevEntry?.flags || {}), [flag]: value },
        committedAt: null,
        since: Date.now(),
      });
      setConversations((prev) =>
        prev.map((c) => (c.id === id ? { ...c, [flag]: value } : c)),
      );
      if (offlineDemo || !tokenRef.current) {
        overrides.delete(key);
        return;
      }
      try {
        await write(tokenRef.current, id, value);
        const cur = overrides.get(key);
        if (cur && cur.flags[flag] === value) cur.committedAt = Date.now();
      } catch (e) {
        const cur = overrides.get(key);
        if (cur && cur.flags[flag] === value) overrides.delete(key);
        setConversations((prev) =>
          prev.map((c) => (c.id === id ? { ...c, [flag]: !value } : c)),
        );
        showToast((e as any)?.message || "Action failed");
      }
    },
    [offlineDemo, showToast],
  );
  const onStar = useCallback(
    (id, value) => setMemberFlag(id, "starred", !!value, api.setStar),
    [setMemberFlag],
  );
  const onMute = useCallback(
    (id, value) => setMemberFlag(id, "muted", !!value, api.setMute),
    [setMemberFlag],
  );
  const onConvAction = useCallback(
    async (action, id) => {
      const c = conversations.find((x) => x.id === id);
      if (!c) return;
      const nm = c.name || "Chat";
      const live = !offlineDemo && tokenRef.current;
      if (action === "mute") onMute(id, !c.muted);
      else if (action === "star") onStar(id, !c.starred);
      else if (action === "read") {
        // Menu item is soft-disabled on an empty chat — explain rather than silently
        // marking a never-used conversation unread (which left a phantom unread dot).
        if (
          !((c.unread || 0) > 0) && !c.previewHtml &&
          !(typeof c.preview === "string" && c.preview.trim()) && !c.lastMessageAt
        ) {
          showToast("No messages yet — nothing to mark as unread.");
          return;
        }
        const wasUnread = (c.unread || 0) > 0;
        setConversations((prev) =>
          prev.map((x) =>
            x.id === id ? { ...x, unread: wasUnread ? 0 : 1 } : x,
          ),
        );
        showToast(wasUnread ? "Marked as read" : "Marked as unread");
        if (live) api.setRead(tokenRef.current, id, wasUnread).catch(() => {});
        // On mobile, surface the list so the new unread indicator is visible.
        // We do NOT clear activeId — keeping the chat open lets the user SEE the
        // sidebar row flip to unread (accent bar + count badge); it only re-reads
        // on an explicit re-open (onSelect), never by staying open. (Previously
        // we closed the chat here, which made it look like nothing happened.)
        if (!wasUnread) setMobilePane("list");
      } else if (action === "hide" || action === "archive") {
        // Archive = mark hidden but KEEP it in state, so it moves to the Archive
        // view and can be unarchived (was previously removed entirely → lost).
        setConversations((prev) =>
          prev.map((x) => (x.id === id ? { ...x, hidden: true } : x)),
        );
        if (activeId === id) setActiveId(null);
        showToast(`${nm} archived`);
        if (live)
          api.hideConversation(tokenRef.current, id, true).catch(() => {});
      } else if (action === "delete") {
        // DATA LOSS GUARD. This used to fire instantly with no confirmation, and
        // on a DM the server deletes the conversation for BOTH people — one
        // click silently destroyed the other person's entire history. Now: a
        // DM/self "Delete chat" removes it for YOU only (archive/hide, which is
        // reversible from Archived); groups/channels still delete for everyone
        // but only after an explicit confirmation, and only for the owner (the
        // server rejects anyone else, so we no longer fake success locally).
        const isDm = c.kind === "dm" || c.kind === "self";
        if (isDm) {
          // "Clear chat" is soft-disabled on an empty DM — nothing to clear, so
          // explain instead of opening a pointless confirm dialog.
          if (
            !((c.unread || 0) > 0) && !c.previewHtml &&
            !(typeof c.preview === "string" && c.preview.trim()) && !c.lastMessageAt
          ) {
            showToast("This chat is empty — there is nothing to clear.");
            return;
          }
          if (
            !(await confirmDialog(
              `Clear your chat with "${nm}"? Your copy of the messages is removed and the chat starts fresh — it stays in your list, and ${nm} keeps their copy.`,
              { title: "Clear chat?", confirmText: "Clear", danger: true },
            ))
          )
            return;
          // Per-user "Clear chat": empty MY view and keep the conversation VISIBLE
          // as a fresh empty chat (NOT archived). The server stamps a history cutoff
          // so the old messages never reappear; the other person keeps their copy.
          // The chat stays OPEN so it reads as a fresh conversation immediately.
          setMessagesByConv((prev) => ({ ...prev, [id]: [] }));
          setMsgLoadStatus((s) => ({ ...s, [id]: "loaded" }));
          setConversations((prev) =>
            prev.map((x) =>
              x.id === id
                ? {
                    ...x,
                    hidden: false,
                    unread: 0,
                    preview: "",
                    previewHtml: null,
                    lastMessage: null,
                    lastMessageAt: null,
                  }
                : x,
            ),
          );
          showToast(`Chat with ${nm} cleared`);
          if (live)
            api.clearConversation(tokenRef.current, id).catch(() => {
              showToast("Couldn't clear the chat.");
              refetchConversations();
            });
          return;
        }
        // Group/channel. Only the OWNER can delete it for EVERYONE; any other
        // member (incl. admins — the server reserves hard-delete for the owner)
        // instead LEAVES, which clears it from THEIR list while others keep it.
        // This unblocks "I have N groups I can't delete" — a non-owner used to be
        // dead-ended with a toast and no way to remove the row at all.
        const isOwner = c.memberRole === "owner";
        if (!isOwner) {
          if (
            !(await confirmDialog(
              `Leave "${nm}"? It's removed from your chat list; the other members keep it.`,
              { title: "Leave group?", confirmText: "Leave" },
            ))
          )
            return;
          setConversations((prev) => prev.filter((x) => x.id !== id));
          dropDraft(id);
          if (activeId === id) setActiveId(null);
          setMessagesByConv((prev) => {
            const next = { ...prev };
            delete next[id];
            return next;
          });
          if (live) {
            try {
              await api.leaveConversation(tokenRef.current, id);
            } catch (e: any) {
              showToast(e?.message || "Couldn't leave that group.");
              refetchConversations();
              return;
            }
          }
          showToast(`Left ${nm}`);
          return;
        }
        if (
          !(await confirmDialog(
            `Delete "${nm}" for everyone? All messages and files in it are removed for every member. This cannot be undone.`,
            { title: "Delete for everyone?", confirmText: "Delete", danger: true },
          ))
        )
          return;
        // Await the server before dropping it locally, so a rejection doesn't
        // leave the user believing it was deleted when it still exists.
        if (live) {
          try {
            await api.deleteConversation(tokenRef.current, id);
          } catch (e: any) {
            showToast(e?.message || "Couldn't delete that conversation.");
            return;
          }
        }
        setConversations((prev) => prev.filter((x) => x.id !== id));
        dropDraft(id);
        if (activeId === id) setActiveId(null);
        setMessagesByConv((prev) => {
          const next = { ...prev };
          delete next[id];
          return next;
        });
        showToast(`${nm} deleted`);
      } else if (action === "schedule") {
        // Open the meeting composer PRE-FILLED from this conversation: title
        // "Meeting with <name>" and the other participant(s) as attendees (the DM
        // peer, or a group/channel's members minus me), instead of a blank form.
        const sc = (conversationsRef.current || []).find((x: any) => x.id === id);
        const meId = meRef.current?.id;
        setMeetingTitle(sc && sc.name ? "Meeting with " + sc.name : "");
        let attendees: string[] = [];
        if (sc && (sc.kind === "group" || sc.kind === "channel") && Array.isArray(sc.members)) {
          attendees = sc.members.map((m: any) => m.id || m).filter((x: string) => x && x !== meId);
        } else if (sc && sc.kind === "dm") {
          const peerId = otherMemberId(sc.members, meId);
          if (peerId) attendees = [peerId];
        }
        setMeetingAttendees(attendees);
        setMode("calendar");
      } else if (action === "unhide") {
        setConversations((prev) =>
          prev.map((x) => (x.id === id ? { ...x, hidden: false } : x)),
        );
        showToast(`${nm} restored`);
        if (live)
          api.hideConversation(tokenRef.current, id, false).catch(() => {});
      } else if (action === "rename" || action === "manage") {
        // Group/channel management modal (rename, description, avatar). Accepts
        // both keys so any older caller using "rename" still works.
        setManageConvId(id);
      } else if (action === "window") {
        // Desktop: open a real in-app pop-out BrowserWindow (shares the session,
        // so it's already authenticated). Browser: keep the existing window.open.
        const cd: any =
          typeof window !== "undefined" ? (window as any).collabDesktop : null;
        if (isDesktopApp && cd && typeof cd.openPopout === "function") {
          try {
            // ISSUE #9: popout=1 → the new window renders ONLY this conversation
            // (Teams-style), with the rail/sidebar/top bar hidden.
            cd.openPopout({ conversation: id, popout: true });
          } catch (_) {}
          showToast("Opened in new window");
        } else {
          try {
            const url = new URL(window.location.href);
            url.search =
              "?conversation=" + encodeURIComponent(id) + "&popout=1";
            window.open(url.toString(), "_blank", "width=460,height=780");
          } catch (_) {}
          showToast("Opened in new window");
        }
      }
    },
    // FIX: removed unnecessary 'onSelect' dep
    [conversations, onMute, onStar, activeId, showToast, offlineDemo],
  );
  const onBulkConvAction = useCallback(
    async (action, ids) => {
      if (action !== "delete" || !Array.isArray(ids) || !ids.length) return false;
      const live = !offlineDemo && tokenRef.current;
      const targets = ids
        .map((id: string) => conversations.find((x) => x.id === id))
        .filter(Boolean) as any[];
      if (!targets.length) return false;
      const dms = targets.filter((c) => c && (c.kind === "dm" || c.kind === "self"));
      const leaves = targets.filter(
        (c) => c && (c.kind === "group" || c.kind === "channel") && c.memberRole !== "owner",
      );
      const deletes = targets.filter(
        (c) => c && (c.kind === "group" || c.kind === "channel") && c.memberRole === "owner",
      );
      // Human-readable breakdown so a bulk "Delete" can't silently hard-delete
      // groups the user only meant to leave. "a", "a and b", "a, b and c".
      const parts: string[] = [];
      if (deletes.length) parts.push(`delete ${deletes.length} you own for everyone`);
      if (leaves.length) parts.push(`leave ${leaves.length}`);
      if (dms.length) parts.push(`remove ${dms.length} from your list`);
      const summary =
        parts.length <= 1
          ? parts.join("")
          : parts.slice(0, -1).join(", ") + " and " + parts[parts.length - 1];
      const hasHardDelete = deletes.length > 0;
      if (
        !(await confirmDialog(
          `This will ${summary}. ${
            hasHardDelete
              ? "Deleting a group you own removes all its messages and files for every member and cannot be undone."
              : "Removed direct messages can be restored from Archived."
          }`,
          {
            title: `Remove ${targets.length} conversation${targets.length > 1 ? "s" : ""}?`,
            confirmText: hasHardDelete ? "Delete" : "Remove",
            danger: hasHardDelete,
          },
        ))
      )
        return false;
      const removed = new Set<string>();
      let failed = 0;
      // DM/self → hide (reversible archive)
      for (const c of dms) {
        if (live) {
          try { await api.hideConversation(tokenRef.current, c.id, true); }
          catch { failed++; continue; }
        }
        removed.add(c.id);
      }
      // Non-owner group/channel → leave (clears from my list only)
      for (const c of leaves) {
        if (live) {
          try { await api.leaveConversation(tokenRef.current, c.id); }
          catch { failed++; continue; }
        }
        removed.add(c.id);
      }
      // Owner group/channel → hard delete for everyone
      for (const c of deletes) {
        if (live) {
          try { await api.deleteConversation(tokenRef.current, c.id); }
          catch { failed++; continue; }
        }
        removed.add(c.id);
      }
      const hideSet = new Set(
        dms.filter((c) => removed.has(c.id)).map((c) => c.id),
      );
      const dropSet = new Set(
        [...leaves, ...deletes].filter((c) => removed.has(c.id)).map((c) => c.id),
      );
      setConversations((prev) =>
        prev
          .filter((x) => !dropSet.has(x.id))
          .map((x) => (hideSet.has(x.id) ? { ...x, hidden: true } : x)),
      );
      if (activeId && removed.has(activeId)) setActiveId(null);
      setMessagesByConv((prev) => {
        const next = { ...prev };
        for (const id of dropSet) delete next[id];
        return next;
      });
      if (failed) {
        showToast(`Removed ${removed.size}; ${failed} couldn't be removed.`);
        refetchConversations();
      } else {
        showToast(`Removed ${removed.size} conversation${removed.size > 1 ? "s" : ""}`);
      }
      return true;
    },
    [conversations, activeId, offlineDemo, showToast],
  );
  const onMarkActivityRead = useCallback(async () => {
    const unread = (conversations || []).filter(
      (c) => c && (c.unread || 0) > 0 && c.kind !== "self",
    );
    if (!offlineDemo && tokenRef.current) {
      try {
        await Promise.all(
          unread.map((c) => api.setRead(tokenRef.current, c.id, true)),
        );
        await refetchConversations();
      } catch (e) {
        showToast((e as any)?.message || "Action failed");
        return;
      }
    } else {
      setConversations((prev) => prev.map((c) => ({ ...c, unread: 0 })));
    }
    showToast("All caught up");
  }, [offlineDemo, conversations, refetchConversations, showToast]);
  const onSetReadConversation = useCallback(
    async (id) => {
      if (!offlineDemo && tokenRef.current) {
        try {
          await api.setRead(tokenRef.current, id, true);
          await refetchConversations();
        } catch (e) {
          showToast((e as any)?.message || "Action failed");
        }
      } else {
        setConversations((prev) =>
          prev.map((c) => (c.id === id ? { ...c, unread: 0 } : c)),
        );
      }
    },
    [offlineDemo, refetchConversations, showToast],
  );
  const doCreate = useCallback(
    async (payload) => {
      setModal(null);
      if (!offlineDemo && tokenRef.current) {
        try {
          const { avatar, ...rest } = payload;
          let c;
          if (avatar instanceof File) {
            const form = new FormData();
            Object.entries(rest).forEach(([k, v]) => form.append(k, v as any));
            form.append("avatar", avatar);
            const res = await fetch("/api/conversations", {
              method: "POST",
              headers: { Authorization: `Bearer ${tokenRef.current}` },
              body: form,
            });
            c = await res.json();
          } else {
            c = await api.createConversation(tokenRef.current, payload);
          }
          await refetchConversations();
          setMode("chats");
          onSelect(c.id);
          return;
        } catch (e) {
          showToast((e as any)?.message || "Action failed");
        }
      }
    },
    [offlineDemo, refetchConversations, onSelect, showToast],
  );
  const onInviteSubmit = useCallback(
    async (email) => {
      const mail = (email || "").toLowerCase().trim();
      if (offlineDemo || !tokenRef.current) {
        showToast("Connect to a workspace to send invites");
        return null;
      }
      const match = users.find((u) => (u.email || "").toLowerCase() === mail);
      if (!match) {
        showToast(`No ${config.appName} user with that email`);
        return null;
      }
      try {
        await api.sendInvite(tokenRef.current, match.id);
        await refetchInvites();
        showToast(`Connection request sent to ${match.name}`);
        return match.name;
      } catch (e) {
        showToast((e as any)?.message || "Couldn't send invite");
        return null;
      }
    },
    [offlineDemo, users, refetchInvites, showToast],
  );
  const onSendInvite = useCallback(
    async (userId) => {
      if (offlineDemo || !tokenRef.current) return;
      try {
        const res: any = await api.sendInvite(tokenRef.current, userId);
        const convId = res && res.conversationId;
        const u = users.find((x) => x.id === userId);
        showToast(`Connection request sent${u ? " to " + u.name : ""}`);
        // Teams-model: the request opens a pending DM immediately. Refresh the lists,
        // then land the user IN that chat so they can send a text right away (a
        // "Request sent" banner shows there until the other person accepts).
        await Promise.all([refetchInvites(), refetchConversations()]);
        if (convId) {
          setMode("chats");
          onSelect(convId);
        }
      } catch (e) {
        showToast((e as any)?.message || "Couldn't send invite");
      }
    },
    [offlineDemo, users, refetchInvites, refetchConversations, showToast, onSelect],
  );
  const onAcceptInvite = useCallback(
    async (id) => {
      if (offlineDemo || !tokenRef.current) return;
      try {
        await api.acceptInvite(tokenRef.current, id);
        await Promise.all([refetchInvites(), refetchConversations()]);
        showToast("Connection accepted");
      } catch (e) {
        showToast((e as any)?.message || "Couldn't accept invite");
      }
    },
    [offlineDemo, refetchInvites, refetchConversations, showToast],
  );
  const onDeclineInvite = useCallback(
    async (id) => {
      if (offlineDemo || !tokenRef.current) return;
      try {
        await api.declineInvite(tokenRef.current, id);
        await refetchInvites();
        showToast("Invite declined");
      } catch (e) {
        showToast((e as any)?.message || "Couldn't decline invite");
      }
    },
    [offlineDemo, refetchInvites, showToast],
  );
  const onCancelInvite = useCallback(
    async (id) => {
      if (offlineDemo || !tokenRef.current) return;
      try {
        await api.cancelInvite(tokenRef.current, id);
        await refetchInvites();
        showToast("Request cancelled");
      } catch (e) {
        showToast((e as any)?.message || "Couldn't cancel request");
      }
    },
    [offlineDemo, refetchInvites, showToast],
  );
  const onBlockInvite = useCallback(
    async (id) => {
      if (offlineDemo || !tokenRef.current) return;
      try {
        await api.blockInvite(tokenRef.current, id);
        await refetchInvites();
        showToast("Blocked — they can't invite you again");
      } catch (e) {
        showToast((e as any)?.message || "Couldn't block");
      }
    },
    [offlineDemo, refetchInvites, showToast],
  );
  const doAddParticipants = useCallback(
    async (userIds, shareHistory = true) => {
      setModal(null);
      if (!offlineDemo && tokenRef.current && activeId) {
        const conv = conversations.find((c) => c.id === activeId);
        if (conv && conv.kind === "dm") {
          try {
            const peers = (conv.members || []).filter(
              (m) => m !== meRef.current?.id,
            );
            const memberIds = Array.from(new Set([...peers, ...userIds]));
            const c: any = await api.createConversation(tokenRef.current, {
              kind: "group",
              memberIds,
            });
            await refetchConversations();
            const created = (c && c.data) || c;
            if (created && created.id) {
              setMode("chats");
              onSelect(created.id);
            }
            showToast("New group created — your direct chat is unchanged");
          } catch (e) {
            showToast((e as any)?.message || "Couldn't create the group");
          }
          return;
        }
        try {
          const res: any = await api.addMembers(
            tokenRef.current,
            activeId,
            userIds,
            shareHistory,
          );
          await refetchConversations();
          const already: string[] = (res && res.already) || [];
          const added =
            res && typeof res.added === "number" ? res.added : userIds.length;
          if (already.length && !added) {
            showToast(
              already.length === 1
                ? already[0] + " is already in this conversation"
                : "They're already in this conversation",
            );
          } else if (already.length) {
            showToast(
              "Added " +
                added +
                " · " +
                already.join(", ") +
                " already in this conversation",
            );
          } else {
            showToast(added > 1 ? "People added" : "Person added");
          }
        } catch (e) {
          showToast((e as any)?.message || "Action failed");
        }
      }
    },
    [
      offlineDemo,
      activeId,
      conversations,
      refetchConversations,
      onSelect,
      showToast,
    ],
  );
  const openBookmarks = useCallback(async () => {
    let items = [];
    if (!offlineDemo && tokenRef.current) {
      try {
        items = await decryptMessageList(await api.getBookmarks(tokenRef.current));
      } catch (_) {}
    }
    setModal({ type: "bookmarks", payload: { items } });
  }, [offlineDemo]);
  const searchReqId = useRef(0);
  const onSearch = useCallback(
    (q) => {
      setSearch(q);
      if (!q.trim()) {
        setSearchResults(null);
        return;
      }
      if (!offlineDemo && tokenRef.current) {
        // Drop out-of-order responses (last request wins): the global Chat-scope
        // search can have many requests in flight while you type.
        const rid = ++searchReqId.current;
        api
          .search(tokenRef.current, q)
          .then((r) => {
            if (rid === searchReqId.current) setSearchResults(r);
          })
          .catch(() => {
            if (rid === searchReqId.current) setSearchResults(null);
          });
      } else {
        const s = q.toLowerCase();
        setSearchResults({
          conversations: conversations.filter((c) =>
            c.name.toLowerCase().includes(s),
          ),
          people: [],
          messages: [],
        });
      }
    },
    [offlineDemo, conversations],
  );
  const lastGxAllNav = useRef("");
  useEffect(() => {
    if (gxScope !== "all") return;
    const v = gxQuery.trim();
    if (!v) return;
    if (mode === "search") {
      lastGxAllNav.current = v;
      return;
    }
    if (v === lastGxAllNav.current) return;
    const t = setTimeout(() => {
      lastGxAllNav.current = v;
      setSearchSeed(gxQuery);
      setMode("search");
    }, 300);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [gxScope, gxQuery, mode]);
  const applyFilePage = useCallback((res: any) => {
    if (Array.isArray(res)) {
      setFiles(res);
      setFileCount(res.length);
      setFileCursor(null);
      setFileHasMore(false);
      return;
    }
    const list = (res && res.files) || [];
    setFiles(list);
    setFileCount(
      res && typeof res.count === "number" ? res.count : list.length,
    );
    setFileCursor((res && res.nextCursor) || null);
    setFileHasMore(!!(res && res.hasMore));
  }, []);
  const refetchFiles = useCallback(
    async (opts?: { tab?: string; search?: string }) => {
      if (offlineDemo || !tokenRef.current) return;
      if (opts && opts.tab !== undefined) {
        fileTabRef.current = opts.tab;
        setFileTab(opts.tab);
      }
      if (opts && opts.search !== undefined) {
        fileSearchRef.current = opts.search;
        setFileSearch(opts.search);
      }
      setFileLoading(true);
      try {
        const res: any = await api.listFiles(tokenRef.current, {
          tab: fileTabRef.current,
          search: fileSearchRef.current || undefined,
        });
        applyFilePage(res);
      } catch {
        /* ignore */
      } finally {
        setFileLoading(false);
      }
    },
    [offlineDemo, applyFilePage],
  );
  const loadMoreFiles = useCallback(async () => {
    if (!fileCursor || offlineDemo || !tokenRef.current) return;
    setFileLoadingMore(true);
    try {
      const res: any = await api.listFiles(tokenRef.current, {
        cursor: fileCursor,
        tab: fileTabRef.current,
        search: fileSearchRef.current || undefined,
      });
      const more = (res && res.files) || [];
      setFiles((prev) => {
        const seen = new Set(prev.map((f) => f.id));
        return [...prev, ...more.filter((f) => !seen.has(f.id))];
      });
      if (res && typeof res.count === "number") setFileCount(res.count);
      setFileCursor((res && res.nextCursor) || null);
      setFileHasMore(!!(res && res.hasMore));
    } catch {
      /* ignore */
    } finally {
      setFileLoadingMore(false);
    }
  }, [fileCursor, offlineDemo]);
  useEffect(() => {
    if (mode === "files") refetchFiles();
  }, [mode, refetchFiles]);
  useEffect(() => {
    refetchFilesRef.current = () => refetchFiles();
    refetchTasksRef.current = () => refetchTasks();
    refetchRemindersRef.current = () => refetchReminders();
  }, [refetchFiles, refetchTasks, refetchReminders]);
  const onUploadFile = useCallback(
    async (file) => {
      if (offlineDemo || !tokenRef.current) {
        showToast("Sign in to upload files");
        return;
      }
      try {
        await api.uploadFile(tokenRef.current, file);
        await refetchFiles();
        showToast("File uploaded");
      } catch (e) {
        showToast((e as any)?.message || "Upload failed");
      }
    },
    [offlineDemo, refetchFiles, showToast],
  );
  const onDeleteFile = useCallback(
    async (id): Promise<boolean> => {
      if (offlineDemo || !tokenRef.current) return false;
      try {
        await api.deleteFile(tokenRef.current, id);
        await refetchFiles();
        return true;
      } catch (e) {
        showToast((e as any)?.message || "Delete failed");
        return false;
      }
    },
    [offlineDemo, refetchFiles, showToast],
  );
  const onRestoreFile = useCallback(
    async (id): Promise<boolean> => {
      if (offlineDemo || !tokenRef.current) return false;
      try {
        await api.restoreFile(tokenRef.current, id);
        await refetchFiles();
        return true;
      } catch (e) {
        showToast((e as any)?.message || "Couldn't restore");
        return false;
      }
    },
    [offlineDemo, refetchFiles, showToast],
  );
  const onToggleStarFile = useCallback(
    async (id, starred) => {
      if (offlineDemo || !tokenRef.current) return;
      setFiles((fs) => fs.map((f) => (f.id === id ? { ...f, starred } : f)));
      try {
        await api.starFile(tokenRef.current, id, starred);
      } catch (e) {
        setFiles((fs) =>
          fs.map((f) => (f.id === id ? { ...f, starred: !starred } : f)),
        );
        showToast((e as any)?.message || "Couldn't update favorite");
      }
    },
    [offlineDemo, showToast],
  );
  const onDownloadFile = useCallback(
    async (id, name) => {
      if (offlineDemo || !tokenRef.current) {
        showToast("Sign in to download files");
        return;
      }
      try {
        const blob = await api.downloadFile(tokenRef.current, id);
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url;
        a.download = name || "file";
        document.body.appendChild(a);
        a.click();
        a.remove();
        setTimeout(() => URL.revokeObjectURL(url), 1000);
      } catch (e) {
        showToast((e as any)?.message || "Download failed");
      }
    },
    [offlineDemo, showToast],
  );
  const onUploadAvatar = useCallback(
    async (file: File) => {
      if (!tokenRef.current) return;
      try {
        // Store a compact data URL on the user record; it's served via the
        // public avatar URL and reflected everywhere for everyone on next fetch.
        const dataUrl = await downscaleToDataURL(file, 256, 0.82);
        const updated = await api.updateAvatar(tokenRef.current, dataUrl);
        // Optimistic: show the new picture instantly (data URL renders directly).
        if (me)
          setMe({
            ...me,
            avatarUrl: (updated && updated.avatarUrl) || dataUrl,
          });
        // Reflect the change across DMs/members/messages views.
        refetchConversations();
        showToast("Profile picture updated");
      } catch (e) {
        showToast((e as any)?.message || "Upload failed");
      }
    },
    [showToast, me, refetchConversations],
  );
  const onUpdateProfile = useCallback(
    async (patch: { name?: string; about?: string; avatarUrl?: string }) => {
      if (!tokenRef.current) return;
      try {
        const updated = await api.updateProfile(tokenRef.current, patch);
        if (updated) setMe((m: any) => ({ ...(m || {}), ...updated }));
        // An avatar change must propagate to DMs/members/messages everywhere.
        if (patch.avatarUrl !== undefined) refetchConversations();
        showToast(
          patch.avatarUrl === ""
            ? "Profile picture removed"
            : "Profile updated",
        );
      } catch (e) {
        showToast((e as any)?.message || "Couldn't update profile");
      }
    },
    [showToast, refetchConversations],
  );
  const onUpdateConversation = useCallback(
    async (id: string, patch: any) => {
      if (!tokenRef.current || !id) return;
      const textPatch: any = {};
      if (patch.title !== undefined) textPatch.name = patch.title;
      if (patch.description !== undefined)
        textPatch.description = patch.description;
      if (Object.keys(textPatch).length)
        setConversations((prev) =>
          prev.map((c) => (c.id === id ? { ...c, ...textPatch } : c)),
        );
      try {
        await api.updateConversation(tokenRef.current, id, patch);
      } catch (e) {
        showToast((e as any)?.message || "Only the owner can edit this");
        refetchConversations();
      }
    },
    [showToast, refetchConversations],
  );
  const onUploadConversationAvatar = useCallback(
    async (id: string, file: File) => {
      if (!tokenRef.current || !id) return;
      try {
        const url = await downscaleToDataURL(file, 256, 0.82);
        await api.updateConversation(tokenRef.current, id, { avatarUrl: url });
        showToast("Group picture updated");
      } catch (e) {
        showToast((e as any)?.message || "Couldn't update picture");
      }
    },
    [showToast],
  );
  const onSetMemberRole = useCallback(
    async (convId: string, uid: string, role: string) => {
      if (!tokenRef.current || !convId) return;
      try {
        await api.setMemberRole(tokenRef.current, convId, uid, role);
        showToast(
          role === "admin"
            ? "Promoted to admin"
            : role === "owner"
              ? "Ownership transferred"
              : "Admin removed",
        );
      } catch (e) {
        showToast((e as any)?.message || "Couldn't change role");
      }
    },
    [showToast],
  );
  const onRemoveMember = useCallback(
    async (convId: string, uid: string, name?: string) => {
      if (!tokenRef.current || !convId) return;
      try {
        await api.removeMember(tokenRef.current, convId, uid);
        showToast(name ? `Removed ${name}` : "Member removed");
      } catch (e) {
        showToast((e as any)?.message || "Couldn't remove member");
      }
    },
    [showToast],
  );
  const onLeaveConversation = useCallback(
    async (convId: string) => {
      if (!tokenRef.current || !convId) return;
      try {
        await api.leaveConversation(tokenRef.current, convId);
        showToast("You left the conversation");
        if (activeIdRef.current === convId) {
          setActiveId(null);
          setMobilePane("list");
        }
        setConversations((prev) => prev.filter((c) => c.id !== convId));
        dropDraft(convId);
      } catch (e) {
        showToast((e as any)?.message || "Couldn't leave");
      }
    },
    [showToast],
  );

  return {
    onReact,
    onPin,
    onUnpin,
    onMarkImportant,
    onBookmark,
    onEditMessage,
    onDeleteMessage,
    onForwardOpen,
    doForward,
    onBlockUser,
    onUnblockUser,
    onReportUser,
    onStar,
    onMute,
    onConvAction,
    onBulkConvAction,
    onMarkActivityRead,
    onSetReadConversation,
    doCreate,
    onInviteSubmit,
    onSendInvite,
    onAcceptInvite,
    onDeclineInvite,
    onCancelInvite,
    onBlockInvite,
    doAddParticipants,
    openBookmarks,
    searchReqId,
    onSearch,
    lastGxAllNav,
    applyFilePage,
    refetchFiles,
    loadMoreFiles,
    onUploadFile,
    onDeleteFile,
    onRestoreFile,
    onToggleStarFile,
    onDownloadFile,
    onUploadAvatar,
    onUpdateProfile,
    onUpdateConversation,
    onUploadConversationAvatar,
    onSetMemberRole,
    onRemoveMember,
    onLeaveConversation,
  };
}
