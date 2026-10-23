// Cross-cutting telemetry (§9.2) end-to-end. Pure REST. The usage-counter
// pipeline: client-style batches land anonymously via POST /api/telemetry/events
// (strict name vocabulary, junk dropped, batch capped), server-side product
// actions bump counters in-process (recurrence pattern distribution, the
// reschedule/cancel occurrence-vs-series split), and the authed GET returns
// per-day aggregates with no user dimension at all.
const BASE = process.env.BASE || "http://localhost:4010";
const ts = Date.now();
const PW = "Passw0rd!123";
let pass = 0, fail = 0;
const ok = (n, c, e = "") => { if (c) { pass++; console.log("  PASS " + n); } else { fail++; console.log("  FAIL " + n + "  " + e); } };
const call = async (m, p, t, b) => {
  const res = await fetch(BASE + p, { method: m, headers: { "Content-Type": "application/json", ...(t ? { Authorization: "Bearer " + t } : {}) }, body: b ? JSON.stringify(b) : undefined });
  let j = null; try { j = await res.json(); } catch {}
  return { status: res.status, j };
};

const r = await call("POST", "/api/auth/signup", null, { email: `tm-${ts}@t.local`, password: PW, name: "Telemetry Tester" });
const tok = r.j?.data?.token;
ok("signup", !!tok);
if (fail) process.exit(1);

// ── Client-style batch: valid names counted, junk silently dropped ──────────
const batch = await fetch(BASE + "/api/telemetry/events", {
  method: "POST",
  headers: { "Content-Type": "application/json" }, // deliberately UNAUTHED
  body: JSON.stringify({ events: [
    "view.switch.speaker", "view.switch.speaker", "popout.open.docpip",
    "chat.jump_pill.tap",
    "<script>alert(1)</script>", "x", "UPPER.case", "a".repeat(80),
  ] }),
});
ok("§9.2 anonymous batch accepted with 204", batch.status === 204, `status=${batch.status}`);

const summary = async () => (await call("GET", "/api/telemetry/events?days=2", tok)).j?.data || [];
const s1 = await summary();
const cnt = (name) => (s1.find((e) => e.name === name) || {}).count || 0;
ok("valid events aggregated with correct counts", cnt("view.switch.speaker") >= 2 && cnt("popout.open.docpip") >= 1 && cnt("chat.jump_pill.tap") >= 1, JSON.stringify(s1.map((e) => e.name)).slice(0, 160));
ok("junk names dropped by the vocabulary gate", !s1.some((e) => /script|UPPER|^x$/.test(e.name)));
ok("aggregates carry NO user dimension", s1.every((e) => Object.keys(e).sort().join(",") === "count,day,name"), JSON.stringify(Object.keys(s1[0] || {})));

// ── Auth posture ────────────────────────────────────────────────────────────
const noAuth = await fetch(BASE + "/api/telemetry/events?days=2");
ok("readout requires auth", noAuth.status === 401, `status=${noAuth.status}`);

// ── Batch cap: 60 copies → at most 50 counted ───────────────────────────────
await fetch(BASE + "/api/telemetry/events", {
  method: "POST", headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ events: Array(60).fill("view.pin.on") }),
});
const s2 = await summary();
const pinCount = (s2.find((e) => e.name === "view.pin.on") || {}).count || 0;
ok("batch capped at 50 events", pinCount === 50, `count=${pinCount}`);

// ── Server-side counters ride the real product flows ────────────────────────
const base = new Date(Date.now() + 2 * 86400000);
base.setUTCHours(9, 0, 0, 0);
const weekly = await call("POST", "/api/meetings", tok, {
  title: `TelWeekly ${ts}`, startsAt: base.toISOString(), durationMin: 30, attendees: [],
  recurrence: "weekly",
  recurrenceRule: { freq: "weekly", interval: 1, byWeekday: [base.getUTCDay()], end: { type: "after", count: 6 } },
});
await call("POST", "/api/meetings", tok, { title: `TelSingle ${ts}`, startsAt: base.toISOString(), durationMin: 30, attendees: [] });
const mid = weekly.j?.data?.id;
const occs = ((await call("GET", "/api/meetings?calendar=1&count=6", tok)).j?.data || []).filter((x) => x.meetingId === mid);
await call("PATCH", `/api/meetings/${mid}`, tok, {
  startsAt: new Date(Date.parse(occs[1].startsAt) + 3600000).toISOString(),
  occurrenceScope: "single", occurrenceKey: occs[1].occurrenceKey, occurrenceStartsAt: occs[1].startsAt,
});
await call("POST", `/api/meetings/${mid}/cancel`, tok, { scope: "occurrence", occurrenceStartsAt: occs[2].occurrenceKey });
await call("POST", `/api/meetings/${mid}/cancel`, tok, {});
await new Promise((r2) => setTimeout(r2, 500));
const s3 = await summary();
const c3 = (name) => (s3.find((e) => e.name === name) || {}).count || 0;
ok("recurrence pattern distribution counted", c3("meeting.create.weekly") >= 1 && c3("meeting.create.single") >= 1, JSON.stringify(s3.filter((e) => e.name.startsWith("meeting.create")).map((e) => e.name)));
ok("reschedule occurrence-vs-series split counted", c3("meeting.reschedule.occurrence") >= 1);
ok("cancel occurrence-vs-series split counted", c3("meeting.cancel.occurrence") >= 1 && c3("meeting.cancel.series") >= 1, JSON.stringify(s3.filter((e) => e.name.startsWith("meeting.cancel"))));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
