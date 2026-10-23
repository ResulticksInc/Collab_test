// E2EE routes — PRESERVED INTACT for future reactivation.
// These routes are registered regardless of the E2EE_ENABLED flag.
// When E2EE_ENABLED=false, the frontend never calls these endpoints
// (isE2EEEnabled() returns false), so they are effectively dormant.
// DO NOT delete this file. See docs/E2EE_PROTOCOL_SPEC.md.
import { asyncRouter } from "../asyncRouter";
import authMiddleware from "../middleware/auth";
import { ok, shared } from "../platform";
import { broadcast } from "../realtime/socket";
import {
  registerDevice,
  myDevices,
  revokeDevice,
  approveDevice,
  publishPreKeys,
  bundleFor,
  putConversationKeys,
  myConversationKeys,
  requestEpochRekey,
  createConversationEpoch,
  consumePreKey,
  uploadHistorySync,
  fetchHistorySync,
  ackHistorySync,
  requestHistorySync,
  putRecoveryBackup,
  getRecoveryBackup,
  getRecoveryBackupMeta,
  deleteRecoveryBackup,
  getOrCreateAccountKey,
  putRecoveryWrap,
  deleteRecoveryWrap,
  requestRedelivery,
  requestRedeliveryBulk,
  listRedeliverRequests,
  redeliverStatus,
  putRedeliveredEnvelope,
  recoveryDiagnostics,
  getMessageEnvelopes,
  getOwnEnvelopesBulk,
} from "../services/e2eeService";

const { EVENTS } = shared;
const router = asyncRouter();
router.use(authMiddleware);

// Live sync choreography: nudge the user's OTHER devices over the socket so
// history bundles move NOW, not on somebody's next page load. Best-effort —
// a realtime hiccup must never fail the REST call that triggered it.
function emitToUser(req: any, event: string, payload: any) {
  try {
    const io = req.app.get("io");
    if (io) io.to(broadcast.userRoom(req.user.userId)).emit(event, payload);
  } catch (_) {
    /* best-effort */
  }
}

router.get("/devices", async (req, res) =>
  res.json(ok(await myDevices(req.user.userId))),
);

router.post("/devices", async (req, res) =>
  res.status(201).json(ok(await registerDevice(req.user.userId, req.body || {}))),
);

router.delete("/devices/:deviceId", async (req, res) =>
  res.json(ok(await revokeDevice(req.user.userId, req.params.deviceId))),
);

router.post("/devices/:deviceId/approve", async (req, res) => {
  const out = await approveDevice(req.user.userId, req.params.deviceId);
  res.json(ok(out));
  // A just-approved device joins the fan-out but has NO history. Tell the
  // user's other (online) devices so they push it a history bundle right away.
  emitToUser(req, EVENTS.E2EE_DEVICE_APPROVED, { deviceId: String(req.params.deviceId) });
});

router.post("/devices/:deviceId/prekeys", async (req, res) =>
  res.json(
    ok(
      await publishPreKeys(
        req.user.userId,
        req.params.deviceId,
        (req.body || {}).keys || [],
      ),
    ),
  ),
);

// Atomically claim a one-time prekey of :deviceId (forward secrecy / X3DH).
router.post("/devices/:deviceId/prekeys/:keyId/consume", async (req, res) =>
  res.json(
    ok(await consumePreKey(req.user.userId, req.params.deviceId, req.params.keyId)),
  ),
);

router.get("/users/:userId/bundle", async (req, res) =>
  res.json(ok(await bundleFor(req.params.userId))),
);

router.get("/conversations/:conversationId/keys", async (req, res) =>
  res.json(ok(await myConversationKeys(req.user.userId, req.params.conversationId))),
);

router.post("/conversations/:conversationId/keys", async (req, res) => {
  const cid = req.params.conversationId;
  const envelopes = (req.body || {}).envelopes || [];
  const out = await putConversationKeys(req.user.userId, cid, envelopes);
  res.status(201).json(ok(out));
  // Tell each recipient device's user that new conversation keys landed, so a
  // conversation stuck on pending-key re-decrypts NOW (epoch-key backfill) rather
  // than on the next reload. Best-effort; scoped to the exact MEMBER users whose
  // rows were actually stored (a no-op store emits nothing).
  try {
    const io = req.app.get("io");
    if (io && out.count > 0)
      for (const uid of out.memberUserIds)
        io.to(broadcast.userRoom(uid)).emit(EVENTS.E2EE_KEYS_UPDATED, {
          conversationId: cid,
        });
  } catch (_) {
    /* best-effort */
  }
});

