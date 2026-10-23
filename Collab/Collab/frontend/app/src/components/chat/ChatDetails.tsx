// ChatDetails.tsx — ChatView render shell (mechanical extraction from ChatView.tsx).
// Do not hand-edit beyond imports.

import { IconBan, IconBell, IconBriefcase, IconCamera, IconCircleCheck, IconClock, IconFile, IconInfo, IconMail, IconPencil, IconPhone, IconUser, IconVideo, IconX } from "../../lib/icons";
import Avatar from "../Avatar";
import E2EEConversationSection from "../E2EEConversationSection";
import { dotClass } from "./helpers";
import { api } from "../../lib/api";
import { confirmDialog } from "../../lib/dialog";
import { mimeOf } from "../../lib/desktopFiles";
import InfoPanelSearch from "./InfoPanelSearch";
import { InfoMediaTile } from "./FileAttachment";
import { fileKeyIndex, withFileKeys } from "../../lib/fileThumbs";

export default function ChatDetails({ s }: { s: any }) {
  const {
    convAvatarRef, conversation, editAbout, editDesc,
    editName, editSelfName, infoFiles, infoLinks,
    infoMembers, infoOpen, infoRender, isGroupish,
    me, meId, messages, mgmtLeave,
    mgmtRemove, mgmtRole, note, onAddParticipants,
    onBlockUser, onLeaveConversation, onMute, onOpenSettings,
    onRemoveMember, onSelectPerson, onSetMemberRole, onStartCall,
    onUnblockUser, onUpdateConversation, onUpdateProfile, peerBlocked,
    people, setConvAvatarCropFile, setEditAbout, setEditDesc,
    setEditName, setEditSelfName, setInfoOpen, setTab,
    shown, sub, text, token, jumpToMessage, infoMode
  } = s;

  if (!conversation) return null;
  // Search icon → search-only panel; group name → full details. 1:1 chats only ever get search.
  const searchOnly =
    conversation.kind !== "self" && (conversation.kind === "dm" || infoMode !== "details");

  return (
    infoRender ? (
          <aside
            className={"info-panel" + (infoOpen ? " open" : " closing") + (searchOnly ? " info-dm" : "")}
            role="complementary"
            aria-label="Conversation details"
          >
            <div className="info-inner">
              <div className="info-head">
                <div className="info-head-t">{searchOnly ? "Search" : "Details"}</div>
                <button
                  className="info-close"
                  aria-label="Close details"
                  onClick={() => setInfoOpen(false)}
                >
                  <IconX />
                </button>
              </div>
              <div className="info-body">
                {searchOnly ? (
                  <InfoPanelSearch
                    messages={messages}
                    infoFiles={infoFiles}
                    infoLinks={infoLinks}
                    onJump={(id) => jumpToMessage && jumpToMessage(id)}
                    onOpenTab={(t) => t && setTab(t)}
                  />
                ) : null}
                {(() => {
                  const isGroupish2 =
                    conversation?.kind === "group" ||
                    conversation?.kind === "channel";
                  const myMember = Array.isArray(infoMembers)
                    ? infoMembers.find((m: any) => m.id === meId)
                    : null;
                  // Role may come from the freshly-fetched member list OR, before
                  // that arrives (e.g. a brand-new call-created group whose members
                  // aren't cached yet), from the conversation object the sidebar
                  // already carries. The creator can always edit. Without these
                  // fallbacks, call-created groups showed no rename/avatar controls
                  // because infoMembers was still null when the panel opened.
                  const myRole =
                    (myMember && myMember.memberRole) ||
                    conversation?.memberRole ||
                    null;
                  const canEdit =
                    isGroupish2 &&
                    (myRole === "owner" ||
                      myRole === "admin" ||
                      (!!conversation?.createdBy &&
                        !!meId &&
                        conversation.createdBy === meId));
                  return (
                    <div className="info-id">
                      <div className="info-av-wrap">
                        <Avatar avatar={conversation?.avatar} size={72} />
                        {canEdit || conversation?.kind === "self" ? (
                          <>
                            <button
                              className="info-av-edit"
                              title="Change picture"
                              onClick={() =>
                                convAvatarRef.current &&
                                convAvatarRef.current.click()
                              }
                            >
                              <IconCamera size={14} />
                            </button>
                            <input
                              ref={convAvatarRef}
                              type="file"
                              accept="image/*"
                              style={{ display: "none" }}
                              onChange={(e) => {
                                const f = e.target.files && e.target.files[0];
                                if (e.target) e.target.value = "";
                                if (!f) return;
                                // Open the cropper; the actual upload happens on
                                // confirm (branch self vs group there).
                                setConvAvatarCropFile(f);
                              }}
                            />
                          </>
                        ) : null}
                      </div>
                      {canEdit && editName !== null ? (
                        <input
                          className="info-name-edit"
                          autoFocus
                          value={editName}
                          maxLength={60}
                          onChange={(e) => setEditName(e.target.value)}
                          onBlur={() => {
                            const v = editName.trim();
                            if (
                              v &&
                              v !== conversation.name &&
                              onUpdateConversation
                            )
                              onUpdateConversation(conversation.id, { title: v });
                            setEditName(null);
                          }}
                          onKeyDown={(e) => {
                            if (e.key === "Enter")
                              (e.target as HTMLInputElement).blur();
                            if (e.key === "Escape") setEditName(null);
                          }}
                        />
                      ) : (
                        <div
                          className="info-name"
                          onClick={() => {
                            if (canEdit) setEditName(conversation.name || "");
                          }}
                          style={canEdit ? { cursor: "text" } : undefined}
                          title={canEdit ? "Click to rename" : undefined}
                        >
                          {conversation.name}
                          {canEdit ? (
                            <IconPencil
                              size={13}
                              style={{
                                marginLeft: 6,
                                opacity: 0.5,
                                verticalAlign: "middle",
                              }}
                            />
                          ) : null}
                        </div>
                      )}
                      <div className="info-sub">{sub}</div>
                      {isGroupish2 ? (
                        canEdit && editDesc !== null ? (
                          <textarea
                            className="info-desc-edit"
                            autoFocus
                            value={editDesc}
                            maxLength={500}
                            placeholder="Add a description…"
                            rows={2}
                            onChange={(e) => setEditDesc(e.target.value)}
                            onBlur={() => {
                              if (
                                editDesc !== (conversation.description || "") &&
                                onUpdateConversation
                              )
                                onUpdateConversation(conversation.id, {
                                  description: editDesc,
                                });
                              setEditDesc(null);
                            }}
                          />
                        ) : (
                          <div
                            className="info-desc"
                            onClick={() => {
                              if (canEdit)
                                setEditDesc(conversation.description || "");
                            }}
                            style={canEdit ? { cursor: "text" } : undefined}
                            title={
                              canEdit ? "Click to edit description" : undefined
                            }
                          >
                            {conversation.description ||
                              (canEdit ? "Add a description…" : "")}
                          </div>
                        )
                      ) : null}
                    </div>
                  );
                })()}
                {conversation?.kind !== "self" ? (
                  <div className="info-actions">
                    {onStartCall ? (
                      // Hidden in the in-call sidebar (no onStartCall) — already in a call.
                      <>
                        <button
                          className="info-act"
                          onClick={() => onStartCall(false)}
                        >
                          <IconPhone size={20} />
                          <span>Audio</span>
                        </button>
                        <button
                          className="info-act"
                          onClick={() => onStartCall(true)}
                        >
                          <IconVideo size={20} />
                          <span>Video</span>
                        </button>
                      </>
                    ) : null}
                    <button className="info-act" onClick={() => setTab("files")}>
                      <IconFile />
                      <span>Files</span>
                    </button>
                  </div>
                ) : (
                  <>
                    <div className="info-note">
                      Your personal space — notes, saved messages, and drafts that
                      only you can see.
                    </div>
                    {/* Edit your own profile right here in your personal space. */}
                    <div className="info-section">
                      <div className="info-section-h">
                        <span>About</span>
                        {editAbout === null ? (
                          <button
                            className="info-edit-link"
                            onClick={() => setEditAbout((me && me.about) || "")}
                          >
                            Edit
                          </button>
                        ) : null}
                      </div>
                      {editAbout !== null ? (
                        <div
                          style={{
                            display: "flex",
                            flexDirection: "column",
                            gap: 8,
                          }}
                        >
                          <textarea
                            autoFocus
                            value={editAbout}
                            maxLength={300}
                            rows={3}
                            onChange={(e) => setEditAbout(e.target.value)}
                            placeholder="Tell people a bit about yourself…"
                            style={{
                              width: "100%",
                              boxSizing: "border-box",
                              padding: "10px 12px",
                              border: "1px solid var(--g200)",
                              borderRadius: 10,
                              background: "var(--sb)",
                              fontSize: 13,
                              lineHeight: 1.5,
                              resize: "vertical",
                              minHeight: 72,
                              outline: "none",
                              color: "var(--g900)",
                            }}
                          />
                          <div style={{ display: "flex", gap: 8 }}>
                            <button
                              onClick={() => {
                                if (onUpdateProfile)
                                  onUpdateProfile({ about: editAbout });
                                setEditAbout(null);
                              }}
                              style={{
                                height: 30,
                                padding: "0 14px",
                                fontSize: 12.5,
                                fontWeight: 600,
                                borderRadius: 8,
                                border: "none",
                                background: "var(--brand-cta-gradient)",
                                color: "#fff",
                                cursor: "pointer",
                              }}
                            >
                              Save
                            </button>
                            <button
                              onClick={() => setEditAbout(null)}
                              style={{
                                height: 30,
                                padding: "0 12px",
                                fontSize: 12.5,
                                fontWeight: 600,
                                borderRadius: 8,
                                border: "1px solid var(--g200)",
                                background: "var(--sb)",
                                color: "var(--g700)",
                                cursor: "pointer",
                              }}
                            >
                              Cancel
                            </button>
                          </div>
                        </div>
                      ) : (
                        <button
                          onClick={() => setEditAbout((me && me.about) || "")}
                          title="Edit your about"
                          style={{
                            display: "block",
                            width: "100%",
                            textAlign: "left",
                            padding: "6px 0",
                            border: "none",
                            background: "transparent",
                            fontSize: 13,
                            lineHeight: 1.5,
                            color: me && me.about ? "var(--g700)" : "var(--g400)",
                            cursor: "pointer",
                          }}
                        >
                          {(me && me.about) || "Add something about yourself…"}
                        </button>
                      )}
                    </div>
                    {/* Display name — inline edit (mirrors About) so the core profile
                      fields are editable right here, matching Settings → Profile. */}
                    <div className="info-section">
                      <div className="info-section-h">
                        <span>Display name</span>
                        {editSelfName === null ? (
                          <button
                            className="info-edit-link"
                            onClick={() => setEditSelfName((me && me.name) || "")}
                          >
                            Edit
                          </button>
                        ) : null}
                      </div>
                      {editSelfName !== null ? (
                        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                          <input
                            autoFocus
                            value={editSelfName}
                            maxLength={80}
                            onChange={(e) => setEditSelfName(e.target.value)}
                            placeholder="Your name"
                            style={{
                              width: "100%",
                              boxSizing: "border-box",
                              padding: "10px 12px",
                              border: "1px solid var(--g200)",
                              borderRadius: 10,
                              background: "var(--sb)",
                              fontSize: 13,
                              outline: "none",
                              color: "var(--g900)",
                            }}
                          />
                          <div style={{ display: "flex", gap: 8 }}>
                            <button
                              onClick={() => {
                                const nm = (editSelfName || "").trim();
                                if (nm && onUpdateProfile) onUpdateProfile({ name: nm });
                                setEditSelfName(null);
                              }}
                              style={{
                                height: 30,
                                padding: "0 14px",
                                fontSize: 12.5,
                                fontWeight: 600,
                                borderRadius: 8,
                                border: "none",
                                background: "var(--brand-cta-gradient)",
                                color: "#fff",
                                cursor: "pointer",
                              }}
                            >
                              Save
                            </button>
                            <button
                              onClick={() => setEditSelfName(null)}
                              style={{
                                height: 30,
                                padding: "0 12px",
                                fontSize: 12.5,
                                fontWeight: 600,
                                borderRadius: 8,
                                border: "1px solid var(--g200)",
                                background: "var(--sb)",
                                color: "var(--g700)",
                                cursor: "pointer",
                              }}
                            >
                              Cancel
                            </button>
                          </div>
                        </div>
                      ) : (
                        <button
                          onClick={() => setEditSelfName((me && me.name) || "")}
                          title="Edit your display name"
                          style={{
                            display: "block",
                            width: "100%",
                            textAlign: "left",
                            padding: "6px 0",
                            border: "none",
                            background: "transparent",
                            fontSize: 13,
                            lineHeight: 1.5,
                            color: me && me.name ? "var(--g700)" : "var(--g400)",
                            cursor: "pointer",
                          }}
                        >
                          {(me && me.name) || "Add your name…"}
                        </button>
                      )}
                    </div>
                    {/* Photo, job title, pronouns, phone, timezone live in the full
                      editor — one tap away, same fields as this panel. */}
                    {onOpenSettings ? (
                      <button
                        className="info-edit-link"
                        onClick={() => onOpenSettings()}
                        style={{
                          marginTop: 6,
                          padding: "6px 0",
                          background: "transparent",
                          border: "none",
                          cursor: "pointer",
                          fontWeight: 600,
                        }}
                      >
                        Edit full profile in Settings →
                      </button>
                    ) : null}
                  </>
                )}

                {(() => {
                  // 1:1 details panel is search + shared media only — no About block.
                  const peer = null as any;
                  void infoMembers;
                  const _unusedPeer =
                    conversation?.kind === "dm" && Array.isArray(infoMembers)
                      ? infoMembers.find((p: any) => p.id !== meId) || null
                      : null;
                  if (
                    !peer ||
                    !(
                      peer.about ||
                      peer.title ||
                      peer.email ||
                      peer.pronouns ||
                      peer.phone ||
                      peer.timezone
                    )
                  )
                    return null;
                  return (
                    <div className="info-section">
                      <div className="info-section-h">
                        <span>About</span>
                      </div>
                      {peer.about ? (
                        <div className="info-about-row">
                          <IconInfo className="info-about-i" />
                          <span>{peer.about}</span>
                        </div>
                      ) : null}
                      {peer.title ? (
                        <div className="info-about-row">
                          <IconBriefcase className="info-about-i" />
                          <span>{peer.title}</span>
                        </div>
                      ) : null}
                      {peer.pronouns ? (
                        <div className="info-about-row">
                          <IconUser className="info-about-i" />
                          <span>{peer.pronouns}</span>
                        </div>
                      ) : null}
                      {peer.email ? (
                        <div className="info-about-row">
                          <IconMail className="info-about-i" />
                          <a
                            className="info-about-link"
                            href={"mailto:" + peer.email}
                          >
                            {peer.email}
                          </a>
                        </div>
                      ) : null}
                      {peer.phone ? (
                        <div className="info-about-row">
                          <IconPhone className="info-about-i" />
                          <a
                            className="info-about-link"
                            href={"tel:" + peer.phone}
                          >
                            {peer.phone}
                          </a>
                        </div>
                      ) : null}
                      {peer.timezone ? (
                        <div className="info-about-row">
                          <IconClock className="info-about-i" />
                          <span>{peer.timezone}</span>
                        </div>
                      ) : null}
                    </div>
                  );
                })()}

                {conversation?.kind !== "self" && conversation?.kind !== "dm" ? (
                  <div className="info-section">
                    <div className="info-section-h">
                      <span>Media, files &amp; links</span>
                    </div>
                    {infoFiles === null ? (
                      <div className="info-empty">Loading…</div>
                    ) : infoFiles.length || (infoLinks && infoLinks.length) ? (
                      <>
                        {infoFiles.length
                          ? (() => {
                            // Media (images/videos) float to the front so the strip
                            // leads with real thumbnails; documents follow.
                            const isMedia = (f: any) =>
                              /^(image|video)\//.test(mimeOf(f));
                            const idx = fileKeyIndex(messages);
                            const ordered = infoFiles
                              .map((f: any) => withFileKeys(f, idx))
                              .sort(
                              (a: any, b: any) =>
                                (isMedia(b) ? 1 : 0) - (isMedia(a) ? 1 : 0),
                            );
                            const shown = ordered.slice(0, 6);
                            const extra = infoFiles.length - shown.length;
                            return (
                              <div className="info-media-strip">
                                {shown.map((f: any, i: number) => (
                                  <InfoMediaTile
                                    key={f.id || f.messageId || i}
                                    file={f}
                                    token={token}
                                    onOpen={() => setTab("files")}
                                    more={
                                      i === shown.length - 1 && extra > 0
                                        ? extra
                                        : 0
                                    }
                                  />
                                ))}
                              </div>
                            );
                          })()
                          : null}
                        <button
                          className="info-row-link"
                          onClick={() => setTab("files")}
                        >
                          <span>Files</span>
                          <span className="info-row-count">
                            {infoFiles.length}
                          </span>
                        </button>
                        <button
                          className="info-row-link"
                          onClick={() => setTab("links")}
                        >
                          <span>Links</span>
                          <span className="info-row-count">
                            {infoLinks ? infoLinks.length : 0}
                          </span>
                        </button>
                      </>
                    ) : (
                      <div className="info-empty">
                        No media, files or links shared yet.
                      </div>
                    )}
                  </div>
                ) : null}

                {conversation?.kind !== "self" && conversation?.kind !== "dm" && onMute ? (
                  <div className="info-section">
                    <button
                      className="info-toggle-row"
                      onClick={() => onMute(conversation.id, !conversation.muted)}
                      aria-pressed={!!conversation.muted}
                    >
                      <span className="info-toggle-l">
                        <IconBell className="info-about-i" />
                        <span>Mute notifications</span>
                      </span>
                      <span
                        className={
                          "info-switch" + (conversation.muted ? " on" : "")
                        }
                      >
                        <span className="info-switch-k" />
                      </span>
                    </button>
                  </div>
                ) : null}

                {false && conversation?.kind === "dm"
                  ? (() => {
                    const peerId = (conversation?.members || []).find(
                      (m: string) => m !== meId,
                    );
                    if (!peerId) return null;
                    return (
                      <div className="info-section">
                        {peerBlocked ? (
                          <button
                            className="info-danger-row"
                            onClick={() => {
                              if (onUnblockUser) onUnblockUser(peerId);
                            }}
                          >
                            <IconCircleCheck className="info-about-i" />
                            <span>Unblock user</span>
                          </button>
                        ) : (
                          <button
                            className="info-danger-row"
                            onClick={async () => {
                              if (
                                !(await confirmDialog(
                                  `Block ${conversation.name || "this person"}? You won't be able to message or call each other.`,
                                  { title: "Block user", confirmText: "Block", danger: true },
                                ))
                              )
                                return;
                              // Routed through the parent so blocked state updates and
                              // the composer immediately becomes the unblock banner.
                              if (onBlockUser) onBlockUser(peerId);
                              else {
                                api.blockUser(token, peerId).catch(() => { });
                              }
                            }}
                          >
                            <IconBan className="info-about-i" />
                            <span>Block user</span>
                          </button>
                        )}
                        {/* Report user button hidden as requested */}
                        {/* <button
                      className="info-danger-row"
                      onClick={() => {
                        const reason = window.prompt("Report this user — describe the issue (optional):", "");
                        if (reason === null) return;
                        const alsoBlock = !peerBlocked && window.confirm("Report submitted. Also block this user so they can't contact you?");
                        if (onReportUser) onReportUser(peerId, reason, alsoBlock);
                        else { api.reportUser(token, peerId, reason).catch(() => {}); showToast && showToast("Report submitted. Thank you."); }
                      }}
                    >
                      <svg viewBox="0 0 24 24" className="info-about-i"><path d="M4 15s1-1 4-1 5 2 8 2 4-1 4-1V3s-1 1-4 1-5-2-8-2-4 1-4 1z" /><line x1="4" y1="22" x2="4" y2="15" /></svg>
                      <span>Report user</span>
                    </button> */}
                      </div>
                    );
                  })()
                  : null}

                {isGroupish
                  ? (() => {
                    const myRole = Array.isArray(infoMembers)
                      ? infoMembers.find((m: any) => m.id === meId)
                        ?.memberRole || "member"
                      : "member";
                    const canManage = myRole === "owner" || myRole === "admin";
                    const roleLabel = (r: string) =>
                      r === "owner" ? "Owner" : r === "admin" ? "Admin" : "";
                    return (
                      <div className="info-section">
                        <div className="info-section-h">
                          <span>{conversation.memberCount} members</span>
                          {onAddParticipants && canManage ? (
                            <button
                              className="info-add"
                              onClick={onAddParticipants}
                            >
                              Add
                            </button>
                          ) : null}
                        </div>
                        <div className="info-members">
                          {infoMembers === null ? (
                            <div className="info-empty">Loading…</div>
                          ) : infoMembers.length ? (
                            infoMembers.map((p: any) => {
                              const pr = p.memberRole || "member";
                              // Owner manages everyone; admin manages plain members only.
                              const canManageThis =
                                canManage &&
                                p.id !== meId &&
                                pr !== "owner" &&
                                !(pr === "admin" && myRole !== "owner");
                              return (
                                <div className="info-member" key={p.id}>
                                  <div className="ca-wrap">
                                    <Avatar
                                      avatar={{
                                        kind: "user",
                                        initials: p.initials,
                                        color: p.color,
                                        avatarUrl: p.avatarUrl,
                                      }}
                                      size={30}
                                    />
                                    {p.presence ? (
                                      <span
                                        className={"sd " + dotClass(p.presence)}
                                      />
                                    ) : null}
                                  </div>
                                  <span className="info-member-n">
                                    {p.name}
                                    {p.id === meId ? " (you)" : ""}
                                  </span>
                                  {roleLabel(pr) ? (
                                    <span className="info-member-r">
                                      {roleLabel(pr)}
                                    </span>
                                  ) : null}
                                  {p.id !== meId && onSelectPerson ? (
                                    <button
                                      className="info-member-msg"
                                      onClick={() => onSelectPerson(p.id)}
                                      title="Message"
                                    >
                                      <svg
                                        viewBox="0 0 24 24"
                                        style={{
                                          width: 14,
                                          height: 14,
                                          stroke: "currentColor",
                                          fill: "none",
                                          strokeWidth: 2,
                                        }}
                                      >
                                        <path d="M21 11.5a8.38 8.38 0 01-.9 3.8 8.5 8.5 0 01-7.6 4.7 8.38 8.38 0 01-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 01-.9-3.8 8.5 8.5 0 014.7-7.6 8.38 8.38 0 013.8-.9h.5a8.48 8.48 0 018 8v.5z" />
                                      </svg>
                                    </button>
                                  ) : null}
                                  {canManageThis ? (
                                    <div className="info-member-acts">
                                      {pr === "member" && onSetMemberRole ? (
                                        <button
                                          className="info-member-act"
                                          onClick={() =>
                                            mgmtRole(p.id, "admin")
                                          }
                                          title="Make admin"
                                        >
                                          Make admin
                                        </button>
                                      ) : null}
                                      {pr === "admin" &&
                                        myRole === "owner" &&
                                        onSetMemberRole ? (
                                        <button
                                          className="info-member-act"
                                          onClick={() =>
                                            mgmtRole(p.id, "member")
                                          }
                                          title="Remove admin"
                                        >
                                          Remove admin
                                        </button>
                                      ) : null}
                                      {onRemoveMember ? (
                                        <button
                                          className="info-member-act danger"
                                          onClick={() =>
                                            mgmtRemove(p.id, p.name)
                                          }
                                          title="Remove from group"
                                        >
                                          Remove
                                        </button>
                                      ) : null}
                                    </div>
                                  ) : null}
                                </div>
                              );
                            })
                          ) : (
                            <div className="info-empty">No members.</div>
                          )}
                        </div>
                        {onLeaveConversation ? (
                          <button
                            className="info-leave"
                            onClick={() => mgmtLeave()}
                          >
                            Leave{" "}
                            {conversation?.kind === "channel"
                              ? "channel"
                              : "group"}
                          </button>
                        ) : null}
                      </div>
                    );
                  })()
                  : null}
                {conversation?.kind !== "dm" ? <E2EEConversationSection
                  conversation={conversation}
                  meId={meId}
                  token={token}
                /> : null}
              </div>
            </div>
            {/* /.info-inner */}
          </aside>
    ) : null
  );
}
