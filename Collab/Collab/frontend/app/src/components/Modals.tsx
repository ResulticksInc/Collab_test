import React, { useState, useEffect } from "react";
import Modal, { Btn, inp } from "./Modal";
import { Select } from "./ui";
import Avatar from "./Avatar";
import AvatarCropModal from "./AvatarCropModal";
import { messageRowPreview, firstLineHtml } from "../lib/messageText";
import { sanitizeMessageHtml } from "../lib/sanitizeHtml";
import { localTime } from "../lib/time";
import { copyText } from "../lib/clipboard";
import { IconCheck, IconCircleCheck, IconPhone, IconVideo, IconMessageCircle } from "../lib/icons";

function PeopleList({ people, selected, toggle }) {
  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        gap: 4,
        maxHeight: 300,
        overflowY: "auto",
      }}
    >
      {people.map((p) => (
        <div
          key={p.id}
          onClick={() => toggle(p.id)}
          style={{
            display: "flex",
            alignItems: "center",
            gap: 10,
            padding: "8px 10px",
            borderRadius: 8,
            cursor: "pointer",
            background: selected.includes(p.id) ? "var(--b50)" : "transparent",
          }}
        >
          <Avatar
            avatar={{
              kind: "user",
              initials: p.initials,
              color: p.color,
              avatarUrl: p.avatarUrl,
            }}
            size={30}
          />
          <div
            style={{
              flex: 1,
              fontSize: 13,
              fontWeight: 600,
              color: "var(--g800)",
            }}
          >
            {p.name}
          </div>
          <div
            style={{
              width: 18,
              height: 18,
              borderRadius: 5,
              border: "1.5px solid var(--g300)",
              background: selected.includes(p.id) ? "var(--bm)" : "transparent",
              color: "#fff",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              fontSize: 12,
            }}
          >
            {selected.includes(p.id) ? <IconCheck size={12} /> : null}
          </div>
        </div>
      ))}
    </div>
  );
}