// Epoch-key backfill request: a member device that can't decrypt a GROUP
// conversation (keyGone) asks the conversation's ONLINE members to re-wrap the
// existing epoch key to it. Membership is asserted in the service; the requesting
// device identity comes from the JWT (never a body), so a member can only ever ask
// for a re-key to their OWN device.
router.post("/conversations/:conversationId/keys/rekey-request", async (req, res) => {
  const cid = req.params.conversationId;
  await requestEpochRekey(req.user.userId, cid); // throws 403 if not a member
  res.json(ok({ requested: true }));
  try {
    const io = req.app.get("io");
    if (io)
      io.to(broadcast.room(cid)).emit(EVENTS.E2EE_EPOCH_REKEY_REQUEST, {
        conversationId: cid,
        userId: req.user.userId,
        deviceId: req.user.deviceId,
      });
  } catch (_) {
    /* best-effort */
  }
});

// Atomically create a new group-key epoch (race-free). Returns { created }.
router.post("/conversations/:conversationId/epoch", async (req, res) => {
  const cid = req.params.conversationId;
  const out: any = await createConversationEpoch(
    req.user.userId,
    cid,
    (req.body || {}).version,
    (req.body || {}).envelopes || [],
  );
  res.json(ok(out));
  // A NEW epoch exists: tell the conversation so every member drops its cached
  // current-epoch key and adopts the newest on its next send. Without this a
  // member kept sending under the previous epoch until a reload, which a device
  // that only holds the new epoch can't read. Best-effort.
  try {
    const io = req.app.get("io");
    if (io && out && out.created)
      io.to(broadcast.room(cid)).emit(EVENTS.E2EE_KEYS_UPDATED, { conversationId: cid });
  } catch (_) {
    /* best-effort */
  }
});

// ---- Mechanism A: server-blind device-link history sync --------------------
// The device identity for fetch/ack is taken ONLY from the device-bound JWT
// (req.user.deviceId), never a body/query id. The service performs all authz.
router.post("/history-sync", async (req, res) => {
  const out = await uploadHistorySync(req.user.userId, req.user.deviceId, req.body || {});
  res.status(201).json(ok(out));
  // Final chunk stored → tell the TARGET device its bundle is waiting so it
  // restores immediately instead of on its next full page load.
  const b = req.body || {};
  const isFinal = Number(b.chunkIndex || 0) === Number(b.chunkCount || 1) - 1;
  if (isFinal && !(out as any)?.skipped)
    emitToUser(req, EVENTS.E2EE_SYNC_READY, { targetDeviceId: String(b.targetDeviceId || "") });
});

// On-demand heal: a device that rendered "[Encrypted — not available on this
// device]" asks its sibling devices (via the user room) for that history.
router.post("/history-sync/request", async (req, res) => {
  const out = await requestHistorySync(req.user.userId, req.user.deviceId, req.body || {});
  res.json(ok({ requested: true }));
  emitToUser(req, EVENTS.E2EE_SYNC_REQUESTED, out);
});

// Member re-delivery of ONE message. The requester (a conversation member whose
// device cannot open its envelope) asks; the ask is stored (0126) so an offline
// member answers on its next sign-in, and relayed live to the conversation
// room so an online member answers now.
router.post("/messages/:messageId/redeliver", async (req, res) => {
  const out = await requestRedelivery(req.user.userId, req.user.deviceId, req.params.messageId, req.body || {});
  res.json(ok({ requested: true }));
  try {
    const io = req.app.get("io");
    if (io)
      io.to(broadcast.room(out.conversationId)).emit(EVENTS.E2EE_REDELIVER_REQUEST, {
        messageId: out.messageId,
        conversationId: out.conversationId,
        userId: out.userId,
        deviceId: out.deviceId,
      });
  } catch (_) {
    /* best-effort */
  }
});

// Migration sweep: many asks at once (≤200). Stored like single asks; relayed
// per conversation with the message ids so online members answer now.
router.post("/messages/redeliver/bulk", async (req, res) => {
  const out = await requestRedeliveryBulk(req.user.userId, req.user.deviceId, req.body || {});
  res.json(ok({ requested: out.conversations.reduce((n, c) => n + c.messageIds.length, 0) }));
  try {
    const io = req.app.get("io");
    if (io)
      for (const c of out.conversations)
        io.to(broadcast.room(c.conversationId)).emit(EVENTS.E2EE_REDELIVER_REQUEST, {
          conversationId: c.conversationId,
          messageIds: c.messageIds,
          userId: out.userId,
          deviceId: out.deviceId,
        });
  } catch (_) {
    /* best-effort */
  }
});

