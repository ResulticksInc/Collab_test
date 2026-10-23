// Reschedule & cancel end-to-end (§7 + §8: RSCH-02/04/06/08/09/10, CNCL-01/04/05/08,
// RCR-20/21/23). Pure REST — no browser, no SFU. The headline: "This event only"
// used to silently rewrite the whole series (occurrenceScope was sent by the
// client and read by nothing); now it writes a per-occurrence override. BASE
// points at the BACKEND directly (default http://localhost:4010).
const BASE = process.env.BASE || "http://localhost:4010";
const ts = Date.now();
const PW = "Passw0rd!123";
let pass = 0, fail = 0;
const ok = (n, c, e = "") => { if (c) { pass++; console.log("  PASS " + n); } else { fail++; console.log("  FAIL " + n + "  " + e); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const call = async (m, p, t, b) => {
  const res = await fetch(BASE + p, { method: m, headers: { "Content-Type": "application/json", ...(t ? { Authorization: "Bearer " + t } : {}) }, body: b ? JSON.stringify(b) : undefined });
  let j = null; try { j = await res.json(); } catch {}
  return { status: res.status, j };
};
const mk = async (slug, name) => {
  const email = `rs-${slug}-${ts}@t.local`;
  const r = await call("POST", "/api/auth/signup", null, { email, password: PW, name });
  return { tok: r.j?.data?.token, id: r.j?.data?.user?.id, email, name };
};

const host = await mk("host", "Sched Host");
const inv = await mk("inv", "Sched Invitee");
ok("signup x2", !!host.tok && !!inv.tok);
if (fail) process.exit(1);
const invite = await call("POST", "/api/invites", host.tok, { toUserId: inv.id });
if (invite.j?.data?.id) await call("POST", `/api/invites/${invite.j.data.id}/accept`, inv.tok, {});

// Weekly series, 6 occurrences, starting in 2 days at 09:00 UTC.
const start = new Date(Date.now() + 2 * 86400000);
start.setUTCHours(9, 0, 0, 0);
const mtg = await call("POST", "/api/meetings", host.tok, {
  title: `Weekly sync ${ts}`,
  startsAt: start.toISOString(),
  durationMin: 30,
  attendees: [inv.id],
  recurrence: "weekly",
  recurrenceRule: { freq: "weekly", interval: 1, byWeekday: [start.getUTCDay()], end: { type: "after", count: 6 } },
});
const mid = mtg.j?.data?.id;
const gid = mtg.j?.data?.meetingGroup?.id;
ok("weekly series scheduled", !!mid && !!gid);
if (fail) process.exit(1);

const calendar = async (u = host) => {
  const rows = (await call("GET", "/api/meetings?calendar=1&count=6", u.tok)).j?.data || [];
  return rows.filter((r) => r.meetingId === mid || r.seriesId === mid);
};
const occs0 = await calendar();
ok("calendar expands 6 occurrences with stable keys", occs0.length === 6 && occs0.every((o) => !!o.occurrenceKey), `n=${occs0.length}`);
const [o1, o2, o3] = occs0;

// ── RSCH-02 / RCR-20: move ONLY occurrence #2 (+2h) ─────────────────────────
const movedIso = new Date(Date.parse(o2.startsAt) + 2 * 3600000).toISOString();
const single = await call("PATCH", `/api/meetings/${mid}`, host.tok, {
  startsAt: movedIso,
  occurrenceScope: "single",
  occurrenceKey: o2.occurrenceKey,
  occurrenceStartsAt: o2.startsAt,
});
ok("single-occurrence PATCH accepted", single.status === 200, JSON.stringify(single.j).slice(0, 120));
const occs1 = await calendar();
const m2 = occs1.find((o) => o.occurrenceKey === o2.occurrenceKey);
ok("RCR-20 only that occurrence moved", m2 && m2.startsAt === movedIso, `startsAt=${m2?.startsAt}`);
ok("RCR-21 moved occurrence flagged as exception", m2 && m2.isException === true);
const o1b = occs1.find((o) => o.occurrenceKey === o1.occurrenceKey);
const o3b = occs1.find((o) => o.occurrenceKey === o3.occurrenceKey);
ok("RSCH-02 sibling occurrences untouched", o1b?.startsAt === o1.startsAt && o3b?.startsAt === o3.startsAt);
ok("series anchor untouched by the single edit", o1b?.seriesStartsAt === start.toISOString(), `anchor=${o1b?.seriesStartsAt}`);

// ── RSCH-08: a PAST occurrence can't be edited ──────────────────────────────
const past = await call("PATCH", `/api/meetings/${mid}`, host.tok, {
  startsAt: movedIso,
  occurrenceScope: "single",
  occurrenceStartsAt: new Date(Date.now() - 7 * 86400000).toISOString(),
});
ok("RSCH-08 past occurrence edit rejected", past.status === 400, `status=${past.status}`);

// ── RSCH-04: RSVP resets only on time change ────────────────────────────────
await call("POST", `/api/meetings/${mid}/rsvp`, inv.tok, { status: "accepted" });
await call("PATCH", `/api/meetings/${mid}`, host.tok, { title: `Weekly sync RENAMED ${ts}` });
const afterTitle = (await calendar(inv))[0];
ok("RSCH-04 title edit preserves RSVP", afterTitle?.myStatus === "accepted", `myStatus=${afterTitle?.myStatus}`);
const seriesMove = new Date(Date.parse(start.toISOString()) + 3600000).toISOString();
await call("PATCH", `/api/meetings/${mid}`, host.tok, { startsAt: seriesMove });
await sleep(600);
const afterMove = (await calendar(inv))[0];
ok("RSCH-04 time edit resets RSVP", afterMove?.myStatus === "invited", `myStatus=${afterMove?.myStatus}`);

// ── RSCH-09: the series edit KEPT the occurrence exception ──────────────────
const occs2 = await calendar();
const m2b = occs2.find((o) => o.occurrenceKey === o2.occurrenceKey);
ok("RSCH-09 series edit keeps the exception (default keep)", m2b && m2b.isException === true && m2b.startsAt === movedIso, `startsAt=${m2b?.startsAt}`);

// ── RSCH-10: reschedule trace in the meeting chat ───────────────────────────
const msgs1 = (await call("GET", `/api/conversations/${gid}/messages`, host.tok)).j?.data || [];
ok("RSCH-10 'moved this meeting' trace in chat", msgs1.some((m) => /moved this meeting to/.test(m.text || "")), JSON.stringify(msgs1.map((m) => (m.text || "").slice(0, 30))).slice(0, 180));

// ── RSCH-06: iCalendar carries SEQUENCE + real RRULE + METHOD:REQUEST ───────
const ics1 = await fetch(`${BASE}/api/meetings/${mid}/ics`, { headers: { Authorization: "Bearer " + host.tok } }).then((r) => r.text());
ok("RSCH-06 SEQUENCE present and bumped", /SEQUENCE:[2-9]/.test(ics1), (ics1.match(/SEQUENCE:\d+/) || [])[0]);
ok("RSCH-06 structured RRULE exported", /RRULE:FREQ=WEEKLY/.test(ics1) && /COUNT=6/.test(ics1) && /BYDAY=/.test(ics1), (ics1.match(/RRULE:[^\r\n]+/) || [])[0]);
ok("RSCH-06 update is METHOD:REQUEST", /METHOD:REQUEST/.test(ics1));

// ── CNCL-01 / RCR-23: cancel ONE occurrence ─────────────────────────────────
const cnclOcc = await call("POST", `/api/meetings/${mid}/cancel`, host.tok, {
  scope: "occurrence",
  occurrenceStartsAt: o3.occurrenceKey,
  note: "skipping this week",
});
ok("occurrence cancel accepted", cnclOcc.status === 200 && !!cnclOcc.j?.data?._occurrenceCancelled, JSON.stringify(cnclOcc.j).slice(0, 120));
const occs3 = await calendar();
ok("RCR-23 cancelled occurrence gone, siblings intact", occs3.length === 5 && !occs3.some((o) => o.occurrenceKey === o3.occurrenceKey), `n=${occs3.length}`);
const ics2 = await fetch(`${BASE}/api/meetings/${mid}/ics`, { headers: { Authorization: "Bearer " + host.tok } }).then((r) => r.text());
ok("RCR-23 EXDATE exported for the cancelled occurrence", /EXDATE:/.test(ics2), (ics2.match(/EXDATE:[^\r\n]+/) || [])[0]);
const msgs2 = (await call("GET", `/api/conversations/${gid}/messages`, host.tok)).j?.data || [];
ok("occurrence-cancel trace (with note) in chat", msgs2.some((m) => /occurrence was cancelled: skipping this week/.test(m.text || "")));

// ── CNCL series: link dies, chat lives, audit written ───────────────────────
await call("POST", `/api/meetings/${mid}/cancel`, host.tok, { note: "moving to async" });
await sleep(600);
const enter = await call("POST", `/api/meetings/${mid}/room/enter`, inv.tok, {});
ok("CNCL-04 join is closed after series cancel", enter.j?.data?.closed === true, JSON.stringify(enter.j).slice(0, 100));
const post = await call("POST", `/api/conversations/${gid}/messages`, inv.tok, { text: "sad — follow-up here then" });
ok("CNCL-05 meeting chat still writable after cancel", !!post.j?.ok);
const ics3 = await fetch(`${BASE}/api/meetings/${mid}/ics`, { headers: { Authorization: "Bearer " + host.tok } }).then((r) => r.text());
ok("CNCL-03 cancellation exports METHOD:CANCEL + STATUS:CANCELLED", /METHOD:CANCEL/.test(ics3) && /STATUS:CANCELLED/.test(ics3));
const audit = (await call("GET", "/api/audit", host.tok)).j?.data || [];
ok("CNCL-08 both cancels audit-logged with scope", audit.filter((e) => e.action === "meeting.cancel").length >= 2 && audit.some((e) => e.action === "meeting.cancel" && e.detail && /occurrence/.test(JSON.stringify(e.detail))), JSON.stringify(audit.map((e) => e.action)).slice(0, 140));
ok("RSCH audit rows for the reschedules", audit.some((e) => e.action === "meeting.reschedule"));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
