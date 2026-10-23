"use client";
import React, { useEffect, useState } from "react";
import { IconLock } from "../../lib/icons";
import {
  isE2EEEnabled,
  restoreHistoryWithSecret,
  getBackupCapabilities,
  deviceNeedsHistoryRestore,
  rearmRecovery,
  getRecoveryPathsCached,
  loadRecoveryPaths,
  subscribeRecoveryPaths,
  invalidateRecoveryPaths,
  getRecoveryState,
  subscribeRecoveryState,
  autoRecoverHistory,
  getE2EEToken,
  getRedeliveryRowStatus,
  loadRedeliveryStatus,
  subscribeRedeliveryStatus,
  type E2EERecoveryPaths,
  type BackupCapabilities,
  type RecoveryState,
} from "../../lib/e2ee/manager";
import { credentialPrompt } from "../../lib/e2ee/restorePlan";

// Recovery is AUTOMATIC. A message this device can't decrypt yet is never a
// dead end and never a "Try again" button: the manager runs every source it
// can open without asking (its cached backup key, the desktop-keychain copy of
// the secret, sibling devices) at init, on reconnect and whenever a gap is hit,
// and publishes what it is doing. These components only REFLECT that state:
//
//   • restoring  — a pass is running: show a calm spinner row.
//   • done       — this device holds a key; anything still pending is on its
//                  way (sibling bundles land asynchronously): keep the spinner.
//   • exhausted  — every automatic source was tried and the device STILL has no
//                  key. Two honest sub-states:
//       – a backup exists that only a typed credential can open → the banner
//         offers ONE unlock (password / passphrase / recovery key). This is the
//         one case a server-blind backup cannot make automatic.
//       – no backup and no other device → the key exists nowhere; say so.
//
// The recovery-paths lookup (backup? siblings?) is shared and cached in the
// manager — a thread can hold hundreds of pending rows and they must not each
// hit the API.
function useRecoveryPaths(): E2EERecoveryPaths | null {
  const [paths, setPaths] = useState<E2EERecoveryPaths | null>(() =>
    isE2EEEnabled() ? getRecoveryPathsCached() : null,
  );
  useEffect(() => {
    if (!isE2EEEnabled()) return;
    let alive = true;
    const un = subscribeRecoveryPaths((v) => alive && setPaths(v));
    let retry: ReturnType<typeof setTimeout> | undefined;
    const run = () =>
      void loadRecoveryPaths()
        .then((v) => {
          if (!alive) return;
          setPaths(v);
          // Built from a failed lookup: ask again shortly instead of waiting
          // for the next render to stumble on it.
          if (!v.verified) retry = setTimeout(run, 8_000);
        })
        .catch(() => {
          if (alive) retry = setTimeout(run, 8_000);
        });
    run();
    return () => {
      alive = false;
      if (retry) clearTimeout(retry);
      un();
    };
  }, []);
  return paths;
}

/** The manager's live automatic-recovery state. Shared by every pending row. */
export function useRecoveryState(): RecoveryState {
  const [s, setS] = useState<RecoveryState>(() => getRecoveryState());
  useEffect(() => {
    let alive = true;
    const un = subscribeRecoveryState((v) => alive && setS(v));
    setS(getRecoveryState());
    return () => {
      alive = false;
      un();
    };
  }, []);
  return s;
}

/** Is an automatic pass running, or is a held key still filling rows in? */
function stillRestoring(rec: RecoveryState): boolean {
  // idle: init hasn't reported yet. restoring: a pass is running. done: this
  // device holds a key (or just merged something) and remaining rows fill in
  // as the thread refetches / sibling bundles land. Only "exhausted" — every
  // automatic source tried, still no key — must NOT show a spinner: nothing is
  // running, and a spinner over nothing is the lie the old copy told.
  return rec.phase !== "exhausted";
}

