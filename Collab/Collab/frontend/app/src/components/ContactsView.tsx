import React, { useState, useEffect, useRef, useCallback } from "react";
import Avatar from "./Avatar";
import { IconMessageSquare, IconUsers } from "../lib/icons";

const dot = (p: string) =>
  p === "on"
    ? "var(--grn)"
    : p === "away" || p === "brb"
      ? "var(--amb)"
      : p === "busy" || p === "dnd"
        ? "var(--red)"
        : "var(--g400)";
const presenceLabel = (p: string) =>
  p === "on"
    ? "Available"
    : p === "busy"
      ? "Busy"
      : p === "dnd"
        ? "Do not disturb"
        : p === "brb"
          ? "Be right back"
          : p === "away"
            ? "Away"
            : "Offline";

// The contact's wall-clock time, shown in the row's meta column (where Calls
// shows the call date). Blank when no timezone is on the profile or it's invalid.
const localTime = (tz?: string) => {
  if (!tz) return "";
  try {
    return new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit", timeZone: tz }).format(new Date());
  } catch {
    return "";
  }
};

// First page of the directory, remembered across visits for the life of the
// tab. The view unmounts whenever the user leaves it, so without this every
// return to Contacts showed an empty list for a debounce + a full round trip.
// A remembered page is shown at once and refreshed in the background.
let firstPageCache: { users: any[]; hasMore: boolean } | null = null;

const av = (u) => ({
  kind: "user",
  initials: u.initials,
  color: u.color,
  avatarUrl: u.avatarUrl,
});

