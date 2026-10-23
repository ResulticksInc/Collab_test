// PeoplePopover — Teams-style header control: people+count button that opens a
// dropdown with the member list, then "Add people" and "Leave" at the bottom.
import React, { useEffect, useRef, useState } from "react";
import { api } from "../../lib/api";
import Avatar from "../Avatar";
import { IconUserPlus, IconLogOut, IconX } from "../../lib/icons";

export default function PeoplePopover({ s }: { s: any }) {
  const { conversation, token, meId, onAddParticipants, onLeaveConversation, onRemoveMember, offlineDemo } = s;
  const [open, setOpen] = useState(false);
  const [members, setMembers] = useState<any[] | null>(null);
  const ref = useRef<HTMLDivElement>(null);
  const count = conversation?.memberCount || (conversation?.members || []).length || 0;
  const isGroupish = conversation?.kind === "group" || conversation?.kind === "channel";

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setOpen(false); };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => { document.removeEventListener("mousedown", onDown); document.removeEventListener("keydown", onKey); };
  }, [open]);

  useEffect(() => {
    if (!open || !token || !conversation?.id || offlineDemo) return;
    let off = false;
    api.getMembers(token, conversation.id)
      .then((d: any) => { if (!off) setMembers(Array.isArray(d) ? d : []); })
      .catch(() => { if (!off) setMembers([]); });
    return () => { off = true; };
  }, [open, token, conversation?.id, offlineDemo]);
  useEffect(() => { setOpen(false); setMembers(null); }, [conversation?.id]);

  const myRole = (members || []).find((x: any) => x.id === meId)?.memberRole;
  const canManage = isGroupish && (myRole === "owner" || myRole === "admin");
  const removeOne = async (m: any) => {
    if (!onRemoveMember) return;
    await onRemoveMember(conversation.id, m.id, m.name);
    setMembers((cur) => (cur || []).filter((x: any) => x.id !== m.id));
  };

  return (
    <div className="pp-wrap" ref={ref}>
      <button className={"ab ab-people" + (open ? " on" : "")} aria-haspopup="menu" aria-expanded={open}
        aria-label="People" data-tip="People" onClick={() => setOpen((o) => !o)}>
        <IconUserPlus size={18} />
        {count ? <span className="ab-people-n">{count}</span> : null}
      </button>
      {open ? (
        <div className="pp-pop" role="menu">
          <div className="pp-h">People ({count})</div>
          <div className="pp-list">
            {members === null ? <div className="pp-empty">Loading…</div> : members.length === 0 ? (
              <div className="pp-empty">No members to show.</div>
            ) : members.map((m: any) => (
              <div className="pp-row" key={m.id}>
                <Avatar avatar={{ kind: "user", initials: m.initials || String(m.name || "?").split(" ").map((w: string) => w[0]).slice(0, 2).join("").toUpperCase(), color: m.color, avatarUrl: m.avatarUrl || m.avatar?.avatarUrl }} size={28} />
                <span className="pp-nm">{m.name}{m.id === meId ? " (You)" : ""}</span>
                {m.memberRole === "owner" || m.memberRole === "admin" ? (
                  <span className="pp-role">{m.memberRole === "owner" ? "Owner" : "Admin"}</span>
                ) : null}
                {canManage && onRemoveMember && m.id !== meId && m.memberRole !== "owner" ? (
                  <button className="pp-x" aria-label={"Remove " + m.name} data-tip="Remove" onClick={() => removeOne(m)}>
                    <IconX size={16} />
                  </button>
                ) : null}
              </div>
            ))}
          </div>
          <div className="pp-sep" />
          {onAddParticipants ? (
            <button className="pp-act" role="menuitem" onClick={() => { setOpen(false); onAddParticipants(); }}>
              <IconUserPlus size={18} /><span>Add people</span>
            </button>
          ) : null}
          {isGroupish && onLeaveConversation ? (
            <button className="pp-act" role="menuitem" onClick={() => { setOpen(false); onLeaveConversation(conversation.id); }}>
              <IconLogOut size={18} /><span>Leave</span>
            </button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
