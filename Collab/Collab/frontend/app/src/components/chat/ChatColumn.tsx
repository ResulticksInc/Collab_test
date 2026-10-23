// ChatColumn.tsx — ChatView render shell (mechanical extraction from ChatView.tsx).
// Do not hand-edit beyond imports.

import ChatMainPane from "./ChatMainPane";
import { IconCalendarDays, IconCamera, IconExternalLink, IconFile, IconLink, IconPhone, IconSearch, IconSparkles, IconUser, IconUserPlus, IconVideo, IconX } from "../../lib/icons";
import Avatar from "../Avatar";
import FloatingMenu from "../FloatingMenu";
import { dotClass } from "./helpers";
import { isDesktopApp } from "../../lib/platform";
import config from "../../lib/config";
import PeoplePopover from "./PeoplePopover";
import { UrlLightbox } from "./MediaAlbum";

export default function ChatColumn({ s }: { s: any }) {
  const {
    TABS, aiLoading, chatGsQuery, chatGsScope,
    chatSearchOpen, chatSearchRef, conversation, dmPeerInfo,
    embedded, handleAvatarEnter, handleAvatarLeave, huddle,
    imgViewer, inHuddle, isGroupish, me,
    messages, note, offlineDemo, onAddParticipants,
    onBack, onGlobalSearchScope, onJoinHuddle, onManageConversation,
    onOpenBookmarks, onScheduleMeeting, onStartCall, people,
    presence, runSummary, setChatGsQuery, setChatGsScope,
    setChatSearchOpen, setImgViewer, setInQuery, setInSearch,
    setInfoOpen, setTab, shown, sub,
    tab, setProfileModal, setInfoMode
  } = s;

  return (
    <div className="cv-col">
      {/* Header */}
      <div className={"ch" + (chatSearchOpen ? " searching" : "")}>
        {/* Desktop pop-out only: this chat header is the topmost band and
              carries the -webkit-app-region:drag region. The window-control pills
              live in a separate subtree (<DesktopChrome>), so their no-drag can't
              carve out of it — without this rect their clicks are swallowed as
              title-bar drags and close/minimize/maximize do nothing. Hidden
              everywhere except an os-win pop-out; pointer-events:none so it only
              affects the OS drag region, never a DOM click. */}
        <div className="ch-winspace" aria-hidden />
        <div className="ch-left">
          {isGroupish && onManageConversation ? (
            // Group/channel: clicking the avatar opens the Manage modal (rename /
            // picture / description). The name still opens the details panel.
            <button
              className="ch-av-btn"
              onClick={() => onManageConversation(conversation?.id)}
              data-tip="Edit picture, name & description"
              aria-label="Manage group"
            >
              <div className="ca-wrap">
                <Avatar avatar={conversation?.avatar} size={40} />
                <span className="ch-av-edit" aria-hidden="true">
                  <IconCamera size={10} />
                </span>
              </div>
            </button>
          ) : null}
          <button
            className="ch-id"
            onClick={() =>
              // 1:1 chat: the header profile opens the full profile modal (same as a
              // group member's). The side panel is opened by the search icon.
              dmPeerInfo && setProfileModal
                ? setProfileModal(dmPeerInfo)
                : (setInfoMode && setInfoMode("details"), setInfoOpen((o) => !o))
            }
            aria-label={dmPeerInfo ? "Open profile" : "Open conversation details"}
          >
            {!(isGroupish && onManageConversation) ? (
              <div
                className="ca-wrap"
                // In a DM, hovering the header avatar shows the peer's profile card
                // (Teams-style). Click still opens conversation details (parent btn).
                onMouseEnter={
                  dmPeerInfo
                    ? (e) =>
                      handleAvatarEnter(
                        dmPeerInfo,
                        e.currentTarget as HTMLElement,
                      )
                    : undefined
                }
                onMouseLeave={dmPeerInfo ? handleAvatarLeave : undefined}
              >
                <Avatar avatar={conversation?.avatar} size={40} />
                {conversation?.avatar?.kind === "user" &&
                  (conversation?.kind === "self" ? presence : conversation?.presence) ? (
                  <span
                    className={
                      "sd " +
                      dotClass(
                        conversation?.kind === "self"
                          ? presence
                          : conversation?.presence,
                      )
                    }
                  />
                ) : null}
              </div>
            ) : null}
            <div className="ch-inf">
              <div className="ch-nm">{conversation?.name}</div>
              <div className="ch-sb">
                {sub}
                {offlineDemo ? " · demo (offline)" : ""}
              </div>
            </div>
          </button>
        </div>
        {/* Progressive inline Global Search: the header's flexible middle space
              BECOMES the search bar (input + inline scope chips) on the SAME row —
              no dropdown, no floating panel, no extra row. "Chat" hands off to
              in-conversation search (no navigation); every other scope defers to
              onGlobalSearchScope. Collapses back to the Search icon on close. */}
        {chatSearchOpen ? (
          <div className="chsr-inline" ref={chatSearchRef} role="search">
            <IconSearch size={16} className="chsr-inline-ico" />
            <input
              autoFocus
              className="chsr-inline-input"
              value={chatGsQuery}
              onChange={(e) => setChatGsQuery(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Escape") setChatSearchOpen(false);
                if (e.key === "Enter") {
                  e.preventDefault();
                  // Enter uses the SELECTED scope (default All → global search).
                  // Only the Chat scope stays in-conversation.
                  setChatSearchOpen(false);
                  if (chatGsScope === "chats" || chatGsScope === "") {
                    // "Find in chat" (or nothing picked) → search THIS conversation.
                    setInQuery(chatGsQuery);
                    setInSearch(true);
                  } else if (onGlobalSearchScope) {
                    // Item 1: "Calls" from inside a conversation (empty query)
                    // filters the Calls module to this conversation's calls.
                    onGlobalSearchScope(
                      chatGsScope,
                      chatGsScope === "calls" &&
                        !chatGsQuery.trim() &&
                        conversation?.kind !== "self"
                        ? conversation?.name || ""
                        : chatGsQuery,
                    );
                  }
                }
              }}
              placeholder="Search"
            />
            <button
              className="chsr-inline-x"
              onClick={() => setChatSearchOpen(false)}
              aria-label="Close search"
            >
              <IconX size={16} />
            </button>
            {/* Scope selector: the modules drop DOWN below the inline bar (the
                  "usual" Global Search dropdown), reusing .gx-menu-head / .gx-chips
                  / .gx-chip. Order: All first, Chat second, then the rest. */}
            <div className="chsr-drop" role="menu">
              <div className="gx-menu-head">Search in</div>
              <div className="gx-chips">
                {(
                  [
                    ["all", "All"],
                    ["chats", "Find in chat"],
                    ["calls", "Calls"],
                    ["contacts", "Contacts"],
                    ["calendar", "Calendar"],
                    ["activity", "Activity"],
                  ] as [string, string][]
                ).map(([k, label]) => (
                  <button
                    key={k}
                    type="button"
                    className={"gx-chip" + (chatGsScope === k ? " active" : "")}
                    onMouseDown={(e) => {
                      e.preventDefault();
                      setChatGsScope(k);
                      setChatSearchOpen(false);
                      if (k === "chats") {
                        // SPECIAL (Messaging only): Chat stays IN this
                        // conversation — hand off to the existing in-conversation
                        // search, NO navigation / route change / module switch.
                        setInQuery(chatGsQuery);
                        setInSearch(true);
                      } else if (onGlobalSearchScope) {
                        // Item 1: picking "Calls" from INSIDE a conversation (with
                        // no typed query) redirects to the Calls module filtered to
                        // THIS conversation's call log — seed the calls search with
                        // the conversation name (the Calls list filters on peer
                        // name). A typed query still searches by that text; the
                        // top-bar Calls chip (different module) passes no seed → all
                        // calls.
                        onGlobalSearchScope(
                          k,
                          k === "calls" &&
                            !chatGsQuery.trim() &&
                            conversation?.kind !== "self"
                            ? conversation?.name || ""
                            : chatGsQuery,
                        );
                      }
                    }}
                  >
                    {label}
                  </button>
                ))}
              </div>
            </div>
          </div>
        ) : null}
        <div className="ch-acts">
          {/* Teams-style: "Add people" lives in the header (people+ icon with the member
              count) instead of inside the ⋮ menu. */}
          {!embedded && isGroupish ? (
            <PeoplePopover s={s} />
          ) : null}
          {/* Search icon expands the inline bar above; hidden while it's open. */}
          {!chatSearchOpen ? (
            <button
              className="ab"
              aria-label="Search messages and people"
              data-tip="Search messages & people"
              onClick={() => {
                // 1:1 chat: the search icon opens the right-hand profile panel
                // (media, files, links & messages for this person).
                if (!embedded && conversation?.kind && conversation.kind !== "self") {
                  setInfoMode && setInfoMode("search");
                  setInfoOpen(true);
                  return;
                }
                // Fresh search each time: NOTHING pre-selected in the chat module
                // (the user picks "Find in chat" or another scope explicitly).
                // 1:1 chat: search lives in the right-hand details panel.
                if (dmPeerInfo) {
                  setInfoOpen(true);
                  return;
                }
                setChatGsScope("");
                setChatGsQuery("");
                setChatSearchOpen(true);
              }}
            >
              <IconSearch />
            </button>
          ) : null}
          {conversation?.kind !== "self" && onStartCall ? (
            // BA/CEO #13: a single "Call" button that opens an Audio / Video
            // choice, replacing the two separate call/video buttons.
            // Hidden when there's no onStartCall handler — the in-call
            // collaboration sidebar (embedded): you're already in a call, so
            // starting another from the chat header is meaningless.
            // Figma Chats header (116:2739): separate audio and video call
            // buttons again, replacing the single Call menu.
            <>
              <button
                className="ab"
                aria-label="Start audio call"
                data-tip="Audio call"
                onClick={() => onStartCall(false)}
              >
                <IconPhone size={18} />
              </button>
              <button
                className="ab"
                aria-label="Start video call"
                data-tip="Video call"
                onClick={() => onStartCall(true)}
              >
                <IconVideo size={18} />
              </button>
            </>
          ) : null}
          {/* Header ⋮ menu — HIDDEN in the in-call/meeting global chat sidebar
                (embedded): profile/bookmarks/files/schedule-meeting/etc. don't
                belong in the compact mid-call chat, matching the already-hidden
                call/video buttons above. */}
          {!embedded && (
            <FloatingMenu
              placement="bottom-end"
              trigger={
                <button className="ab" aria-label="More actions">
                  <svg viewBox="0 0 24 24">
                    <circle cx="12" cy="5" r="1.6" />
                    <circle cx="12" cy="12" r="1.6" />
                    <circle cx="12" cy="19" r="1.6" />
                  </svg>
                </button>
              }
              items={[
                {
                  label: "Bookmarks",
                  onClick: onOpenBookmarks,
                  icon: (
                    <svg
                      viewBox="0 0 24 24"
                      width="18"
                      height="18"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="1.5"
                    >
                      <path d="M19 21l-7-5-7 5V5a2 2 0 012-2h10a2 2 0 012 2z" />
                    </svg>
                  ),
                },
                {
                  label: "Open in new window",
                  onClick: () => {
                    // Desktop: real in-app pop-out (shares the session, already
                    // authenticated). Browser: keep the existing window.open.
                    const cd: any =
                      typeof window !== "undefined"
                        ? (window as any).collabDesktop
                        : null;
                    if (
                      isDesktopApp &&
                      cd &&
                      typeof cd.openPopout === "function"
                    ) {
                      try {
                        // ISSUE #9: popout=1 → single-conversation window.
                        cd.openPopout({
                          conversation: conversation.id,
                          popout: true,
                        });
                      } catch (_) { }
                      return;
                    }
                    try {
                      const u = new URL(window.location.href);
                      u.search =
                        "?conversation=" +
                        encodeURIComponent(conversation.id) +
                        "&popout=1";
                      window.open(
                        u.toString(),
                        "_blank",
                        "width=460,height=780",
                      );
                    } catch (_) { }
                  },
                  icon: (
                    <IconExternalLink size={18} />
                  ),
                },
                {
                  label: "Files",
                  onClick: () => setTab("files"),
                  icon: (
                    <IconFile size={18} />
                  ),
                },
                {
                  label: "Links",
                  onClick: () => setTab("links"),
                  icon: (
                    <IconLink size={18} />
                  ),
                },
                {
                  label: "Schedule meeting",
                  onClick: () => onScheduleMeeting && onScheduleMeeting(),
                  icon: (
                    <IconCalendarDays size={18} />
                  ),
                },
                ...(config.features.aiSummary
                  ? [
                    {
                      label: "Catch me up",
                      onClick: runSummary,
                      disabled: aiLoading,
                      icon: (
                        <IconSparkles size={18} />
                      ),
                    },
                  ]
                  : []),
              ]}
            />
          )}
          <button
            className="mobile-back"
            title="Back"
            aria-label="Back"
            onClick={onBack}
          >
            <IconX />

          </button>
        </div>
      </div>

      {/* Live-call header (Teams-style): sits right under the chat header on
            EVERY tab whenever this group/temp-group has a call in progress the
            viewer hasn't joined — kind-aware Lucide icon, who's on the call,
            and a prominent Join. */}
      {huddle && !inHuddle ? (
        <div className="huddle-banner" role="status">
          <span className="huddle-live-ic" aria-hidden="true">
            {huddle.kind === "video" ? (
              <IconVideo size={17} />
            ) : (
              <IconPhone size={17} />
            )}
          </span>
          <div className="huddle-txt">
            <div className="huddle-title">
              <span className="huddle-dot" />
              {huddle.kind === "video" ? "Video call" : "Call"} in progress
            </div>
            <div className="huddle-sub">
              {(() => {
                const names = (huddle.participants || []).map((p: any) =>
                  p && p.name ? String(p.name).split(" ")[0] : "Someone",
                );
                if (!names.length) return "Happening now — jump in";
                const shown = names.slice(0, 3).join(", ");
                const extra = names.length - 3;
                return `${shown}${extra > 0 ? ` +${extra} more` : ""} on the call`;
              })()}
            </div>
          </div>
          <button
            className="huddle-join"
            onClick={() => onJoinHuddle(huddle.kind === "video")}
          >
            {huddle.kind === "video" ? (
              <IconVideo size={15} />
            ) : (
              <IconPhone size={15} />
            )}
            Join
          </button>
        </div>
      ) : null}

      {/* Tabs — BA/CEO #14: the lone "Chat" tab under the name is redundant
            (you're already in Chat). Only show the tab bar once Files/Links/Members
            add a second tab to switch between. */}
      {TABS.length > 1 ? (
        <div className="chat-tabs">
          {TABS.map(([t, label]) => (
            <button
              key={t}
              className={"tab" + (tab === t ? " active" : "")}
              onClick={() => setTab(t)}
            >
              {label}
            </button>
          ))}
        </div>
      ) : null}
      <ChatMainPane s={s} />

      {/* Toast */}
      {note ? (
        <div
          style={{
            position: "absolute",
            bottom: 80,
            left: "50%",
            transform: "translateX(-50%)",
            background: "var(--ink)",
            color: "#fff",
            padding: "8px 14px",
            borderRadius: 8,
            fontSize: 12.5,
            fontWeight: 500,
            zIndex: 50,
            boxShadow: "var(--shm)",
          }}
        >
          {note}
        </div>
      ) : null}
      {imgViewer ? (
        <UrlLightbox url={imgViewer} onClose={() => setImgViewer(null)} />
      ) : null}
    </div>
  );
}