export default function ContactsView({
  users,
  meId,
  conversations,
  onMessage,
  onStartChat,
  onStartCall,
  onAddToGroup,
  invites = [],
  onConnect,
  onAccept,
  onDecline,
  onCancelInvite,
  externalSearch,
  // When provided, the Contacts list is loaded from the server PAGE BY PAGE
  // (with server-side search) so it scales to large directories instead of
  // downloading + rendering everyone. Falls back to the in-memory `users` prop
  // when absent. Signature: ({ offset, limit, q }) => Promise<{users, hasMore}>.
  onLoadPage,
}) {
  const [q, setQ] = useState("");
  useEffect(() => {
    setQ(externalSearch || "");
  }, [externalSearch]);
  const [limit, setLimit] = useState(50); // client-fallback render cap

  // ── Server-side pagination (used when onLoadPage is wired) ──
  const canPage = typeof onLoadPage === "function";
  const PAGE = 50;
  const [srvUsers, setSrvUsers] = useState<any[]>(() => (canPage && firstPageCache ? firstPageCache.users : []));
  const [srvMore, setSrvMore] = useState(() => !!(canPage && firstPageCache && firstPageCache.hasMore));
  const [srvLoading, setSrvLoading] = useState(false);
  // If the paged endpoint ever fails (e.g. an older backend without /api/users/page,
  // or a transient error), fall back to the in-memory `users` prop — Contacts must
  // NEVER show an empty "No people found" because of our fetch. This is what makes
  // the change deploy-safe: the full list is always the source of truth underneath.
  const [srvErr, setSrvErr] = useState(false);
  const paged = canPage && !srvErr;
  const srvOffsetRef = useRef(0);
  const reqSeqRef = useRef(0); // guards a slow response from clobbering a newer query
  // Read the loader through a ref so a fresh arrow from the parent on every render
  // does NOT retrigger the fetch effect (which would refetch on every parent
  // re-render). The effect depends only on `paged` + `q`.
  const onLoadPageRef = useRef(onLoadPage);
  onLoadPageRef.current = onLoadPage;

  // Debounced first-page (re)load on search change.
  useEffect(() => {
    if (!paged) return;
    const seq = ++reqSeqRef.current;
    const isFirstPage = q.trim() === "";
    // The unfiltered first page needs no typing debounce, and when a remembered
    // copy is on screen the refresh is silent (no spinner over real rows).
    const haveCached = isFirstPage && !!firstPageCache;
    if (haveCached) srvOffsetRef.current = firstPageCache!.users.length;
    setSrvLoading(!haveCached);
    const t = setTimeout(async () => {
      try {
        const res = await onLoadPageRef.current({ offset: 0, limit: PAGE, q: q.trim() });
        if (reqSeqRef.current !== seq) return; // stale — a newer query started
        const rows = (res && res.users) || [];
        if (isFirstPage) firstPageCache = { users: rows, hasMore: !!(res && res.hasMore) };
        setSrvUsers(rows);
        setSrvMore(!!(res && res.hasMore));
        srvOffsetRef.current = rows.length;
      } catch {
        if (reqSeqRef.current !== seq) return;
        // Endpoint missing / errored → drop to the prop-based list (client mode).
        setSrvErr(true);
      } finally {
        if (reqSeqRef.current === seq) setSrvLoading(false);
      }
    }, isFirstPage ? 0 : 250);
    return () => clearTimeout(t);
  }, [paged, q]);

  const loadMoreServer = useCallback(async () => {
    if (!paged || srvLoading || !srvMore) return;
    const seq = reqSeqRef.current; // same-query context; a new search bumps this
    setSrvLoading(true);
    try {
      const res = await onLoadPageRef.current({ offset: srvOffsetRef.current, limit: PAGE, q: q.trim() });
      if (reqSeqRef.current !== seq) return; // a newer search superseded this page
      const more = (res && res.users) || [];
      setSrvUsers((prev) => prev.concat(more));
      setSrvMore(!!(res && res.hasMore));
      srvOffsetRef.current += more.length;
    } catch {
      /* keep what we already have */
    } finally {
      if (reqSeqRef.current === seq) setSrvLoading(false);
    }
  }, [paged, srvLoading, srvMore, q]);

  const dmWith = (uid) =>
    (conversations || []).some(
      // A PENDING DM (a sent-but-not-accepted request) is NOT a connection yet, so
      // it doesn't count as "connected" — the row keeps showing "Cancel request"
      // (via outgoingTo) until the other person accepts.
      (c) => c && c.kind === "dm" && !c.pendingConnection && (c.members || []).includes(uid),
    );
  // Pending connection requests, keyed by the OTHER user's id.
  const incomingFrom = (uid) =>
    (invites || []).find(
      (i) => i.direction === "incoming" && i.status === "pending" && i.from && i.from.id === uid,
    );
  const outgoingTo = (uid) =>
    (invites || []).find(
      (i) => i.direction === "outgoing" && i.status === "pending" && i.to && i.to.id === uid,
    );

  useEffect(() => setLimit(50), [q]);

  // Rows to render + the "load more" affordance, chosen per mode.
  let shown, moreAvailable, onMore, totalLabel;
  if (paged) {
    // Server already applied search + alphabetical order; just drop myself.
    shown = srvUsers.filter((u) => u.id !== meId);
    moreAvailable = srvMore;
    onMore = loadMoreServer;
    totalLabel = null; // exact directory total isn't known with paging
  } else {
    const list = (users || [])
      .filter((u) => u.id !== meId)
      .filter(
        (u) =>
          !q.trim() ||
          u.name.toLowerCase().includes(q.toLowerCase()) ||
          (u.email || "").toLowerCase().includes(q.toLowerCase()),
      )
      .sort((a, b) => a.name.localeCompare(b.name));
    shown = list.slice(0, limit);
    moreAvailable = list.length > shown.length;
    onMore = () => setLimit((n) => n + 50);
    totalLabel = list.length;
  }

  const pillBtn = (bg, color): React.CSSProperties => ({
    height: 28,
    padding: "0 12px",
    fontSize: 12,
    fontWeight: 600,
    borderRadius: 8,
    border: "none",
    cursor: "pointer",
    background: bg,
    color,
  });

  const reqCount = (invites || []).filter(
    (i) => i.direction === "incoming" && i.status === "pending" && i.from,
  ).length;
  const onlineCount = shown.filter((u) => u.presence === "on").length;
  const peopleTotal = totalLabel != null ? totalLabel : shown.length + (moreAvailable ? "+" : "");

  return (
    <div className="view active" id="vcontacts">
      <div className="cn">
      <div className="cn-stats">
        <div className="cn-stat">
          <div>
            <div className="cn-stat-k">People</div>
            <div className="cn-stat-v"><b>{peopleTotal}</b><span>in your workspace</span></div>
          </div>
          <span className="cn-stat-i"><IconUsers size={18} /></span>
        </div>
        <div className="cn-stat">
          <div>
            <div className="cn-stat-k">Online now</div>
            <div className="cn-stat-v"><b>{onlineCount}</b><span className="cn-chip ok">Available</span></div>
          </div>
          <span className="cn-stat-i green"><i /></span>
        </div>
        <div className="cn-stat">
          <div>
            <div className="cn-stat-k">Requests</div>
            <div className="cn-stat-v"><b>{reqCount}</b>{reqCount ? <span className="cn-chip bad">Pending</span> : <span>none waiting</span>}</div>
          </div>
          <span className="cn-stat-i amber"><i /></span>
        </div>
      </div>
      {(() => {
        // Discoverable "Connection Requests" section pinned at the top, so
        // incoming requests are never buried in the alphabetical people list.
        const reqs = (invites || []).filter(
          (i) =>
            i.direction === "incoming" && i.status === "pending" && i.from,
        );
        if (!reqs.length) return null;
        return (
          <div
            className="cn-reqs"
            style={{
              padding: "14px 18px 14px",
              flexShrink: 0,
              borderBottom: "1px solid var(--g200)",
            }}
          >
            <div
              style={{
                display: "flex",
                alignItems: "center",
                gap: 8,
                marginBottom: 10,
              }}
            >
              <h3 style={{ fontSize: 13, fontWeight: 700 }}>
                Connection Requests
              </h3>
              <span
                style={{
                  fontSize: 11,
                  fontWeight: 700,
                  color: "#fff",
                  background: "var(--bm, #4f46e5)",
                  borderRadius: 999,
                  padding: "1px 8px",
                  lineHeight: "16px",
                }}
              >
                {reqs.length}
              </span>
            </div>
            <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
              {reqs.map((i) => (
                <div
                  key={i.id}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 10,
                    padding: "8px 10px",
                    borderBottom: "1px solid var(--g200)",
                    borderRadius: 10,
                    background: "var(--sb)",
                  }}
                >
                  <Avatar avatar={av(i.from)} size={36} />
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontWeight: 600, fontSize: 13 }}>
                      {i.from.name}
                    </div>
                    <div style={{ fontSize: 11.5, color: "var(--g500)" }}>
                      wants to connect
                    </div>
                  </div>
                  <button
                    style={pillBtn("var(--brand-cta-gradient)", "#fff")}
                    onClick={() => onAccept && onAccept(i.id)}
                  >
                    Accept
                  </button>
                  <button
                    style={pillBtn("var(--g100)", "var(--g700)")}
                    onClick={() => onDecline && onDecline(i.id)}
                  >
                    Decline
                  </button>
                </div>
              ))}
            </div>
          </div>
        );
      })()}

      <div className="ct-list cn-card">
        {shown.length ? (
          shown.map((u, ui) => {
            const letter = (u.name || "#").charAt(0).toUpperCase();
            const prevLetter = ui > 0 ? (shown[ui - 1].name || "#").charAt(0).toUpperCase() : null;
            const connected = dmWith(u.id);
            const inc = !connected && incomingFrom(u.id);
            const out = !connected && !inc && outgoingTo(u.id);
            const tz = localTime(u.timezone);
            return (
              <React.Fragment key={u.id}>
              {letter !== prevLetter ? <div className="ct-letter">{letter}</div> : null}
              <div className="ct-row">
                <div className="ct-av">
                  <Avatar avatar={av(u)} size={40} />
                  <span
                    className="ct-dot"
                    style={{ background: dot(u.presence) }}
                    title={presenceLabel(u.presence)}
                  />
                </div>
                <div className="ct-info">
                  <div className="ct-name">{u.name}</div>
                  <div
                    className="ct-det"
                    title={tz ? "Local time " + tz + " · " + u.timezone : undefined}
                  >
                    {u.email || presenceLabel(u.presence)}
                  </div>
                </div>
                <div className="ct-acts">
                  {connected ? (
                    <>
                      <button
                        className="ct-btn ct-btn--outline"
                        aria-label={"Message " + u.name}
                        onClick={() => onMessage(u.id)}
                      >
                        <IconMessageSquare size={14} />
                        Message
                      </button>
                      <button
                        className="ct-btn ct-btn--soft"
                        aria-label={"Call " + u.name}
                        onClick={() => onStartCall(u.id, false)}
                      >
                        Call
                      </button>
                      <button
                        className="ct-btn ct-btn--link"
                        aria-label={"Add " + u.name + " to a group"}
                        onClick={() => onAddToGroup(u.id)}
                      >
                        Add to group
                      </button>
                    </>
                  ) : inc ? (
                    // They sent YOU a request → Accept / Decline.
                    <>
                      <button
                        className="ct-btn ct-btn--primary"
                        aria-label={"Accept " + u.name + "'s request"}
                        onClick={() => onAccept && onAccept(inc.id)}
                      >
                        Accept
                      </button>
                      <button
                        className="ct-btn ct-btn--soft"
                        aria-label={"Decline " + u.name + "'s request"}
                        onClick={() => onDecline && onDecline(inc.id)}
                      >
                        Decline
                      </button>
                    </>
                  ) : out ? (
                    // Outgoing pending request → let the sender WITHDRAW it. On
                    // cancel the recipient's request also disappears (server emits
                    // INVITE_UPDATED to both).
                    <>
                      <span className="ct-state">Request sent</span>
                      <button
                        className="ct-btn ct-btn--soft"
                        aria-label={"Cancel your request to " + u.name}
                        onClick={() => onCancelInvite && onCancelInvite(out.id)}
                      >
                        Cancel
                      </button>
                    </>
                  ) : (
                    // No connection yet → send a request (accept-to-chat).
                    <button
                      className="ct-btn ct-btn--primary"
                      aria-label={"Connect with " + u.name}
                      onClick={() => (onConnect ? onConnect(u.id) : onStartChat(u.id))}
                    >
                      Connect
                    </button>
                  )}
                </div>
              </div>
              </React.Fragment>
            );
          })
        ) : (
          <div
            style={{
              color: "var(--g400)",
              fontSize: 13,
              padding: "30px 0",
              textAlign: "center",
            }}
          >
            {paged && srvLoading ? "Loading…" : "No people found."}
          </div>
        )}
        {moreAvailable ? (
          <button
            className="ct-more"
            onClick={onMore}
            disabled={paged && srvLoading}
          >
            {paged && srvLoading
              ? "Loading…"
              : paged
                ? "Load more"
                : `Show ${totalLabel - shown.length} more`}
          </button>
        ) : null}
      </div>
      </div>
    </div>
  );
}
