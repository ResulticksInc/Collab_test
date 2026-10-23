import React, { useEffect, useRef, useState } from "react";
import { api } from "../lib/api";
import { promptDialog, alertDialog } from "../lib/dialog";
import { IconChevronDown, IconCheck, IconPlus } from "../lib/icons";

// Org switcher (#71) for the Rail. Self-contained: fetches the caller's orgs + the
// active-org context, and switches by calling the server then reloading (the session's
// active_org_id changes server-side, so a reload re-bootstraps the whole app in the new
// tenant — no token reissue). Renders nothing when the session has no org (a legacy /
// no-membership session), so single-tenant + pre-org sessions see the app unchanged.

type Org = { id: string; name: string; slug?: string; role?: string };

function initialsOf(name?: string): string {
  const s = (name || "").trim();
  if (!s) return "·";
  const parts = s.split(/\s+/);
  return ((parts[0]?.[0] || "") + (parts[1]?.[0] || parts[0]?.[1] || "")).toUpperCase() || "·";
}

// Built-in role keys → display labels; a custom role key falls back to Title case.
const ROLE_LABELS: Record<string, string> = {
  owner: "Owner",
  admin: "Admin",
  member: "Member",
  guest: "Guest",
};
function roleLabel(r?: string): string {
  if (!r) return "";
  return ROLE_LABELS[r] || r.charAt(0).toUpperCase() + r.slice(1);
}