// Batched: this device's own envelope for up to 200 messages (members only).
router.post("/messages/own-envelopes", async (req, res) =>
  res.json(ok(await getOwnEnvelopesBulk(req.user.userId, req.user.deviceId, req.body || {}))),
);

// One message's envelope set (members only) — lets an asked device open its
// own server-side copy when its plaintext cache no longer has the message.
router.get("/messages/:messageId", async (req, res) =>
  res.json(ok(await getMessageEnvelopes(req.user.userId, req.params.messageId))),
);

// The caller's own open asks in one conversation and whether any device is
// left to answer them (the honest "Restoring…" vs "no device has it" split).
router.get("/redeliver-requests/status", async (req, res) =>
  res.json(ok(await redeliverStatus(req.user.userId, req.user.deviceId, req.query || {}))),
);

// Stored asks this device can answer (conversations the caller belongs to).
router.get("/redeliver-requests", async (req, res) =>
  res.json(ok(await listRedeliverRequests(req.user.userId, req.user.deviceId, req.query || {}))),
);

// What the server can say about the caller's recovery state (no secrets).
router.get("/diagnostics", async (req, res) =>
  res.json(ok(await recoveryDiagnostics(req.user.userId, req.user.deviceId, req.query || {}))),
);

// A member answers with a fresh opaque envelope for that one device. The
// server appends it to the message's envelope set, drops the stored ask, and
// tells the requester's devices to re-read the message.
router.put("/messages/:messageId/envelope", async (req, res) => {
  const out = await putRedeliveredEnvelope(req.user.userId, req.params.messageId, req.body || {});
  res.json(ok(out));
  try {
    const io = req.app.get("io");
    if (io)
      io.to(broadcast.userRoom(out.recipientId)).emit(EVENTS.E2EE_REDELIVERED, {
        messageId: out.messageId,
        conversationId: out.conversationId,
        deviceId: out.recipientDeviceId,
      });
  } catch (_) {
    /* best-effort */
  }
});

router.get("/history-sync", async (req, res) =>
  res.json(ok(await fetchHistorySync(req.user.userId, req.user.deviceId))),
);

router.delete("/history-sync", async (req, res) =>
  res.json(
    ok(
      await ackHistorySync(
        req.user.userId,
        req.user.deviceId,
        (req.query.bundleId as string) || null,
      ),
    ),
  ),
);

// ---- Mechanism B: server-blind encrypted history recovery backup -----------
// userId is taken ONLY from the JWT (req.user.userId), never a body/query id.
// The service performs all authz + size guards; the server stores opaque
// ciphertext + iv + the non-secret salt and never derives the key or decrypts.
router.put("/recovery-backup", async (req, res) =>
  res.json(ok(await putRecoveryBackup(req.user.userId, req.body || {}))),
);

// `?meta=1` returns salt/version/wraps/size + a one-chunk probe and NO chunk
// ciphertext — for the many existence / key-verification checks that don't need
// the (potentially very large) backup body.
router.get("/recovery-backup", async (req, res) =>
  res.json(
    ok(
      String(req.query.meta || "") === "1"
        ? await getRecoveryBackupMeta(req.user.userId)
        : await getRecoveryBackup(req.user.userId),
    ),
  ),
);

router.delete("/recovery-backup", async (req, res) =>
  res.json(ok(await deleteRecoveryBackup(req.user.userId))),
);

// Automatic recovery: the caller's own account key (see service). Minted on
// first use, identical for every device of the user. 404 when the feature is
// off (E2EE_AUTO_RECOVERY=false).
router.get("/account-key", async (req, res) =>
  res.json(ok(await getOrCreateAccountKey(req.user.userId))),
);

// Add/replace a single recovery wrap (e.g. a recovery-passphrase wrap of the same
// secret) without re-uploading the backup chunks.
router.put("/recovery-wrap", async (req, res) =>
  res.json(ok(await putRecoveryWrap(req.user.userId, req.body || {}))),
);

// Remove a single recovery-wrap kind (e.g. clear a recovery passphrase) without
// deleting the backup itself. kind comes from the query (?kind=passphrase).
router.delete("/recovery-wrap", async (req, res) =>
  res.json(
    ok(await deleteRecoveryWrap(req.user.userId, String(req.query.kind || "passphrase"))),
  ),
);

export default router;