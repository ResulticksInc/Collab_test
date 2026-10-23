# Phase 3A: E2EE Key Lifecycle & Ownership Validation Completion

This document outlines the complete lifecycle of End-to-End Encryption (E2EE) keys, integrating ownership validation, rotation, recovery, and revocation into a unified security model.

## 1. Key Identity and Generation
Every participant in an E2EE conversation possesses a key pair (Public/Private). To ensure authenticity, these keys are bound to the user's identity via a validated ownership proof.
- **Generation**: Keys are generated on the client side using cryptographically secure random number generators.
- **Storage**: Private keys are stored in the `EpochStore` with encryption at rest.

## 2. Ownership Validation (The "Trust" Layer)
Before a key is accepted as valid for communication, it must undergo ownership validation:
- **Validation Process**: The system ensures that the entity possessing the private key associated with a public key is indeed the intended user.
- **Verification**: This prevents Man-in-the-Middle (MITM) attacks by validating the identity of the sender/recipient before establishing an encrypted channel.

### Implementation Notes
- A lightweight frontend helper `ownership-validation.ts` provides utilities for verifying ownership proofs using WebCrypto (JWK import, signature verify). See [frontend/app/src/lib/e2ee/ownership-validation.ts](frontend/app/src/lib/e2ee/ownership-validation.ts#L1-L200) for the reference implementation.
- Ownership proofs are short-lived signed payloads (timestamped) that tie a `signerId` to a public key and optionally include a payload hash. Frontend sanity checks reject proofs older than 24 hours; server-side policy may differ.
- The ownership validation step is invoked during initial device registration, on key import, and prior to accepting keys from a peer during session establishment.

## 3. Key Rotation (The "Forward Secrecy" Layer)
To minimize the impact of a potential key compromise, keys are rotated periodically or upon specific events (e.g., device addition/removal).
- **Rotation Engine**: Orchestrates the transition from `Epoch N` to `Epoch N+1`.
- **Backward Secrecy**: New epochs ensure that future messages cannot be decrypted using compromised old keys.
- **Forward Secrecy**: Once an epoch is closed and rotated, old messages remain secure as new session keys are derived.

## 4. Recovery Protocol (The "Availability" Layer)
To prevent permanent data loss during device loss or account recovery:
- **Recovery Keys**: A master recovery key or fragmented shards (via Shamir's Secret Sharing or similar/backup mechanism) allow the restoration of the identity key_id_.
- **Re-authentication**: Recovery triggers a new rotation epoch, ensuring the restored user starts with a fresh, validated key set.

## 5. Revocation Model (The "Termination" Layer)
When a device is decommissioned or a session is terminated:
- **Explicit Revocation**: The revocation model marks specific keys as invalid in the global state.
- **Automatic/Implicit Revocation**: Rotation automatically renders previous epoch keys obsolete for new messages.

## 6. Combined Lifecycle Summary
| Stage | Trigger | Action | Outcome |
| :--- | :--- | :--- | :--- |
| **Initialization** | User Login / Device Reg | Generate Keypair $\rightarrow$ Validate Ownership | Trusted Public Key registered |
| **Maintenance** | Time Interval / Event | Rotate Epoch $\rightarrow$ Distribute New Keys | Forward Secrecy maintained |
| **Recovery** | Loss of Access | Provide Recovery Secret $\rightarrow$ Identity Restore | Restored access to encrypted data |
| **Termination** | Logout / Device Removal | Revoke Key $\rightarrow$ Force Rotation | Secure disconnection from E2EE group |

## Conclusion
The integration of these five pillars ensures that the CoLab E2EE system is not only private but resilient, authentic, and maintainable over the long term.

## Next Steps to Complete Phase 3A
- Finalize lifecycle completion checklist to include:
	- Frontend ownership proof generation and verification flow ([ownership-validation.ts](frontend/app/src/lib/e2ee/ownership-validation.ts#L1-L200)).
	- Hook ownership validation into `EpochStore` initialization and `rotation-engine` handoff.
	- Ensure recover/revoke flows emit lifecycle events that trigger UI and server-side state reconciliation.
	- Add integration tests for ownership proof verification in both E2EE and non-E2EE conversation flows.

Once these follow-ups are wired, Phase 3A can be marked complete.