export default function OrgSwitcher({
  token,
  collapsed = false,
  variant = "rail",
  orgNotifUnread = 0,
  onOpenOrg,
  orgActive = false,
}: {
  token: string | null;
  collapsed?: boolean;
  variant?: "rail" | "topbar";
  // BA #5: unread org-scoped notifications (role changes, broadcasts, approvals
  // that involve YOU) — drives the dot on the toggle. Computed by CoLabV1 from
  // the notifications feed and passed down via Rail.
  orgNotifUnread?: number;
  // BA #7: navigate to the Organization MODULE. The panel is no longer owned by
  // this component (it was a modal/overlay); CoLabV1 routes mode === "org".
  onOpenOrg?: () => void;
  // True while that module is the active view — highlights the toggle.
  orgActive?: boolean;
}) {
  const isTopbar = variant === "topbar";
  // In the top bar the switcher is always a compact inline button (never the
  // rail's collapsed icon-only mode).
  const compact = isTopbar ? false : collapsed;
  const [orgs, setOrgs] = useState<Org[] | null>(null);
  const [ctx, setCtx] = useState<any>(null); // { org, role, permissions }
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  // ISSUE #18: count of pending org join-requests (managers only) → badge on the toggle.
  const [pendingReqs, setPendingReqs] = useState(0);
  const ref = useRef<HTMLDivElement>(null);

  const load = async () => {
    if (!token) return;
    try {
      // All three in ONE round trip. The join-request call used to wait for
      // orgCurrent so non-managers would not fire it, but that made every org
      // refresh (boot, entering the Organization view, each admin action) two
      // sequential trips; the endpoint simply 403s → [] for non-managers, and
      // the result is only applied for a manager.
      const [list, cur, reqs] = await Promise.all([
        api.listOrgs(token),
        api.orgCurrent(token),
        api.orgJoinRequests(token).catch(() => []),
      ]);
      setOrgs(Array.isArray(list) ? list : []);
      setCtx(cur || null);
      const canManage = Array.isArray(cur?.permissions) && cur.permissions.length > 0;
      setPendingReqs(canManage && Array.isArray(reqs) ? reqs.length : 0);
    } catch {
      /* leave nulls → renders nothing */
    }
  };
  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token]);

  // Live badge: CoLabV1 dispatches "colab:org-notif" on any org_* notification
  // (join-request etc.) so the count refreshes without a reload.
  useEffect(() => {
    const onOrgNotif = () => load();
    window.addEventListener("colab:org-notif", onOrgNotif);
    return () => window.removeEventListener("colab:org-notif", onOrgNotif);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token]);

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [open]);

  const activeOrg: Org | null = (ctx && ctx.org) || (orgs && orgs[0]) || null;

  if (!token) return null;
  // Org-less "normal user": while still loading (orgs === null) render nothing; once
  // we know they have ZERO orgs, show a persistent "Create or join organization"
  // entry so they can start/join one whenever they decide (they were not forced into
  // it at sign-up). It opens the same create/join flow via a window event.
  if (!activeOrg) {
    if (orgs === null) return null;
    // Expanded rail: same box as the nav items below (.rb — 44px tall, 8px/4px
    // side margins, 24px icon, 14px gap, 14px label) so the edges line up.
    const railRow = !compact && !isTopbar;
    return (
      <button
        onClick={() => window.dispatchEvent(new Event("colab:open-org-flow"))}
        title="Create or join an organization"
        style={{
          display: "flex",
          alignItems: "center",
          gap: railRow ? 14 : 8,
          // Collapsed rail: a 40px tile on the same axis as the logo and nav icons.
          width: isTopbar ? "auto" : railRow ? "calc(100% - 19px)" : compact ? 40 : "100%",
          height: railRow ? 44 : compact ? 40 : undefined,
          margin: railRow ? "0 4px 0 8px" : compact ? "0 auto" : undefined,
          padding: compact ? 4 : railRow ? "0 12px" : "6px 8px",
          justifyContent: compact ? "center" : "flex-start",
          border: "1px dashed var(--g300, var(--g200))",
          borderRadius: 10,
          background: "var(--sb, transparent)",
          cursor: "pointer",
        }}
      >
        <span
          style={{
            width: railRow ? 24 : 26,
            height: railRow ? 24 : 26,
            borderRadius: 7,
            flex: "0 0 auto",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            fontSize: 17,
            fontWeight: 700,
            lineHeight: 1,
            color: "#fff",
            background: "linear-gradient(45deg, #8b29be, #381354)",
          }}
        >
          <IconPlus size={20} />
        </span>
        {!compact ? (
          <span
            style={{
              flex: 1,
              minWidth: 0,
              textAlign: "left",
              fontSize: railRow ? 14 : 13,
              fontWeight: railRow ? 500 : 600,
              color: "var(--g800)",
              whiteSpace: "nowrap",
              overflow: "hidden",
              textOverflow: "ellipsis",
            }}
          >
            Create or join org
          </span>
        ) : null}
      </button>
    );
  }

  const doSwitch = async (orgId: string) => {
    if (busy) return;
    if (orgId === activeOrg.id) {
      setOpen(false);
      return;
    }
    setBusy(true);
    try {
      await api.switchOrg(token, orgId);
      window.location.reload();
    } catch {
      setBusy(false);
    }
  };

  const doCreate = async () => {
    const name = await promptDialog("Name your new organization", "", {
      title: "Create organization",
      placeholder: "Organization name",
      confirmText: "Create",
    });
    if (!name || !name.trim()) return;
    setBusy(true);
    try {
      await api.provisionOrg(token, name.trim());
      window.location.reload(); // provision auto-switches server-side
    } catch (e: any) {
      setBusy(false);
      await alertDialog(e?.message || "Couldn't create the organization.", {
        title: "Couldn't create organization",
      });
    }
  };

  const canManage = Array.isArray(ctx?.permissions) && ctx.permissions.length > 0;

  const badge: React.CSSProperties = {
    // 22px, down from 26. The nav icons beneath are 18px, so a 26px badge made
    // the org row visibly taller than every row under it; 22 keeps the org mark
    // reading as the more prominent item without breaking the rail's pitch.
    // Rail: 36×34 / r7.5 / 16px per the Figma "Collab Screens" dashboard
    // (Frame 66 "RE RESULTICKS"). Topbar keeps the compact 22px mark.
    width: isTopbar ? 22 : 36,
    height: isTopbar ? 22 : 34,
    borderRadius: isTopbar ? 6 : 7.5,
    flex: "0 0 auto",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    fontSize: isTopbar ? 11 : 16,
    fontWeight: 700,
    color: "#fff",
    background: "linear-gradient(45deg, #8b29be, #381354)",
  };

  return (
    <div
      ref={ref}
      style={{
        // Rail spacing/alignment is owned by the .rl-org wrapper (BA/CEO #10
        // spacing pass), so the switcher itself carries no padding.
        position: "relative",
        padding: 0,
        display: isTopbar ? "inline-flex" : undefined,
      }}
    >
      <button
        onClick={() => setOpen((o) => !o)}
        // Collapsed rail: use the app's dark, right-placed rail tooltip
        // (GlobalTooltip reads data-tip and, inside #rail, renders it to the right)
        // so the org toggle matches the other rail icons — labelled "Organisation".
        // Expanded rail / topbar keep the native org-name title (the name shows
        // inline there anyway).
        title={compact ? undefined : activeOrg.name}
        data-tip={compact ? "Organisation" : undefined}
        style={{
          display: "flex",
          alignItems: "center",
          // 6px in the rail so the LABEL also lands on the nav rows' text line:
          // a nav row is an 18px icon + 10px gap = 28px to its label; this badge
          // is 22px, so it needs 6px to reach the same 28px. Icon-left and
          // text-left therefore both align with the nav beneath.
          gap: isTopbar ? 8 : 10,
          width: isTopbar ? "auto" : "100%",
          maxWidth: isTopbar ? 200 : undefined,
          padding: compact ? 4 : isTopbar ? "5px 10px" : "3px 10px 3px 9px",
          // Rail: the SAME 36px box as a nav row (.rb). It was 30px, so the gap
          // from "Resulticks" to "Dashboard" measured 37px while every nav row
          // sat at a 42px pitch — the uneven spacing that was visible in the
          // rail. Matching the row height puts the org switcher on the same
          // rhythm as the items below it. box-sizing so the 1px border does not
          // push it to 38.
          minHeight: compact || isTopbar ? undefined : 36,
          boxSizing: "border-box",
          justifyContent: compact ? "center" : "flex-start",
          /* No outline on the org toggle — keep a transparent 1px border so the
             box height/alignment is unchanged. While the Organization module is
             the active view the toggle reads as selected (BA #7), matching how
             rail nav items indicate the current module. */
          border: "1px solid transparent",
          borderRadius: 8,
          // TRANSPARENT at rest, not var(--sb). The rail now paints --side (a
          // shade darker than --sb), so a --sb background turned this control
          // into a bright card floating on the rail — which is what made its
          // padding look oversized. Sitting on the rail surface, it reads as
          // part of the nav, exactly like the .rb rows below it, and only
          // lights up on hover or while the Organization module is open.
          background: orgActive ? "var(--sbah, var(--g100))" : "transparent",
          cursor: "pointer",
        }}
        onMouseEnter={(e) => {
          if (!orgActive) e.currentTarget.style.background = "var(--sbah, var(--g100))";
        }}
        onMouseLeave={(e) => {
          if (!orgActive) e.currentTarget.style.background = "transparent";
        }}
      >
        <span style={{ ...badge, position: "relative" }}>
          {initialsOf(activeOrg.name)}
          {pendingReqs > 0 ? (
            <span
              aria-label={`${pendingReqs} pending join request${pendingReqs === 1 ? "" : "s"}`}
              title={`${pendingReqs} pending join request${pendingReqs === 1 ? "" : "s"}`}
              style={{
                position: "absolute",
                top: -6,
                right: -6,
                minWidth: 16,
                height: 16,
                padding: "0 4px",
                // Fully rounded so a single digit is a circle and "9+" grows into
                // a pill, instead of the squarish 8px radius reading as a chip.
                borderRadius: 999,
                // Slightly deeper, less fluorescent red. #ef4444 vibrating against
                // the purple avatar is most of why this looked stuck-on.
                background: "var(--danger, #e5484d)",
                color: "#fff",
                fontSize: 10,
                fontWeight: 700,
                lineHeight: "16px",
                textAlign: "center",
                // Digits in a 16px circle need to be optically centred and even-
                // width, or "1" drifts and "9+" crowds.
                fontVariantNumeric: "tabular-nums",
                letterSpacing: 0.2,
                // The separator ring is a SHADOW, not a border. As a 2px
                // border-box border it ate 4px of a 16px badge, leaving a 12px
                // interior — that is what made the digit look cramped and the
                // badge oversized for the glyph it held. As a shadow the pill
                // keeps its full 16px and the ring sits outside it. The second
                // shadow lifts it off the avatar so it reads as layered rather
                // than painted on.
                boxShadow:
                  "0 0 0 2px var(--sb, #fff), 0 1px 3px rgba(0,0,0,0.32)",
              }}
            >
              {pendingReqs > 9 ? "9+" : pendingReqs}
            </span>
          ) : orgNotifUnread > 0 ? (
            // BA #5: a plain dot for unseen org updates that involve YOU (role
            // changes, approvals, removals, broadcasts). The pending-requests
            // COUNT badge outranks it when both apply.
            <span
              aria-label="New organization updates"
              title="New organization updates"
              style={{
                position: "absolute",
                top: -3,
                right: -3,
                // Same ring-as-shadow treatment as the count badge above: a 2px
                // border on a 10px dot left a 6px core that read as a smudge.
                width: 9,
                height: 9,
                borderRadius: 999,
                // Brand purple, matching the primary-action gradient's head —
                // this dot is an informational cue, so it belongs to the accent
                // family, not the red reserved for a queue awaiting action.
                background: "var(--ac, #8b29be)",
                boxShadow:
                  "0 0 0 2px var(--sb, #fff), 0 1px 3px rgba(0,0,0,0.32)",
              }}
            />
          ) : null}
        </span>
        {!compact ? (
          <>
            <span
              style={{
                // Was flex:1, which stretched the name across the whole button and
                // pushed the chevron to the far right. flex:0 1 auto keeps it at
                // content width (still shrinks + ellipsises a long name) so the
                // caret sits right next to "Resulticks".
                flex: "0 1 auto",
                minWidth: 0,
                textAlign: "left",
                // 14px / 500 — the SAME as .rb-lbl on the nav rows below, so the
                // org name sits at the rail's type pitch instead of reading a
                // size smaller than every item under it. Was 13/600.
                // Rail: 16/700 per the Figma dashboard's "RESULTICKS" label.
                fontSize: isTopbar ? 14 : 16,
                fontWeight: isTopbar ? 500 : 700,
                color: "var(--g900)",
                whiteSpace: "nowrap",
                overflow: "hidden",
                textOverflow: "ellipsis",
              }}
            >
              {activeOrg.name}
            </span>
            <span style={{ color: "var(--g500)", display: "inline-flex", alignItems: "center", flex: "0 0 auto" }}><IconChevronDown size={12} /></span>
          </>
        ) : null}
      </button>

      {open ? (
        <div
          style={{
            position: "absolute",
            top: "100%",
            left: 0,
            zIndex: 3000,
            minWidth: 215,
            marginTop: 4,
            background: "var(--bg, #fff)",
            border: "1px solid var(--g200)",
            borderRadius: 12,
            boxShadow: "0 16px 40px rgba(0,0,0,0.20)",
            padding: 6,
          }}
        >
          {(orgs || []).length > 1 ? (
            <>
              <div style={{ fontSize: 11, fontWeight: 700, color: "var(--g500)", padding: "6px 8px" }}>
                ORGANIZATIONS
              </div>
              {/* Active org pinned to the top: it's informational (checkmark, NOT
                  clickable — "switching" to the org you're already in does nothing,
                  and a dead button that looks live is confusing). Every OTHER org is
                  a real switch target. */}
              {[...(orgs || [])]
                .sort((a, b) => (a.id === activeOrg.id ? -1 : b.id === activeOrg.id ? 1 : 0))
                .map((o) => {
                  const isActive = o.id === activeOrg.id;
                  const roleKey = isActive ? ctx?.role || o.role : o.role;
                  const rl = roleLabel(roleKey);
                  const rowStyle: React.CSSProperties = {
                    display: "flex",
                    alignItems: "center",
                    gap: 8,
                    width: "100%",
                    padding: "7px 8px",
                    border: "none",
                    borderRadius: 8,
                    background: isActive ? "var(--g100, #f3f4f6)" : "transparent",
                    textAlign: "left",
                  };
                  const inner = (
                    <>
                      <span style={{ ...badge, width: 24, height: 24, fontSize: 10 }}>{initialsOf(o.name)}</span>
                      <span style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column", gap: 1 }}>
                        <span style={{ fontSize: 13, fontWeight: isActive ? 600 : 500, color: "var(--g900)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", lineHeight: 1.25 }}>
                          {o.name}
                        </span>
                        {rl ? (
                          <span style={{ fontSize: 11, color: "var(--g500)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", lineHeight: 1.2 }}>
                            {rl}
                          </span>
                        ) : null}
                      </span>
                      {isActive ? <span style={{ color: "#8b29be", display: "inline-flex", alignItems: "center", flex: "0 0 auto" }}><IconCheck size={14} /></span> : null}
                    </>
                  );
                  return isActive ? (
                    <div key={o.id} aria-current="true" style={{ ...rowStyle, cursor: "default" }}>
                      {inner}
                    </div>
                  ) : (
                    <button key={o.id} onClick={() => doSwitch(o.id)} style={{ ...rowStyle, cursor: "pointer" }}>
                      {inner}
                    </button>
                  );
                })}
            </>
          ) : (
            /* Single organization: there's nowhere to switch to, so DON'T render a
               selectable list (a lone checkmarked item that does nothing on click
               reads as broken). Show the current workspace as read-only info. */
            <div style={{ padding: "6px 8px 2px" }}>
              <div style={{ fontSize: 11, fontWeight: 700, color: "var(--g500)" }}>
                CURRENT ORGANIZATION
              </div>
              <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "8px 0 4px" }}>
                <span style={{ ...badge, width: 24, height: 24, fontSize: 10 }}>{initialsOf(activeOrg.name)}</span>
                <span style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column", gap: 1 }}>
                  <span style={{ fontSize: 13, fontWeight: 600, color: "var(--g900)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", lineHeight: 1.25 }}>
                    {activeOrg.name}
                  </span>
                  {roleLabel(ctx?.role || activeOrg.role) ? (
                    <span style={{ fontSize: 11, color: "var(--g500)", lineHeight: 1.2 }}>
                      {roleLabel(ctx?.role || activeOrg.role)}
                    </span>
                  ) : null}
                </span>
              </div>
            </div>
          )}
          <div style={{ height: 1, background: "var(--g150, var(--g200))", margin: "6px 4px" }} />
          {/* BA #3: EVERY member can open the org panel — managers get the full
              console, members a read-only view (roster, teams, their role, the
              RBAC explainer, broadcasts). BA #7: it ROUTES to the Organization
              module (mode === "org") — a real full page in the content column,
              so other modules can be selected normally from here. */}
          <button
            onClick={() => {
              setOpen(false);
              onOpenOrg?.();
            }}
            style={menuItemStyle}
          >
            {canManage ? "Manage organization" : "View organization"}
          </button>
          <button
            onClick={() => {
              setOpen(false);
              doCreate();
            }}
            style={menuItemStyle}
          >
            Create organization
          </button>
        </div>
      ) : null}

    </div>
  );
}

const menuItemStyle: React.CSSProperties = {
  display: "block",
  width: "100%",
  padding: "8px",
  border: "none",
  borderRadius: 8,
  background: "transparent",
  cursor: "pointer",
  textAlign: "left",
  fontSize: 13,
  fontWeight: 600,
  color: "var(--g800)",
};
