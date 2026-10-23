"use client";
// ProfileModal — full profile detail for a chat author (opened by clicking their
// avatar in a group / channel conversation). The hover PersonCard stays the quick
// look; this is the "full profile" with Overview / Contact tabs.
import React, { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import Avatar from "../Avatar";
import { presenceDotClass } from "../../lib/presence";
import PresenceStatusIcon from "./PresenceStatusIcon";
import { personPresenceLabel } from "./helpers";
import { IconMessageCircle, IconVideo, IconPhone, IconMail, IconX, IconBell, IconBan, IconCircleCheck, IconUser, IconBriefcase, IconClock, IconInfo, IconLink } from "../../lib/icons";
import E2EEConversationSection from "../E2EEConversationSection";
import { api } from "../../lib/api";
import { confirmDialog } from "../../lib/dialog";
import { mimeOf } from "../../lib/desktopFiles";
import { InfoMediaTile, FileExtAvatar } from "./FileAttachment";
import { fileKeyIndex, withFileKeys } from "../../lib/fileThumbs";
import { extractLinksFromMessages } from "./helpers";
const fileName = (f: any) => String((f && (f.name || f.fileName || f.filename || f.originalName)) || "File");
const fileSize = (f: any) => {
  const n = Number(f && (f.size || f.bytes));
  if (!n) return "";
  return n < 1024 * 1024 ? Math.max(1, Math.round(n / 1024)) + " KB" : (n / 1048576).toFixed(1) + " MB";
};

// 1:1 extras shown in the profile modal: About, Mute, Block, end-to-end encryption.
function DmExtras({ s, info, onClose }: { s: any; info: any; onClose: () => void }) {
  const { conversation, meId, token, onMute, onBlockUser, onUnblockUser, peerBlocked, messages, setTab } = s;
  const [files, setFiles] = useState<any[] | null>(null);
  const [peer, setPeer] = useState<any>(null);
  useEffect(() => {
    let off = false;
    if (!token || !conversation?.id) return;
    api.getMembers(token, conversation.id)
      .then((d: any) => { if (!off && Array.isArray(d)) setPeer(d.find((p: any) => p.id !== meId) || null); })
      .catch(() => {});
    return () => { off = true; };
  }, [token, conversation?.id, meId]);
  useEffect(() => {
    let off = false;
    if (!token || !conversation?.id) return;
    api.getFiles(token, conversation.id)
      .then((d: any) => { if (!off) setFiles(Array.isArray(d) ? d : []); })
      .catch(() => { if (!off) setFiles([]); });
    return () => { off = true; };
  }, [token, conversation?.id]);
  const links = extractLinksFromMessages(messages || []);
  const idx = fileKeyIndex(messages || []);
  const keyed = (files || []).map((f: any) => withFileKeys(f, idx));
  const images = keyed.filter((f: any) => /^image\//.test(mimeOf(f)));
  const docs = keyed.filter((f: any) => !/^image\//.test(mimeOf(f)));
  const openTab = (t: string) => { onClose(); setTab && setTab(t); };
  const pr = peer || {};
  const email = pr.email || info.email;
  const phone = pr.phone || info.phone;
  const rows: [React.ReactNode, string, React.ReactNode][] = [];
  if (pr.about) rows.push([<IconInfo key="a" size={20} />, "About", pr.about]);
  if (pr.title) rows.push([<IconBriefcase key="t" size={20} />, "Title", pr.title]);
  if (pr.pronouns) rows.push([<IconUser key="p" size={20} />, "Pronouns", pr.pronouns]);
  if (email) rows.push([<IconMail key="e" size={20} />, "Email", <a key="el" className="pm-link" href={"mailto:" + email}>{email}</a>]);
  if (phone) rows.push([<IconPhone key="ph" size={20} />, "Phone", <a key="pl" className="pm-link" href={"tel:" + phone}>{phone}</a>]);
  if (pr.timezone) rows.push([<IconClock key="z" size={20} />, "Time zone", pr.timezone]);
  const peerId = info.id;
  return (
    <>
      {rows.length ? <h3 className="pm-h">About</h3> : null}
      {rows.map(([ic, l, v], i) => (
        <div className="pm-row" key={i}>
          <span className="pm-row-ico">{ic}</span>
          <div><div className="pm-row-lbl">{l}</div><div>{v}</div></div>
        </div>
      ))}
      {files === null || files.length || links.length ? (
        <>
          <h3 className="pm-h">Attachments</h3>
          {files === null ? <div className="pm-empty">Loading…</div> : null}
          {images.length ? (
            <>
              <div className="pm-row-lbl">Images ({images.length})</div>
              <div className="info-media-strip pm-media">
                {images.slice(0, 6).map((f: any, i: number, arr: any[]) => (
                  <InfoMediaTile key={f.id || f.messageId || i} file={f} token={token} onOpen={() => openTab("files")}
                    more={i === arr.length - 1 && images.length > arr.length ? images.length - arr.length : 0} />
                ))}
              </div>
            </>
          ) : null}
          {docs.length ? (
            <>
              <div className="pm-row-lbl" style={{ marginTop: 10 }}>Files ({docs.length})</div>
              {docs.slice(0, 5).map((f: any, i: number) => (
                <button key={f.id || i} className="pm-file" onClick={() => openTab("files")}>
                  <FileExtAvatar name={fileName(f)} size={30} radius={8} /><span className="pm-file-n">{fileName(f)}</span><span className="pm-file-s">{fileSize(f)}</span>
                </button>
              ))}
              {docs.length > 5 ? <button className="pm-more" onClick={() => openTab("files")}>View all files</button> : null}
            </>
          ) : null}
          {links.length ? (
            <button className="pm-file" style={{ marginTop: 6 }} onClick={() => openTab("links")}>
              <IconLink size={18} /><span className="pm-file-n">Links</span><span className="pm-file-s">{links.length}</span>
            </button>
          ) : null}
        </>
      ) : null}
      <h3 className="pm-h">Settings</h3>
      {onMute ? (
        <button className="info-toggle-row pm-set" onClick={() => onMute(conversation.id, !conversation.muted)} aria-pressed={!!conversation.muted}>
          <span className="info-toggle-l"><IconBell className="info-about-i" /><span>Mute notifications</span></span>
          <span className={"info-switch" + (conversation.muted ? " on" : "")}><span className="info-switch-k" /></span>
        </button>
      ) : null}
      {peerBlocked ? (
        <button className="info-danger-row pm-set" onClick={() => onUnblockUser && onUnblockUser(peerId)}>
          <IconCircleCheck className="info-about-i" /><span>Unblock user</span>
        </button>
      ) : (
        <button className="info-danger-row pm-set" onClick={async () => {
          if (!(await confirmDialog(`Block ${info.name || "this person"}? You won't be able to message or call each other.`, { title: "Block user", confirmText: "Block", danger: true }))) return;
          if (onBlockUser) onBlockUser(peerId); else api.blockUser(token, peerId).catch(() => {});
        }}>
          <IconBan className="info-about-i" /><span>Block user</span>
        </button>
      )}
      <E2EEConversationSection conversation={conversation} meId={meId} token={token} />
    </>
  );
}

export default function ProfileModal({
  info,
  onClose,
  onChat,
  onCall,
  dm,
}: {
  info: any;
  onClose: () => void;
  onChat?: (info: any) => void;
  onCall?: (person: any, video: boolean) => void;
  /** 1:1 chat state — adds About / Mute / Block / encryption to the modal. */
  dm?: any;
}) {
  const [tab, setTab] = useState<"overview" | "contact">("overview");
  const [more, setMore] = useState(false);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        onClose();
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [onClose]);

  if (typeof document === "undefined" || !info) return null;

  const status = info.statusText || personPresenceLabel(info.presence) || "";
  const hasContact = !!(info.email || info.phone);

  const contactRows = (
    <>
      {info.email ? (
        <div className="pm-row">
          <span className="pm-row-ico"><IconMail size={20} /></span>
          <div>
            <div className="pm-row-lbl">Email</div>
            <a className="pm-link" href={"mailto:" + info.email}>{info.email}</a>
          </div>
        </div>
      ) : null}
      {info.phone ? (
        <div className="pm-row">
          <span className="pm-row-ico"><IconPhone size={20} /></span>
          <div>
            <div className="pm-row-lbl">Phone</div>
            <a className="pm-link" href={"tel:" + info.phone}>{info.phone}</a>
          </div>
        </div>
      ) : null}
      {!hasContact ? <div className="pm-empty">No contact information available.</div> : null}
    </>
  );

  return createPortal(
    <div className="pm-overlay" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="pm-card" role="dialog" aria-modal="true" aria-label={info.name + " profile"}>
        <button className="pm-close" aria-label="Close" onClick={onClose}>
          <IconX size={20} />
        </button>

        <div className="pm-head">
          <div className="pm-avatar">
            <Avatar
              avatar={{ kind: "user", initials: info.initials, color: info.color, avatarUrl: info.avatarUrl }}
              size={104}
            />
            {info.presence ? <span className={"pm-pdot sd " + presenceDotClass(info.presence)} /> : null}
          </div>
          <div className="pm-id">
            <h2 className="pm-name">{info.name}</h2>
            <div className="pm-actions">
              {onChat ? (
                <button className="pm-act" title="Chat" aria-label="Chat" onClick={() => onChat(info)}>
                  <IconMessageCircle size={22} />
                </button>
              ) : null}
              {onCall ? (
                <>
                  <button className="pm-act" title="Video call" aria-label="Video call" onClick={() => onCall(info, true)}>
                    <IconVideo size={22} />
                  </button>
                  <button className="pm-act" title="Call" aria-label="Call" onClick={() => onCall(info, false)}>
                    <IconPhone size={22} />
                  </button>
                </>
              ) : null}
            </div>
          </div>
        </div>

        <div className="pm-tabs" role="tablist">
          <button role="tab" aria-selected={tab === "overview"} className={"pm-tab" + (tab === "overview" ? " on" : "")} onClick={() => setTab("overview")}>Overview</button>
          <button role="tab" aria-selected={tab === "contact"} className={"pm-tab" + (tab === "contact" ? " on" : "")} onClick={() => setTab("contact")}>Contact</button>
        </div>

        <div className="pm-body">
          {tab === "overview" ? (
            <>
              {status ? (
                <div className="pm-status">
                  <PresenceStatusIcon presence={info.presence} size={22} />
                  <span>{status}</span>
                </div>
              ) : null}
              {dm ? null : (
                <>
                  <h3 className="pm-h">Contact information</h3>
                  {contactRows}
                </>
              )}
              {info.memberRole ? (
                <>
                  <button className="pm-more" onClick={() => setMore((v) => !v)}>
                    {more ? "Show less contact information" : "Show more contact information"}
                  </button>
                  {more ? (
                    <div className="pm-row">
                      <div>
                        <div className="pm-row-lbl">Role</div>
                        <div>{String(info.memberRole).charAt(0).toUpperCase() + String(info.memberRole).slice(1)}</div>
                      </div>
                    </div>
                  ) : null}
                </>
              ) : null}
              {dm ? <DmExtras s={dm} info={info} onClose={onClose} /> : null}
            </>
          ) : (
            <>
              <h3 className="pm-h">Contact information</h3>
              {contactRows}
              {info.memberRole ? (
                <div className="pm-row">
                  <div>
                    <div className="pm-row-lbl">Role</div>
                    <div>{String(info.memberRole).charAt(0).toUpperCase() + String(info.memberRole).slice(1)}</div>
                  </div>
                </div>
              ) : null}
            </>
          )}
        </div>
      </div>
    </div>,
    document.body,
  );
}
