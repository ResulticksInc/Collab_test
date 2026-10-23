import { useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { IconSearch, IconX, IconMessageSquare, IconChevronLeft } from "../lib/icons";

// ── Collaboration sidebar (P0-5, Teams-style) — the LIST ─────────────────────
// Opened from the top-left ☰ during a call/meeting. This renders the chat/people
// LIST and a "not connected" prompt. Opening a conversation is handled by the
// ROOT, which renders the REAL ChatView (exact chat window) for it in the same
// sidebar — the call/meeting stays full-size, no PiP, no navigation.

function initials(name: string): string {
  return (
    String(name || "?")
      .split(/\s+/)
      .map((w) => w[0])
      .filter(Boolean)
      .slice(0, 2)
      .join("")
      .toUpperCase() || "?"
  );
}

export default function CommsSidebar({
  conversations,
  users,
  meId,
  onOpenConversation,
  onSendInvite,
  onClose,
  resizeHandle,
}: {
  conversations: any[];
  users: any[];
  meId: string | null;
  onOpenConversation: (conversationId: string) => void;
  onSendInvite: (userId: string) => void;
  onClose: () => void;
  // Drag/keyboard resize handle rendered on the sidebar's right edge (owned by
  // CoLabV1 so the width + --comms-w push stay in one place). See CoLabV1.
  resizeHandle?: ReactNode;
}) {
  const [q, setQ] = useState("");
  const [pendingPerson, setPendingPerson] = useState<any>(null);
  const [inviteSent, setInviteSent] = useState(false);

  const query = q.trim().toLowerCase();
  const match = (s: any) => String(s || "").toLowerCase().includes(query);
  // Group the conversation list by kind — Direct messages, Groups, Channels —
  // each sorted most-recent-first, instead of one flat mixed list. `self` is
  // excluded (it's the "You" space, surfaced elsewhere). An `others` bucket
  // catches any future kind so nothing silently disappears.
  const filtered = (conversations || [])
    .filter((c: any) => c && c.kind !== "self" && (!query || match(c.name)))
    .slice()
    .sort((a: any, b: any) => {
      return String(b?.lastMessageAt || "").localeCompare(String(a?.lastMessageAt || ""));
    });
  const chats = filtered.filter((c: any) => c && (c.kind === "dm" || c.kind === "group")).slice(0, 40);
  const channels = filtered.filter((c: any) => c && c.kind === "channel").slice(0, 30);
  const others = filtered
    .filter((c: any) => c && c.kind !== "dm" && c.kind !== "group" && c.kind !== "channel")
    .slice(0, 30);
  const anyConvs = chats.length + channels.length + others.length > 0;
  const dmByUser = new Map<string, any>();
  for (const c of conversations || [])
    if (c && c.kind === "dm")
      for (const uid of c.members || []) if (uid !== meId) dmByUser.set(uid, c);
  const people = (users || [])
    .filter((u: any) => u && u.id !== meId && (!query || match(u.name)))
    .slice(0, 40);

  const openPerson = (u: any) => {
    const dm = dmByUser.get(u.id);
    if (dm) onOpenConversation(dm.id);
    else {
      // No DM → inline "not connected" prompt, staying in the sidebar (no PiP).
      setInviteSent(false);
      setPendingPerson(u);
    }
  };

  // One conversation kind → a labelled section of rows (null when empty).
  const convSection = (label: string, list: any[]) =>
    list.length > 0 ? (
      <div key={label}>
        <div className="comms-section">{label}</div>
        {list.map((c: any) => (
          <button key={c.id} className="comms-row" onClick={() => onOpenConversation(c.id)}>
            <span
              className="comms-avatar"
              style={{ background: (c.avatar && c.avatar.color) || "var(--ac, #6366f1)" }}
            >
              {(c.avatar && c.avatar.initials) || initials(c.name)}
            </span>
            <span className="comms-rowmain">
              <span className="comms-rowtop">
                <span className="comms-name">{c.name}</span>
                {c.time ? <span className="comms-time">{c.time}</span> : null}
              </span>
              <span className="comms-rowsub">
                <span className="comms-preview">{c.preview || "No messages yet"}</span>
                {c.unread > 0 && (
                  <span className="comms-unread">{c.unread > 99 ? "99+" : c.unread}</span>
                )}
              </span>
            </span>
          </button>
        ))}
      </div>
    ) : null;

  return createPortal(
    <div className="comms-sidebar" role="complementary" aria-label="Chat while in the call">
      {resizeHandle}
      {pendingPerson ? (
        <>
          <div className="comms-head comms-conv-head">
            <button className="comms-back" onClick={() => setPendingPerson(null)} aria-label="Back to list">
              <IconChevronLeft size={18} />
            </button>
            <span className="comms-avatar comms-conv-avatar" style={{ background: pendingPerson.color || "var(--ac, #6366f1)" }}>
              {pendingPerson.initials || initials(pendingPerson.name)}
            </span>
            <span className="comms-conv-name">{pendingPerson.name}</span>
            <button className="comms-close" onClick={onClose} aria-label="Close chat sidebar">
              <IconX size={15} />
            </button>
          </div>
          <div className="comms-noconn">
            {inviteSent ? (
              <>
                <div className="comms-noconn-title">Request sent</div>
                <p>
                  We've sent {pendingPerson.name} a connection request. You can
                  message them once they accept.
                </p>
              </>
            ) : (
              <>
                <div className="comms-noconn-title">Not connected yet</div>
                <p>
                  You're not connected with {pendingPerson.name}, so there's no
                  conversation to open. Send a connection request to start
                  chatting.
                </p>
                <button
                  className="comms-noconn-btn"
                  onClick={() => {
                    onSendInvite(pendingPerson.id);
                    setInviteSent(true);
                  }}
                >
                  Send connection request
                </button>
              </>
            )}
          </div>
        </>
      ) : (
        <>
          <div className="comms-head">
            <span className="comms-title">
              <IconMessageSquare size={15} />
              Chat
            </span>
            <button className="comms-close" onClick={onClose} aria-label="Close chat sidebar">
              <IconX size={15} />
            </button>
          </div>
          <div className="comms-hint">
            Message anyone — your call stays live in the background.
          </div>
          <div className="comms-search">
            <IconSearch size={13} />
            <input
              autoFocus
              placeholder="Search people and conversations…"
              value={q}
              onChange={(e) => setQ(e.target.value)}
              aria-label="Search people and conversations"
            />
          </div>
          <div className="comms-body">
            {convSection("Chats", chats)}
            {convSection("Channels", channels)}
            {convSection("Conversations", others)}
            {people.length > 0 && (
              <>
                <div className="comms-section">People</div>
                {people.map((u: any) => (
                  <button key={u.id} className="comms-row" onClick={() => openPerson(u)}>
                    <span className="comms-avatar" style={{ background: u.color || "var(--ac, #6366f1)" }}>
                      {u.initials || initials(u.name)}
                    </span>
                    <span className="comms-rowmain">
                      <span className="comms-rowtop">
                        <span className="comms-name">{u.name}</span>
                      </span>
                    </span>
                    <span className={"comms-presence" + (u.presence === "online" ? " on" : "")} aria-hidden="true" />
                  </button>
                ))}
              </>
            )}
            {!anyConvs && people.length === 0 && (
              <div className="comms-empty">No matches for “{q.trim()}”.</div>
            )}
          </div>
        </>
      )}
    </div>,
    document.body,
  );
}