// Props are accepted for call-site compatibility; the row is driven entirely by
// the shared recovery state, so none of them are read.
export function EncryptedPendingRow(_props: {
  m: any;
  isMobile?: boolean;
  onRetryLoad?: () => void;
}) {
  const e2eeOn = isE2EEEnabled();
  const paths = useRecoveryPaths();
  const recShared = useRecoveryState();
  const m = _props.m || {};
  // Is anyone LEFT who could still send this row? The server knows which
  // member devices have been online since the ask; when all of them have and
  // the ask is still open, no device holds this message any more and the row
  // must say so instead of spinning forever.
  const [, bump] = useState(0);
  useEffect(() => {
    if (!e2eeOn || !m._redeliveryPending || !m.conversationId) return;
    const un = subscribeRedeliveryStatus(() => bump((n) => n + 1));
    void loadRedeliveryStatus(String(m.conversationId));
    const t = setInterval(() => void loadRedeliveryStatus(String(m.conversationId)), 45_000);
    return () => {
      un();
      clearInterval(t);
    };
  }, [e2eeOn, m._redeliveryPending, m.conversationId]);
  const rowStatus = m._redeliveryPending && m.conversationId && m.id
    ? getRedeliveryRowStatus(String(m.conversationId), String(m.id))
    : null;
  // A sender re-delivery has been asked for THIS message: something is
  // genuinely in flight for it even when the shared backup/sibling pass has
  // nothing left to try, so keep the calm restoring row.
  const rec: RecoveryState =
    m._redeliveryPending && recShared.phase === "exhausted"
      ? { ...recShared, phase: "idle" }
      : recShared;
  if (e2eeOn && rowStatus && rowStatus.unanswerable) {
    return (
      <div className="msg-locked" style={{ fontStyle: "italic", opacity: 0.75 }}>
        <span
          style={{ display: "inline-flex", alignItems: "center", gap: 6 }}
          title="Every device that could still hold this message has been online since it was requested and none of them has it. It was encrypted for a device whose keys are gone."
        >
          <IconLock size={13} aria-hidden />
          No device has this message any more
        </span>
      </div>
    );
  }
  if (!e2eeOn) {
    return (
      <div className="msg-locked" style={{ fontStyle: "italic", opacity: 0.75 }}>
        <span style={{ display: "inline-flex", alignItems: "center", gap: 5 }}>
          <IconLock size={13} aria-hidden />
          Encrypted message
        </span>
      </div>
    );
  }
  // Until the answer is known, say the neutral thing rather than guessing —
  // claiming "can't be recovered" and then recovering it a second later would be
  // worse than saying nothing.
  // A re-delivery ask for THIS message is open: the sender or a member may still
  // answer it, so it is not lost. Only the server's "unanswerable" verdict
  // (handled above) ends that.
  const terminal = paths ? !paths.recoverable && !m._redeliveryPending : false;
  const restoring = !terminal && stillRestoring(rec);
  return (
    <div className="msg-locked" style={{ fontStyle: "italic", opacity: 0.75 }}>
      <span
        style={{ display: "inline-flex", alignItems: "center", gap: 6 }}
        title={
          terminal
            ? "This message was encrypted for a device that is no longer signed in, and there is no chat backup to restore it from."
            : restoring
              ? "Restoring this message from your encrypted backup or your other devices."
              : paths && paths.hasBackup
                ? "Encrypted. It appears once your backup is unlocked on this device."
                : "Encrypted. It appears once one of your other devices is online."
        }
        aria-live="polite"
      >
        {restoring ? (
          <span className="e2ee-restore-spin" style={{ width: 12, height: 12 }} aria-hidden />
        ) : (
          <IconLock size={13} aria-hidden />
        )}
        {terminal
          ? "Message can’t be recovered on this device"
          : restoring
            ? "Restoring…"
            : "Encrypted message"}
      </span>
    </div>
  );
}

// Dismissing is per-SESSION and app-wide, not per-conversation: a device that
// needs unlocking needs it in every thread, so hiding the prompt in one and
// having it reappear in the next would be nagging, not helping.
let unlockPromptDismissed = false;