export function CreateGroupModal({ people, kind, onClose, onCreate }) {
  const [title, setTitle] = useState("");
  const [sel, setSel] = useState<any[]>([]);
  const [avatar, setAvatar] = useState<File | null>(null);
  const [memberQuery, setMemberQuery] = useState(""); // BA/CEO #16: member search
  const [avatarPreview, setAvatarPreview] = useState<string | null>(null);
  const toggle = (id) =>
    setSel((s) => (s.includes(id) ? s.filter((x) => x !== id) : [...s, id]));
  const label = kind === "channel" ? "Channel" : "Group";
  const handleAvatar = (e: React.ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0];
    if (f) {
      setAvatar(f);
      setAvatarPreview(URL.createObjectURL(f));
    }
  };
  return (
    <Modal
      title={"New " + label}
      onClose={onClose}
      footer={
        <>
          <Btn onClick={onClose}>Cancel</Btn>
          <Btn
            primary
            disabled={!title.trim()}
            onClick={() =>
              onCreate({ kind, title: title.trim(), memberIds: sel, avatar })
            }
          >
            Create
          </Btn>
        </>
      }
    >
      <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 12 }}>
        <label
          style={{
            width: 50,
            height: 50,
            flex: "0 0 50px",
            borderRadius: "50%",
            background: "var(--g200)",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            cursor: "pointer",
            overflow: "hidden",
            border: "2px dashed var(--g300)",
          }}
        >
          {avatarPreview ? (
            <img src={avatarPreview} alt="" style={{ width: "100%", height: "100%", objectFit: "cover" }} />
          ) : (
            <IconMessageCircle size={20} style={{ color: "var(--g500)" }} />
          )}
          <input type="file" accept="image/*" onChange={handleAvatar} style={{ display: "none" }} id="group-avatar" />
        </label>
        <input
          name="group-name"
          autoComplete="off"
          autoFocus
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          placeholder={label + " name"}
          style={{ ...inp, flex: 1 }}
        />
      </div>
      <div style={{ fontSize: 12, color: "var(--g500)", margin: "12px 0 8px" }}>
        Add members
      </div>
      {/* BA/CEO #16: search instead of scrolling a long roster. Selection is held
          in `sel` independent of the visible list, so filtering never drops picks. */}
      <input
        name="member-search"
        autoComplete="off"
        value={memberQuery}
        onChange={(e) => setMemberQuery(e.target.value)}
        placeholder="Search people…"
        style={{ ...inp, marginBottom: 8 }}
      />
      <PeopleList
        people={people.filter(
          (p: any) =>
            !memberQuery.trim() ||
            String(p.name || "").toLowerCase().includes(memberQuery.trim().toLowerCase()),
        )}
        selected={sel}
        toggle={toggle}
      />
    </Modal>
  );
}
// Manage an existing group/channel: rename, edit description, change avatar.
// Admin/owner only (server enforces; UI hides save when canEdit is false).
export function ManageGroupModal({ conversation, onClose, onSave, onAvatar, canEdit }: any) {
  const isChannel = conversation?.kind === "channel";
  const label = isChannel ? "Channel" : "Group";
  const [title, setTitle] = useState(conversation?.name || "");
  const [desc, setDesc] = useState(conversation?.description || "");
  const [avatarFile, setAvatarFile] = useState<File | null>(null);
  const [avatarPreview, setAvatarPreview] = useState<string | null>(null);
  const [cropFile, setCropFile] = useState<File | null>(null);
  const [retentionDays, setRetentionDays] = useState(
    Number(conversation?.retentionDays) > 0 ? Number(conversation.retentionDays) : 7,
  );
  useEffect(() => () => { if (avatarPreview) URL.revokeObjectURL(avatarPreview); }, [avatarPreview]);
  const handleAvatar = (e: React.ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0];
    if (f) setCropFile(f); // open the cropper; the cropped result becomes the avatar
    if (e.target) e.target.value = "";
  };
  const dirty =
    title.trim() !== (conversation?.name || "") ||
    desc !== (conversation?.description || "") ||
    !!avatarFile;
  const save = () => {
    const patch: any = {};
    if (title.trim() && title.trim() !== conversation?.name) patch.title = title.trim();
    if (desc !== (conversation?.description || "")) patch.description = desc;
    if (Object.keys(patch).length) onSave(patch);
    if (avatarFile) onAvatar(avatarFile);
    onClose();
  };
  return (
    <Modal
      title={"Manage " + label}
      onClose={onClose}
      footer={
        <>
          <Btn onClick={onClose}>Cancel</Btn>
          <Btn primary disabled={!canEdit || !dirty || !title.trim()} onClick={save}>Save</Btn>
        </>
      }
    >
      {!canEdit ? (
        <div style={{ fontSize: 12, color: "var(--g500)", marginBottom: 10 }}>
          Only owners and admins can edit this {label.toLowerCase()}.
        </div>
      ) : null}
      {/* Temporary conversation controls — any participant may set the retention
          window or promote the conversation to a permanent group (both keep all
          history; convert just removes the auto-delete clock). */}
      {conversation?.temporary ? (
        <div
          style={{
            marginBottom: 14,
            padding: 12,
            borderRadius: 10,
            background: "rgba(245,158,11,0.10)",
            border: "1px solid rgba(245,158,11,0.28)",
          }}
        >
          <div style={{ fontSize: 12.5, fontWeight: 600, color: "var(--g800)", marginBottom: 2 }}>
            ⏳ Temporary conversation
          </div>
          <div style={{ fontSize: 11.5, color: "var(--g600)", marginBottom: 10, lineHeight: 1.45 }}>
            Auto-deletes after {retentionDays} day{retentionDays === 1 ? "" : "s"} of inactivity.
            Any new message, file, recording, or call session resets the timer.
          </div>
          <div style={{ fontSize: 11, color: "var(--g500)", marginBottom: 4 }}>Keep for</div>
          <Select
            value={retentionDays}
            onChange={(e) => {
              const d = Number(e.target.value);
              setRetentionDays(d);
              onSave({ retentionDays: d });
            }}
            style={{ ...inp, marginBottom: 10 }}
          >
            {[7, 14, 30, 60, 90].map((d) => (
              <option key={d} value={d}>
                {d} days after last activity
              </option>
            ))}
          </Select>
          <Btn
            primary
            onClick={() => {
              onSave({ temporary: false });
              onClose();
            }}
          >
            Convert to permanent group
          </Btn>
        </div>
      ) : null}
      <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 12 }}>
        <label
          htmlFor="mg-avatar"
          style={{
            width: 60, height: 60, borderRadius: "50%",
            background: "var(--g200)",
            display: "flex", alignItems: "center", justifyContent: "center",
            cursor: canEdit ? "pointer" : "not-allowed",
            overflow: "hidden",
            border: "2px dashed var(--g300)",
            flexShrink: 0,
          }}
        >
          {avatarPreview ? (
            <img src={avatarPreview} alt="" style={{ width: "100%", height: "100%", objectFit: "cover" }} />
          ) : conversation?.avatar?.avatarUrl ? (
            <img src={conversation.avatar.avatarUrl} alt="" style={{ width: "100%", height: "100%", objectFit: "cover" }} />
          ) : (
            <span style={{ fontWeight: 700, color: "var(--g700)" }}>
              {(conversation?.avatar?.initials || conversation?.name || "?").slice(0, 2).toUpperCase()}
            </span>
          )}
          <input id="mg-avatar" type="file" accept="image/*" disabled={!canEdit} onChange={handleAvatar} style={{ display: "none" }} />
        </label>
        <input
          value={title}
          disabled={!canEdit}
          autoFocus
          maxLength={60}
          onChange={(e) => setTitle(e.target.value)}
          placeholder={label + " name"}
          style={{ ...inp, flex: 1 }}
        />
      </div>
      <div style={{ fontSize: 12, color: "var(--g500)", margin: "6px 0" }}>Description</div>
      <textarea
        value={desc}
        disabled={!canEdit}
        maxLength={500}
        rows={3}
        onChange={(e) => setDesc(e.target.value)}
        placeholder={"What's this " + label.toLowerCase() + " about?"}
        style={{ ...inp, resize: "vertical", minHeight: 70 }}
      />
      {cropFile ? (
        <AvatarCropModal
          file={cropFile}
          onCancel={() => setCropFile(null)}
          onConfirm={(cropped) => {
            setCropFile(null);
            setAvatarFile(cropped);
            setAvatarPreview(URL.createObjectURL(cropped));
          }}
        />
      ) : null}
    </Modal>
  );
}

