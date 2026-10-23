import { asyncRouter } from "../asyncRouter";
import { config } from "../platform";
import { finalize } from "../services/recordingService";

const router = asyncRouter();

// LiveKit Egress webhook. The media server posts a signed event when an egress
// (meeting recording) completes; we verify the signature with the API secret
// and mark the matching recording "ready" with its storage location, duration,
// and size. The raw request body (mounted ahead of express.json in app.ts) is
// required for signature verification.
router.post("/", async (req: any, res: any) => {
  try {
    const sdk: any = await import("livekit-server-sdk");
    const receiver = new sdk.WebhookReceiver(
      config.livekit.apiKey,
      config.livekit.apiSecret,
    );
    const raw = Buffer.isBuffer(req.body)
      ? req.body.toString("utf8")
      : typeof req.body === "string"
        ? req.body
        : JSON.stringify(req.body || {});
    const event: any = await receiver.receive(raw, req.get("Authorization"));
    const info = (event && event.egressInfo) || {};
    const done =
      event &&
      (event.event === "egress_ended" ||
        info.status === "EGRESS_COMPLETE" ||
        info.status === 3);
    if (done && info.egressId) {
      const file = (info.fileResults && info.fileResults[0]) || info.file || {};
      await finalize({
        egressId: info.egressId,
        storageKey: file.filename || file.location || null,
        playbackUrl: file.location || null,
        durationSec: Math.round((Number(file.duration) || 0) / 1e9),
        sizeBytes: Number(file.size) || 0,
      });
    }
    res.json({ received: true });
  } catch (_e) {
    res.status(400).json({ received: false });
  }
});

export default router;
