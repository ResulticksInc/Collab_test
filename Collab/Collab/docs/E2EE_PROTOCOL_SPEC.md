# CoLab E2EE Protocol Specification: Native WebCrypto Edition (v3)

This document outlines the detailed protocol design for implementing End-to-End Encryption (E2EE) using native browser `crypto.subtle` APIs, replacing the failed `@signalapp/libsignal-client` implementation.

## 1. Objectives
*   **Browser Compatibility**: Zero dependence on Node.js globals, NAPI, or large WASM blobs.
*   **Forward Secrecy**: Forward secrecy is achieved via the Symmetric Ratchet. A compromise of current keys does not compromise past messages.
*   **Multi-Device Support**: Reliable fanout and session synchronization across user devices.
*   **High Performance**: Utilization of hardware-accelerated WebCrypto APIs.

---

## 2. Identity Layer (The Trust Root)
Every device acts as an independent cryptographic entity.

### 2.1 Key Types
*   **Long-term Identity Key ($\text{IK}$)**: `ECDH P-256` key pair generated once per device. $\text{IK}_{\text{pub}}$ is the permanent identifier for that device.
*   **Signed PreKey ($\text{SPK}$)**: A medium-term `ECDH P-256` key pair, signed by $\text{IK}$, rotated every 7 days.
*   **One-Time PreKeys ($\text{OPK}$)**: A pool of `ECDH P-256` keys uploaded to the server and consumed on a first-come, first-served basis.

### 2.2 Registration Flow
1.  Device generates $\text{IK}$, $\text{IK}_{\text{priv}}$ is stored in IndexedDB.
2.  Device generates $\text{SPK}$ and calculates $\sigma = \text{Sign}(\text{IK}_{\text{priv}}, \text{SPK}_{\text{pub}})$.
3.  Device generates $N$ $\text{OPKs}$.
4.  Server stores: $\{\text{UserID, DeviceID}, \text{IK}_{\text{pub}}, \text{SPK}_{\text{pub}}, \sigma, [\text{OPK}_{1\dots N}]\}$.

### 2.3 Trust Model (MITM Protection)
*   **Trust On First Use (TOFU)**: The system implements TOFU. Upon first session establishment, the receiver's $\text{IK}_{\text{pub}}$ is cached locally.
*   **Fingerprint/Safety Number**: A "Safety Number" ($\text{IK}_{\text{pub\_Sender}} || \text{IK}_{\text{pub\_Receiver}}$) hashed into a 60-digit number for out-of-band verification.
*   **Key Change Alerts**: If the server provides an $\text{IK}_{\text{pub}}$ that differs from cached version, the same session is viewed as "untrusted" and encryption is blocked until user acknowledges change.

---

## 3. Session Layer (X3DH + Symmetric Ratchet)
We implement an X3DH (Extended Triple Diffie-Hellman) variant for asynchronous session establishment and a Symmetric-Key Ratchet for message encryption.

### 3.1 Session Establishment (Handshake)
To start a session, the Sender performs 4 DH exchanges using an ephemeral key pair ($\text{EK}$):
*   $DH_1 = \text{ECDH}(\text{Sender\_IK}_{\text{priv}}, \text{Receiver\_SPK}_{\text{pub}})$
*   $DH_2 = \text{ECDH}(\text{Sender\_EK}_{\text{priv}}, \text{Receiver\_IK}_{\text{pub}})$
*   $DH_3 = \text{ECDH}(\text{Sender\_EK}_{\text{priv}}, \text{Receiver\_SPK}_{\text{pub}})$
*   $DH_4 = \text{ECDH}(\text{Sender\_EK}_{\text{priv}}, \text{Receiver\_OPK}_{\text{pub}})$ (if available)

**Root Key Derivation**: 
$\text{RootKey} = \text{HKDF}(\text{Salt}=\text{None}, \text{IKM}=DH_1 || DH_2 || DH_3 || DH_4)$

