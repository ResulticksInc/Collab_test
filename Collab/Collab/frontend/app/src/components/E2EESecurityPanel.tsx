import { useCallback, useEffect, useState } from "react";
import {
  isE2EEEnabled,
  getMyDeviceId,
  listMyDevices,
  revokeMyDevice,
  approveMyDevice,
  getKeyChangedUserIds,
  acceptIdentityChange,
  resetE2EEDevice,
  recoveryBackupStatus,
  enableRecoveryBackup,
  disableRecoveryBackup,
  restoreFromRecoveryKey,
  WrongRecoveryKeyError,
  enrollRecoveryPassphrase,
  removeRecoveryPassphrase,
  restoreWithPassphrase,
  hasLocalRecoverySecret,
  accountHasRecoveryPassphrase,
  e2eeDiagnostics,
} from "../lib/e2ee/manager";

// Settings › Security › Recovery diagnostics: one report of why THIS device can
// or cannot show history — local state plus the server's view — with a Copy
// button, so support gets facts instead of a screenshot of a placeholder.
function RecoveryDiagnostics() {
  const [report, setReport] = useState<any>(null);
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);
  const run = useCallback(async () => {
    setBusy(true);
    try {
      setReport(await e2eeDiagnostics());
    } catch (e: any) {
      setReport({ error: String(e && e.message ? e.message : e) });
    } finally {
      setBusy(false);
    }
  }, []);
  useEffect(() => {
    void run();
  }, [run]);
  const text = report ? JSON.stringify(report, null, 2) : "";
  const l = report && report.local;
  const sv = report && report.server;
  const line = (k: string, v: any) => (
    <div style={{ display: "flex", gap: 8, fontSize: 12, lineHeight: 1.7 }}>
      <span style={{ color: "var(--g500)", minWidth: 170 }}>{k}</span>
      <span style={{ fontFamily: "ui-monospace, monospace" }}>{String(v)}</span>
    </div>
  );
  return (
    <div style={{ border: "1px solid var(--g200, #e5e7eb)", borderRadius: 10, padding: 12, margin: "0 0 16px" }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 6 }}>
        <div style={{ fontWeight: 600 }}>Recovery diagnostics</div>
        <div style={{ display: "flex", gap: 8 }}>
          <button type="button" className="btn-s" style={{ height: 28, fontSize: 12, padding: "0 10px" }} disabled={busy} onClick={() => void run()}>
            {busy ? "Checking…" : "Refresh"}
          </button>
          <button
            type="button"
            className="btn-s"
            style={{ height: 28, fontSize: 12, padding: "0 10px" }}
            disabled={!text}
            onClick={() => {
              try {
                void navigator.clipboard.writeText(text);
                setCopied(true);
                setTimeout(() => setCopied(false), 1500);
              } catch (_) { }
            }}
          >
            {copied ? "Copied" : "Copy report"}
          </button>
        </div>
      </div>
      {l ? (
        <div>
          {line("Recovery state", l.recovery && l.recovery.phase + " · tried: " + ((l.recovery.tried || []).join(", ") || "—") + " · restored: " + (l.recovery.restored ?? 0))}
          {line("Backup key on this device", l.holdsBackupKey ? "yes" : "no")}
          {line("Recovery secret on this device", l.holdsRecoverySecret ? "yes" : "no")}
          {line("Chat backup setting", l.chatBackupEnabled ? "on" : "off")}
          {line("Device id", l.deviceId || "—")}
          {sv && !sv.error ? (
            <>
              {line("Server: automatic recovery", sv.autoRecovery ? "on" : "off")}
              {line("Server: account key", sv.accountKey)}
              {line("Server: backup", sv.backup && sv.backup.exists ? "yes · " + (sv.backup.chunkCount || 0) + " chunk(s) · " + Math.round((sv.backup.byteLen || 0) / 1024) + " KB · wraps: " + ((sv.backup.wraps || []).join(", ") || "none") : sv.backup && sv.backup.error ? "error: " + sv.backup.error : "none")}
              {line("Server: this device known", sv.thisDevice ? (sv.thisDevice.known ? "yes" + (sv.thisDevice.trusted ? " · trusted" : " · NOT trusted") : "NO") : "token not device-bound")}
              {line("Server: devices on account", Array.isArray(sv.devices) ? sv.devices.length : "?")}
              {line("Server: sync bundles waiting", sv.pendingSyncBundles ?? "—")}
              {line("Server: re-delivery asks open", sv.pendingRedeliverRequests ?? "—")}
            </>
          ) : sv && sv.error ? line("Server", "unreachable: " + sv.error) : null}
        </div>
      ) : (
        <div style={{ fontSize: 12, color: "var(--g500)" }}>{busy ? "Checking…" : "No report yet."}</div>
      )}
    </div>
  );
}
import { IconAlertTriangle, IconMonitor } from "../lib/icons";

