// Recurring meetings end-to-end (§8: RCR-03/04/05/22/27). Pure REST.
// Headline: RCR-22 "this and all following" — the series splits, the past keeps
// its schedule, the future carries the edit, exceptions partition at the split,
// and BOTH series share the one meeting chat. BASE = backend directly.
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
const mk = async (slug, name) => {
  const email = `rc-${slug}-${ts}@t.local`;
  const r = await call("POST", "/api/auth/signup", null, { email, password: PW, name });
  return { tok: r.j?.data?.token, id: r.j?.data?.user?.id, email, name };
};

const host = await mk("host", "Rec2 Host");
const inv = await mk("inv", "Rec2 Invitee");
ok("signup x2", !!host.tok && !!inv.tok);
if (fail) process.exit(1);
const invite = await call("POST", "/api/invites", host.tok, { toUserId: inv.id });
if (invite.j?.data?.id) await call("POST", `/api/invites/${invite.j.data.id}/accept`, inv.tok, {});

const base = new Date(Date.now() + 2 * 86400000);
base.setUTCHours(9, 0, 0, 0);

// ── RCR-03: series horizon enforced at validation ───────────────────────────
const tooMany = await call("POST", "/api/meetings", host.tok, {
  title: `Horizon ${ts}`, startsAt: base.toISOString(), durationMin: 30, attendees: [],
  recurrence: "weekly",
  recurrenceRule: { freq: "weekly", interval: 1, end: { type: "after", count: 5000 } },
});
ok("RCR-03 >730 occurrences rejected", tooMany.status === 400, `status=${tooMany.status}`);
const tooFar = await call("POST", "/api/meetings", host.tok, {
  title: `Horizon2 ${ts}`, startsAt: base.toISOString(), durationMin: 30, attendees: [],
  recurrence: "weekly",
  recurrenceRule: { freq: "weekly", interval: 1, end: { type: "on", date: new Date(Date.now() + 10 * 366 * 86400000).toISOString().slice(0, 10) } },
});
ok("RCR-03 end date >5 years rejected", tooFar.status === 400, `status=${tooFar.status}`);

// ── RCR-04: monthly day-31 — clamp (default) vs skip ────────────────────────
// Anchor on the NEXT future 31st so the series is valid whenever this runs.
const anchor31 = (() => {
  const d = new Date();
  for (let i = 1; i < 14; i++) {
    const c = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + i, 31, 9, 0, 0));
    if (c.getUTCDate() === 31 && c.getTime() > Date.now() + 86400000) return c;
  }
  return null;
})();
const mkMonthly = async (shortMode) =>
  call("POST", "/api/meetings", host.tok, {
    title: `Monthly31 ${shortMode || "clamp"} ${ts}`,
    startsAt: anchor31.toISOString(), durationMin: 30, attendees: [],
    recurrence: "monthly",
    recurrenceRule: { freq: "monthly", interval: 1, monthlyMode: "day", day: 31, ...(shortMode ? { monthlyShortMode: shortMode } : {}), end: { type: "after", count: 6 } },
  });
const clampM = await mkMonthly(null);
const skipM = await mkMonthly("skip");
const calFor = async (mid) => ((await call("GET", "/api/meetings?calendar=1&count=6", host.tok)).j?.data || []).filter((r) => r.meetingId === mid || r.seriesId === mid);
const clampOccs = await calFor(clampM.j?.data?.id);
const skipOccs = await calFor(skipM.j?.data?.id);
const dayOf = (o) => new Date(o.startsAt).getUTCDate();
ok("RCR-04 clamp lands on short months' LAST day (never the next month's 1st)",
  clampOccs.length === 6 && clampOccs.every((o) => dayOf(o) >= 28) && clampOccs.some((o) => dayOf(o) < 31),
  JSON.stringify(clampOccs.map(dayOf)));
ok("RCR-04 skip emits ONLY true day-31 months", skipOccs.length >= 3 && skipOccs.every((o) => dayOf(o) === 31), JSON.stringify(skipOccs.map(dayOf)));
ok("RCR-04 bad shortMode rejected", (await call("POST", "/api/meetings", host.tok, {
  title: "x", startsAt: base.toISOString(), durationMin: 30, attendees: [], recurrence: "monthly",
  recurrenceRule: { freq: "monthly", monthlyMode: "day", day: 31, monthlyShortMode: "wat", end: { type: "after", count: 3 } },
})).status === 400);

