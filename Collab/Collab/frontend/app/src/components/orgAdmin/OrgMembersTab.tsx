"use client";
import React from "react";
import { IconSearch, IconLock, IconShield, IconMonitor, IconCopy, IconCheck } from "../../lib/icons";
import { Select } from "../ui";

export default function OrgMembersTab({
  members,
  shownMembers,
  q,
  setQ,
  roleFilter,
  setRoleFilter,
  ssoFilter,
  setSsoFilter,
  memberRoleOptions,
  showRoleSplit,
  setShowRoleSplit,
  roleCounts,
  canSeeRoster,
  otherMemberCount,
  can,
  roleLabel,
  assignableRoles,
  roleRankOf,
  myRank,
  openReset,
  setSessionsFor,
  onPromote,
  onRemoveMember,
  resetTarget,
  resetPw,
  setResetPw,
  doReset,
  setResetTarget,
  resetInfo,
  setResetInfo,
  copied,
  setCopied,
  pEmail,
  setPEmail,
  pName,
  setPName,
  pPassword,
  setPPassword,
  pRole,
  setPRole,
  pDone,
  setPDone,
  onAddMember,
  onProvisionMember,
  busy,
}: any) {
  return (
    <div className="org-tab-body">
      <div className="org-toolbar" style={{ display: "flex", gap: 8, alignItems: "center", marginBottom: 16 }}>
        <div className="search-box" style={{ flex: 1, position: "relative" }}>
          <IconSearch size={16} style={{ position: "absolute", left: 10, top: 10, opacity: 0.5 }} />
          <input
            type="text"
            className="ipt"
            placeholder="Filter members by name or email..."
            value={q}
            onChange={(e) => setQ(e.target.value)}
            style={{ paddingLeft: 32, width: "100%" }}
          />
        </div>
        <Select className="ipt" value={roleFilter} onChange={(e) => setRoleFilter(e.target.value)}>
          <option value="all">All roles</option>
          {memberRoleOptions.map((rk: string) => (
            <option key={rk} value={rk}>
              {roleLabel(rk)}
            </option>
          ))}
        </Select>
        <Select className="ipt" value={ssoFilter} onChange={(e: any) => setSsoFilter(e.target.value)}>
          <option value="all">All auth types</option>
          <option value="sso">SSO only</option>
          <option value="password">Password only</option>
        </Select>
      </div>

      {resetInfo && (
        <div
          className="reset-banner"
          style={{
            background: "var(--g100)",
            border: "1px solid var(--g300)",
            borderRadius: 8,
            padding: 12,
            marginBottom: 16,
          }}
        >
          <div style={{ fontWeight: 600, marginBottom: 4 }}>Temporary Password Generated for {resetInfo.name}</div>
          <div style={{ fontSize: 13, color: "var(--g600)", marginBottom: 8 }}>
            Hand this temporary password to the user. They can log in immediately:
          </div>
          <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
            <code style={{ background: "var(--main)", padding: "4px 8px", borderRadius: 4, fontFamily: "monospace" }}>
              {resetInfo.password}
            </code>
            <button
              className="btn-c"
              onClick={() => {
                navigator.clipboard.writeText(resetInfo.password);
                setCopied(true);
                setTimeout(() => setCopied(false), 2000);
              }}
            >
              {copied ? <IconCheck size={14} /> : <IconCopy size={14} />} {copied ? "Copied!" : "Copy"}
            </button>
            <button className="btn-c" onClick={() => setResetInfo(null)}>
              Dismiss
            </button>
          </div>
        </div>
      )}

      {resetTarget && (
        <div
          className="reset-form"
          style={{
            background: "var(--g100)",
            border: "1px solid var(--g300)",
            borderRadius: 8,
            padding: 12,
            marginBottom: 16,
          }}
        >
          <div style={{ fontWeight: 600, marginBottom: 4 }}>Reset Password for {resetTarget.name || resetTarget.email}</div>
          <div style={{ fontSize: 13, color: "var(--g600)", marginBottom: 8 }}>
            Leave blank to auto-generate a secure random temporary password.
          </div>
          <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
            <input
              type="text"
              className="ipt"
              placeholder="New password (optional)"
              value={resetPw}
              onChange={(e) => setResetPw(e.target.value)}
              style={{ width: 240 }}
            />
            <button className="btn-p" disabled={busy} onClick={doReset}>
              Set Password
            </button>
            <button className="btn-c" onClick={() => setResetTarget(null)}>
              Cancel
            </button>
          </div>
        </div>
      )}

      <div className="members-list">
        {shownMembers.map((m: any) => {
          const mRank = roleRankOf(m.role);
          const canManageThisMember = can("members:manage") && mRank <= myRank;
          return (
            <div
              key={m.userId || m.email}
              className="mem-row"
              style={{
                display: "flex",
                alignItems: "center",
                justifyContent: "space-between",
                padding: "8px 0",
                borderBottom: "1px solid var(--g200)",
              }}
            >
              <div className="mem-info" style={{ display: "flex", flexDirection: "column" }}>
                <span className="mem-name" style={{ fontWeight: 600 }}>
                  {m.name || m.email}
                </span>
                <span className="mem-email" style={{ fontSize: 12, color: "var(--g500)" }}>
                  {m.email} {m.ssoEnabled ? "• SSO" : ""}
                </span>
              </div>
              <div className="mem-actions" style={{ display: "flex", gap: 8, alignItems: "center" }}>
                {canManageThisMember ? (
                  <Select
                    className="ipt"
                    style={{ fontSize: 12, padding: "2px 6px" }}
                    value={m.role}
                    onChange={(e) => onPromote(m.userId, e.target.value)}
                  >
                    {assignableRoles.map((rk: string) => (
                      <option key={rk} value={rk}>
                        {roleLabel(rk)}
                      </option>
                    ))}
                  </Select>
                ) : (
                  <span className="badge" style={{ fontSize: 12 }}>
                    {roleLabel(m.role)}
                  </span>
                )}
                {canManageThisMember && (
                  <>
                    <button className="btn-ic" title="Reset password" onClick={() => openReset(m)}>
                      <IconLock size={14} />
                    </button>
                    <button className="btn-ic" title="Inspect sessions" onClick={() => setSessionsFor(m)}>
                      <IconMonitor size={14} />
                    </button>
                    <button className="btn-ic danger" title="Remove member" onClick={() => onRemoveMember(m.userId)}>
                      &times;
                    </button>
                  </>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
