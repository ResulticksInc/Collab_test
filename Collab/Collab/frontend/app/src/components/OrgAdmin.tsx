import React, { useEffect, useRef, useState } from "react";
// The panel itself renders inline (routed module), but its dialogs portal to
// <body> so they overlay the whole app rather than being clipped by the column.
import { createPortal } from "react-dom";
import { api } from "../lib/api";
import BroadcastComposer from "./BroadcastComposer";
import { sanitizeMessageHtml } from "../lib/sanitizeHtml";
import { confirmDialog, promptDialog } from "../lib/dialog";
import { IconX, IconCheck, IconLock, IconShieldCheck, IconCopy, IconSearch, IconChevronDown, IconChevronRight } from "../lib/icons";
import { Select } from "./ui";

// Generate a policy-compliant temporary password (≥9 chars, with lower/upper/digit/
// symbol) using the platform CSPRNG — works in browsers and Electron alike. The admin
// hands this to the user, who signs in and can then change it. Avoids ambiguous
// glyphs (0/O, 1/l/I) so it's easy to read aloud or type.
function genTempPassword(): string {
  const lower = "abcdefghijkmnpqrstuvwxyz";
  const upper = "ABCDEFGHJKLMNPQRSTUVWXYZ";
  const digit = "23456789";
  const symbol = "!@#$%*?";
  const all = lower + upper + digit + symbol;
  const rnd = (n: number) => {
    const a = new Uint32Array(1);
    (globalThis.crypto || (window as any).crypto).getRandomValues(a);
    return a[0] % n;
  };
  const pick = (s: string) => s[rnd(s.length)];
  // Guarantee one of each required class, then fill to length 16.
  const chars = [pick(lower), pick(upper), pick(digit), pick(symbol)];
  while (chars.length < 16) chars.push(pick(all));
  // Fisher–Yates shuffle so the required classes aren't always in the first 4 slots.
  for (let i = chars.length - 1; i > 0; i--) {
    const j = rnd(i + 1);
    [chars[i], chars[j]] = [chars[j], chars[i]];
  }
  return chars.join("");
}

// Organization admin console (#71). A self-contained modal: it fetches its own
// context (org + the caller's role + resolved permissions), members, teams and the
// role catalog, and performs the mutations. Every action is ALSO enforced server-side
// (RBAC + the >=1-owner invariant); the UI just hides what the caller can't do and
// surfaces the server's error message when a guard trips.

const ROLE_LABELS: Record<string, string> = {
  owner: "Owner",
  admin: "Admin",
  member: "Member",
  guest: "Guest",
};

// One crisp line per BUILT-IN role for the Roles & permissions modal. The exact
// capability list under each role is rendered from that role's REAL granted
// permissions (live role catalog), so these lines say what the role is FOR —
// the authoritative "can do" list is generated, never hand-maintained here.
const ROLE_BLURBS: Record<string, string> = {
  owner:
    "Runs the organization and owns it. Holds every permission, including the ones no other role can be granted — deleting the organization and transferring ownership.",
  admin:
    "Day-to-day administrator. Manages people, teams, roles and settings, but cannot delete the organization or act on an Owner.",
  member:
    "The standard role for your staff — most people here are Members. Full use of the product: messages, calls, meetings and files. No administrative control over the organization.",
  guest:
    "For people outside your company, like a contractor or a client. A Guest is not part of the organization — they only reach the specific conversations they are invited into, and they never appear in your team directory or hold any administrative control.",
};

// org:delete is deliberately absent from PERMISSION_CATALOG (it is never grantable
// to a custom role), so the modal falls back to this for owner-only permissions.
const EXTRA_PERM_LABELS: Record<string, { label: string; description: string }> = {
  "org:delete": {
    label: "Delete the organization",
    description: "Archive or delete the whole organization. Owner only — never grantable.",
  },
};