// ── RCR-05: next-dates preview, before anything is saved ────────────────────
const prev = await call("POST", "/api/meetings/preview-occurrences", host.tok, {
  startsAt: base.toISOString(),
  recurrence: "weekly",
  recurrenceRule: { freq: "weekly", interval: 2, byWeekday: [base.getUTCDay()], end: { type: "after", count: 10 } },
  count: 5,
});
const dates = prev.j?.data || [];
const fortnight = dates.length === 5 && dates.every((d, i) => i === 0 || Date.parse(d) - Date.parse(dates[i - 1]) === 14 * 86400000);
ok("RCR-05 preview returns 5 dates a fortnight apart", prev.status === 200 && fortnight, JSON.stringify(dates));

// ── RCR-22: split a weekly 6-series at occurrence #3 ────────────────────────
const mtg = await call("POST", "/api/meetings", host.tok, {
  title: `Split series ${ts}`, startsAt: base.toISOString(), durationMin: 30, attendees: [inv.id],
  recurrence: "weekly",
  recurrenceRule: { freq: "weekly", interval: 1, byWeekday: [base.getUTCDay()], end: { type: "after", count: 6 } },
});
const mid = mtg.j?.data?.id;
const gid = mtg.j?.data?.meetingGroup?.id;
ok("series + shared chat scheduled", !!mid && !!gid);
const occs0 = await calFor(mid);
const [, , o3, , o5] = occs0;
// Pre-split exception AFTER the split point: cancel occurrence #5.
await call("POST", `/api/meetings/${mid}/cancel`, host.tok, { scope: "occurrence", occurrenceStartsAt: o5.occurrenceKey });
// Split at occurrence #3 with a +2h time change.
const newIso = new Date(Date.parse(o3.startsAt) + 2 * 3600000).toISOString();
const split = await call("PATCH", `/api/meetings/${mid}`, host.tok, {
  startsAt: newIso,
  occurrenceScope: "following",
  occurrenceKey: o3.occurrenceKey,
  occurrenceStartsAt: o3.startsAt,
});
const newId = split.j?.data?.meetingId || split.j?.data?.id;
ok("RCR-22 split returns the new series", split.status === 200 && !!split.j?.data?._seriesSplit && newId !== mid, JSON.stringify(split.j?.data?._seriesSplit || {}));
const oldOccs = await calFor(mid);
const newOccs = await calFor(newId);
ok("RCR-22 original keeps only the pre-split occurrences", oldOccs.length === 2, `old=${oldOccs.length}`);
ok("RCR-22 new series carries the rest at the NEW time (minus the moved-over exclusion)",
  newOccs.length === 3 && newOccs.every((o) => new Date(o.startsAt).toISOString().slice(11, 16) === newIso.slice(11, 16)),
  JSON.stringify(newOccs.map((o) => o.startsAt)));
ok("RCR-22 the excluded occurrence moved WITH the split", !newOccs.some((o) => o.occurrenceKey === o5.occurrenceKey));
ok("RCR-22 both series share ONE meeting chat", newOccs[0]?.conversationId === gid, `conv=${newOccs[0]?.conversationId} gid=${gid}`);
ok("RCR-22 attendees carried to the new series", (newOccs[0]?.attendees || []).some((a) => a.id === inv.id || a.userId === inv.id));
const postSplit = await call("POST", `/api/conversations/${gid}/messages`, inv.tok, { text: "same chat after split" });
ok("RCR-22 invitee still posts in the shared chat", !!postSplit.j?.ok);

// ── RCR-27: end the new series early — artifacts stay ───────────────────────
const today = new Date().toISOString().slice(0, 10);
const endEarly = await call("PATCH", `/api/meetings/${newId}`, host.tok, {
  recurrenceRule: { freq: "weekly", interval: 1, byWeekday: [base.getUTCDay()], end: { type: "on", date: today } },
});
ok("RCR-27 end-after-today accepted", endEarly.status === 200);
const ended = await calFor(newId);
ok("RCR-27 no future occurrences remain", ended.length === 0, `n=${ended.length}`);
const chat = (await call("GET", `/api/conversations/${gid}/messages`, inv.tok)).j?.data || [];
ok("RCR-27 chat history untouched by ending the series", chat.some((m) => /same chat after split/.test(m.text || "")));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
