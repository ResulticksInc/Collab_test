// Backend proof: replicate EXACTLY the socket payload the frontend's onSendFile
// builds for a VOICE reply (type:'voice' + voice{} + parentMessageId), then read
// it back from the API to see whether parentMessageId persisted. No assumptions.
import axios from "axios";
import { io } from "socket.io-client";
import fs from "fs";
import jwt from "jsonwebtoken";
import dotenv from "dotenv";
dotenv.config();

const BASE = process.env.NEXT_PUBLIC_API_BASE_URL || "http://localhost:4000";
const SOCK = process.env.NEXT_PUBLIC_SOCKET_URL || "http://localhost:4000";
const userId = "u_kp_aravinth_resulticksmail_com";
const token = jwt.sign({ sub: userId, userId }, process.env.AUTH_JWT_SECRET!, { expiresIn: "1d" });

const CONV = process.argv[2] || "12b4506a-b34b-46e0-bd2a-1e5a800ed688";
const PARENT = process.argv[3] || "9db2ba08"; // a VOICE message -> tests voice→voice
const { EVENTS } = require("../shared/src/index.ts");

async function uploadDummy() {
  // Match frontend api.uploadFile exactly: raw bytes in body, metadata in query.
  const bytes = fs.readFileSync("dummy_voice.webm");
  const qs = new URLSearchParams({ name: "Voice Message.webm", mime: "audio/webm", conversationId: CONV });
  const r = await axios.post(`${BASE}/api/files?${qs}`, bytes, {
    headers: { "Content-Type": "audio/webm", Authorization: `Bearer ${token}` },
  });
  return r.data.data ?? r.data;
}

(async () => {
  // resolve full parent id from prefix
  const hist = (await axios.get(`${BASE}/api/conversations/${CONV}/messages?limit=200`, { headers: { Authorization: `Bearer ${token}` } })).data;
  const msgs = hist.data ?? hist;
  const parent = msgs.find((m: any) => m.id.startsWith(PARENT));
  if (!parent) throw new Error(`parent ${PARENT} not found in conv ${CONV}`);
  console.log(`parent: id=${parent.id} type=${parent.type}`);

  const meta = await uploadDummy();
  console.log("uploaded fileId=", meta.id, "mime=", meta.mime || meta.type);

  const payload: any = {
    conversationId: CONV,
    parentMessageId: parent.id,
    type: "voice",
    voice: { fileId: meta.id, duration: 3, waveform: null, mimeType: meta.mime || "audio/webm" },
    file: meta,
  };
  console.log("EMITTING payload:", JSON.stringify(payload));

  const socket = io(SOCK, { auth: { token }, transports: ["websocket"] });
  const newMsg: any = await new Promise((resolve, reject) => {
    socket.on("connect", () => {
      socket.emit(EVENTS.CONVERSATION_JOIN, { conversationId: CONV });
      socket.on(EVENTS.MESSAGE_NEW, (m: any) => { if (m.type === "voice" && m.parentMessageId) resolve(m); });
      socket.emit(EVENTS.MESSAGE_SEND, payload);
      setTimeout(() => resolve(null), 4000);
    });
    socket.on("connect_error", reject);
  });
  socket.disconnect();

  console.log("\nMESSAGE_NEW broadcast received:", newMsg ? JSON.stringify({ id: newMsg.id, type: newMsg.type, parentMessageId: newMsg.parentMessageId }) : "(none / no parent)");

  // read back from API as source of truth
  const hist2 = (await axios.get(`${BASE}/api/conversations/${CONV}/messages?limit=200`, { headers: { Authorization: `Bearer ${token}` } })).data;
  const after = (hist2.data ?? hist2).filter((m: any) => m.type === "voice").slice(-3);
  console.log("\nLast voice msgs from API (id | type | parentMessageId):");
  for (const m of after) console.log(`  ${m.id.slice(0, 8)} | ${m.type} | parent=${m.parentMessageId || "null"}`);
  process.exit(0);
})().catch((e) => { console.error("FAILED:", e.response?.data || e.message); process.exit(1); });
