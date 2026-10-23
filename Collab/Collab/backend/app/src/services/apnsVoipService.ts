// APNs VoIP pushes (PushKit) for iOS incoming calls — the ONLY way to ring a
// terminated iOS app through CallKit. Talks to APNs directly over HTTP/2 with
// token-based (.p8) auth; Node's built-in http2 + `jsonwebtoken` (ES256) mean
// no new dependency.
//
// Payload contract (mirrors Collab_mobile ios/Runner/AppDelegate.swift
// `pushRegistry(_:didReceiveIncomingPushWith:…)`):
//   { callId, callerName, callerAvatar?, conversationId?, kind: "audio"|"video",
//     huddle?: bool, action: "ring" | "cancel" }
// Apple requires every VoIP push to report a call to CallKit, so the app-side
// handler ALWAYS reports (or ends) a call — never send a VoIP push for anything
// other than ring/cancel.
import fs from "fs";
import http2 from "http2";
import jwt from "jsonwebtoken";
import { config } from "../platform";
import { record as logError } from "./logService";

let ready = false;
let keyPem = "";
let session: http2.ClientHttp2Session | null = null;
let providerToken: { value: string; issuedAt: number } | null = null;

function host() {
  return config.apns.environment === "production"
    ? "https://api.push.apple.com"
    : "https://api.sandbox.push.apple.com";
}

function loadKey(): string {
  const { keyP8, keyFile } = config.apns;
  try {
    let raw = "";
    if (keyP8) {
      raw = keyP8.trim();
      if (!raw.includes("-----BEGIN")) raw = Buffer.from(raw, "base64").toString("utf8");
    } else if (keyFile) {
      raw = fs.readFileSync(keyFile, "utf8");
    }
    return raw.replace(/\\n/g, "\n").trim();
  } catch (e: any) {
    console.warn("[apns] cannot read auth key:", e?.message);
    return "";
  }
}

export function init(): boolean {
  const { keyId, teamId, bundleId } = config.apns;
  keyPem = loadKey();
  ready = !!(keyId && teamId && bundleId && keyPem.includes("-----BEGIN"));
  if (ready) console.log(`[apns] VoIP push configured (${config.apns.environment}, topic ${bundleId}.voip)`);
  else console.warn("[apns] APNS_KEY_ID/TEAM_ID/KEY_P8 not set — iOS calls fall back to FCM alerts (no CallKit ring when terminated)");
  // Some of the variables set but the key unusable = a deployment fault worth a
  // Server Logs row (nothing set at all is the "VoIP not used here" case).
  const partly = !!(keyId || teamId || config.apns.keyP8 || config.apns.keyFile);
  if (!ready && partly) {
    logError({
      source: "process",
      severity: "warn",
      code: "PUSH_APNS_UNAVAILABLE",
      message: "[apns] APNs VoIP key incomplete or unreadable — iOS calls fall back to FCM alerts (no CallKit ring when the app is closed)",
      context: { keyId: !!keyId, teamId: !!teamId, keyFile: config.apns.keyFile || null, inlineKey: !!config.apns.keyP8, bundleId, environment: config.apns.environment },
    });
  }
  return ready;
}

export function isReady() { return ready; }

// Apple: refresh the provider token at least hourly, no more than every 20 min.
function bearer(): string {
  const now = Math.floor(Date.now() / 1000);
  if (providerToken && now - providerToken.issuedAt < 50 * 60) return providerToken.value;
  const value = jwt.sign({ iss: config.apns.teamId, iat: now }, keyPem, {
    algorithm: "ES256",
    header: { alg: "ES256", kid: config.apns.keyId },
  });
  providerToken = { value, issuedAt: now };
  return value;
}

function connect(): http2.ClientHttp2Session {
  if (session && !session.closed && !session.destroyed) return session;
  const s = http2.connect(host());
  s.on("error", (e) => { console.warn("[apns] session error:", e?.message); if (session === s) session = null; });
  s.on("close", () => { if (session === s) session = null; });
  s.on("goaway", () => { if (session === s) session = null; });
  session = s;
  return s;
}

type ApnsSendResult = { ok: boolean; stale: boolean; status: number; error?: string };

/** One VoIP push. Never throws; `stale` = token no longer valid for this app. */
export async function sendVoip(voipToken: string, payload: Record<string, any>, opts: { expirationSec?: number } = {}): Promise<ApnsSendResult> {
  if (!ready) return { ok: false, stale: false, status: 0, error: "apns not configured" };
  const body = JSON.stringify(payload);
  const expiration = Math.floor(Date.now() / 1000) + (opts.expirationSec ?? 45);
  return new Promise<ApnsSendResult>((resolve) => {
    let done = false;
    const finish = (r: ApnsSendResult) => { if (!done) { done = true; resolve(r); } };
    try {
      const s = connect();
      const req = s.request({
        ":method": "POST",
        ":path": `/3/device/${voipToken}`,
        authorization: `bearer ${bearer()}`,
        "apns-topic": `${config.apns.bundleId}.voip`,
        "apns-push-type": "voip",
        "apns-priority": "10",
        "apns-expiration": String(expiration),
        "content-type": "application/json",
        "content-length": String(Buffer.byteLength(body)),
      });
      let status = 0;
      let chunks = "";
      const timer = setTimeout(() => { try { req.close(http2.constants.NGHTTP2_CANCEL); } catch (_) {} finish({ ok: false, stale: false, status: 0, error: "timeout" }); }, 10_000);
      req.on("response", (headers) => { status = Number(headers[":status"]) || 0; });
      req.on("data", (c) => { chunks += c; });
      req.on("end", () => {
        clearTimeout(timer);
        if (status === 200) return finish({ ok: true, stale: false, status });
        let reason = "";
        try { reason = JSON.parse(chunks || "{}").reason || ""; } catch (_) {}
        // 410 Unregistered / 400 BadDeviceToken|DeviceTokenNotForTopic: forget the token.
        const stale = status === 410 || (status === 400 && /BadDeviceToken|DeviceTokenNotForTopic/.test(reason));
        if (status === 403 && /ExpiredProviderToken|InvalidProviderToken/.test(reason)) providerToken = null;
        finish({ ok: false, stale, status, error: `${status} ${reason}`.trim() });
      });
      req.on("error", (e: any) => { clearTimeout(timer); finish({ ok: false, stale: false, status: 0, error: e?.message || String(e) }); });
      req.end(body);
    } catch (e: any) {
      finish({ ok: false, stale: false, status: 0, error: e?.message || String(e) });
    }
  });
}