/**
 * Self-contained Encryption & Security panel. Renders inside Settings → Security.
 * Self-gates on isE2EEEnabled(): when E2EE is OFF (the product default) it shows
 * only an honest status note, so mounting it is safe in the live build. When ON
 * it surfaces the previously invisible identity-trust state:
 *  - registered devices (with revoke — stops future fan-out to that device),
 *  - MITM key-change alerts with an explicit "accept new key" (re-pin) action.
 * Per-conversation safety numbers are computed by getSafetyNumber() in manager;
 * they belong on the conversation details surface and are wired separately.
 */
export default function E2EESecurityPanel({
  token,
  users,
}: {
  token: string | null;
  users?: any[];
}) {
  const enabled = isE2EEEnabled();
  const myDev = getMyDeviceId();
  const [devices, setDevices] = useState<any[] | null>(null);
  const [changed, setChanged] = useState<string[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [confirmReset, setConfirmReset] = useState(false);

  // Mechanism B — message backup state.
  const [backup, setBackup] = useState<{
    enabled: boolean;
    hasServerBackup: boolean;
    lastBackupAt: number | null;
  } | null>(null);
  // The newly-generated recovery key, shown ONCE in a dismissible box.
  const [newKey, setNewKey] = useState<string | null>(null);
  const [savedAck, setSavedAck] = useState(false);
  const [copied, setCopied] = useState(false);
  // Restore flow.
  const [showRestore, setShowRestore] = useState(false);
  const [restoreInput, setRestoreInput] = useState("");
  const [restoreMsg, setRestoreMsg] = useState<{ kind: "ok" | "err"; text: string } | null>(null);

  // Slice 2 — recovery passphrase. `has` = the account has a passphrase wrap;
  // `canEnroll` = this device holds the recovery secret so it can set/change one.
  const [passState, setPassState] = useState<{ has: boolean; canEnroll: boolean } | null>(null);
  const [passInput, setPassInput] = useState("");
  const [passConfirm, setPassConfirm] = useState("");
  const [passRestoreInput, setPassRestoreInput] = useState("");
  const [showPassSet, setShowPassSet] = useState(false);
  const [showPassRestore, setShowPassRestore] = useState(false);
  const [passMsg, setPassMsg] = useState<{ kind: "ok" | "err"; text: string } | null>(null);

  const loadBackup = useCallback(async () => {
    if (!enabled) return;
    try {
      setBackup(await recoveryBackupStatus());
    } catch {
      /* status is best-effort */
    }
    if (token) {
      try {
        const [has, canEnroll] = await Promise.all([
          accountHasRecoveryPassphrase(token),
          hasLocalRecoverySecret(),
        ]);
        setPassState({ has, canEnroll });
      } catch {
        /* best-effort */
      }
    }
  }, [enabled, token]);

  const onSetUpBackup = useCallback(async () => {
    if (!token) return;
    setBusy("__backup_enable__");
    try {
      const key = await enableRecoveryBackup(token);
      setNewKey(key);
      setSavedAck(false);
      setCopied(false);
    } catch {
      setRestoreMsg({ kind: "err", text: "Couldn't set up backup. Please try again." });
    } finally {
      setBusy(null);
      loadBackup();
    }
  }, [token, loadBackup]);

  const onTurnOffBackup = useCallback(async () => {
    if (!token) return;
    setBusy("__backup_disable__");
    try {
      await disableRecoveryBackup(token);
    } finally {
      setBusy(null);
      setNewKey(null);
      loadBackup();
    }
  }, [token, loadBackup]);

  const onRestore = useCallback(async () => {
    if (!token) return;
    setBusy("__backup_restore__");
    setRestoreMsg(null);
    try {
      const res = await restoreFromRecoveryKey(token, restoreInput);
      if (res.noBackup) {
        setRestoreMsg({ kind: "err", text: "No backup was found for your account." });
      } else {
        setRestoreMsg({
          kind: "ok",
          text:
            res.restored > 0
              ? `Restored ${res.restored} message${res.restored === 1 ? "" : "s"} from your backup.`
              : "Backup restored. No new messages needed restoring on this device.",
        });
        setRestoreInput("");
        setShowRestore(false);
      }
    } catch (e) {
      if (e instanceof WrongRecoveryKeyError) {
        setRestoreMsg({ kind: "err", text: "That recovery key doesn't match." });
      } else {
        setRestoreMsg({ kind: "err", text: "Couldn't restore from backup. Please try again." });
      }
    } finally {
      setBusy(null);
      loadBackup();
    }
  }, [token, restoreInput, loadBackup]);

  const onSetPassphrase = useCallback(async () => {
    if (!token) return;
    if (passInput.trim().length < 8) {
      setPassMsg({ kind: "err", text: "Use a passphrase of at least 8 characters." });
      return;
    }
    if (passInput !== passConfirm) {
      setPassMsg({ kind: "err", text: "The passphrases don't match." });
      return;
    }
    setBusy("__pass_set__");
    setPassMsg(null);
    try {
      await enrollRecoveryPassphrase(token, passInput);
      setPassMsg({
        kind: "ok",
        text: "Recovery passphrase saved. A new device can now restore your history from just this passphrase.",
      });
      setPassInput("");
      setPassConfirm("");
      setShowPassSet(false);
    } catch (e: any) {
      setPassMsg({ kind: "err", text: (e && e.message) || "Couldn't save the passphrase." });
    } finally {
      setBusy(null);
      loadBackup();
    }
  }, [token, passInput, passConfirm, loadBackup]);

  const onRemovePassphrase = useCallback(async () => {
    if (!token) return;
    setBusy("__pass_remove__");
    setPassMsg(null);
    try {
      await removeRecoveryPassphrase(token);
      setPassMsg({ kind: "ok", text: "Recovery passphrase removed." });
    } finally {
      setBusy(null);
      loadBackup();
    }
  }, [token, loadBackup]);

  const onRestorePassphrase = useCallback(async () => {
    if (!token) return;
    setBusy("__pass_restore__");
    setPassMsg(null);
    try {
      const res = await restoreWithPassphrase(token, passRestoreInput);
      setPassMsg({
        kind: "ok",
        text:
          res.restored > 0
            ? `Restored ${res.restored} message${res.restored === 1 ? "" : "s"} from your backup.`
            : "Restored. No new messages needed restoring on this device.",
      });
      setPassRestoreInput("");
      setShowPassRestore(false);
    } catch (e: any) {
      setPassMsg({
        kind: "err",
        text: (e && e.message) || "Couldn't restore with that passphrase.",
      });
    } finally {
      setBusy(null);
      loadBackup();
    }
  }, [token, passRestoreInput, loadBackup]);

  const copyKey = useCallback(async () => {
    if (!newKey) return;
    try {
      await navigator.clipboard.writeText(newKey);
      setCopied(true);
      setTimeout(() => setCopied(false), 1800);
    } catch {
      /* clipboard blocked — the key is still visible to copy manually */
    }
  }, [newKey]);

  const downloadKey = useCallback(() => {
    if (!newKey) return;
    try {
      const blob = new Blob(
        [
          "Collab Recovery Key\n\n",
          newKey,
          "\n\nKeep this safe. You need it to restore your message history on a new ",
          "device. Collab cannot recover it for you.\n",
        ],
        { type: "text/plain" },
      );
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = "Collab Recovery Key.txt";
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch {
      /* download blocked — Copy is the fallback */
    }
  }, [newKey]);

  const doReset = useCallback(async () => {
    setBusy("__reset__");
    try {
      // Best-effort: revoke this device server-side so it doesn't linger as a
      // stale trusted device after we re-enroll. Then wipe ALL local crypto
      // state and reload — initE2EE mints a fresh, fully-enrolled device.
      try {
        if (token && myDev) await revokeMyDevice(token, String(myDev));
      } catch {
        /* revoke is best-effort; reset proceeds regardless */
      }
      await resetE2EEDevice();
    } finally {
      // Hard reload so initE2EE re-runs from a clean slate.
      try {
        window.location.reload();
      } catch {
        setBusy(null);
      }
    }
  }, [token, myDev]);

  const reload = useCallback(async () => {
    if (!enabled || !token) return;
    setDevices(await listMyDevices(token));
    setChanged(getKeyChangedUserIds());
  }, [enabled, token]);

  useEffect(() => {
    reload();
    loadBackup();
  }, [reload, loadBackup]);

  if (!enabled) {
    return (
      <div className="sp-section active sp-nested">
        <h3>End-to-end encryption</h3>
        <p style={{ fontSize: 13, color: "var(--g500)", lineHeight: 1.6 }}>
          End-to-end encryption is not enabled for this workspace. Messages are
          protected in transit (TLS) and at rest, but the server can read their
          content. When E2EE is enabled, direct messages, group messages and
          attachments become readable only on your devices.
        </p>
      </div>
    );
  }

  const nameOf = (uid: string) => {
    const u = (users || []).find((x: any) => x && x.id === uid);
    return (u && u.name) || "A contact";
  };

  return (
    <div className="sp-section active sp-nested">
      <h3>End-to-end encryption</h3>
      <p
        style={{
          fontSize: 13,
          color: "var(--g500)",
          lineHeight: 1.6,
          margin: "0 0 14px",
        }}
      >
        Messages and attachments in your direct messages, groups and channels are
        encrypted on your device; the server relays only ciphertext. Sender,
        recipients and timestamps remain visible to the server. Your chat backup
        works differently: so that every device you sign in to shows your full
        history without a password, the server keeps a sealed copy of the backup
        key, which means an operator with database access could open your
        backup. Turn off Chat Backup if you would rather the server hold nothing.
      </p>

      <RecoveryDiagnostics />

      {changed.length > 0 && (
        <div
          style={{
            border: "1px solid var(--danger, #e5484d)",
            borderRadius: 10,
            padding: 12,
            margin: "0 0 16px",
          }}
        >
          <div style={{ fontWeight: 600, marginBottom: 6 }}>
            Security code changed
          </div>
          <p style={{ fontSize: 12, lineHeight: 1.6, margin: "0 0 10px" }}>
            The encryption identity of{" "}
            {changed.length === 1 ? "a contact" : "some contacts"} changed.
            That is normal after a reinstall or a new device, but it can also mean
            someone is intercepting messages. Confirm with them out of band before
            accepting.
          </p>
          {changed.map((uid) => (
            <div className="dev-row" key={uid}>
              <div className="dev-body">
                <div className="dev-name">{nameOf(uid)}</div>
                <div className="dev-meta">Identity key changed</div>
              </div>
              <button
                className="zo"
                disabled={busy === uid}
                onClick={async () => {
                  setBusy(uid);
                  try {
                    await acceptIdentityChange(token!, uid);
                  } finally {
                    setBusy(null);
                    reload();
                  }
                }}
              >
                {busy === uid ? "…" : "Accept new key"}
              </button>
            </div>
          ))}
        </div>
      )}

      <h4 style={{ margin: "0 0 8px", fontSize: 13 }}>Your devices</h4>
      {devices === null ? (
        <div className="ev-empty">Loading…</div>
      ) : devices.length === 0 ? (
        <div className="ev-empty">No registered devices yet.</div>
      ) : (
        devices.map((d: any) => {
          const isCurrent = String(d.id) === String(myDev);
          const pending = d.trusted === false;
          return (
            <div className="dev-row" key={d.id}>
              <div className="dev-ic">
                <IconMonitor />
              </div>
              <div className="dev-body">
                <div className="dev-name">
                  {d.name || "Device"}{" "}
                  <span style={{ fontSize: 11, color: "var(--g500)" }}>
                    #{String(d.id).slice(0, 8)}
                  </span>
                </div>
                <div className="dev-meta">
                  {isCurrent
                    ? "This device"
                    : pending
                      ? "Pending approval — cannot read messages until approved"
                      : "Registered device"}
                </div>
              </div>
              {isCurrent && !pending ? (
                <span className="dev-badge">Current</span>
              ) : (
                <div style={{ display: "flex", gap: 6 }}>
                  {pending && (
                    <button
                      className="zo"
                      disabled={busy === d.id}
                      onClick={async () => {
                        setBusy(d.id);
                        try {
                          await approveMyDevice(token!, d.id);
                        } finally {
                          setBusy(null);
                          reload();
                        }
                      }}
                    >
                      {busy === d.id ? "…" : "Approve"}
                    </button>
                  )}
                  <button
                    className="zo"
                    disabled={busy === d.id}
                    onClick={async () => {
                      setBusy(d.id);
                      try {
                        await revokeMyDevice(token!, d.id);
                      } finally {
                        setBusy(null);
                        reload();
                      }
                    }}
                  >
                    {busy === d.id ? "…" : "Revoke"}
                  </button>
                </div>
              )}
            </div>
          );
        })
      )}
      <p
        style={{
          fontSize: 12,
          color: "var(--g500)",
          marginTop: 14,
          lineHeight: 1.6,
        }}
      >
        Revoking a device stops new messages from being encrypted to it. To verify
        a contact&apos;s identity, compare your security code with them inside the
        conversation.
      </p>

      {/* ---- Mechanism B: encrypted message backup ---- */}
      <div
        style={{
          marginTop: 18,
          paddingTop: 16,
          borderTop: "1px solid var(--border, rgba(0,0,0,0.08))",
        }}
      >
        <h4 style={{ margin: "0 0 6px", fontSize: 13 }}>Message backup</h4>

        {/* Status line */}
        <p style={{ fontSize: 13, color: "var(--g500)", lineHeight: 1.6, margin: "0 0 10px" }}>
          {backup?.enabled
            ? "Backup is on — your messages can be restored on a new device."
            : "Backup is off."}
        </p>

        {/* The one-time recovery-key box (shown right after setting up). */}
        {newKey ? (
          <div
            style={{
              border: "1px solid var(--border, rgba(0,0,0,0.12))",
              borderRadius: 10,
              padding: 12,
              margin: "0 0 12px",
              background: "var(--card, rgba(0,0,0,0.02))",
            }}
          >
            <div style={{ fontWeight: 600, marginBottom: 6, fontSize: 13 }}>
              Your recovery key
            </div>
            <p style={{ fontSize: 12, lineHeight: 1.6, margin: "0 0 10px", color: "var(--g500)" }}>
              Save this key now. You need it to restore your messages on a new
              device. Collab cannot recover it for you — if you lose it, your backup
              cannot be opened.
            </p>
            <div
              style={{
                fontFamily: "monospace",
                fontSize: 14,
                letterSpacing: "0.04em",
                wordBreak: "break-all",
                padding: "10px 12px",
                borderRadius: 8,
                border: "1px solid var(--border, rgba(0,0,0,0.12))",
                margin: "0 0 10px",
                userSelect: "all",
              }}
            >
              {newKey}
            </div>
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 10 }}>
              <button className="zo" onClick={copyKey}>
                {copied ? "Copied" : "Copy"}
              </button>
              <button className="zo" onClick={downloadKey}>
                Download
              </button>
            </div>
            <label style={{ display: "flex", gap: 8, alignItems: "flex-start", fontSize: 12, lineHeight: 1.5 }}>
              <input
                type="checkbox"
                checked={savedAck}
                onChange={(e) => setSavedAck(e.target.checked)}
                style={{ marginTop: 2 }}
              />
              <span>I&apos;ve saved my recovery key.</span>
            </label>
            <div style={{ marginTop: 10 }}>
              <button
                className="zo"
                disabled={!savedAck}
                onClick={() => {
                  setNewKey(null);
                  setSavedAck(false);
                }}
              >
                Done
              </button>
            </div>
          </div>
        ) : backup?.enabled ? (
          // Backup ON.
          <div>
            <p style={{ fontSize: 12, color: "var(--g500)", lineHeight: 1.6, margin: "0 0 10px" }}>
              {backup.lastBackupAt
                ? `Last backed up: ${new Date(backup.lastBackupAt).toLocaleString()}.`
                : "Your messages are backed up."}{" "}
              Your recovery key was shown when you set up backup. Keep it safe — it
              is the only way to restore on a new device.
            </p>
            <button
              className="zo"
              disabled={busy === "__backup_disable__"}
              onClick={onTurnOffBackup}
            >
              {busy === "__backup_disable__" ? "…" : "Turn off backup"}
            </button>
          </div>
        ) : (
          // Backup OFF.
          <div>
            <p style={{ fontSize: 12, color: "var(--g500)", lineHeight: 1.6, margin: "0 0 10px" }}>
              Turn on backup to restore your message history if you lose this device
              or sign in on a new one. You&apos;ll get a one-time recovery key.
              Collab can never read your backup or recover the key for you.
            </p>
            <button
              className="zo"
              disabled={busy === "__backup_enable__"}
              onClick={onSetUpBackup}
            >
              {busy === "__backup_enable__" ? "Setting up…" : "Set up backup"}
            </button>
          </div>
        )}

        {/* Restore-from-backup affordance — always reachable (a new/reset device
            with a server backup but no local key surfaces this to recover). */}
        {!newKey && (
          <div style={{ marginTop: 14 }}>
            {!showRestore ? (
              <button
                className="zo"
                onClick={() => {
                  setShowRestore(true);
                  setRestoreMsg(null);
                }}
              >
                Restore from backup
              </button>
            ) : (
              <div>
                <p style={{ fontSize: 12, color: "var(--g500)", lineHeight: 1.6, margin: "0 0 8px" }}>
                  Enter your recovery key to restore your messages on this device.
                </p>
                <input
                  type="text"
                  value={restoreInput}
                  onChange={(e) => setRestoreInput(e.target.value)}
                  placeholder="ABCD-EFGH-…"
                  spellCheck={false}
                  autoCapitalize="characters"
                  style={{
                    width: "100%",
                    boxSizing: "border-box",
                    fontFamily: "monospace",
                    fontSize: 14,
                    padding: "10px 12px",
                    borderRadius: 8,
                    border: "1px solid var(--border, rgba(0,0,0,0.12))",
                    margin: "0 0 10px",
                  }}
                />
                <div style={{ display: "flex", gap: 8 }}>
                  <button
                    className="zo"
                    disabled={busy === "__backup_restore__" || !restoreInput.trim()}
                    onClick={onRestore}
                  >
                    {busy === "__backup_restore__" ? "Restoring…" : "Restore"}
                  </button>
                  <button
                    className="zo"
                    disabled={busy === "__backup_restore__"}
                    onClick={() => {
                      setShowRestore(false);
                      setRestoreInput("");
                    }}
                  >
                    Cancel
                  </button>
                </div>
              </div>
            )}
          </div>
        )}

        {restoreMsg && (
          <p
            style={{
              fontSize: 12,
              lineHeight: 1.6,
              marginTop: 10,
              color: restoreMsg.kind === "ok" ? "var(--g500)" : "var(--danger, #e5484d)",
            }}
          >
            {restoreMsg.text}
          </p>
        )}
      </div>

      {/* ── Recovery passphrase (Slice 2) — memorable, no recovery key to store,
             works for SSO users, restores a brand-new device on its own. ── */}
      <div
        style={{
          marginTop: 18,
          paddingTop: 16,
          borderTop: "1px solid var(--border, rgba(0,0,0,0.08))",
        }}
      >
        <h4 style={{ margin: "0 0 6px", fontSize: 13 }}>Recovery passphrase</h4>
        <p style={{ fontSize: 12, color: "var(--g500)", lineHeight: 1.6, margin: "0 0 10px" }}>
          Set a passphrase you&apos;ll remember. A new device can restore your full
          message history from just this passphrase — no recovery key to save and no
          other device needed. Collab never sees your passphrase and can&apos;t reset
          it for you.
        </p>
        {passState?.has ? (
          <p style={{ fontSize: 12, color: "var(--g500)", margin: "0 0 10px" }}>
            ✓ A recovery passphrase is set for your account.
          </p>
        ) : null}
        {passState?.canEnroll ? (
          !showPassSet ? (
            <button
              className="zo"
              onClick={() => {
                setShowPassSet(true);
                setPassMsg(null);
              }}
            >
              {passState?.has ? "Change recovery passphrase" : "Set a recovery passphrase"}
            </button>
          ) : (
            <div>
              <input
                type="password"
                value={passInput}
                onChange={(e) => setPassInput(e.target.value)}
                placeholder="Recovery passphrase (at least 8 characters)"
                autoComplete="new-password"
                style={{
                  width: "100%",
                  boxSizing: "border-box",
                  fontSize: 14,
                  padding: "10px 12px",
                  borderRadius: 8,
                  border: "1px solid var(--border, rgba(0,0,0,0.12))",
                  margin: "0 0 8px",
                }}
              />
              <input
                type="password"
                value={passConfirm}
                onChange={(e) => setPassConfirm(e.target.value)}
                placeholder="Confirm passphrase"
                autoComplete="new-password"
                style={{
                  width: "100%",
                  boxSizing: "border-box",
                  fontSize: 14,
                  padding: "10px 12px",
                  borderRadius: 8,
                  border: "1px solid var(--border, rgba(0,0,0,0.12))",
                  margin: "0 0 10px",
                }}
              />
              <div style={{ display: "flex", gap: 8 }}>
                <button
                  className="zo"
                  disabled={busy === "__pass_set__"}
                  onClick={onSetPassphrase}
                >
                  {busy === "__pass_set__" ? "Saving…" : "Save passphrase"}
                </button>
                <button
                  className="zo"
                  disabled={busy === "__pass_set__"}
                  onClick={() => {
                    setShowPassSet(false);
                    setPassInput("");
                    setPassConfirm("");
                  }}
                >
                  Cancel
                </button>
              </div>
            </div>
          )
        ) : (
          <p style={{ fontSize: 12, color: "var(--g500)", lineHeight: 1.6, margin: "0 0 10px" }}>
            To set a passphrase, open your chats so this device finishes syncing your
            history first, then come back here.
          </p>
        )}

        {/* Restore-with-passphrase — the new/reset-device path. */}
        <div style={{ marginTop: 10 }}>
          {!showPassRestore ? (
            <button
              className="zo"
              onClick={() => {
                setShowPassRestore(true);
                setPassMsg(null);
              }}
            >
              Restore with passphrase
            </button>
          ) : (
            <div>
              <p style={{ fontSize: 12, color: "var(--g500)", lineHeight: 1.6, margin: "0 0 8px" }}>
                Enter your recovery passphrase to restore your messages on this device.
              </p>
              <input
                type="password"
                value={passRestoreInput}
                onChange={(e) => setPassRestoreInput(e.target.value)}
                placeholder="Recovery passphrase"
                autoComplete="off"
                style={{
                  width: "100%",
                  boxSizing: "border-box",
                  fontSize: 14,
                  padding: "10px 12px",
                  borderRadius: 8,
                  border: "1px solid var(--border, rgba(0,0,0,0.12))",
                  margin: "0 0 10px",
                }}
              />
              <div style={{ display: "flex", gap: 8 }}>
                <button
                  className="zo"
                  disabled={busy === "__pass_restore__" || !passRestoreInput.trim()}
                  onClick={onRestorePassphrase}
                >
                  {busy === "__pass_restore__" ? "Restoring…" : "Restore"}
                </button>
                <button
                  className="zo"
                  disabled={busy === "__pass_restore__"}
                  onClick={() => {
                    setShowPassRestore(false);
                    setPassRestoreInput("");
                  }}
                >
                  Cancel
                </button>
              </div>
            </div>
          )}
        </div>

        {passState?.has && passState?.canEnroll ? (
          <button
            className="zo"
            style={{ marginTop: 10 }}
            disabled={busy === "__pass_remove__"}
            onClick={onRemovePassphrase}
          >
            {busy === "__pass_remove__" ? "Removing…" : "Remove passphrase"}
          </button>
        ) : null}

        {passMsg && (
          <p
            style={{
              fontSize: 12,
              lineHeight: 1.6,
              marginTop: 10,
              color: passMsg.kind === "ok" ? "var(--g500)" : "var(--danger, #e5484d)",
            }}
          >
            {passMsg.text}
          </p>
        )}
      </div>

      <div
        style={{
          marginTop: 18,
          paddingTop: 16,
          borderTop: "1px solid var(--border, rgba(0,0,0,0.08))",
        }}
      >
        <h4 style={{ margin: "0 0 6px", fontSize: 13 }}>
          Reset encryption on this device
        </h4>
        <p style={{ fontSize: 12, color: "var(--g500)", lineHeight: 1.6, margin: "0 0 10px" }}>
          <strong>Last resort.</strong> Only use this if a chat shows
          &quot;not available on this device&quot; or you can send but not
          receive. It re-enrolls this device with fresh keys and reloads.
        </p>
        <p
          style={{
            fontSize: 12,
            color: "var(--danger, #e5484d)",
            lineHeight: 1.6,
            margin: "0 0 10px",
          }}
        >
          <IconAlertTriangle size={13} style={{ verticalAlign: "-2px", marginRight: 4 }} /> Messages encrypted before now may become unreadable <em>on this
          device</em> unless another of your signed-in devices is online to
          re-sync them. Nothing is deleted from the server, and the people you
          chat with are unaffected.
        </p>
        {!confirmReset ? (
          <button
            className="zo"
            disabled={busy === "__reset__"}
            onClick={() => setConfirmReset(true)}
          >
            Reset encryption on this device
          </button>
        ) : (
          <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
            <span style={{ fontSize: 12, color: "var(--g500)" }}>Are you sure?</span>
            <button
              className="zo danger"
              disabled={busy === "__reset__"}
              onClick={doReset}
            >
              {busy === "__reset__" ? "Resetting…" : "Yes, reset & reload"}
            </button>
            <button
              className="zo"
              disabled={busy === "__reset__"}
              onClick={() => setConfirmReset(false)}
            >
              Cancel
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