export default function OrgAdmin({
  token,
  onClose,
  initialTab,
  onLeftOrg,
}: {
  token: string | null;
  onClose: () => void;
  // Deep-link target (BA #6): a broadcast/join-request notification routes to the
  // Organization module AND opens the tab the notification is actually about,
  // instead of dumping the user on the default Members roster.
  initialTab?: string | null;
  // Called after the caller successfully LEAVES this org. The shell pivots the
  // session to `nextOrgId` (already switched server-side) or, when null, to the
  // organization onboarding/selection flow.
  onLeftOrg?: (nextOrgId: string | null, orgName: string) => void;
}) {
  const [ctx, setCtx] = useState<any>(null); // { org, role, teamId, permissions }
  const [members, setMembers] = useState<any[] | null>(null);
  const [teams, setTeams] = useState<any[] | null>(null);
  const [roles, setRoles] = useState<any[] | null>(null);
  const [joinReqs, setJoinReqs] = useState<any[]>([]);
  type OrgTab =
    | "members" | "teams" | "settings" | "roles" | "requests" | "activity" | "broadcasts" | "actions";
  const ORG_TABS: OrgTab[] = [
    "members", "teams", "settings", "roles", "requests", "activity", "broadcasts", "actions",
  ];
  const asTab = (v: any): OrgTab | null =>
    ORG_TABS.includes(v as OrgTab) ? (v as OrgTab) : null;
  const [tab, setTab] = useState<OrgTab>(asTab(initialTab) || "members");
  // Re-target when a NEW deep-link arrives while the module is already open (e.g.
  // a second broadcast notification clicked from the Organization page itself).
  // Guarded on the incoming value so it never fights the user's own tab clicks.
  useEffect(() => {
    const t = asTab(initialTab);
    if (t) setTab(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialTab]);
  // Org activity feed (BA #4, audit:view) + broadcasts (BA #6) — lazy-loaded.
  const [audit, setAudit] = useState<any[] | null>(null);
  const [bcasts, setBcasts] = useState<any[] | null>(null);
  // Broadcast composer (org:manage).
  // Confirmation line after a broadcast is sent/scheduled (the composer owns its
  // own draft state; OrgAdmin only needs the result).
  const [bNote, setBNote] = useState<string | null>(null);
  // The broadcast currently being edited (null = composing a new one). Drives
  // BroadcastComposer's edit mode so an edit gets the same rich toolbar.
  const [editBcast, setEditBcast] = useState<{
    id: string; title: string; body: string; sendAt: string | null; status: string;
  } | null>(null);
  // BA #3: the "what can each role do?" explainer, toggled from the header ⓘ.
  const [rbacInfo, setRbacInfo] = useState(false);
  const [email, setEmail] = useState("");
  const [addRole, setAddRole] = useState("member");
  const [name, setName] = useState("");
  // The org-name field is reloaded by load(), which runs after EVERY action and
  // on any 409 re-sync. Track the last server value so a reload only adopts the
  // server name when the admin has NOT typed an unsaved rename — otherwise an
  // unrelated conflict (duplicate team/role name, last-owner) would wipe it.
  const loadedNameRef = useRef("");
  const [err, setErr] = useState<string | null>(null);
  // In-flight guard for the "Leave Organization" action (Organization Actions tab).
  const [leaving, setLeaving] = useState(false);
  const [busy, setBusy] = useState(false);
  // Provision-a-new-user form (create a username/password account, admin-driven).
  const [pEmail, setPEmail] = useState("");
  const [pName, setPName] = useState("");
  const [pPassword, setPPassword] = useState("");
  const [pRole, setPRole] = useState("member");
  const [pDone, setPDone] = useState<string | null>(null);
  // After an admin password reset: the new credential to hand to the user. Shown once
  // in a copyable banner; never persisted or re-fetchable (the server only stores the
  // hash). { name, email, password }.
  const [resetInfo, setResetInfo] = useState<{ name: string; email: string; password: string } | null>(null);
  const [copied, setCopied] = useState(false);
  // Admin reset FORM: which member is being reset + the (optional) typed password.
  // Blank = auto-generate. This replaces the old one-click auto-generate confirm so the
  // admin can set a password of their choosing.
  const [resetTarget, setResetTarget] = useState<any | null>(null);
  const [resetPw, setResetPw] = useState("");
  // Anchor at the top of the members body — we scroll here when the reset form or the
  // new-password banner opens (the lock trigger can be far down the list).
  const topRef = useRef<HTMLDivElement>(null);
  // Member search filter (name or email, case-insensitive).
  const [q, setQ] = useState("");
  // Members tab: narrow the list by org role and by sign-in method (SSO vs
  // password). "all" on either = that dimension is not filtered.
  const [roleFilter, setRoleFilter] = useState("all");
  // Role breakdown next to the member total. Collapsed by default: the headline
  // number is what most people come for, and a permanently-expanded row of role
  // chips crowds the filters directly beneath it.
  const [showRoleSplit, setShowRoleSplit] = useState(false);
  const [ssoFilter, setSsoFilter] = useState<"all" | "sso" | "password">("all");
  // Teams tab: search + which team is expanded to reveal its roster before selecting.
  const [teamQuery, setTeamQuery] = useState("");
  const [expandedTeamId, setExpandedTeamId] = useState<string | null>(null);
  // Create-team form (teams:manage). Blank parent = top-level department.
  const [newTeamName, setNewTeamName] = useState("");
  const [newTeamParent, setNewTeamParent] = useState("");
  // Custom-role editor (roles:manage): permission catalog + a new-role draft.
  const [permCatalog, setPermCatalog] = useState<{ key: string; label: string; description: string }[]>([]);
  const [newRoleName, setNewRoleName] = useState("");
  const [newRolePerms, setNewRolePerms] = useState<Set<string>>(new Set());
  // Session Management admin (Phase 4). Org session policy editor (org:manage):
  // policyLimit/"" = inherit env; policyIdle minutes/"" = no timeout. Member
  // device viewer (members:manage): sessionsFor = the member row being inspected.
  const [policy, setPolicy] = useState<any>(null); // { sessionLimit, idleTimeoutMin, envDefaultLimit }
  const [policyLimit, setPolicyLimit] = useState<string>("");
  const [policyIdle, setPolicyIdle] = useState<string>("");
  const [policyBusy, setPolicyBusy] = useState(false);
  // Media settings: the org's GIF-search (GIPHY) key (never echoed — only whether set).
  const [mediaCfg, setMediaCfg] = useState<any>(null); // { provider, gifConfigured, envFallback }
  const [gifKeyInput, setGifKeyInput] = useState<string>("");
  const [gifBusy, setGifBusy] = useState(false);
  const [sessionsFor, setSessionsFor] = useState<any>(null); // member row
  const [memberSessions, setMemberSessions] = useState<any[] | null>(null);
  const [sessBusy, setSessBusy] = useState(false);

  const perms = new Set<string>(ctx?.permissions || []);
  const can = (p: string) => perms.has(p);

  const load = async () => {
    if (!token) return;
    try {
      const [c, m, t, r, pc, jr] = await Promise.all([
        api.orgCurrent(token),
        api.orgMembers(token),
        api.orgTeams(token),
        api.orgRoles(token),
        api.orgPermissionCatalog(token).catch(() => []),
        // Pending join requests — 403s (→ []) for non-managers, so it's safe to
        // always fetch and gate the TAB on the permission client-side.
        api.orgJoinRequests(token).catch(() => []),
      ]);
      setCtx(c);
      setMembers(Array.isArray(m) ? m : []);
      setTeams(Array.isArray(t) ? t : []);
      setRoles(Array.isArray(r) ? r : []);
      setPermCatalog(Array.isArray(pc) ? pc : []);
      setJoinReqs(Array.isArray(jr) ? jr : []);
      // Adopt the server name only if the field still holds the last value WE
      // loaded (i.e. no unsaved edit in progress); preserve an active rename.
      // The baseline always tracks the server, so a genuine external rename is
      // still picked up once the admin isn't mid-edit.
      {
        const serverName = (c && c.org && c.org.name) || "";
        setName((prev) => (prev === loadedNameRef.current ? serverName : prev));
        loadedNameRef.current = serverName;
      }
    } catch (e: any) {
      setErr(e?.message || "Couldn't load the organization.");
    }
  };
  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token]);
  // Keep the pending join-requests LIVE while the Requests tab is open: when
  // another admin/owner approves or rejects a request first, it should VANISH
  // here on its own so the second admin never clicks a stale card and sees
  // "already handled". Refreshes ONLY the requests slice (not the full load(),
  // which resets the org-name field) every few seconds, so it can't disturb an
  // in-progress rename or any other edit.
  useEffect(() => {
    if (tab !== "requests" || !token) return;
    let alive = true;
    const refresh = () =>
      api
        .orgJoinRequests(token)
        .then((jr: any) => {
          if (!alive) return;
          const next = Array.isArray(jr) ? jr : [];
          setJoinReqs((prev) => {
            // Another admin approved/rejected first → keep the org-toggle badge in
            // lockstep with the list. Dispatch only on an ACTUAL change so the 5s
            // poll doesn't refetch the switcher every tick.
            if (prev.length !== next.length)
              window.dispatchEvent(new Event("colab:org-notif"));
            return next;
          });
        })
        .catch(() => {});
    const id = setInterval(refresh, 5000);
    return () => { alive = false; clearInterval(id); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab, token]);
  // Auto-scroll so the admin actually SEES the reset form / the resulting new-password
  // banner even when they clicked a lock icon lower down the list.
  useEffect(() => {
    if (resetTarget || resetInfo) topRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
  }, [resetTarget, resetInfo]);

  const run = async (fn: () => Promise<any>) => {
    setErr(null);
    setBusy(true);
    try {
      await fn();
      await load();
    } catch (e: any) {
      // A CONFLICT means someone else already acted — most often a second admin
      // approving the same join request in the ~5s before this list polled. Do
      // NOT surface the raw "already been handled" error; that's the exact message
      // the user asked us to stop showing. Silently re-sync so the resolved card
      // just drops out (load() also resets the org-name field, so we only reload
      // on this specific conflict, never after an unrelated failure that could
      // wipe a half-typed rename).
      if (e?.status === 409 || e?.code === "REQUEST_DECIDED") {
        setErr(null);
        try {
          await load();
        } catch (_) {}
      } else {
        setErr(e?.message || "Something went wrong.");
      }
    } finally {
      setBusy(false);
      // Re-sync the org-toggle badge (OrgSwitcher's pending join-request count):
      // approving/rejecting a request changes it, but OrgSwitcher only re-fetches
      // on this event or a fresh org_* notification — which the acting admin never
      // receives for their OWN action. Without this the toggle keeps a stale "1"
      // after the last request is handled ("badge shows 1, but No pending
      // join requests").
      window.dispatchEvent(new Event("colab:org-notif"));
    }
  };

  // Session policy (Phase 4a): loaded lazily when the Settings tab is opened by an
  // org:manage admin. Kept separate from the heavy `run`/`load` cycle.
  const loadPolicy = async () => {
    if (!token) return;
    // Both in one round trip (they were awaited one after the other). Each is
    // non-fatal on its own: the editor shows blanks (inherit) / "no key set".
    const [p, media] = await Promise.all([
      api.orgSessionPolicy(token).catch(() => null),
      api.orgMediaSettings(token).catch(() => null),
    ]);
    if (p) {
      setPolicy(p);
      setPolicyLimit(p.sessionLimit != null ? String(p.sessionLimit) : "");
      setPolicyIdle(p.idleTimeoutMin != null ? String(p.idleTimeoutMin) : "");
    }
    setMediaCfg(media || null);
  };
  const saveGifKey = async (clear = false) => {
    if (!token) return;
    setGifBusy(true);
    setErr(null);
    try {
      const m = await api.orgSetGifKey(token, "giphy", clear ? null : gifKeyInput.trim());
      setMediaCfg(m || null);
      setGifKeyInput("");
    } catch (e: any) {
      setErr(e?.message || "Couldn't save the GIF search key.");
    } finally {
      setGifBusy(false);
    }
  };
  useEffect(() => {
    if (tab === "settings" && ctx && can("org:manage") && !policy) loadPolicy();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab, ctx]);
  // Lazy loads for the Activity feed (audit:view) and the Broadcasts list (any
  // member). Re-fetched each time the tab is opened so the feed is fresh.
  // Broadcasts are visible to every member, so that fetch does not wait for
  // `ctx` (the permission context from load()) — otherwise opening the tab
  // straight after mount cost two sequential round trips.
  useEffect(() => {
    if (!token || tab !== "broadcasts") return;
    api.orgBroadcasts(token).then((rows) => setBcasts(Array.isArray(rows) ? rows : [])).catch(() => setBcasts([]));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab, token]);
  useEffect(() => {
    if (!token || !ctx) return;
    if (tab === "activity" && can("audit:view"))
      api.orgAuditLog(token).then((rows) => setAudit(Array.isArray(rows) ? rows : [])).catch(() => setAudit([]));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab, ctx, token]);
  const savePolicy = async () => {
    if (!token) return;
    setPolicyBusy(true);
    setErr(null);
    try {
      // "" = inherit (null); a number (0 = unlimited) otherwise.
      const patch = {
        sessionLimit: policyLimit.trim() === "" ? null : Math.max(0, Math.floor(Number(policyLimit) || 0)),
        idleTimeoutMin: policyIdle.trim() === "" ? null : Math.max(0, Math.floor(Number(policyIdle) || 0)),
      };
      const p = await api.orgUpdateSessionPolicy(token, patch);
      setPolicy(p || null);
    } catch (e: any) {
      setErr(e?.message || "Couldn't save the session policy.");
    } finally {
      setPolicyBusy(false);
    }
  };

  // Member device viewer (Phase 4b): load when a member is selected for inspection.
  const loadMemberSessions = async (userId: string) => {
    if (!token) return;
    setSessBusy(true);
    try {
      const r = await api.orgMemberSessions(token, userId);
      setMemberSessions((r && r.sessions) || []);
    } catch (e: any) {
      setErr(e?.message || "Couldn't load that member's devices.");
      setMemberSessions([]);
    } finally {
      setSessBusy(false);
    }
  };
  useEffect(() => {
    if (sessionsFor && sessionsFor.userId) {
      setMemberSessions(null);
      loadMemberSessions(sessionsFor.userId);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionsFor]);

  // Admin password reset. Clicking the lock opens an inline form (openReset); the admin
  // types a password or leaves it blank to auto-generate, then confirms (doReset). The
  // new password is surfaced once so it can be handed over, and the target user is
  // signed out on every device server-side, so they must sign in again with it. The old
  // password is never recoverable (one-way hash) — this replaces it.
  const openReset = (m: any) => {
    setErr(null);
    setResetPw("");
    setResetTarget(m);
  };
  const doReset = async () => {
    if (!token || !resetTarget) return;
    const m = resetTarget;
    setErr(null);
    setBusy(true);
    try {
      const pw = resetPw.trim() || genTempPassword();
      await api.orgResetMemberPassword(token, m.userId, pw);
      setResetInfo({ name: m.name || m.email, email: m.email, password: pw });
      setCopied(false);
      setResetTarget(null);
      setResetPw("");
      try {
        window.dispatchEvent(new CustomEvent("colab:toast", { detail: `Password reset for ${m.name || m.email} — signed out on all devices.` }));
      } catch { /* toast bus is optional */ }
    } catch (e: any) {
      setErr(e?.message || "Couldn't reset the password.");
    } finally {
      setBusy(false);
    }
  };

  const roleKeys = (roles || []).map((r) => r.key);
  const availableRoles = roleKeys.length ? roleKeys : ["owner", "admin", "member", "guest"];
  // Display name for a role key: built-in label, else the custom role's own name.
  const roleLabel = (key: string) => ROLE_LABELS[key] || (roles || []).find((r) => r.key === key)?.name || key;
  // Permission key → human label/description for the Roles & permissions modal.
  // Prefers the server's grantable catalog, then the owner-only extras, then the
  // raw key (so a permission added server-side still renders, never blank).
  const permLabel = (k: string) =>
    permCatalog.find((p) => p.key === k)?.label || EXTRA_PERM_LABELS[k]?.label || k;
  const permDesc = (k: string) =>
    permCatalog.find((p) => p.key === k)?.description || EXTRA_PERM_LABELS[k]?.description || "";
  // RBAC in the UI: you can only ASSIGN roles at or below your OWN rank, and you can't
  // change a member who OUTRANKS you. The backend enforces both (rank ceiling); this
  // mirrors it in the pickers so it's clear up front, not rejected after the fact.
  const FALLBACK_RANK: Record<string, number> = {
    owner: 100, admin: 80, member: 40, guest: 20,
  };
  const roleRankOf = (key: string) => (roles || []).find((r) => r.key === key)?.rank ?? FALLBACK_RANK[key] ?? 0;
  const myRank = roleRankOf(ctx?.role);
  const assignableRoles = availableRoles.filter((k) => roleRankOf(k) <= myRank);
  const memberQuery = q.trim().toLowerCase();
  // Roles actually present among members, senior-first — these become the role
  // filter's options (so it never lists roles nobody holds).
  const memberRoleOptions = [
    ...new Set((members || []).map((m) => m.role).filter(Boolean)),
  ].sort((a, b) => roleRankOf(b) - roleRankOf(a));
  // A plain member gets a "who runs this organization" view, NOT the full staff
  // directory: the tab is labelled Roles and lists only the people who hold
  // management roles (Owners/Admins and any custom role with permissions).
  // Everyone else is summarised in one line — a member has no reason to page
  // through the whole roster, and it keeps the directory out of reach.
  const canSeeRoster = can("members:manage");
  const isLeadershipRole = (key: string) => {
    if (key === "owner" || key === "admin") return true;
    const r = (roles || []).find((x: any) => x.key === key);
    return !!(r && (r.permissions || []).length); // custom role WITH powers
  };
  const shownMembers = (members || []).filter((m) => {
    if (!canSeeRoster && !isLeadershipRole(m.role)) return false;
    if (
      memberQuery &&
      !(m.name || "").toLowerCase().includes(memberQuery) &&
      !(m.email || "").toLowerCase().includes(memberQuery)
    )
      return false;
    if (roleFilter !== "all" && m.role !== roleFilter) return false;
    if (ssoFilter === "sso" && !m.ssoEnabled) return false;
    if (ssoFilter === "password" && m.ssoEnabled) return false;
    return true;
  });
  // Count of everyone NOT shown in the read-only Roles view (the plain members).
  const otherMemberCount = canSeeRoster
    ? 0
    : (members || []).filter((m) => !isLeadershipRole(m.role)).length;
  // Headcount by role, senior-first, counting the WHOLE organization — not the
  // filtered list, so the totals stay a fixed reference point while you search.
  // Only roles somebody actually holds appear, so the row never pads itself with
  // empty roles.
  const roleCounts = memberRoleOptions.map((key) => ({
    key,
    label: roleLabel(key),
    count: (members || []).filter((m) => m.role === key).length,
  }));
  const teamQ = teamQuery.trim().toLowerCase();
  const shownTeams = (teams || []).filter((t) => !teamQ || (t.name || "").toLowerCase().includes(teamQ));

  // ── Organization Actions: Leave Organization ──────────────────────────────
  // The caller's role in THIS org, and whether they are the sole remaining owner.
  // Owners always hold members:manage, so their roster (and this owner count) is
  // complete; the server re-enforces the >=1-owner invariant regardless (409).
  const myOrgRole: string = ctx?.role || "member";
  const activeOwnerCount = (members || []).filter(
    (m: any) => m.role === "owner" && m.status === "active",
  ).length;
  const isSoleOwner = myOrgRole === "owner" && activeOwnerCount <= 1;
  const doLeaveOrg = async () => {
    if (leaving || !token || !ctx?.org) return;
    const orgName = ctx.org.name || "this organization";
    const confirmed = await confirmDialog(
      "You are about to leave:\n\n" +
        orgName +
        "\n\nAfter leaving you will lose access to:\n\n" +
        "•  Chats\n•  Channels\n•  Meetings\n•  Calls\n•  Files\n" +
        "•  Organization Contacts\n•  Permissions\n•  Organization Data\n\n" +
        "You can only rejoin if an administrator sends you a new invitation.",
      {
        title: "Leave Organization",
        confirmText: "Leave Organization",
        cancelText: "Cancel",
      },
    );
    if (!confirmed) return;
    setLeaving(true);
    setErr(null);
    try {
      const res: any = await api.leaveOrg(token);
      // The shell handles the pivot (switch to nextOrgId, refresh nav/permissions,
      // or route to onboarding). No local reset — the app reloads on success.
      onLeftOrg?.(res?.nextOrgId ?? null, orgName);
    } catch (e: any) {
      setErr(e?.message || "Couldn't leave the organization. Please try again.");
      setLeaving(false);
    }
  };
  // A team's roster = every member who belongs to it. Membership is multi-team, so a
  // member can appear in several rosters (their `teamIds` lists all their teams).
  const rosterOf = (teamId: string) => (members || []).filter((m) => (m.teamIds || []).includes(teamId));

  // BA #7 (final): Organization is a ROUTED MODULE (mode === "org") — not a
  // modal, not a fixed overlay, not a separate window. It fills the content
  // column beside the Rail exactly like #settings.screen / #help.screen.
  //
  // Why not the fixed-overlay version this replaces: an overlay pinned over the
  // content column leaves the PREVIOUS module mounted underneath, so selecting
  // another module swapped the view + top bar behind it while Organization
  // stayed on top — the "not dynamic / top bar updates but doesn't switch" bug.
  // As a routed mode, React unmounts it on any mode change, so navigation, the
  // top bar, Escape/back history and the rail highlight all stay in lock-step.
  // Desktop titlebar room is handled by the .gx-topbar above it.
  const panel: React.CSSProperties = {
    width: "100%",
    maxWidth: "none",
    height: "100%",
    display: "flex",
    flexDirection: "column",
    overflow: "hidden",
  };
  const tabBtn = (on: boolean): React.CSSProperties => ({
    height: 34,
    padding: "0 14px",
    fontSize: 13,
    fontWeight: 600,
    borderRadius: 8,
    border: "none",
    cursor: "pointer",
    background: on ? "var(--g100)" : "transparent",
    color: on ? "var(--g900)" : "var(--g600)",
  });
  const primaryBtn: React.CSSProperties = {
    height: 34,
    padding: "0 16px",
    fontSize: 13,
    fontWeight: 600,
    borderRadius: 8,
    border: "none",
    background: "var(--brand-cta-gradient)",
    color: "#fff",
    cursor: busy ? "default" : "pointer",
    opacity: busy ? 0.7 : 1,
  };
  // Merged onto primaryBtn when a button's required inputs aren't filled — greys
  // it out so it reads as unavailable (the `disabled` attr already blocks clicks).
  // Keeps the purple gradient + white text from primaryBtn — only dims it and
  // flips the cursor so it reads as unavailable (the `disabled` attr blocks clicks).
  const disabledBtn: React.CSSProperties = {
    cursor: "not-allowed",
    opacity: 0.5,
  };
  const input: React.CSSProperties = {
    height: 34,
    padding: "0 12px",
    fontSize: 13,
    border: "1px solid var(--g200)",
    borderRadius: 8,
    background: "var(--sb)",
    color: "var(--g900)",
    outline: "none",
  };

  // Rendered inline as a routed module (no portal): CoLabV1 mounts this directly
  // inside #main, so it is laid out by the normal column flow. The old portal
  // existed only because this used to render from inside the conversation-list
  // pane (whose `.sb-body` has `contain: layout paint`, clipping fixed children).
  return (
    <div
      id="org"
      className="screen org-screen"
      role="region"
      aria-label="Organization"
    >
      <div style={panel}>
        {/* Header — module top bar; ✕ returns to the previous module. */}
        <div
          className="org-screen-header"
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            padding: "16px 20px",
            borderBottom: "1px solid var(--g150, var(--g200))",
          }}
        >
          <div>
            <div style={{ fontSize: 16, fontWeight: 700, color: "var(--g900)" }}>
              {(ctx && ctx.org && ctx.org.name) || "Organization"}
            </div>
            <div style={{ fontSize: 12, color: "var(--g500)", display: "flex", alignItems: "center", gap: 6 }}>
              You are {ROLE_LABELS[ctx?.role] || ctx?.role || "a member"}
              {/* BA #3: toggles the "what can each role do?" RBAC explainer. */}
              <button
                onClick={() => setRbacInfo((v) => !v)}
                aria-label="About roles and permissions"
                title="About roles & permissions"
                style={{
                  width: 18, height: 18, borderRadius: 999, border: "1px solid var(--g200)",
                  background: rbacInfo ? "var(--ac, #6366F1)" : "var(--sb)",
                  color: rbacInfo ? "#fff" : "var(--g500)",
                  cursor: "pointer", fontSize: 11, fontWeight: 700, lineHeight: 1,
                  display: "inline-flex", alignItems: "center", justifyContent: "center",
                  padding: 0,
                }}
              >
                i
              </button>
            </div>
          </div>
          <button
            onClick={onClose}
            aria-label="Close"
            style={{
              width: 30,
              height: 30,
              borderRadius: 8,
              border: "none",
              background: "var(--g100)",
              color: "var(--g600)",
              cursor: "pointer",
              display: "inline-flex",
              alignItems: "center",
              justifyContent: "center",
            }}
          >
            <IconX size={15} />
          </button>
        </div>

        {/* Tabs */}
        <div style={{ display: "flex", gap: 6, padding: "10px 16px 0" }}>
          <button style={tabBtn(tab === "members")} onClick={() => setTab("members")}>
            {canSeeRoster ? "Members" : "Roles"}
          </button>
          {can("members:manage") ? (
            <button style={tabBtn(tab === "requests")} onClick={() => setTab("requests")}>
              Join requests
              {joinReqs.length ? (
                <span
                  style={{
                    marginLeft: 6, fontSize: 11, fontWeight: 700, lineHeight: 1,
                    color: "#fff", background: "var(--ac, #6366F1)",
                    borderRadius: 999, padding: "2px 6px",
                  }}
                >
                  {joinReqs.length}
                </span>
              ) : null}
            </button>
          ) : null}
          <button style={tabBtn(tab === "teams")} onClick={() => setTab("teams")}>
            Teams
          </button>
          {can("roles:manage") ? (
            <button style={tabBtn(tab === "roles")} onClick={() => setTab("roles")}>
              Roles
            </button>
          ) : null}
          {/* Broadcasts (BA #6): every member may READ; org:manage may post. */}
          <button style={tabBtn(tab === "broadcasts")} onClick={() => setTab("broadcasts")}>
            Broadcasts
          </button>
          {/* Activity (BA #4): the org audit feed. [audit:view] */}
          {can("audit:view") ? (
            <button style={tabBtn(tab === "activity")} onClick={() => setTab("activity")}>
              Activity
            </button>
          ) : null}
          {can("org:manage") ? (
            <button style={tabBtn(tab === "settings")} onClick={() => setTab("settings")}>
              Settings
            </button>
          ) : null}
          {/* Organization Actions — available to EVERY member. Leaving the org is a
              personal, self-serve action, so this tab is never permission-gated. */}
          <button style={tabBtn(tab === "actions")} onClick={() => setTab("actions")}>
            Organization Actions
          </button>
        </div>

        {/* BA #3: RBAC explainer as a MODAL (was an inline dropdown). Content is
            built from the LIVE role catalog — each role's real granted
            permissions — so it states exactly what each role can do in THIS org,
            custom roles included, instead of a generic permission glossary. */}
        {rbacInfo
          ? createPortal(
              <div
                onClick={() => setRbacInfo(false)}
                style={{
                  position: "fixed",
                  inset: 0,
                  background: "rgba(15,10,25,0.45)",
                  backdropFilter: "blur(2px)",
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  zIndex: 4200,
                }}
              >
                <div
                  onClick={(e) => e.stopPropagation()}
                  role="dialog"
                  aria-modal="true"
                  aria-label="Roles and permissions"
                  style={{
                    width: "min(680px, 94vw)",
                    maxHeight: "84vh",
                    background: "var(--bg, #fff)",
                    borderRadius: 16,
                    border: "1px solid var(--g200)",
                    boxShadow: "0 24px 60px rgba(0,0,0,0.28)",
                    display: "flex",
                    flexDirection: "column",
                    overflow: "hidden",
                  }}
                >
                  <div
                    style={{
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "space-between",
                      padding: "16px 20px",
                      borderBottom: "1px solid var(--g150, var(--g200))",
                    }}
                  >
                    <div style={{ fontSize: 16, fontWeight: 700, color: "var(--g900)" }}>
                      Roles &amp; permissions
                    </div>
                    <button
                      onClick={() => setRbacInfo(false)}
                      aria-label="Close"
                      style={{
                        width: 30,
                        height: 30,
                        display: "flex",
                        alignItems: "center",
                        justifyContent: "center",
                        border: "none",
                        background: "transparent",
                        borderRadius: 8,
                        color: "var(--g500)",
                        cursor: "pointer",
                      }}
                    >
                      <IconX size={16} />
                    </button>
                  </div>
                  <div style={{ padding: "14px 20px 18px", overflowY: "auto", fontSize: 13 }}>
                    <div style={{ color: "var(--g700)", marginBottom: 14, lineHeight: 1.55 }}>
                      Everyone in this organization holds exactly{" "}
                      <strong style={{ color: "var(--g900)" }}>one role</strong>. A role is a
                      set of permissions, and every permission is enforced{" "}
                      <strong style={{ color: "var(--g900)" }}>on the server</strong> for each
                      action — hiding a button never grants access, and access is re-checked
                      on every request.
                    </div>
                    <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
                      {(roles || []).map((r: any) => {
                        const perms: string[] = r.permissions || [];
                        const label = r.name || ROLE_LABELS[r.key] || r.key;
                        return (
                          <div
                            key={r.id || r.key}
                            style={{
                              border: "1px solid var(--g150, var(--g200))",
                              borderRadius: 12,
                              padding: "12px 14px",
                              background: "var(--g50, var(--g100))",
                            }}
                          >
                            <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 4 }}>
                              <span style={{ fontWeight: 700, color: "var(--g900)", fontSize: 13.5 }}>
                                {label}
                              </span>
                              {r.isSystem ? null : (
                                <span
                                  style={{
                                    fontSize: 10.5,
                                    fontWeight: 700,
                                    padding: "2px 7px",
                                    borderRadius: 999,
                                    background: "var(--ac, #6366F1)",
                                    color: "#fff",
                                  }}
                                >
                                  CUSTOM
                                </span>
                              )}
                            </div>
                            <div style={{ color: "var(--g600)", marginBottom: perms.length ? 8 : 0, lineHeight: 1.5 }}>
                              {ROLE_BLURBS[r.key] ||
                                "A custom role — it can do exactly what the permissions below allow, and nothing else."}
                            </div>
                            {perms.length ? (
                              <>
                                <div style={{ fontSize: 11, fontWeight: 700, color: "var(--g500)", letterSpacing: 0.3, marginBottom: 5 }}>
                                  CAN
                                </div>
                                <div style={{ display: "flex", flexDirection: "column", gap: 3 }}>
                                  {perms.map((k) => (
                                    <div key={k} style={{ color: "var(--g700)" }}>
                                      <span style={{ color: "var(--ok, #16a34a)", fontWeight: 700 }}>✓</span>{" "}
                                      <span style={{ fontWeight: 600, color: "var(--g900)" }}>
                                        {permLabel(k)}
                                      </span>
                                      {permDesc(k) ? (
                                        <span style={{ color: "var(--g500)" }}> — {permDesc(k)}</span>
                                      ) : null}
                                    </div>
                                  ))}
                                </div>
                              </>
                            ) : (
                              <div style={{ color: "var(--g600)" }}>
                                <span style={{ fontWeight: 700, color: "var(--g500)" }}>
                                  No management permissions.
                                </span>{" "}
                                Full use of the product — messages, calls, meetings and files —
                                plus a read-only view of this page.
                              </div>
                            )}
                          </div>
                        );
                      })}
                    </div>
                    <div style={{ marginTop: 14, color: "var(--g500)", fontSize: 12, lineHeight: 1.5 }}>
                      An organization must always keep at least one Owner, and no one can
                      change or remove a member who outranks them.
                    </div>
                  </div>
                </div>
              </div>,
              document.body,
            )
          : null}

        {err ? (
          <div
            style={{
              margin: "10px 16px 0",
              padding: "8px 12px",
              borderRadius: 8,
              background: "rgba(220,38,38,0.08)",
              color: "var(--danger-fg, #dc2626)",
              fontSize: 12.5,
            }}
          >
            {err}
          </div>
        ) : null}

        {/* Body — grows to fill the full-page height and scrolls internally. */}
        <div style={{ padding: 16, overflowY: "auto", flex: 1, minHeight: 0 }}>
          {tab === "requests" && can("members:manage") ? (
            <>
              <div style={{ fontSize: 12.5, color: "var(--g500)", marginBottom: 12 }}>
                People who’ve asked to join this organization. Approving adds them as a Member; rejecting notifies them without granting access.
              </div>
              {joinReqs.length === 0 ? (
                <div style={{ fontSize: 13, color: "var(--g500)" }}>No pending join requests.</div>
              ) : (
                <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                  {joinReqs.map((r) => (
                    <div
                      key={r.id}
                      style={{
                        display: "flex", alignItems: "center", gap: 10, padding: "8px 10px",
                        borderRadius: 10, border: "1px solid var(--g150, var(--g200))",
                      }}
                    >
                      <div style={{ minWidth: 0, flex: 1 }}>
                        <div style={{ fontSize: 13, fontWeight: 600, color: "var(--g900)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                          {r.name || r.email}
                        </div>
                        <div style={{ fontSize: 11.5, color: "var(--g500)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                          {r.email}{r.createdAt ? ` · requested ${new Date(r.createdAt).toLocaleDateString()}` : ""}
                        </div>
                      </div>
                      <button
                        style={{ ...primaryBtn, ...(busy ? disabledBtn : {}) }}
                        disabled={busy}
                        onClick={() => run(() => api.orgApproveJoinRequest(token, r.id))}
                      >
                        Approve
                      </button>
                      <button
                        style={{
                          height: 34, padding: "0 14px", fontSize: 13, fontWeight: 600, borderRadius: 8,
                          border: "1px solid var(--g200)", background: "transparent", color: "var(--g700)",
                          cursor: busy ? "not-allowed" : "pointer", opacity: busy ? 0.5 : 1,
                        }}
                        disabled={busy}
                        onClick={async () => {
                          // BA #1: optional reason, shared with the requester +
                          // audited. Cancel aborts; blank = no reason given.
                          const reason = await promptDialog(
                            `Reject ${r.name || r.email}’s request to join?`,
                            "",
                            {
                              title: "Reject request",
                              placeholder: "Reason (optional — shared with them)",
                              multiline: true,
                              confirmText: "Reject",
                              danger: true,
                            },
                          );
                          if (reason === null) return;
                          run(() => api.orgRejectJoinRequest(token, r.id, reason.trim()));
                        }}
                      >
                        Reject
                      </button>
                    </div>
                  ))}
                </div>
              )}
            </>
          ) : tab === "members" ? (
            <>
              <div ref={topRef} />
              {resetTarget ? (
                <div
                  style={{
                    marginBottom: 14,
                    padding: "12px 14px",
                    borderRadius: 10,
                    border: "1px solid var(--g200)",
                    background: "var(--sb)",
                  }}
                >
                  <div style={{ fontSize: 12.5, fontWeight: 600, color: "var(--g900)" }}>
                    Reset password for {resetTarget.name || resetTarget.email}
                  </div>
                  <div style={{ fontSize: 11.5, color: "var(--g600)", margin: "3px 0 9px" }}>
                    Type a new password, or leave blank to auto-generate. This replaces their
                    current password and signs them out on every device.
                  </div>
                  <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                    <input
                      style={{ ...input, flex: "1 1 220px" }}
                      type="text"
                      autoFocus
                      placeholder="New password (blank = auto-generate)"
                      value={resetPw}
                      onChange={(e) => setResetPw(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter" && !busy) doReset();
                        if (e.key === "Escape") { setResetTarget(null); setResetPw(""); }
                      }}
                    />
                    <button style={primaryBtn} disabled={busy} onClick={doReset}>
                      Reset &amp; sign out
                    </button>
                    <button
                      onClick={() => { setResetTarget(null); setResetPw(""); }}
                      disabled={busy}
                      style={{
                        height: 34,
                        padding: "0 14px",
                        fontSize: 13,
                        fontWeight: 600,
                        borderRadius: 8,
                        border: "1px solid var(--g200)",
                        background: "var(--sb)",
                        color: "var(--g600)",
                        cursor: busy ? "default" : "pointer",
                      }}
                    >
                      Cancel
                    </button>
                  </div>
                </div>
              ) : null}
              {resetInfo ? (
                <div
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 10,
                    marginBottom: 14,
                    padding: "10px 12px",
                    borderRadius: 10,
                    border: "1px solid color-mix(in srgb, var(--grn, #16a34a) 35%, transparent)",
                    background: "color-mix(in srgb, var(--grn, #16a34a) 10%, transparent)",
                  }}
                >
                  <IconLock size={16} />
                  <div style={{ minWidth: 0, flex: 1 }}>
                    <div style={{ fontSize: 12.5, fontWeight: 600, color: "var(--g900)" }}>
                      New password for {resetInfo.name}
                    </div>
                    <div style={{ fontSize: 11.5, color: "var(--g600)", marginTop: 2 }}>
                      Copy it now and share it securely — it won't be shown again. They've been
                      signed out on every device and must sign in with this password.
                    </div>
                    <code
                      style={{
                        display: "inline-block",
                        marginTop: 6,
                        fontSize: 14,
                        fontFamily: "var(--mono, ui-monospace, SFMono-Regular, Menlo, monospace)",
                        fontWeight: 700,
                        letterSpacing: "0.04em",
                        color: "var(--g900)",
                        background: "var(--sb)",
                        border: "1px solid var(--g200)",
                        borderRadius: 8,
                        padding: "4px 10px",
                        userSelect: "all",
                      }}
                    >
                      {resetInfo.password}
                    </code>
                  </div>
                  <button
                    onClick={async () => {
                      try {
                        await navigator.clipboard.writeText(resetInfo.password);
                        setCopied(true);
                      } catch (_) {
                        /* clipboard blocked — the code is select-all, so manual copy still works */
                      }
                    }}
                    title="Copy password"
                    style={{
                      height: 30,
                      padding: "0 10px",
                      borderRadius: 8,
                      border: "1px solid var(--g200)",
                      background: "var(--sb)",
                      color: "var(--g700)",
                      cursor: "pointer",
                      display: "inline-flex",
                      alignItems: "center",
                      gap: 6,
                      fontSize: 12,
                      fontWeight: 600,
                    }}
                  >
                    {copied ? <IconCheck size={14} /> : <IconCopy size={14} />}
                    {copied ? "Copied" : "Copy"}
                  </button>
                  <button
                    onClick={() => setResetInfo(null)}
                    title="Dismiss"
                    style={{
                      width: 30,
                      height: 30,
                      borderRadius: 8,
                      border: "1px solid var(--g200)",
                      background: "var(--sb)",
                      color: "var(--g600)",
                      cursor: "pointer",
                      display: "inline-flex",
                      alignItems: "center",
                      justifyContent: "center",
                    }}
                  >
                    <IconX size={14} />
                  </button>
                </div>
              ) : null}
              {can("members:invite") ? (
                <div style={{ display: "flex", gap: 8, marginBottom: 14, flexWrap: "wrap" }}>
                  <input
                    style={{ ...input, flex: 1, minWidth: 180 }}
                    type="email"
                    placeholder="Add member by email…"
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" && email.trim()) run(() => api.orgAddMember(token, email.trim(), addRole));
                    }}
                  />
                  {/* AUDIT P2 (#29): offer only roles at/below the caller's rank
                      (as the role-change pickers do) — availableRoles listed roles
                      the server always rejects, a confusing dead-end. */}
                  <Select style={{ ...input, cursor: "pointer" }} value={addRole} onChange={(e) => setAddRole(e.target.value)}>
                    {assignableRoles.map((r) => (
                      <option key={r} value={r}>
                        {roleLabel(r)}
                      </option>
                    ))}
                  </Select>
                  <button
                    style={{ ...primaryBtn, ...(busy || !email.trim() ? disabledBtn : {}) }}
                    disabled={busy || !email.trim()}
                    onClick={() => run(() => api.orgAddMember(token, email.trim(), addRole))}
                  >
                    Add
                  </button>
                </div>
              ) : null}
              {/* Create a NEW username/password account (enterprise provisioning —
                  public sign-up is disabled). Gated by members:manage server-side. */}
              {can("members:manage") ? (
                <div style={{ border: "1px solid var(--g150, var(--g200))", borderRadius: 10, padding: 12, marginBottom: 14 }}>
                  <div style={{ fontSize: 12.5, fontWeight: 600, color: "var(--g800)", marginBottom: 8 }}>
                    Create a new user
                  </div>
                  <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                    <input style={{ ...input, flex: "1 1 150px" }} type="email" placeholder="Email" value={pEmail} onChange={(e) => setPEmail(e.target.value)} />
                    <input style={{ ...input, flex: "1 1 110px" }} placeholder="Full name" value={pName} onChange={(e) => setPName(e.target.value)} />
                    <input style={{ ...input, flex: "1 1 130px" }} type="text" placeholder="Temp password" value={pPassword} onChange={(e) => setPPassword(e.target.value)} />
                    <Select style={{ ...input, cursor: "pointer" }} value={pRole} onChange={(e) => setPRole(e.target.value)}>
                      {assignableRoles.map((r) => (
                        <option key={r} value={r}>{roleLabel(r)}</option>
                      ))}
                    </Select>
                    <button
                      style={{ ...primaryBtn, ...(busy || !pEmail.trim() || !pPassword ? disabledBtn : {}) }}
                      disabled={busy || !pEmail.trim() || !pPassword}
                      onClick={() =>
                        run(async () => {
                          await api.orgProvisionUser(token, { email: pEmail.trim(), name: pName.trim(), password: pPassword, role: pRole });
                          setPDone(pEmail.trim());
                          setPEmail(""); setPName(""); setPPassword("");
                        })
                      }
                    >
                      Create
                    </button>
                  </div>
                  <div style={{ fontSize: 11.5, color: "var(--g500)", marginTop: 7 }}>
                    Creates the account immediately. Share the email + password with the person — they can switch to SSO later.
                    {pDone ? <span style={{ color: "var(--grn, #16a34a)", fontWeight: 600 }}>{" "}Created {pDone}.</span> : null}
                  </div>
                </div>
              ) : null}
              {/* Headcount summary. The total is always visible; the per-role
                  split is behind a toggle so the default state stays a single
                  quiet line above the filters. Each role is also a shortcut into
                  the role filter, so the numbers do something rather than just
                  sitting there. Counts are org-wide and do not follow the search
                  box — they are the reference you compare the filtered list to. */}
              {members && members.length > 0 ? (
                <div style={{ marginBottom: 10 }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                    <span style={{ fontSize: 13, color: "var(--g900)", fontWeight: 600 }}>
                      {members.length} {members.length === 1 ? "member" : "members"}
                    </span>
                    {roleCounts.length > 1 ? (
                      <button
                        onClick={() => setShowRoleSplit((v) => !v)}
                        aria-expanded={showRoleSplit}
                        title={showRoleSplit ? "Hide the breakdown by role" : "Show the breakdown by role"}
                        style={{
                          display: "inline-flex",
                          alignItems: "center",
                          gap: 3,
                          border: "none",
                          background: "transparent",
                          color: "var(--g500)",
                          cursor: "pointer",
                          padding: 0,
                          fontSize: 12.5,
                          fontWeight: 600,
                        }}
                      >
                        By role
                        {showRoleSplit ? <IconChevronDown size={13} /> : <IconChevronRight size={13} />}
                      </button>
                    ) : null}
                  </div>
                  {showRoleSplit && roleCounts.length > 1 ? (
                    <div style={{ display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap", marginTop: 8 }}>
                      {roleCounts.map((r) => {
                        const active = roleFilter === r.key;
                        // A regular member may see WHO the owners/admins are, but
                        // not drill into the full member roster — so the "member"
                        // chip is non-interactive for viewers who can't manage
                        // members. Owners/admins keep it clickable.
                        const locked = r.key === "member" && !can("members:manage");
                        return (
                          <button
                            key={r.key}
                            disabled={locked}
                            onClick={locked ? undefined : () => setRoleFilter(active ? "all" : r.key)}
                            title={
                              locked
                                ? "Only owners and admins can filter the full member list"
                                : active
                                  ? `Showing ${r.label} only — select again to clear`
                                  : `Show only ${r.label}`
                            }
                            style={{
                              display: "inline-flex",
                              alignItems: "baseline",
                              gap: 5,
                              padding: "3px 9px",
                              borderRadius: 999,
                              border: `1px solid ${active ? "var(--ac)" : "var(--g200)"}`,
                              background: active ? "var(--ac)" : "var(--sb)",
                              color: active ? "#fff" : "var(--g900)",
                              cursor: locked ? "default" : "pointer",
                              opacity: locked ? 0.55 : 1,
                              fontSize: 12,
                              lineHeight: 1.6,
                            }}
                          >
                            <span>{r.label}</span>
                            <span style={{ fontWeight: 700, fontVariantNumeric: "tabular-nums" }}>{r.count}</span>
                          </button>
                        );
                      })}
                    </div>
                  ) : null}
                </div>
              ) : null}
              {members && members.length > 0 ? (
                <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 10, flexWrap: "wrap" }}>
                  <div
                    style={{
                      display: "flex",
                      alignItems: "center",
                      gap: 8,
                      padding: "0 10px",
                      height: 34,
                      flex: "1 1 220px",
                      minWidth: 0,
                      border: "1px solid var(--g200)",
                      borderRadius: 8,
                      background: "var(--sb)",
                      color: "var(--g500)",
                    }}
                  >
                    <IconSearch size={15} />
                    <input
                      value={q}
                      onChange={(e) => setQ(e.target.value)}
                      placeholder="Search members by name or email…"
                      style={{ flex: 1, minWidth: 0, border: "none", background: "transparent", outline: "none", fontSize: 13, color: "var(--g900)" }}
                    />
                    {q ? (
                      <button
                        onClick={() => setQ("")}
                        title="Clear search"
                        style={{ border: "none", background: "transparent", color: "var(--g500)", cursor: "pointer", display: "inline-flex", padding: 0 }}
                      >
                        <IconX size={13} />
                      </button>
                    ) : null}
                  </div>
                  {/* Role filter — only lists roles members actually hold, senior-first. */}
                  <Select
                    value={roleFilter}
                    onChange={(e) => setRoleFilter(e.target.value)}
                    title="Filter by role"
                    style={{ ...input, cursor: "pointer", flex: "0 0 auto", minWidth: 128 }}
                  >
                    <option value="all">All roles</option>
                    {memberRoleOptions
                      .filter((r) => can("members:manage") || r !== "member")
                      .map((r) => (
                        <option key={r} value={r}>{roleLabel(r)}</option>
                      ))}
                  </Select>
                  {/* Sign-in method filter — SSO (IdP) vs password (local) accounts. */}
                  <Select
                    value={ssoFilter}
                    onChange={(e) => setSsoFilter(e.target.value as "all" | "sso" | "password")}
                    title="Filter by sign-in method"
                    style={{ ...input, cursor: "pointer", flex: "0 0 auto", minWidth: 128 }}
                  >
                    <option value="all">All sign-in</option>
                    <option value="sso">SSO</option>
                    <option value="password">Password</option>
                  </Select>
                </div>
              ) : null}
              {/* Read-only Roles view (plain members): explain WHAT this list is
                  before showing it, so "only two people" never reads as a bug. */}
              {!canSeeRoster ? (
                <div style={{ fontSize: 12.5, color: "var(--g600)", marginBottom: 10, lineHeight: 1.55 }}>
                  Listed below are the administrators of this Organization. They
                  manage membership, assign roles and control organization
                  settings. Everyone else is a Member — full access to
                  messaging, calls, meetings and files, without administrative
                  permissions.
                </div>
              ) : null}
              <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                {shownMembers.map((m) => (
                  <div
                    key={m.userId}
                    style={{
                      display: "flex",
                      alignItems: "center",
                      gap: 10,
                      padding: "8px 10px",
                      borderRadius: 10,
                      border: "1px solid var(--g150, var(--g200))",
                    }}
                  >
                    {/* flex-basis 0 + a real min-width: the identity column must never
                        collapse. The role <Select> below renders a width:100% trigger
                        (ui.css) which, left unconstrained in this flex row, swallowed the
                        row and squeezed the name/email to zero — every Admin row in the
                        live org read as a bare "Admin" dropdown. */}
                    <div style={{ minWidth: 160, flex: "1 1 0" }}>
                      <div style={{ fontSize: 13, fontWeight: 600, color: "var(--g900)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                        {m.name || m.email}
                      </div>
                      <div style={{ fontSize: 11.5, color: "var(--g500)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                        {m.email}
                      </div>
                    </div>
                    {m.ssoEnabled ? (
                      <span
                        title="Signs in with SSO"
                        style={{
                          display: "inline-flex",
                          alignItems: "center",
                          gap: 4,
                          fontSize: 11,
                          fontWeight: 600,
                          color: "var(--ac)",
                          background: "color-mix(in srgb, var(--ac) 12%, transparent)",
                          border: "1px solid color-mix(in srgb, var(--ac) 30%, transparent)",
                          borderRadius: 999,
                          padding: "2px 8px",
                          whiteSpace: "nowrap",
                        }}
                      >
                        <IconShieldCheck size={12} /> SSO
                      </span>
                    ) : null}
                    {can("members:manage") && roleRankOf(m.role) <= myRank ? (
                      <Select
                        aria-label={`Role of ${m.name || m.email}`}
                        style={{ ...input, height: 30, cursor: "pointer", width: 150, flex: "0 0 150px" }}
                        value={m.role}
                        onChange={(e) => run(() => api.orgSetMemberRole(token, m.userId, e.target.value))}
                      >
                        {assignableRoles.map((r) => (
                          <option key={r} value={r}>
                            {roleLabel(r)}
                          </option>
                        ))}
                      </Select>
                    ) : (
                      <span style={{ fontSize: 12, fontWeight: 600, color: "var(--g600)" }}>
                        {roleLabel(m.role)}
                      </span>
                    )}
                    {can("members:manage") ? (
                      <button
                        onClick={() => setSessionsFor(m)}
                        title="Manage devices / sessions"
                        style={{
                          height: 30,
                          padding: "0 10px",
                          borderRadius: 8,
                          border: "1px solid var(--g200)",
                          background: "var(--sb)",
                          color: "var(--g600)",
                          cursor: "pointer",
                          fontSize: 12,
                          fontWeight: 600,
                          whiteSpace: "nowrap",
                        }}
                      >
                        Devices
                      </button>
                    ) : null}
                    {can("members:manage") && m.hasPassword ? (
                      <button
                        onClick={() => openReset(m)}
                        title="Reset password"
                        style={{
                          width: 30,
                          height: 30,
                          borderRadius: 8,
                          border: "1px solid var(--g200)",
                          background: "var(--sb)",
                          color: "var(--g600)",
                          cursor: "pointer",
                          display: "inline-flex",
                          alignItems: "center",
                          justifyContent: "center",
                        }}
                      >
                        <IconLock size={14} />
                      </button>
                    ) : null}
                    {can("members:manage") ? (
                      <button
                        onClick={async () => {
                          // BA #1: optional reason, echoed to the removed user +
                          // audited. Cancel aborts; blank = no reason given.
                          const reason = await promptDialog(
                            `Remove ${m.name || m.email} from the organization?`,
                            "",
                            {
                              title: "Remove member",
                              placeholder: "Reason (optional — shared with them)",
                              multiline: true,
                              confirmText: "Remove",
                              danger: true,
                            },
                          );
                          if (reason === null) return;
                          run(() => api.orgRemoveMember(token, m.userId, reason.trim()));
                        }}
                        title="Remove member"
                        style={{
                          width: 30,
                          height: 30,
                          borderRadius: 8,
                          border: "1px solid var(--g200)",
                          background: "var(--sb)",
                          color: "var(--danger-fg, #dc2626)",
                          cursor: "pointer",
                          display: "inline-flex",
                          alignItems: "center",
                          justifyContent: "center",
                        }}
                      >
                        <IconX size={14} />
                      </button>
                    ) : null}
                  </div>
                ))}
                {members && members.length === 0 ? (
                  <div style={{ fontSize: 13, color: "var(--g500)" }}>No members yet.</div>
                ) : shownMembers.length === 0 ? (
                  <div style={{ fontSize: 13, color: "var(--g500)" }}>
                    {q.trim() ? `No members match “${q}”.` : "No members match the current filters."}
                  </div>
                ) : null}
              </div>
            </>
          ) : null}

          {/* Broadcasts (BA #6): composer for org:manage, history for everyone. */}
          {tab === "broadcasts" ? (
            <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
              {can("org:manage") ? (
                <BroadcastComposer
                  token={token}
                  edit={editBcast}
                  onCancelEdit={() => setEditBcast(null)}
                  onError={(m) => setErr(m)}
                  onSent={async (scheduled) => {
                    setErr(null);
                    setBNote(
                      editBcast
                        ? "Broadcast updated for everyone."
                        : scheduled
                          ? "Broadcast scheduled — it will go out at the time you picked."
                          : "Broadcast sent — every member has been notified.",
                    );
                    setEditBcast(null);
                    const rows = await api.orgBroadcasts(token).catch(() => null);
                    if (Array.isArray(rows)) setBcasts(rows);
                  }}
                />
              ) : (
                <div style={{ fontSize: 12.5, color: "var(--g500)" }}>
                  Announcements from your organization's owners and admins.
                </div>
              )}
              {bNote ? (
                <div
                  style={{
                    padding: "8px 12px",
                    borderRadius: 8,
                    background: "rgba(22,163,74,0.10)",
                    color: "var(--ok, #16a34a)",
                    fontSize: 12.5,
                    fontWeight: 600,
                  }}
                >
                  {bNote}
                </div>
              ) : null}
              {bcasts === null ? (
                <div style={{ fontSize: 13, color: "var(--g500)" }}>Loading…</div>
              ) : bcasts.length === 0 ? (
                <div style={{ fontSize: 13, color: "var(--g500)" }}>No broadcasts yet.</div>
              ) : (
                bcasts.map((b: any) => (
                  <div
                    key={b.id}
                    style={{
                      padding: "10px 12px", borderRadius: 10,
                      border: "1px solid var(--g150, var(--g200))",
                    }}
                  >
                    <div style={{ display: "flex", alignItems: "baseline", gap: 8 }}>
                      <div style={{ fontSize: 13, fontWeight: 700, color: "var(--g900)", flex: 1, minWidth: 0 }}>
                        {b.title}
                      </div>
                      {/* Queued announcements are visible to managers only (the
                          server filters them out for everyone else) — badge them
                          so a scheduled item is never mistaken for a sent one. */}
                      {b.status === "scheduled" ? (
                        <span
                          style={{
                            fontSize: 10.5, fontWeight: 700, padding: "2px 7px",
                            borderRadius: 999, background: "var(--warn, #f59e0b)", color: "#fff",
                          }}
                        >
                          SCHEDULED
                        </span>
                      ) : b.status === "failed" ? (
                        <span
                          style={{
                            fontSize: 10.5, fontWeight: 700, padding: "2px 7px",
                            borderRadius: 999, background: "var(--danger, #ef4444)", color: "#fff",
                          }}
                        >
                          FAILED
                        </span>
                      ) : null}
                      <div style={{ fontSize: 11, color: "var(--g500)", whiteSpace: "nowrap" }}>
                        {b.status === "scheduled" && b.sendAt
                          ? `Sends ${new Date(b.sendAt).toLocaleString()}`
                          : b.createdAt
                            ? new Date(b.createdAt).toLocaleString()
                            : ""}
                      </div>
                    </div>
                    {b.body ? (
                      // Rich text from the composer. MUST go through the shared
                      // sanitizer — a broadcast body is author-supplied HTML
                      // rendered for EVERY member, so an unsanitised render here
                      // would be a stored-XSS hole with org-wide blast radius.
                      <div
                        className="msg-rich"
                        style={{ fontSize: 12.5, color: "var(--g700)", marginTop: 3 }}
                        dangerouslySetInnerHTML={{ __html: sanitizeMessageHtml(b.body) }}
                      />
                    ) : null}
                    <div style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 4 }}>
                      <div style={{ fontSize: 11.5, color: "var(--g500)", flex: 1 }}>
                        — {b.authorName || "An administrator"}
                        {b.fileId ? " · 📎 attachment" : ""}
                      </div>
                      {/* Edit / delete apply FOR EVERYONE (BA). Hidden while a
                          broadcast is mid-delivery ('sending'), which the server
                          also refuses, so the UI never offers a losing action. */}
                      {can("org:manage") && b.status !== "sending" ? (
                        <>
                          <button
                            className="btn-c"
                            style={{ fontSize: 11.5, padding: "4px 9px" }}
                            disabled={busy}
                            onClick={() => {
                              setEditBcast({
                                id: b.id,
                                title: b.title || "",
                                body: b.body || "",
                                sendAt: b.sendAt || null,
                                status: b.status || "sent",
                              });
                              setBNote(null);
                              topRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
                            }}
                          >
                            Edit
                          </button>
                          <button
                            className="btn-c"
                            style={{ fontSize: 11.5, padding: "4px 9px" }}
                            disabled={busy}
                            onClick={() =>
                              run(async () => {
                                const okDel = await confirmDialog(
                                  b.status === "scheduled"
                                    ? "This broadcast will not be sent, and will be withdrawn from the organization's announcements."
                                    : "This broadcast will be withdrawn from the organization's announcements for all members. Notifications already delivered will remain in recipients' history.",
                                  {
                                    title:
                                      b.status === "scheduled"
                                        ? "Cancel this scheduled broadcast?"
                                        : "Delete this broadcast?",
                                    confirmText:
                                      b.status === "scheduled" ? "Cancel broadcast" : "Delete",
                                    danger: true,
                                  },
                                );
                                if (!okDel) return;
                                await api.orgDeleteBroadcast(token, b.id);
                                if (editBcast && editBcast.id === b.id) setEditBcast(null);
                                const rows = await api.orgBroadcasts(token).catch(() => null);
                                if (Array.isArray(rows)) setBcasts(rows);
                                setBNote(
                                  b.status === "scheduled"
                                    ? "Scheduled broadcast cancelled."
                                    : "Broadcast deleted for everyone.",
                                );
                              })
                            }
                          >
                            {b.status === "scheduled" ? "Cancel" : "Delete"}
                          </button>
                        </>
                      ) : null}
                    </div>
                  </div>
                ))
              )}
            </div>
          ) : null}

          {/* Activity (BA #4): who approved/rejected whom, role changes, removals,
              settings updates — the org's audit trail. [audit:view] */}
          {tab === "activity" && can("audit:view") ? (
            <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
              <div style={{ fontSize: 12.5, color: "var(--g500)", marginBottom: 6 }}>
                Role-based activity in this organization — approvals, rejections, role
                changes, removals and settings updates.
              </div>
              {audit === null ? (
                <div style={{ fontSize: 13, color: "var(--g500)" }}>Loading…</div>
              ) : audit.length === 0 ? (
                <div style={{ fontSize: 13, color: "var(--g500)" }}>No activity recorded yet.</div>
              ) : (
                audit.map((a: any, i: number) => {
                  const who = a.actorName || "Someone";
                  const detail = a.detail || {};
                  const target = (members || []).find((m: any) => m.userId === a.targetId);
                  const targetName = target ? target.name || target.email : detail.name || "";
                  const ACTION_TEXT: Record<string, string> = {
                    "org.join_request.approve": `approved ${targetName || "a join request"}`,
                    "org.join_request.reject": `rejected ${targetName ? `${targetName}'s join request` : "a join request"}`,
                    "org.member.remove": `removed ${targetName || "a member"}`,
                    "org.member.leave": "left the organization",
                    "org.member.add": `added ${targetName || "a member"}`,
                    "org.member.provision": `provisioned an account${targetName ? ` for ${targetName}` : ""}`,
                    "org.member.role_change": `changed ${targetName || "a member"}'s role${detail.role ? ` to ${detail.role}` : ""}`,
                    "org.settings.update": "updated organization settings",
                    "org.broadcast.send": `sent a broadcast${detail.title ? `: “${detail.title}”` : ""}`,
                    "org.session_policy.update": "updated the session policy",
                    "org.media_settings.update": "updated media settings",
                    "admin.session.revoke": "signed a member's device out",
                    "admin.session.revoke_all": `signed ${targetName || "a member"} out everywhere`,
                  };
                  return (
                    <div
                      key={a.id || i}
                      style={{
                        display: "flex", alignItems: "baseline", gap: 8,
                        padding: "8px 10px", borderRadius: 8,
                        border: "1px solid var(--g150, var(--g200))", fontSize: 12.5,
                      }}
                    >
                      <div style={{ flex: 1, minWidth: 0, color: "var(--g700)" }}>
                        <span style={{ fontWeight: 600, color: "var(--g900)" }}>{who}</span>{" "}
                        {ACTION_TEXT[a.action] || a.action}
                        {detail.reason ? (
                          <span style={{ color: "var(--g500)" }}> — “{detail.reason}”</span>
                        ) : null}
                      </div>
                      <div style={{ fontSize: 11, color: "var(--g500)", whiteSpace: "nowrap" }}>
                        {a.createdAt ? new Date(a.createdAt).toLocaleString() : ""}
                      </div>
                    </div>
                  );
                })
              )}
            </div>
          ) : null}



          {tab === "teams" ? (
            <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
              <div style={{ fontSize: 12.5, color: "var(--g500)", marginBottom: 6 }}>
                Click a team to see who's in it, then Join or Leave. You can belong to more than one team.
              </div>
              {can("teams:manage") ? (
                <div style={{ border: "1px solid var(--g150, var(--g200))", borderRadius: 10, padding: 12, marginBottom: 10 }}>
                  <div style={{ fontSize: 12.5, fontWeight: 600, color: "var(--g800)", marginBottom: 8 }}>Create a team</div>
                  <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                    <input
                      style={{ ...input, flex: "1 1 160px" }}
                      placeholder="Team name"
                      value={newTeamName}
                      onChange={(e) => setNewTeamName(e.target.value)}
                    />
                    <Select style={{ ...input, cursor: "pointer" }} value={newTeamParent} onChange={(e) => setNewTeamParent(e.target.value)}>
                      <option value="">No parent (top level)</option>
                      {(teams || []).map((t) => (
                        <option key={t.id} value={t.id}>
                          {"— ".repeat(t.depth || 0)}
                          {t.name}
                        </option>
                      ))}
                    </Select>
                    <button
                      style={{ ...primaryBtn, ...(busy || !newTeamName.trim() ? disabledBtn : {}) }}
                      disabled={busy || !newTeamName.trim()}
                      onClick={() =>
                        run(async () => {
                          await api.orgCreateTeam(token, newTeamName.trim(), newTeamParent || null);
                          setNewTeamName("");
                          setNewTeamParent("");
                        })
                      }
                    >
                      Create
                    </button>
                  </div>
                  <div style={{ fontSize: 11.5, color: "var(--g500)", marginTop: 7 }}>
                    Add a department, or nest one under a parent (e.g. Data Science under Product).
                  </div>
                </div>
              ) : null}
              {teams && teams.length > 0 ? (
                <div
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 8,
                    marginBottom: 10,
                    padding: "0 10px",
                    height: 34,
                    border: "1px solid var(--g200)",
                    borderRadius: 8,
                    background: "var(--sb)",
                    color: "var(--g500)",
                  }}
                >
                  <IconSearch size={15} />
                  <input
                    value={teamQuery}
                    onChange={(e) => setTeamQuery(e.target.value)}
                    placeholder="Search teams by name…"
                    style={{ flex: 1, border: "none", background: "transparent", outline: "none", fontSize: 13, color: "var(--g900)" }}
                  />
                  {teamQuery ? (
                    <button
                      onClick={() => setTeamQuery("")}
                      title="Clear search"
                      style={{ border: "none", background: "transparent", color: "var(--g500)", cursor: "pointer", display: "inline-flex", padding: 0 }}
                    >
                      <IconX size={13} />
                    </button>
                  ) : null}
                </div>
              ) : null}
              {shownTeams.map((t) => {
                const mine = (ctx?.teamIds || []).includes(t.id);
                const expanded = expandedTeamId === t.id;
                const roster = rosterOf(t.id);
                return (
                  <div
                    key={t.id}
                    style={{
                      borderRadius: 10,
                      border: "1px solid " + (mine ? "#8b29be" : "var(--g150, var(--g200))"),
                      background: mine ? "rgba(139,41,190,0.06)" : "var(--sb)",
                      overflow: "hidden",
                    }}
                  >
                    <button
                      onClick={() => setExpandedTeamId(expanded ? null : t.id)}
                      style={{
                        width: "100%",
                        display: "flex",
                        alignItems: "center",
                        justifyContent: "space-between",
                        gap: 8,
                        padding: "9px 12px",
                        paddingLeft: 10 + (t.depth || 0) * 16,
                        border: "none",
                        background: "transparent",
                        cursor: "pointer",
                        textAlign: "left",
                      }}
                    >
                      <span style={{ display: "inline-flex", alignItems: "center", gap: 6, minWidth: 0 }}>
                        {expanded ? <IconChevronDown size={14} /> : <IconChevronRight size={14} />}
                        <span style={{ fontSize: 13, fontWeight: 600, color: "var(--g900)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                          {t.name}
                        </span>
                      </span>
                      <span style={{ fontSize: 11.5, color: "var(--g500)", display: "inline-flex", alignItems: "center", gap: 4, flexShrink: 0 }}>
                        {mine ? <><IconCheck size={12} /> Your team</> : `${roster.length} member${roster.length === 1 ? "" : "s"}`}
                      </span>
                    </button>
                    {expanded ? (
                      <div style={{ padding: "8px 12px 12px", borderTop: "1px solid var(--g150, var(--g200))" }}>
                        {roster.length ? (
                          <div style={{ display: "flex", flexDirection: "column", gap: 4, marginBottom: 10 }}>
                            {roster.map((m) => (
                              <div key={m.userId} style={{ display: "flex", alignItems: "baseline", gap: 6, minWidth: 0 }}>
                                <span style={{ fontSize: 12.5, fontWeight: 600, color: "var(--g900)", whiteSpace: "nowrap" }}>{m.name || m.email}</span>
                                <span style={{ fontSize: 11.5, color: "var(--g500)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{m.email}</span>
                              </div>
                            ))}
                          </div>
                        ) : (
                          <div style={{ fontSize: 12.5, color: "var(--g500)", marginBottom: 10 }}>No one is in this team yet.</div>
                        )}
                        {mine ? (
                          <button
                            onClick={() => run(() => api.orgSetTeamMembership(token, t.id, false))}
                            disabled={busy}
                            style={{
                              height: 32,
                              padding: "0 14px",
                              fontSize: 12.5,
                              fontWeight: 600,
                              borderRadius: 8,
                              border: "1px solid var(--g200)",
                              background: "var(--sb)",
                              color: "var(--g700)",
                              cursor: busy ? "default" : "pointer",
                            }}
                          >
                            Leave team
                          </button>
                        ) : (
                          <button
                            onClick={() => run(() => api.orgSetTeamMembership(token, t.id, true))}
                            disabled={busy}
                            style={{ ...primaryBtn, height: 32, fontSize: 12.5 }}
                          >
                            Join team
                          </button>
                        )}
                      </div>
                    ) : null}
                  </div>
                );
              })}
              {teams && teams.length === 0 ? (
                <div style={{ fontSize: 13, color: "var(--g500)" }}>No teams defined.</div>
              ) : shownTeams.length === 0 ? (
                <div style={{ fontSize: 13, color: "var(--g500)" }}>No teams match “{teamQuery}”.</div>
              ) : null}
            </div>
          ) : null}

          {tab === "settings" && can("org:manage") ? (
            <div style={{ display: "flex", flexDirection: "column", gap: 10, maxWidth: 420 }}>
              <label style={{ fontSize: 13, fontWeight: 600, color: "var(--g800)" }}>Organization name</label>
              <div style={{ display: "flex", gap: 8 }}>
                <input style={{ ...input, flex: 1 }} value={name} maxLength={120} onChange={(e) => setName(e.target.value)} />
                <button
                  style={{ ...primaryBtn, ...(busy || !name.trim() || name.trim() === (ctx?.org?.name || "") ? disabledBtn : {}) }}
                  disabled={busy || !name.trim() || name.trim() === (ctx?.org?.name || "")}
                  onClick={() => run(() => api.updateOrg(token, { name: name.trim() }))}
                >
                  Save
                </button>
              </div>
              <div style={{ fontSize: 12, color: "var(--g500)" }}>
                Slug: <code>{ctx?.org?.slug}</code>
              </div>
              {/* Session policy (Session Mgmt Phase 4) — per-org overrides of the
                  system session defaults. Blank = inherit; limit 0 = unlimited. */}
              <div style={{ height: 1, background: "var(--g150, var(--g200))", margin: "8px 0 2px" }} />
              <div style={{ fontSize: 13, fontWeight: 600, color: "var(--g800)" }}>Session policy</div>
              <div style={{ fontSize: 12, color: "var(--g500)", marginTop: -4 }}>
                Applies to everyone in this organization. Leave a field blank to inherit the
                system default.
              </div>
              <label style={{ fontSize: 12.5, fontWeight: 600, color: "var(--g700)" }}>
                Max devices per member
              </label>
              <input
                style={{ ...input, maxWidth: 180 }}
                type="number"
                min={0}
                placeholder={`Inherit (${policy?.envDefaultLimit ?? 5})`}
                value={policyLimit}
                onChange={(e) => setPolicyLimit(e.target.value)}
              />
              <div style={{ fontSize: 11.5, color: "var(--g500)", marginTop: -4 }}>
                0 = unlimited · blank = inherit the system default
              </div>
              <label style={{ fontSize: 12.5, fontWeight: 600, color: "var(--g700)" }}>
                Idle timeout (minutes)
              </label>
              <input
                style={{ ...input, maxWidth: 180 }}
                type="number"
                min={0}
                placeholder="No timeout"
                value={policyIdle}
                onChange={(e) => setPolicyIdle(e.target.value)}
              />
              <div style={{ fontSize: 11.5, color: "var(--g500)", marginTop: -4 }}>
                Sessions idle beyond this are signed out automatically · blank or 0 = never
              </div>
              <div>
                <button
                  style={{ ...primaryBtn, ...(policyBusy ? disabledBtn : {}) }}
                  disabled={policyBusy}
                  onClick={savePolicy}
                >
                  {policyBusy ? "Saving…" : "Save session policy"}
                </button>
              </div>

              {/* GIF search (GIPHY key) — enable searchable GIFs/stickers org-wide
                  without a redeploy. The key is write-only from here; the GET only
                  reports whether one is set. Members always have the keyless
                  built-in sticker pack + the create-your-own studio regardless. */}
              <div style={{ height: 1, background: "var(--g150, var(--g200))", margin: "14px 0 2px" }} />
              <div style={{ fontSize: 13, fontWeight: 600, color: "var(--g800)" }}>GIF search (GIPHY)</div>
              <div style={{ fontSize: 12, color: "var(--g500)", marginTop: -4 }}>
                Paste a free <b>GIPHY API key</b> (from developers.giphy.com) to turn on searchable
                GIFs &amp; stickers for everyone in this organization. Without one, members still
                have the built-in sticker pack and the create-your-own studio.
              </div>
              <div style={{ fontSize: 11.5, color: "var(--amber,#b45309)", marginTop: -2 }}>
                Note: GIPHY's free/beta keys are rate-limited — verify production terms &amp;
                capacity before relying on search at scale.
              </div>
              <div style={{ fontSize: 12, fontWeight: 600, color: mediaCfg?.gifConfigured ? "var(--green,#16a34a)" : "var(--g500)", marginTop: 2 }}>
                {mediaCfg?.gifConfigured
                  ? "✓ A key is set — GIF search is on."
                  : mediaCfg?.envFallback
                  ? "Using the system default key."
                  : "No key set — search is off (built-in stickers + studio still work)."}
              </div>
              <input
                style={{ ...input, maxWidth: 340 }}
                type="password"
                autoComplete="off"
                placeholder={mediaCfg?.gifConfigured ? "Enter a new key to replace it" : "Paste GIPHY API key"}
                value={gifKeyInput}
                onChange={(e) => setGifKeyInput(e.target.value)}
              />
              <div style={{ display: "flex", gap: 8 }}>
                <button
                  style={{ ...primaryBtn, ...(gifBusy || !gifKeyInput.trim() ? disabledBtn : {}) }}
                  disabled={gifBusy || !gifKeyInput.trim()}
                  onClick={() => saveGifKey(false)}
                >
                  {gifBusy ? "Saving…" : "Save key"}
                </button>
                {mediaCfg?.gifConfigured ? (
                  <button
                    style={{ ...input, height: 34, cursor: gifBusy ? "default" : "pointer", fontWeight: 600, background: "var(--sb)", maxWidth: 140 }}
                    disabled={gifBusy}
                    onClick={() => saveGifKey(true)}
                  >
                    Remove key
                  </button>
                ) : null}
              </div>
            </div>
          ) : null}

          {tab === "actions" ? (
            <div style={{ display: "flex", flexDirection: "column", gap: 14, maxWidth: 640 }}>
              <div style={{ fontSize: 12.5, color: "var(--g500)", lineHeight: 1.5 }}>
                Actions for your own membership in this organization.
              </div>
              {/* Leave Organization — a standard, self-serve organization action.
                  Owners must transfer ownership first when they are the only owner
                  (the same >=1-owner rule the server enforces). */}
              <div
                style={{
                  border: "1px solid var(--g200)",
                  borderRadius: 12,
                  padding: "16px 18px",
                  background: "var(--sb)",
                  display: "flex",
                  alignItems: "flex-start",
                  justifyContent: "space-between",
                  gap: 16,
                  flexWrap: "wrap",
                }}
              >
                <div style={{ minWidth: 0 }}>
                  <div style={{ fontSize: 14, fontWeight: 700, color: "var(--g900)" }}>
                    Leave Organization
                  </div>
                  <div
                    style={{
                      fontSize: 12.5,
                      color: "var(--g500)",
                      lineHeight: 1.5,
                      marginTop: 4,
                      maxWidth: 460,
                    }}
                  >
                    {isSoleOwner
                      ? "You are the only owner of " +
                        ((ctx?.org?.name) || "this organization") +
                        ". Transfer ownership before leaving this organization."
                      : "Remove yourself from " +
                        ((ctx?.org?.name) || "this organization") +
                        ". You'll lose access to its chats, channels, meetings, calls, files and data, and can only rejoin with a new invitation."}
                  </div>
                </div>
                {isSoleOwner ? (
                  <button
                    onClick={() => setTab("members")}
                    style={{
                      flexShrink: 0,
                      height: 34,
                      padding: "0 16px",
                      borderRadius: 8,
                      border: "1px solid var(--g300)",
                      background: "var(--sb)",
                      color: "var(--g800)",
                      fontSize: 13,
                      fontWeight: 600,
                      cursor: "pointer",
                    }}
                  >
                    Transfer ownership
                  </button>
                ) : (
                  <button
                    onClick={doLeaveOrg}
                    disabled={leaving}
                    style={{
                      flexShrink: 0,
                      height: 34,
                      padding: "0 16px",
                      borderRadius: 8,
                      border: "1px solid var(--g300)",
                      background: "var(--sb)",
                      color: "var(--g800)",
                      fontSize: 13,
                      fontWeight: 600,
                      cursor: leaving ? "default" : "pointer",
                      opacity: leaving ? 0.6 : 1,
                    }}
                  >
                    {leaving ? "Leaving…" : "Leave Organization"}
                  </button>
                )}
              </div>
            </div>
          ) : null}

          {tab === "roles" && can("roles:manage") ? (
            <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
              <div style={{ fontSize: 12.5, color: "var(--g500)" }}>
                Define custom roles and choose their permissions. Built-in roles are shown but can't be edited.
                You can only grant permissions you hold yourself.
              </div>
              <div style={{ border: "1px solid var(--g150, var(--g200))", borderRadius: 10, padding: 12 }}>
                <div style={{ fontSize: 12.5, fontWeight: 600, color: "var(--g800)", marginBottom: 8 }}>Create a role</div>
                <input
                  style={{ ...input, width: "100%", marginBottom: 10 }}
                  placeholder="Role name (e.g. Team Lead)"
                  value={newRoleName}
                  onChange={(e) => setNewRoleName(e.target.value)}
                />
                <div style={{ display: "flex", flexDirection: "column", gap: 7, marginBottom: 10 }}>
                  {permCatalog.map((p) => (
                    <label key={p.key} style={{ display: "flex", alignItems: "flex-start", gap: 8, cursor: "pointer" }}>
                      <input
                        type="checkbox"
                        checked={newRolePerms.has(p.key)}
                        onChange={(e) => {
                          const next = new Set(newRolePerms);
                          if (e.target.checked) next.add(p.key);
                          else next.delete(p.key);
                          setNewRolePerms(next);
                        }}
                        style={{ marginTop: 2, flexShrink: 0 }}
                      />
                      <span style={{ minWidth: 0 }}>
                        <span style={{ fontSize: 12.5, fontWeight: 600, color: "var(--g900)" }}>{p.label}</span>
                        <span style={{ fontSize: 11.5, color: "var(--g500)", display: "block" }}>{p.description}</span>
                      </span>
                    </label>
                  ))}
                </div>
                <button
                  style={{ ...primaryBtn, ...(busy || !newRoleName.trim() ? disabledBtn : {}) }}
                  disabled={busy || !newRoleName.trim()}
                  onClick={() =>
                    run(async () => {
                      await api.orgCreateRole(token, newRoleName.trim(), undefined, [...newRolePerms]);
                      setNewRoleName("");
                      setNewRolePerms(new Set());
                    })
                  }
                >
                  Create role
                </button>
              </div>
              <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                {(roles || []).map((r) => (
                  <div
                    key={r.id}
                    style={{ border: "1px solid var(--g150, var(--g200))", borderRadius: 10, padding: "9px 12px", display: "flex", alignItems: "center", gap: 10 }}
                  >
                    <div style={{ minWidth: 0, flex: 1 }}>
                      <div style={{ fontSize: 13, fontWeight: 600, color: "var(--g900)" }}>
                        {ROLE_LABELS[r.key] || r.name}
                        <span style={{ fontSize: 11, fontWeight: 600, color: r.isSystem ? "var(--g500)" : "var(--ac)", marginLeft: 8 }}>
                          {r.isSystem ? "Built-in" : "Custom"}
                        </span>
                      </div>
                      <div style={{ fontSize: 11.5, color: "var(--g500)" }}>
                        {(r.permissions || []).length} permission{(r.permissions || []).length === 1 ? "" : "s"} · rank {r.rank}
                      </div>
                    </div>
                    {!r.isSystem ? (
                      <button
                        onClick={async () => {
                          if (
                            await confirmDialog(
                              `The “${r.name}” role will be removed from this organization and will no longer be available when assigning permissions. This action cannot be undone.`,
                              {
                                title: `Delete the “${r.name}” role?`,
                                confirmText: "Delete role",
                                danger: true,
                              },
                            )
                          )
                            run(() => api.orgDeleteRole(token, r.id));
                        }}
                        title="Delete role"
                        style={{ width: 30, height: 30, borderRadius: 8, border: "1px solid var(--g200)", background: "var(--sb)", color: "var(--danger-fg, #dc2626)", cursor: "pointer", display: "inline-flex", alignItems: "center", justifyContent: "center" }}
                      >
                        <IconX size={14} />
                      </button>
                    ) : null}
                  </div>
                ))}
              </div>
            </div>
          ) : null}
        </div>
      </div>
      {/* Member device viewer (Session Mgmt Phase 4b) — overlays the admin modal.
          Force-logout ends a session immediately (live-disconnect) on that device. */}
      {sessionsFor ? (
        <div
          onClick={() => setSessionsFor(null)}
          style={{
            position: "fixed",
            inset: 0,
            zIndex: 30,
            background: "rgba(0,0,0,.45)",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            padding: 16,
          }}
        >
          <div
            onClick={(e) => e.stopPropagation()}
            style={{
              width: "min(560px, 96vw)",
              maxHeight: "84vh",
              overflow: "auto",
              background: "var(--bg, #fff)",
              color: "var(--g900)",
              borderRadius: 14,
              border: "1px solid var(--g200)",
              boxShadow: "0 24px 64px rgba(0,0,0,.35)",
              padding: 18,
            }}
          >
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 4 }}>
              <div style={{ fontSize: 15, fontWeight: 700 }}>
                Devices — {sessionsFor.name || sessionsFor.email}
              </div>
              <button
                onClick={() => setSessionsFor(null)}
                title="Close"
                style={{ width: 30, height: 30, borderRadius: 8, border: "1px solid var(--g200)", background: "var(--sb)", color: "var(--g600)", cursor: "pointer", display: "inline-flex", alignItems: "center", justifyContent: "center" }}
              >
                <IconX size={14} />
              </button>
            </div>
            <div style={{ fontSize: 12, color: "var(--g500)", marginBottom: 12 }}>
              Signed-in devices for this member. Signing one out ends that session
              immediately on the device.
            </div>
            {memberSessions === null ? (
              <div style={{ fontSize: 12.5, color: "var(--g500)", padding: "12px 0" }}>Loading…</div>
            ) : memberSessions.filter((s) => !s.revoked).length === 0 ? (
              <div style={{ fontSize: 12.5, color: "var(--g500)", padding: "12px 0" }}>No active sessions.</div>
            ) : (
              <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                {memberSessions
                  .filter((s) => !s.revoked)
                  .map((s) => (
                    <div key={s.id} style={{ display: "flex", alignItems: "center", gap: 10, border: "1px solid var(--g150, var(--g200))", borderRadius: 10, padding: "9px 11px" }}>
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div style={{ fontSize: 13, fontWeight: 600, color: "var(--g900)" }}>
                          {s.deviceLabel || "Unknown device"}
                          {s.status === "idle" ? (
                            <span style={{ fontSize: 11, fontWeight: 600, color: "var(--g500)", marginLeft: 8 }}>Idle</span>
                          ) : null}
                        </div>
                        <div style={{ fontSize: 11.5, color: "var(--g500)" }}>
                          {[s.location, s.browser, s.os].filter(Boolean).join(" · ") || "—"}
                        </div>
                      </div>
                      <button
                        disabled={sessBusy}
                        onClick={async () => {
                          setSessBusy(true);
                          try {
                            await api.orgRevokeMemberSession(token, sessionsFor.userId, s.id);
                            await loadMemberSessions(sessionsFor.userId);
                          } catch (e: any) {
                            setErr(e?.message || "Couldn't sign out that device.");
                          } finally {
                            setSessBusy(false);
                          }
                        }}
                        style={{ height: 30, padding: "0 12px", borderRadius: 8, border: "1px solid var(--g200)", background: "var(--sb)", color: "var(--danger-fg, #dc2626)", fontSize: 12, fontWeight: 600, cursor: sessBusy ? "default" : "pointer" }}
                      >
                        Sign out
                      </button>
                    </div>
                  ))}
              </div>
            )}
            {memberSessions && memberSessions.filter((s) => !s.revoked).length > 0 ? (
              <div style={{ display: "flex", justifyContent: "flex-end", marginTop: 14 }}>
                <button
                  disabled={sessBusy}
                  onClick={async () => {
                    if (
                      !(await confirmDialog(
                        `${sessionsFor.name || sessionsFor.email} will be signed out of every device and browser where they are currently signed in, and will need to sign in again.`,
                        {
                          title: "Sign this member out everywhere?",
                          confirmText: "Sign out everywhere",
                          danger: true,
                        },
                      ))
                    )
                      return;
                    setSessBusy(true);
                    try {
                      await api.orgRevokeAllMemberSessions(token, sessionsFor.userId);
                      await loadMemberSessions(sessionsFor.userId);
                    } catch (e: any) {
                      setErr(e?.message || "Couldn't sign out all devices.");
                    } finally {
                      setSessBusy(false);
                    }
                  }}
                  style={{ height: 32, padding: "0 14px", borderRadius: 8, border: "1px solid var(--danger-fg, #dc2626)", background: "transparent", color: "var(--danger-fg, #dc2626)", fontSize: 12.5, fontWeight: 700, cursor: sessBusy ? "default" : "pointer" }}
                >
                  Sign out all devices
                </button>
              </div>
            ) : null}
          </div>
        </div>
      ) : null}
    </div>
  );
}