export function AddParticipantsModal({ people, onClose, onAdd, onSearch }: any) {
  const [sel, setSel] = useState<any[]>([]);
  const [q, setQ] = useState("");
  const [remote, setRemote] = useState<any[] | null>(null);
  // #16: by default new members can read the full chat history; un-checking
  // this withholds everything sent before they were added.
  const [shareHistory, setShareHistory] = useState(true);
  // When an onSearch is provided (the in-call/meeting invite), a non-empty query
  // hits the org directory backend — so you can invite anyone in the tenant, not
  // just the pre-passed DM contacts. Debounced + stale-guarded so a slow response
  // can't overwrite a newer query. Without onSearch, behaviour is unchanged.
  useEffect(() => {
    if (!onSearch) return;
    const term = q.trim();
    if (!term) {
      setRemote(null);
      return;
    }
    let alive = true;
    const t = setTimeout(() => {
      Promise.resolve(onSearch(term))
        .then((list: any) => {
          if (alive) setRemote(Array.isArray(list) ? list : []);
        })
        .catch(() => {
          if (alive) setRemote([]);
        });
    }, 250);
    return () => {
      alive = false;
      clearTimeout(t);
    };
  }, [q, onSearch]);
  // Selection persists as ids in `sel`, so a person picked from a search result
  // stays selected (and is submitted via onAdd) even after the query changes and
  // they drop out of the visible list.
  const toggle = (id) =>
    setSel((s) => (s.includes(id) ? s.filter((x) => x !== id) : [...s, id]));
  const filtered =
    onSearch && q.trim()
      ? remote || []
      : (people || []).filter(
          (p) =>
            !q.trim() ||
            ((p && p.name) || "").toLowerCase().includes(q.trim().toLowerCase()),
        );
  return (
    <Modal
      title="Add participants"
      onClose={onClose}
      footer={
        <>
          <Btn onClick={onClose}>Cancel</Btn>
          <Btn primary disabled={!sel.length} onClick={() => onAdd(sel, shareHistory)}>
            Add{sel.length ? ` (${sel.length})` : ""}
          </Btn>
        </>
      }
    >
      <input
        name="add-participants-search"
        autoComplete="off"
        value={q}
        onChange={(e) => setQ(e.target.value)}
        placeholder="Search people…"
        style={{ ...inp, marginBottom: 10 }}
        aria-label="Search people to add"
      />
      {sel.length > 0 ? (
        <div
          style={{
            fontSize: 12,
            fontWeight: 600,
            color: "var(--g500)",
            margin: "0 2px 8px",
          }}
        >
          {sel.length} selected · tap to deselect
        </div>
      ) : null}
      {filtered.length ? (
        <PeopleList people={filtered} selected={sel} toggle={toggle} />
      ) : (
        <div
          style={{
            padding: "16px 4px",
            fontSize: 13,
            color: "var(--g500)",
            textAlign: "center",
          }}
        >
          {onSearch && q.trim() && remote === null
            ? "Searching…"
            : "No people found."}
        </div>
      )}
      <label className="share-hist">
        <input
          type="checkbox"
          checked={shareHistory}
          onChange={(e) => setShareHistory(e.target.checked)}
        />
        <span className="share-hist-txt">
          <strong>Share previous messages</strong>
          <em>
            {shareHistory
              ? "New members can read the full chat history."
              : "New members will only see messages sent from now on."}
          </em>
        </span>
      </label>
    </Modal>
  );
}
export function ForwardModal({
  conversations,
  preview,
  onClose,
  onForward,
  title = "Forward message",
  heading = "Forwarding",
  actionLabel = "Forward",
}: {
  conversations: any;
  preview: any;
  onClose: any;
  onForward: any;
  title?: string;
  heading?: string;
  actionLabel?: string;
}) {
  const [q, setQ] = useState("");
  // WhatsApp-style multi-select: pick one OR many chats, then Forward to all.
  const [sel, setSel] = useState<Record<string, boolean>>({});
  const list = (conversations || []).filter(
    (c) => c && c.kind !== "self" && (c.name || "").toLowerCase().includes(q.toLowerCase()),
  );
  const selectedIds = Object.keys(sel).filter((id) => sel[id]);
  const toggle = (id: string) => setSel((s) => ({ ...s, [id]: !s[id] }));
  return (
    <Modal title={title} onClose={onClose}>
      <div style={{ fontSize: 12, color: "var(--g500)" }}>{heading}</div>
      <div
        style={{
          background: "var(--g50)",
          border: "1px solid var(--g200)",
          borderRadius: 8,
          padding: "8px 10px",
          margin: "6px 0 12px",
          fontSize: 13,
          color: "var(--g700)",
          overflowWrap: "break-word",
          wordBreak: "break-word",
          maxHeight: 80,
          overflowY: "auto",
        }}
      >
        {preview}
      </div>
      <input
        name="forward-search"
        autoComplete="off"
        value={q}
        onChange={(e) => setQ(e.target.value)}
        placeholder="Search people, groups & channels…"
        style={inp}
      />
      <div
        style={{
          display: "flex",
          flexDirection: "column",
          gap: 4,
          maxHeight: 260,
          overflowY: "auto",
          marginTop: 10,
        }}
      >
        {list.length === 0 ? (
          <div style={{ fontSize: 12.5, color: "var(--g400)", padding: "12px 8px", textAlign: "center" }}>No conversations match.</div>
        ) : null}
        {list.map((c) => {
          const on = !!sel[c.id];
          return (
            <div
              key={c.id}
              onClick={() => toggle(c.id)}
              role="button"
              aria-pressed={on}
              style={{
                display: "flex",
                alignItems: "center",
                gap: 10,
                padding: "8px 10px",
                borderRadius: 8,
                cursor: "pointer",
                background: on ? "var(--ac-bg, rgba(37,99,235,.10))" : "transparent",
              }}
            >
              <Avatar avatar={c.avatar} size={30} />
              <div style={{ flex: 1, fontSize: 13, fontWeight: 600 }}>{c.name}</div>
              <span
                aria-hidden="true"
                style={{
                  width: 18,
                  height: 18,
                  borderRadius: 5,
                  border: "2px solid " + (on ? "var(--ac, #2563eb)" : "var(--g300)"),
                  background: on ? "var(--ac, #2563eb)" : "transparent",
                  color: "#fff",
                  fontSize: 12,
                  lineHeight: "14px",
                  textAlign: "center",
                  flex: "0 0 auto",
                  display: "inline-flex",
                  alignItems: "center",
                  justifyContent: "center",
                }}
              >
                {on ? <IconCheck size={12} /> : null}
              </span>
            </div>
          );
        })}
      </div>
      <div style={{ display: "flex", gap: 8, justifyContent: "flex-end", marginTop: 14 }}>
        <button className="btn-c" style={{ height: 32, padding: "0 14px" }} onClick={onClose}>Cancel</button>
        <button
          className="btn-p"
          style={{ height: 32, padding: "0 16px" }}
          disabled={selectedIds.length === 0}
          onClick={() => onForward(selectedIds)}
        >
          {actionLabel}{selectedIds.length ? ` (${selectedIds.length})` : ""}
        </button>
      </div>
    </Modal>
  );
}
export function BookmarksPanel({ items, onClose }) {
  return (
    <Modal title="Bookmarks" onClose={onClose}>
      {items.length ? (
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          {items.map((m) => (
            <div
              key={m.id}
              style={{
                borderLeft: "3px solid var(--bm)",
                background: "var(--g50)",
                padding: "8px 10px",
                borderRadius: "0 8px 8px 0",
              }}
            >
              <div
                style={{ fontSize: 12, fontWeight: 700, color: "var(--g700)" }}
              >
                {m.me ? "You" : m.sender.name}
              </div>
              {m.text && !m.file ? (
                <div className="msg-prev-1" style={{ fontSize: 13, color: "var(--g700)" }} dangerouslySetInnerHTML={{ __html: sanitizeMessageHtml(firstLineHtml(m.text)) }} />
              ) : (
                <div style={{ fontSize: 13, color: "var(--g700)", overflowWrap: "break-word", wordBreak: "break-word" }}>
                  {messageRowPreview(m)}
                </div>
              )}
              <div style={{ fontSize: 11, color: "var(--g400)" }}>
                {m.createdAt ? localTime(m.createdAt) : m.time}
              </div>
            </div>
          ))}
        </div>
      ) : (
        <div
          style={{
            textAlign: "center",
            color: "var(--g400)",
            padding: "24px",
            fontSize: 13,
          }}
        >
          No bookmarks yet. Hover a message and tap the bookmark icon.
        </div>
      )}
    </Modal>
  );
}