### 3.2 Message Keys & Forward Secrecy (Symmetric Ratchet)
Every message advances the ratchet. Every encryption operation derives a new key from the chain:
*   $(\text{NextChainKey}, \text{MessageKey}) = \text{HKDF}(\text{CurrentChainKey})$
*   **Forward Secrecy**: `MessageKey` is deleted immediately after use.
*   **Handling Gaps (Offline Delivery)**: 
    - If a message arrives with sequence $N+5$, the receiver derives and stores keys for sequences $N+1 \dots N+4$.
    - **Max Window**: Skipped keys are cached for up to 100 messages.
    - **Out-of-Order delivery**: Messages arriving within the window are decrypted using cached keys; others are discarded.

---

## 4. Message Layer (The Envelope)
Messages are transmitted as opaque envelopes.

### 4.1 Envelope Schema
```json
{
  "version": 1,
  "senderDeviceId": "string",
  "recipientDeviceId": "string",
  "ciphertext": "base64_aes_gcm_payload",
  "iv": "base64_nonce",
  "keyId": "ratchet_step_identifier",
  "keyVersion": 1,
  "seq": "number",
  "timestamp": "number"
}
```

### 4.2 Security Mechanisms
Symmetric encryption is performed using `AES-GCM 256-bit` (Authenticated Encryption).
*   **IV Handling**: $\text{IV}$ is a unique 96-bit nonce generated via `crypto.getRandomValues()`.
*   **Replay Protection**:
    - **Duplicate Detection**: The receiver maintains a sliding window of seen sequence numbers per device session.
    - **Replay Cache Policy**: The cache expires when the ratchet advances significantly or after 24 hours of inactivity.

---

## 5. Multi-Device & Recovery Layer

### 5.1 Device Registration & Security
*   **Enrollment Flow**: When adding a second device, the existing trusted device must approve it. The primary device generates an `EnrollmentKey` and sends it to the server wrapped in E2EE’s 1-to-1 session.
*   **Server Blindness**: The server cannot silently add devices because any message sent to such a "ghost" device will fail decryption at the client level.

### 5.2 Recovery & Resilience
Symmetric key states are stored in IndexedDB. If browser storage is cleared, all existing sessions are invalidated. The user must re-register as a new device. Past messages can only be recovered if the user has an exported backup of their `RootKey` (optional feature).

---

## 6. Media Layer (Hybrid Encryption)
Large binaries are not encrypted with session keys directly to avoid overhead and memory issues.

### 6.1 File encryption flow
1.  **CEK Generation**: Generate random 256-bit Content Encryption Key ($\text{CEK}$).
2.  **Data Encryption**: $\text{CipherFile} = \text{AES-GCM}(\text{CEK}, \text{PlainFile})$.
3.  **Upload**: Upload `CipherFile` to the server's storage.
4.  **Key Wrapping**: The $\text{CEK}$ is encrypted using the E2EE Message Layer (Section 4) and transmitted as a text message content within an envelope.

---

## 7. Audit & Observability (Zero-Knowledge)
Diagnostics are captured without exposing plaintext:
*   `E2EE_DEC_FAIL`: Count of decryption failures.
*   `SESS_INIT_COUNT`: internal metric for successful X3DH handshakes.
*   `E2EE_PREKEY_LOW`: Warning when OPK pool falls below 20 keys.
*   `E2EE_SYNC_GAP`: Log distance between expected `seq` and `seq_received`.

---

## 8. Future Group Evolution path
The current architecture is designed to evolve into group encryption via **Sender Keys**:
1.  Users distribute a unique **Chain Key** for the same group using established 1-to-1 channels.
2.  Users then use this Chain Key to derive keys for subsequent group messages.
3.  **Compatibility**: This evolution requires no replacement of the Identity, Session, or Device layers.

---

## 9. Key Rotation Policy
| Key Type | Rotation Frequency | Rotation Trigger | Action |
| :--- | :--- | :--- | :--- |
| **Identity Key (IK)** | Never/Manual | User-initiated reset | Full re-registration |
| **Signed PreKey (SPK)** | Every 7 Days | Local device clock | Update $\text{SPK}_{\text{pub}}$ and $\sigma$ on server |
| **Symmetric Keys** | Per Message | Ratchet advance | Delete old `MessageKey` |
| **One-Time PreKeys (OPK)** | On Exhaustion | Pool size < 20 keys | Generate and upload new batch |
| **Root Key** | Per Session | X3DH Handshake | Initialize session state |