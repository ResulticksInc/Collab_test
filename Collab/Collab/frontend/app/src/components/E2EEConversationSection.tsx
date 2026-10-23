import { useEffect, useState } from "react";
import {
  isE2EEEnabled,
  getSafetyNumber,
  hasIdentityChanged,
  getKeyChangedUserIds,
  acceptIdentityChange,
  markIdentityVerified,
  isIdentityVerified,
  clearIdentityVerification,
} from "../lib/e2ee/manager";
import { IconLock, IconCheck } from "../lib/icons";

/**
 * Per-conversation encryption section for the chat Details panel. Self-gates on
 * isE2EEEnabled() (renders nothing when E2EE is OFF, the product default), so it
 * is safe to mount in the live build. When ON it surfaces the identity-trust
 * state where it belongs — inside the conversation:
 *  - DM: the out-of-band SECURITY CODE (safety number) to compare with the peer,
 *    plus a key-change (MITM) alert with an explicit "accept new code" re-pin.
 *  - Group/channel: encrypted status + a member key-change alert.
 */
export default function E2EEConversationSection({
  conversation,
  meId,
  token,
}: {
  conversation: any;
  meId: string | null;
  token: string | null;
}) {
  const enabled = isE2EEEnabled();
  const kind = conversation && conversation.kind;
  const isDm = kind === "dm";
  const isGroupish = kind === "group" || kind === "channel";
  const members: string[] = (conversation && conversation.members) || [];
  const peerId = isDm ? members.find((m) => m !== meId) || null : null;
  const convId = conversation && conversation.id;

  const [code, setCode] = useState<string | null>(null);
  const [changed, setChanged] = useState(false);
  const [busy, setBusy] = useState(false);
  const [revealed, setRevealed] = useState(false);
  // Out-of-band verification state for THIS DM's peer. `verified` = user clicked
  // "Mark verified" after comparing the safety code; `mismatch` = the peer's
  // identity key has since changed (verifiedFingerprint != current fingerprint)
  // — surface as "Verified key changed — re-verify".
  const [verifyState, setVerifyState] = useState<{ verified: boolean; mismatch: boolean }>({
    verified: false,
    mismatch: false,
  });

  useEffect(() => {
    if (!enabled || !token) return;
    let alive = true;
    if (isDm && peerId) {
      setChanged(hasIdentityChanged(peerId));
      getSafetyNumber(token, peerId)
        .then((c) => {
          if (alive) setCode(c);
        })
        .catch(() => {});
      isIdentityVerified(token, peerId)
        .then((s) => {
          if (alive) setVerifyState(s);
        })
        .catch(() => {});
    } else if (isGroupish) {
      const ch = getKeyChangedUserIds();
      setChanged(ch.some((u) => members.includes(u)));
    }
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, token, isDm, isGroupish, peerId, convId]);

  if (!enabled || kind === "self") return null;

  const acceptDm = async () => {
    if (!token || !peerId) return;
    setBusy(true);
    try {
      await acceptIdentityChange(token, peerId);
      setChanged(false);
      const c = await getSafetyNumber(token, peerId);
      setCode(c);
      // Re-pinning a CHANGED identity invalidates any prior verification — the
      // user verified the OLD key, not this one. Clear so they re-verify.
      await clearIdentityVerification(token, peerId);
      setVerifyState({ verified: false, mismatch: false });
    } finally {
      setBusy(false);
    }
  };
  const verifyDm = async () => {
    if (!token || !peerId) return;
    setBusy(true);
    try {
      const ok = await markIdentityVerified(token, peerId);
      if (ok) setVerifyState({ verified: true, mismatch: false });
    } finally {
      setBusy(false);
    }
  };
  const unverifyDm = async () => {
    if (!token || !peerId) return;
    setBusy(true);
    try {
      await clearIdentityVerification(token, peerId);
      setVerifyState({ verified: false, mismatch: false });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div
      style={{
        padding: "16px 0 4px",
        borderTop: "1px solid rgba(128,128,128,0.18)",
        marginTop: 8,
      }}
    >
      <div
        style={{
          fontWeight: 600,
          fontSize: 13,
          marginBottom: 8,
          display: "flex",
          alignItems: "center",
          gap: 6,
        }}
      >
        <IconLock size={14} />
        End-to-end encrypted
      </div>
      <p
        style={{
          fontSize: 12,
          color: "var(--g500)",
          lineHeight: 1.6,
          margin: "0 0 10px",
        }}
      >
        {isDm
          ? "Messages and attachments in this chat are encrypted on your devices. Compare the security code below with this contact to confirm no one is intercepting."
          : "Messages and attachments in this " +
            (kind === "channel" ? "channel" : "group") +
            " are encrypted on members' devices."}
      </p>

      {changed && (
        <div
          style={{
            border: "1px solid var(--danger,#e5484d)",
            borderRadius: 8,
            padding: 10,
            marginBottom: 10,
          }}
        >
          <div style={{ fontWeight: 600, fontSize: 12, marginBottom: 6 }}>
            Security code changed
          </div>
          <p style={{ fontSize: 11, lineHeight: 1.6, margin: "0 0 8px" }}>
            {isDm
              ? "This contact's encryption identity changed (a reinstall or new device — or, rarely, interception). Confirm with them out of band before continuing."
              : "A member's encryption identity changed. Review before continuing."}
          </p>
          {isDm && (
            <button className="zo" disabled={busy} onClick={acceptDm}>
              {busy ? "…" : "Accept new code"}
            </button>
          )}
        </div>
      )}

      {isDm && code && (
        <div>
          {/* OOB verification state. Three visual states:
              - Not verified yet  → grey hint
              - Verified          → green check + "Verified" + Unverify
              - Verified+mismatch → amber warning: key changed since verification */}
          {verifyState.verified && !verifyState.mismatch && (
            <div
              style={{
                display: "flex",
                alignItems: "center",
                gap: 6,
                fontSize: 12,
                color: "var(--success,#2bb673)",
                marginBottom: 8,
                fontWeight: 600,
              }}
            >
              <IconCheck size={14} />
              Verified
              <button
                className="zo"
                onClick={unverifyDm}
                disabled={busy}
                style={{ marginLeft: "auto", fontSize: 11, padding: "2px 8px" }}
              >
                Unverify
              </button>
            </div>
          )}
          {verifyState.verified && verifyState.mismatch && (
            <div
              style={{
                border: "1px solid var(--warning,#f5a623)",
                borderRadius: 8,
                padding: 10,
                marginBottom: 10,
              }}
            >
              <div style={{ fontWeight: 600, fontSize: 12, marginBottom: 6 }}>
                Verified key changed
              </div>
              <p style={{ fontSize: 11, lineHeight: 1.6, margin: "0 0 8px" }}>
                You previously verified this contact's encryption identity, but it
                has changed. Compare the new security code below and re-verify.
              </p>
              <button className="zo" disabled={busy} onClick={unverifyDm}>
                Clear verification
              </button>
            </div>
          )}
          <button
            className="zo"
            onClick={() => setRevealed((r) => !r)}
            style={{ marginBottom: 8 }}
          >
            {revealed ? "Hide security code" : "Show security code"}
          </button>
          {revealed && (
            <div
              style={{
                fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
                fontSize: 13,
                letterSpacing: 1,
                background: "rgba(128,128,128,0.12)",
                borderRadius: 8,
                padding: "10px 12px",
                wordBreak: "break-word",
                lineHeight: 1.7,
              }}
            >
              {code}
            </div>
          )}
          {revealed && !verifyState.verified && (
            <button
              className="zo"
              disabled={busy}
              onClick={verifyDm}
              style={{ marginTop: 8 }}
            >
              {busy ? "…" : "Mark as verified"}
            </button>
          )}
        </div>
      )}
    </div>
  );
}