export function InviteModal({ onClose, onInvite }) {
  const [email, setEmail] = useState("");
  const [sent, setSent] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [link] = useState(
    () =>
      "https://collab.resulticks.com/join/" +
      Math.random().toString(36).slice(2, 8),
  );
  const send = async () => {
    const v = email.trim();
    if (!v || busy) return;
    setBusy(true);
    setErr(null);
    try {
      const name = await onInvite(v);
      setSent(name || v);
      setEmail("");
    } catch (e: any) {
      setErr((e && e.message) || "Couldn't send the invite.");
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal
      title="Invite to Collab"
      onClose={onClose}
      footer={
        <>
          <Btn onClick={onClose}>Done</Btn>
          <Btn primary disabled={!email.trim() || busy} onClick={send}>
            {busy ? "Inviting…" : "Send invite"}
          </Btn>
        </>
      }
    >
      <p style={{ fontSize: 13, color: "var(--g600)", marginBottom: 10 }}>
        Invite a teammate by email — they&rsquo;ll show up in your Contacts so
        you can message them.
      </p>
      <input
        name="invite-email"
        type="email"
        autoComplete="off"
        autoFocus
        value={email}
        onChange={(e) => setEmail(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") send();
        }}
        placeholder="name@company.com"
        style={inp}
      />
      {err ? (
        <div
          style={{
            marginTop: 10,
            fontSize: 12.5,
            color: "var(--red)",
            background: "var(--red-bg)",
            padding: "8px 12px",
            borderRadius: 9,
          }}
        >
          {err}
        </div>
      ) : null}
      {sent ? (
        <div
          style={{
            marginTop: 10,
            fontSize: 12.5,
            color: "var(--grn)",
            background: "var(--grn-bg)",
            padding: "8px 12px",
            borderRadius: 9,
            display: "flex",
            alignItems: "center",
            gap: 6,
          }}
        >
          <IconCircleCheck size={15} /> {sent} added to your workspace — they&rsquo;re in Contacts now.
        </div>
      ) : null}
      <div style={{ fontSize: 12, color: "var(--g500)", margin: "16px 0 6px" }}>
        Or share an invite link
      </div>
      <div style={{ display: "flex", gap: 8 }}>
        <input
          name="invite-link"
          readOnly
          value={link}
          onFocus={(e) => e.target.select()}
          style={{ ...inp, flex: 1 }}
        />
        <Btn
          onClick={() => {
            try {
              copyText(link);
            } catch (_) {}
          }}
        >
          Copy
        </Btn>
      </div>
    </Modal>
  );
}

// Pick who to call from the directory, then connect. `mode` is "audio",
// "video", or "both" (both shows an audio AND a video button per person).
// Search matches name, the spaceless name, or the (email-derived) id, so
// typing "@" + any fragment of a person's name/handle filters the list.
export function NewCallModal({ people, mode, onClose, onPick }) {
  const [q, setQ] = useState("");
  const [hover, setHover] = useState("");
  const term = q.trim().replace(/^@+/, "").toLowerCase();
  const norm = (s) => (s || "").toLowerCase();
  const matches = (people || []).filter((p) => {
    if (!term) return true;
    return [norm(p.name), norm(p.name).replace(/\s+/g, ""), norm(p.id)].some(
      (h) => h.includes(term),
    );
  });
  const title =
    mode === "both"
      ? "New call"
      : mode === "video"
        ? "New video call"
        : mode === "message"
          ? "New message"
          : "New audio call";
  const iconBtn = (p, isVideo) => (
    <button
      key={isVideo ? "v" : "a"}
      onClick={(e) => {
        e.stopPropagation();
        onPick(p, isVideo);
      }}
      aria-label={(isVideo ? "Video call " : "Audio call ") + p.name}
      style={{
        width: 32,
        height: 32,
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        borderRadius: 8,
        border: "1px solid var(--g200)",
        background: "#fff",
        cursor: "pointer",
      }}
    >
      {isVideo ? (
        <IconVideo size={16} style={{ color: "var(--bm)" }} />
      ) : (
        <IconPhone size={16} style={{ color: "var(--bm)" }} />
      )}
    </button>
  );
  return (
    <Modal title={title} onClose={onClose}>
      <input
        autoFocus
        value={q}
        onChange={(e) => setQ(e.target.value)}
        placeholder="Search people, or type @ to filter…"
        style={inp}
      />
      <div
        style={{
          display: "flex",
          flexDirection: "column",
          gap: 4,
          maxHeight: 320,
          overflowY: "auto",
          marginTop: 10,
        }}
      >
        {matches.length ? (
          matches.map((p) => (
            <div
              key={p.id}
              onClick={
                mode === "both" ? undefined : mode === "message" ? () => onPick(p) : () => onPick(p, mode === "video")
              }
              onMouseEnter={() => setHover(p.id)}
              onMouseLeave={() => setHover("")}
              style={{
                display: "flex",
                alignItems: "center",
                gap: 10,
                padding: "8px 10px",
                borderRadius: 8,
                cursor: mode === "both" ? "default" : "pointer",
                background: hover === p.id ? "var(--b50)" : "transparent",
              }}
            >
              <Avatar
                avatar={{
                  kind: "user",
                  initials: p.initials,
                  color: p.color,
                  avatarUrl: p.avatarUrl,
                }}
                size={30}
              />
              <div
                style={{
                  flex: 1,
                  minWidth: 0,
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                  whiteSpace: "nowrap",
                  fontSize: 13,
                  fontWeight: 600,
                  color: "var(--g800)",
                }}
              >
                {p.name}
              </div>
              <div style={{ display: "flex", gap: 6 }}>
                {mode === "both" ? (
                  <>
                    {iconBtn(p, false)}
                    {iconBtn(p, true)}
                  </>
                ) : mode === "message" ? (
                  <IconMessageCircle size={16} style={{ color: "var(--bm)" }} />
                ) : (
                  iconBtn(p, mode === "video")
                )}
              </div>
            </div>
          ))
        ) : (
          <div
            style={{
              padding: "16px 10px",
              fontSize: 13,
              color: "var(--g500)",
              textAlign: "center",
            }}
          >
            No people match.
          </div>
        )}
      </div>
    </Modal>
  );
}