export function E2EERestoreBanner({
  conversationId,
  onRetryLoad,
  hasPendingMessages = false,
}: {
  conversationId?: string;
  onRetryLoad?: () => void;
  /** True when the open thread is showing at least one undecryptable row. */
  hasPendingMessages?: boolean;
}) {
  const e2eeOn = isE2EEEnabled();
  const paths = useRecoveryPaths();
  const rec = useRecoveryState();
  const [showModal, setShowModal] = useState(false);
  const [passInput, setPassInput] = useState("");
  const [passErr, setPassErr] = useState<string | null>(null);
  const [passOk, setPassOk] = useState<string | null>(null);
  const [passBusy, setPassBusy] = useState(false);
  // Which credentials this account has, so the box asks for the right thing.
  const [caps, setCaps] = useState<BackupCapabilities | null>(null);
  // Does this device still lack a backup key while a backup exists? Kept
  // separate from the pending-row check: a brand-new device can be sitting on an
  // EMPTY thread and still have history waiting to be unlocked.
  const [needsKey, setNeedsKey] = useState(false);
  const [dismissed, setDismissed] = useState(unlockPromptDismissed);

  useEffect(() => {
    if (!isE2EEEnabled()) return;
    let alive = true;
    void getBackupCapabilities().then((c) => alive && setCaps(c)).catch(() => {});
    void deviceNeedsHistoryRestore().then((n) => alive && setNeedsKey(n)).catch(() => {});
    return () => {
      alive = false;
    };
    // Re-check whenever a recovery pass finishes — it may have just obtained the key.
  }, [rec.phase, rec.at]);

  if (!e2eeOn) return null;
  const terminal = paths ? !paths.recoverable : false;
  const restoring = rec.phase === "restoring";
  // Every automatic source was tried, this device holds no key, and a backup
  // exists that a typed credential could open.
  const needsUnlock =
    !terminal &&
    rec.phase === "exhausted" &&
    (rec.credentialCouldUnlock || needsKey) &&
    !!(caps && caps.hasBackup);

  // Nothing to say: no unreadable rows in view and nothing waiting to be unlocked.
  // (A recovery pass with nothing pending in THIS thread stays invisible — a
  // reconnect must not flash a banner on every healthy conversation.)
  if (!hasPendingMessages && !needsUnlock) return null;
  // A pass is running, or the device holds a key and rows are filling in: a
  // quiet progress line, no buttons.
  if (restoring || (!needsUnlock && !terminal && rec.phase !== "exhausted")) {
    if (!hasPendingMessages) return null;
    return (
      <div className="e2ee-banner e2ee-banner-progress" role="status" aria-live="polite">
        <span className="e2ee-restore-spin" style={{ width: 14, height: 14, flexShrink: 0 }} aria-hidden />
        <span>{"Restoring your messages…"}</span>
      </div>
    );
  }
  // Exhausted with no backup to unlock but another device exists: nothing is
  // running, so say what will actually make these appear — no spinner.
  if (!needsUnlock && !terminal) {
    if (!hasPendingMessages) return null;
    return (
      <div className="e2ee-banner e2ee-banner-progress" role="status">
        <IconLock size={14} style={{ color: "#4f46e5", flexShrink: 0 }} />
        <span>These messages appear automatically once one of your other devices is online.</span>
      </div>
    );
  }
  if (dismissed && !terminal) return null;

  const handleUnlock = async () => {
    if (!passInput.trim()) return;
    setPassBusy(true);
    setPassErr(null);
    setPassOk(null);
    try {
      // The app stores its session token as "clb_token" (tokenStore); the old
      // lookup of "token" was always empty, so Unlock failed for everyone with
      // "Authentication token missing". Prefer the device-bound token E2EE runs with.
      const token =
        getE2EEToken() ||
        (typeof window !== "undefined" ? localStorage.getItem("clb_token") || "" : "");
      if (!token) throw new Error("Authentication token missing.");
      // ONE field, every credential the account actually holds (password wrap,
      // passphrase wrap, recovery key) — the user need not know which they have.
      const res = await restoreHistoryWithSecret(token, passInput.trim());
      setPassInput("");
      rearmRecovery(conversationId);
      // The unlock just gave this device its key — let the orchestrator record
      // that (phase → done) and pull anything else that is now openable.
      invalidateRecoveryPaths();
      void loadRecoveryPaths(true).catch(() => {});
      void autoRecoverHistory({ force: true, reason: "unlock" }).catch(() => {});
      setNeedsKey(false);
      setPassOk(
        res.restored > 0
          ? `Restored ${res.restored} message${res.restored === 1 ? "" : "s"}.`
          : "Backup unlocked. Your messages will fill in from here.",
      );
      onRetryLoad && onRetryLoad();
      setTimeout(() => setShowModal(false), 1200);
    } catch (err: any) {
      setPassErr(err.message || "That didn’t match. Check it and try again.");
    } finally {
      setPassBusy(false);
    }
  };

  return (
    <div className="e2ee-banner">
      <div style={{ display: "flex", alignItems: "center", gap: 10, fontSize: 13, color: "var(--fg)" }}>
        <IconLock size={16} style={{ color: "#4f46e5", flexShrink: 0 }} />
        <span>
          {terminal
            ? "Some earlier messages here were encrypted for a device that is no longer signed in, and there is no chat backup to restore them from — they can’t be shown on this device. New messages appear normally. Chat Backup is on, so this can’t happen to your next device."
            : caps && caps.hasPasswordWrap
              ? "Your encrypted message history is backed up. Unlock it once with your sign-in password to show it on this device."
              : "Your encrypted message history is backed up. Unlock it once with your recovery passphrase or recovery key to show it on this device."}
        </span>
      </div>
      {terminal ? null : (
        <div style={{ display: "flex", gap: 8, flexShrink: 0 }}>
          <button
            type="button"
            className="btn-p"
            onClick={() => {
              setPassErr(null);
              setPassOk(null);
              setShowModal(true);
            }}
            style={{ height: 30, fontSize: 12, padding: "0 14px", background: "#4f46e5", color: "#fff", border: "none" }}
          >
            Unlock
          </button>
          <button
            type="button"
            className="btn-s"
            onClick={() => {
              unlockPromptDismissed = true;
              setDismissed(true);
            }}
            style={{ height: 30, fontSize: 12, padding: "0 12px" }}
            title="Hide until you sign in again — your history stays restorable from Settings › Security"
          >
            Later
          </button>
        </div>
      )}

      {showModal ? (
        <div
          style={{
            position: "fixed",
            inset: 0,
            zIndex: 9999,
            background: "rgba(0,0,0,0.45)",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            backdropFilter: "blur(2px)",
          }}
          onClick={() => setShowModal(false)}
        >
          <div
            style={{
              background: "var(--bg, #fff)",
              borderRadius: 12,
              padding: 24,
              width: 400,
              maxWidth: "90vw",
              boxShadow: "0 12px 32px rgba(0,0,0,0.2)",
            }}
            onClick={(e) => e.stopPropagation()}
          >
            <div style={{ fontSize: 16, fontWeight: 600, marginBottom: 8, color: "var(--fg)" }}>
              Unlock your message history
            </div>
            <div style={{ fontSize: 13, opacity: 0.75, marginBottom: 16, color: "var(--fg)" }}>
              {caps && caps.hasPasswordWrap
                ? "Enter your sign-in password to unlock your encrypted backup. Every message, photo, file and voice note is restored to this device, and it stays unlocked from now on. A recovery passphrase or recovery key works too."
                : "Enter your recovery passphrase or recovery key to unlock your encrypted backup. Every message and attachment is restored to this device, and it stays unlocked from now on."}
            </div>
            <input
              type="password"
              placeholder={caps ? credentialPrompt(caps) : "Password, passphrase or recovery key"}
              value={passInput}
              onChange={(e) => setPassInput(e.target.value)}
              style={{
                width: "100%",
                padding: "8px 12px",
                fontSize: 14,
                borderRadius: 6,
                border: "1px solid #ccc",
                marginBottom: 12,
                boxSizing: "border-box",
              }}
              onKeyDown={(e) => e.key === "Enter" && handleUnlock()}
              autoFocus
            />
            {passErr ? (
              <div style={{ color: "#ef4444", fontSize: 12, marginBottom: 12 }}>
                {passErr}
              </div>
            ) : null}
            {passOk ? (
              <div style={{ color: "#0f6e56", fontSize: 12, marginBottom: 12, fontWeight: 600 }}>
                {passOk}
              </div>
            ) : null}
            <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
              <button
                type="button"
                className="btn-s"
                onClick={() => {
                  setShowModal(false);
                  setPassErr(null);
                  setPassOk(null);
                }}
                style={{ height: 32, padding: "0 14px" }}
              >
                Cancel
              </button>
              <button
                type="button"
                className="btn-p"
                disabled={passBusy || !passInput.trim()}
                onClick={handleUnlock}
                style={{ height: 32, padding: "0 18px", background: "#10b981", color: "#fff", border: "none" }}
              >
                {passBusy ? "Unlocking…" : "Unlock"}
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
