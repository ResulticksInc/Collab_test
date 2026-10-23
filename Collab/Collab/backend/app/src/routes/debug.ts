import { asyncRouter } from "../asyncRouter";
const router = asyncRouter();
import authMiddleware from "../middleware/auth";
import { db, config, ok, shared } from "../platform";
import { send as sendMessage } from "../services/messageService";
import mysql from "mysql2/promise";

router.use(authMiddleware);

// POST /api/debug/voice-proof
// Creates a set of parent->reply message pairs covering voice/text combinations
// and returns DB rows (raw SELECT), serialized API objects (serializeMessage),
// and a DESCRIBE messages to verify schema.
router.post("/voice-proof", async (req, res) => {
  const userId = req.user.userId;
  const convId = (req.body || {}).conversationId;
  if (!convId) return res.status(400).json({ ok: false, error: { message: "conversationId required" } });
  // Ensure caller is member by using send; messageService will assert membership.
  try {
    const outcomes = [];
    const combos = [
      ["voice", "voice"],
      ["voice", "text"],
      ["text", "voice"],
      ["text", "text"],
    ];
    for (const [parentType, replyType] of combos) {
      // create parent
      const parentPayload: any = { conversationId: convId, senderId: userId };
      if (parentType === "voice") {
        parentPayload.type = "voice";
        parentPayload.voice = { fileId: "dbg-parent-" + Math.random().toString(36).slice(2), duration: 3, waveform: null, mimeType: "audio/webm" };
      } else {
        parentPayload.text = "Parent " + parentType + " at " + new Date().toISOString();
      }
      const parent = await sendMessage(parentPayload);
      // create reply referencing parent
      const replyPayload: any = { conversationId: convId, senderId: userId, parentMessageId: parent.id };
      if (replyType === "voice") {
        replyPayload.type = "voice";
        replyPayload.voice = { fileId: "dbg-reply-" + Math.random().toString(36).slice(2), duration: 7, waveform: null, mimeType: "audio/webm" };
      } else {
        replyPayload.text = "Reply " + replyType + " at " + new Date().toISOString();
      }
      const reply = await sendMessage(replyPayload);

      // Raw DB SELECT for reply row
      const u = new URL(config.database.url);
      const conn = await mysql.createConnection({
        host: u.hostname === "localhost" ? "127.0.0.1" : u.hostname,
        port: Number(u.port) || 3306,
        user: decodeURIComponent(u.username),
        password: decodeURIComponent(u.password),
        database: decodeURIComponent(u.pathname.replace(/^\//, "")),
      });
      const [rows] = await conn.query(
        `SELECT id, type, voice_json, file_json, parent_message_id FROM messages WHERE id = ? LIMIT 1`,
        [reply.id],
      );
      const rawRow = Array.isArray(rows) && rows[0] ? rows[0] : null;
      const [descRows] = await conn.query(`DESCRIBE messages`);
      await conn.end();

      outcomes.push({ parent, reply, rawRow, describe: descRows });
    }
    return res.json(ok(outcomes));
  } catch (e) {
    console.error("[debug.voice-proof]", e);
    return res.status(500).json({ ok: false, error: { message: "debug failed" } });
  }
});

// GET /api/debug/message/:id
// Return raw DB row and DESCRIBE for an existing message id (real production path)
router.get("/message/:id", async (req, res) => {
  const id = req.params.id;
  if (!id) return res.status(400).json({ ok: false, error: { message: "id required" } });
  try {
    const u = new URL((require("../../../config/src")).database.url);
    const mysql = require("mysql2/promise");
    const conn = await mysql.createConnection({
      host: u.hostname === "localhost" ? "127.0.0.1" : u.hostname,
      port: Number(u.port) || 3306,
      user: decodeURIComponent(u.username),
      password: decodeURIComponent(u.password),
      database: decodeURIComponent(u.pathname.replace(/^\//, "")),
    });
    const [rows] = await conn.query(
      `SELECT id, type, voice_json, file_json, parent_message_id FROM messages WHERE id = ? LIMIT 1`,
      [id],
    );
    const [descRows] = await conn.query(`DESCRIBE messages`);
    await conn.end();
    // include any recent incoming client payload recorded by the realtime layer
    let incoming = null;
    try {
      const rt = require("../realtime/socket");
      incoming = rt && rt.recentIncoming ? rt.recentIncoming.get(id) || null : null;
    } catch (_) {
      incoming = null;
    }
    return res.json(ok({ rawRow: rows[0] || null, describe: descRows, incoming }));
  } catch (e) {
    console.error("[debug.message]", e);
    return res.status(500).json({ ok: false, error: { message: "debug lookup failed" } });
  }
});

export default router;
