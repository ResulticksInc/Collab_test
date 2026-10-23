import * as LK from "livekit-client";
import { isE2EEEnabled } from "./manager";

/**
 * LiveKit call/meeting media E2EE (insertable streams). Entirely gated on
 * isE2EEEnabled(): when E2EE is OFF (the product default) e2eeRoomOptions()
 * returns {} and enableRoomE2EE() is a no-op, so the call/meeting path is
 * byte-for-byte unchanged — non-E2EE calls, the 6 call tests and the live demo
 * are unaffected. The media key is the conversation's shared epoch key
 * (getCallMediaKey in manager.ts), so every participant who can read the
 * conversation derives the same key; key distribution reuses the message E2EE.
 *
 * NOTE: implemented to LiveKit 2.x's documented E2EE API and gated, but NOT yet
 * runtime-verified (insertable streams need a live multi-party call). It must
 * pass the live validation before E2EE is enabled in production.
 */

let keyProvider: any = null;
let worker: Worker | null = null;

// Call/meeting MEDIA E2EE is a SEPARATE, still-unvalidated feature from chat
// message E2EE — and it must NOT ride the chat `isE2EEEnabled()` gate. Doing so
// turned media E2EE on the moment chat E2EE was enabled, before the live
// multi-party validation this file's header calls for. Worse, a meeting has no
// pre-shared conversation epoch key: getCallMediaKey mints one on the fly under
// the synthetic "meeting:<id>" id, so two participants who join together mint
// DIFFERENT keys and can't decrypt each other — the media arrives but is
// undecryptable, so audio is silent while tiles still blink (the SFU computes
// active-speaker from RTP, server-side). Gate media E2EE on its OWN flag,
// default OFF, so calls/meetings use standard SFU-trusted media (DTLS-SRTP in
// transit) and are audible. Chat message content E2EE is completely unaffected.
// Flip this on only once insertable-stream media E2EE passes live 2-party QA.
let mediaE2EEEnabled = false;
export function setCallMediaE2EE(on: boolean): void {
  mediaE2EEEnabled = !!on;
}
function mediaE2EEOn(): boolean {
  return mediaE2EEEnabled && isE2EEEnabled();
}
// Callers gate their media-key minting (getCallMediaKey → ensureGroupKey → per-
// device ECIES wrap → server round-trips) on this, so while media E2EE is off
// those round-trips are skipped entirely instead of minting a key that
// enableRoomE2EE would then discard.
export function isCallMediaE2EEOn(): boolean {
  return mediaE2EEOn();
}

function ensureProvider(): { keyProvider: any; worker: Worker } | null {
  if (typeof window === "undefined" || typeof Worker === "undefined") return null;
  try {
    if (!worker) {
      // The ./e2ee-worker subpath is a real package export; webpack resolves the
      // worker chunk. It is only instantiated here, behind the E2EE gate.
      worker = new Worker(new URL("livekit-client/e2ee-worker", import.meta.url));
    }
    if (!keyProvider) keyProvider = new (LK as any).ExternalE2EEKeyProvider();
    return { keyProvider, worker };
  } catch (_) {
    return null;
  }
}

// Spread into the `new Room({...})` options. Returns {} when E2EE is off so the
// Room constructor is identical to before.
export function e2eeRoomOptions(): any {
  if (!mediaE2EEOn()) return {};
  const p = ensureProvider();
  if (!p) return {};
  return { e2ee: { keyProvider: p.keyProvider, worker: p.worker } };
}

// Set the shared media key and turn E2EE on for the room. Best-effort + gated;
// any failure leaves the call running (un-encrypted media) rather than dropping it.
export async function enableRoomE2EE(room: any, mediaKeyB64: string | null): Promise<void> {
  if (!mediaE2EEOn() || !room || !mediaKeyB64 || !keyProvider) return;
  try {
    await keyProvider.setKey(mediaKeyB64);
    if (typeof room.setE2EEEnabled === "function") await room.setE2EEEnabled(true);
  } catch (_) {
    /* gated best-effort: never break the call on E2EE setup failure */
  }
}
