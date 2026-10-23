import { config, db } from "../platform";
import * as storage from "./storageService";
import { randomUUID } from "crypto";
import { httpErr as deny } from "../optimization/httpError";

// Recordings capture the meeting's LiveKit room via Egress. The egress capture
// and the completion webhook that finalizes storage live in the deployment
// (LiveKit Egress + object storage, see infrastructure/); without them, start
// fails honestly rather than fabricating a recording. Everything below — the
// lifecycle, permissions, listing, retention — is real and self-contained.

function egressConfigured() {
  // Recording needs a SEPARATE LiveKit Egress WORKER process (the
  // `livekit/egress` container) running and sharing Redis with the SFU — the
  // app cannot drive egress on its own. Gate explicitly on EGRESS_ENABLED so a
  // deployment that hasn't provisioned that worker returns an honest "not
  // enabled" message instead of attempting egress and failing with a cryptic
  // 502. Flip EGRESS_ENABLED=yes only after the egress container is deployed
  // (see docker-compose.yml `egress` service + infrastructure/livekit/livekit.yaml).
  return config.livekit.egressEnabled && config.livekit.apiKey !== "devkey";
}
function egressHost() {
  return config.livekit.serverUrl.replace(/^ws(s?):\/\//, "http$1://");
}

async function meetingOr404(meetingId: string) {
  const m = await db.meetings.getById(meetingId);
  if (!m) throw deny(404, "Meeting not found.");
  return m;
}
function isMemberOrHost(m: any, uid: string) {
  return (
    m.createdBy === uid ||
    (m.attendees || []).some((a: any) => a.userId === uid)
  );
}
// AUDIT P2 (#21): the client Record button is enabled for co-hosts (canControl),
// but the save path was host-only — so a co-host's recording was silently
// discarded with a misleading "storage unavailable" error. Co-hosts can control
// the meeting, so they may record; align the server to host-OR-co-host.
async function isHostOrCoHost(m: any, uid: string): Promise<boolean> {
  if (m.createdBy === uid) return true;
  try {
    return (await db.meetings.getAttendeeRole(m.id, uid)) === "co-host";
  } catch {
    return false;
  }
}
// AUDIT P2 (#20): a host-ejected participant loses recording access too.
async function isEjected(meetingId: string, uid: string, m: any): Promise<boolean> {
  if (m.createdBy === uid || !(db.meetings as any).meetingIsEjected) return false;
  try {
    return !!(await (db.meetings as any).meetingIsEjected(meetingId, uid));
  } catch {
    return false;
  }
}

async function start({ meetingId, userId }: any) {
  const m = await meetingOr404(meetingId);
  if (!(await isHostOrCoHost(m, userId)))
    throw deny(403, "Only the host or a co-host can start recording.");
  if (!egressConfigured())
    throw deny(
      503,
      "Recording isn't enabled on this server. It needs the LiveKit Egress worker deployed (docker-compose `egress` service) and EGRESS_ENABLED=yes.",
    );
  let egressId: string | null = null;
  try {
    const sdk: any = await import("livekit-server-sdk");
    const client: any = new sdk.EgressClient(
      egressHost(),
      config.livekit.apiKey,
      config.livekit.apiSecret,
    );
    // Write the finished MP4 to MinIO/S3 so it is retrievable and the egress
    // completion webhook can finalize the row with a storage key + playback
    // URL. Without an upload target egress would write to the egress
    // container's local FS, where nothing can serve it back.
    const fileInit: any = {
      fileType: sdk.EncodedFileType ? sdk.EncodedFileType.MP4 : 1,
      filepath: `recordings/${meetingId}/{room_name}-{time}.mp4`,
    };
    const s3 = config.storage;
    if (s3 && s3.bucket && s3.accessKeyId) {
      fileInit.output = {
        case: "s3",
        value: new sdk.S3Upload({
          accessKey: s3.accessKeyId,
          secret: s3.secretAccessKey,
          bucket: s3.bucket,
          endpoint: s3.endpoint,
          region: "us-east-1",
          forcePathStyle: true,
        }),
      };
    }
    const output = { file: new sdk.EncodedFileOutput(fileInit) };
    const info = await client.startRoomCompositeEgress(
      "meeting_" + meetingId,
      output,
    );
    egressId = (info && (info.egressId || info.egress_id)) || null;
  } catch (e: any) {
    throw deny(
      502,
      "Could not start recording: " + (e?.message || "egress error"),
    );
  }
  return db.recordings.create(meetingId, userId, egressId);
}

async function stop({ meetingId, recordingId, userId }: any) {
  const m = await meetingOr404(meetingId);
  if (!(await isHostOrCoHost(m, userId)))
    throw deny(403, "Only the host or a co-host can stop recording.");
  const rec = await db.recordings.getById(recordingId);
  if (!rec || rec.meetingId !== meetingId)
    throw deny(404, "Recording not found.");
  if (egressConfigured() && rec.egressId) {
    try {
      const sdk: any = await import("livekit-server-sdk");
      const client: any = new sdk.EgressClient(
        egressHost(),
        config.livekit.apiKey,
        config.livekit.apiSecret,
      );
      await client.stopEgress(rec.egressId);
    } catch (_) {
      /* best-effort; the egress webhook finalizes regardless */
    }
  }
  return db.recordings.finish(recordingId, {
    status: "processing",
    endedAt: new Date().toISOString(),
  });
}

async function listForMeeting({ meetingId, userId }: any) {
  const m = await meetingOr404(meetingId);
  if (!isMemberOrHost(m, userId))
    throw deny(
      403,
      "You can only view recordings for meetings you're part of.",
    );
  return db.recordings.listForMeeting(meetingId);
}

async function remove({ meetingId, recordingId, userId }: any) {
  const m = await meetingOr404(meetingId);
  if (m.createdBy !== userId)
    throw deny(403, "Only the host can delete recordings.");
  const rec = await db.recordings.getById(recordingId);
  if (!rec || rec.meetingId !== meetingId)
    throw deny(404, "Recording not found.");
  return db.recordings.remove(recordingId);
}

// Finalize a recording once egress completes. Wired to the LiveKit egress
// webhook in the deployment; verified directly here.
async function finalize({
  egressId,
  storageKey,
  playbackUrl,
  durationSec,
  sizeBytes,
}: any) {
  const rec = await db.recordings.findByEgress(egressId);
  if (!rec) return null;
  const done = await db.recordings.finish(rec.id, {
    status: "ready",
    endedAt: new Date().toISOString(),
    storageKey,
    playbackUrl,
    durationSec,
    sizeBytes,
  });
  // REC-08: announce readiness in the meeting chat. The client-recording path
  // posts the actual file card itself; the EGRESS path finishes minutes after
  // the meeting via this webhook, when nobody's client is around to post — so
  // the server drops the ready notice into the meeting's group (the same
  // "call|m:<id>" group every meeting has from scheduling).
  try {
    const convId =
      (db.conversations as any).findByDmKey &&
      (await (db.conversations as any).findByDmKey("call|m:" + rec.meetingId));
    if (convId) {
      const msgSvc: any = await import("./messageService");
      const mins = Math.round((Number(durationSec) || 0) / 60);
      await msgSvc.send({
        conversationId: convId,
        senderId: rec.startedBy,
        text: `📹 Meeting recording is ready${mins ? ` (${mins} min)` : ""} — open the meeting's Recordings panel to play or download it.`,
        file: null,
        type: "call",
        bumpUnread: true,
      });
    }
  } catch (_) {
    /* the notice is best-effort — the recording row is already ready */
  }
  return done;
}

async function purgeOlderThan(days: number) {
  return db.recordings.deleteOlderThan(days);
}

// Client-side recording: the browser composites + records the meeting with
// MediaRecorder and uploads the finished blob here. We store it in object
// storage and write a "ready" recording row directly — no egress worker needed,
// so recording works in any environment (the egress path stays for deployments
// that provision it). Host-only, mirroring start().
async function uploadClientRecording({ meetingId, userId, data, mime, durationSec }: any) {
  const m = await meetingOr404(meetingId);
  if (!(await isHostOrCoHost(m, userId)))
    throw deny(403, "Only the host or a co-host can save a recording.");
  if (!data || !data.length) throw deny(400, "The recording was empty.");
  const ext = (mime || "").includes("mp4") ? "mp4" : "webm";
  const key = `recordings/${meetingId}/${randomUUID()}.${ext}`;
  await storage.upload(key, data, mime || "video/webm");
  const rec = await db.recordings.create(meetingId, userId, null);
  return db.recordings.finish(rec.id, {
    status: "ready",
    endedAt: new Date().toISOString(),
    storageKey: key,
    // Served back through our own authenticated download route (never expires;
    // membership is enforced per request) so an <video src> can play it inline.
    playbackUrl: `/api/meetings/${meetingId}/recordings/${rec.id}/download`,
    durationSec: Number(durationSec) || 0,
    sizeBytes: data.length,
  });
}

// Stream a stored recording back for inline playback / download. Any meeting
// member or the host may view it.
async function getRecordingDownload({ meetingId, recordingId, userId }: any) {
  const m = await meetingOr404(meetingId);
  if (!isMemberOrHost(m, userId))
    throw deny(403, "You can only view recordings for meetings you're part of.");
  if (await isEjected(meetingId, userId, m))
    throw deny(403, "You were removed from this meeting.");
  const rec = await db.recordings.getById(recordingId);
  if (!rec || rec.meetingId !== meetingId || !rec.storageKey)
    throw deny(404, "Recording not found.");
  const { stream, contentLength } = await storage.getStream(rec.storageKey);
  return {
    stream,
    contentLength,
    mime: rec.storageKey.endsWith(".mp4") ? "video/mp4" : "video/webm",
  };
}

export {
  start,
  stop,
  listForMeeting,
  remove,
  finalize,
  purgeOlderThan,
  uploadClientRecording,
  getRecordingDownload,
};
