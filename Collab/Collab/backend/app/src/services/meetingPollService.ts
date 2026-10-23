// Meeting polls (0121).
//
// The database guarantees one answer per person; THIS layer guarantees who may
// do what, and — the part that actually matters — that an anonymous poll stays
// anonymous. Vote rows carry user_id even when anonymous, because that is what
// makes double-voting impossible; the duty not to reveal it lives here, in one
// place, rather than being re-decided at each call site.

import { db } from "../platform";

const MAX_OPTIONS = 10;
const MIN_OPTIONS = 2;

function bad(message: string, status = 400, code = "BAD_REQUEST"): never {
  const e: any = new Error(message);
  e.status = status;
  e.code = code;
  throw e;
}

// Everyone in the meeting may see and answer polls; only the host or a co-host
// may create, close or delete one. Same two-tier gate as every other meeting
// surface, so there is nothing new to reason about.
async function roleIn(meetingId: string, userId: string) {
  const m = await db.meetings.getById(meetingId);
  if (!m) bad("Meeting not found.", 404, "NOT_FOUND");
  const isHost = m.createdBy === userId;
  const role = await db.meetings.getAttendeeRole(meetingId, userId);
  const isCoHost = role === "co-host";
  if (!isHost && !role)
    bad("You are not part of this meeting.", 403, "FORBIDDEN");
  return { meeting: m, isHost, isCoHost, canManage: isHost || isCoHost };
}

export async function create({ meetingId, userId, question, options, anonymous, multiChoice }: any) {
  const { canManage } = await roleIn(meetingId, userId);
  if (!canManage) bad("Only the host or a co-host can start a poll.", 403, "FORBIDDEN");

  const q = String(question || "").trim();
  if (!q) bad("A poll needs a question.");
  if (q.length > 500) bad("That question is too long (500 characters max).");

  const opts = (Array.isArray(options) ? options : [])
    .map((o: any) => String(o == null ? "" : o).trim())
    .filter(Boolean);
  if (opts.length < MIN_OPTIONS) bad(`A poll needs at least ${MIN_OPTIONS} options.`);
  if (opts.length > MAX_OPTIONS) bad(`A poll can have at most ${MAX_OPTIONS} options.`);
  if (opts.some((o: string) => o.length > 200)) bad("An option is too long (200 characters max).");
  // Duplicate options make the result meaningless and are almost always a slip.
  if (new Set(opts.map((o: string) => o.toLowerCase())).size !== opts.length)
    bad("Two options are the same — give each one a distinct label.");

  const poll = await db.polls.create({
    meetingId,
    createdBy: userId,
    question: q,
    options: opts,
    // Anonymous by DEFAULT: a poll people answer honestly is worth more than one
    // whose answers can be traced, and a host who wants attribution must ask for
    // it deliberately.
    anonymous: anonymous !== false,
    multiChoice: !!multiChoice,
  });
  return serialize(poll, { counts: {}, voterCount: 0 }, [], true);
}

export async function list({ meetingId, userId }: any) {
  const { canManage } = await roleIn(meetingId, userId);
  const rows = await db.polls.listForMeeting(meetingId);
  return Promise.all(
    rows.map(async (p: any) => {
      const tally = await db.polls.tally(p.id);
      const mine = await db.polls.myVote(p.id, userId);
      return serialize(p, tally, mine, canManage);
    }),
  );
}

export async function vote({ pollId, userId, optionIndexes }: any) {
  const poll = await db.polls.getById(pollId);
  if (!poll) bad("Poll not found.", 404, "NOT_FOUND");
  const { canManage } = await roleIn(poll.meetingId, userId);
  if (poll.status !== "open") bad("This poll is closed.", 409, "POLL_CLOSED");

  const idx = (Array.isArray(optionIndexes) ? optionIndexes : [optionIndexes])
    .map((n: any) => Number(n))
    .filter((n: number) => Number.isInteger(n));
  if (!idx.length) bad("Choose an option.");
  if (idx.some((n: number) => n < 0 || n >= poll.options.length))
    bad("That option doesn't exist on this poll.");
  if (!poll.multiChoice && idx.length > 1)
    bad("This poll only allows one answer.");
  if (new Set(idx).size !== idx.length) bad("The same option was chosen twice.");

  await db.polls.vote(pollId, userId, Array.from(new Set(idx)));
  const tally = await db.polls.tally(pollId);
  return serialize(poll, tally, idx, canManage);
}

export async function close({ pollId, userId }: any) {
  const poll = await db.polls.getById(pollId);
  if (!poll) bad("Poll not found.", 404, "NOT_FOUND");
  const { canManage } = await roleIn(poll.meetingId, userId);
  if (!canManage) bad("Only the host or a co-host can close a poll.", 403, "FORBIDDEN");
  const closed = await db.polls.close(pollId);
  const tally = await db.polls.tally(pollId);
  const mine = await db.polls.myVote(pollId, userId);
  return serialize(closed, tally, mine, true);
}

export async function remove({ pollId, userId }: any) {
  const poll = await db.polls.getById(pollId);
  if (!poll) bad("Poll not found.", 404, "NOT_FOUND");
  const { canManage } = await roleIn(poll.meetingId, userId);
  if (!canManage) bad("Only the host or a co-host can delete a poll.", 403, "FORBIDDEN");
  return db.polls.remove(pollId);
}

// Who voted for what — refused outright for an anonymous poll rather than
// filtered, so there is no code path that could leak it by accident.
export async function voters({ pollId, userId }: any) {
  const poll = await db.polls.getById(pollId);
  if (!poll) bad("Poll not found.", 404, "NOT_FOUND");
  const { canManage } = await roleIn(poll.meetingId, userId);
  if (!canManage) bad("Only the host or a co-host can see who voted.", 403, "FORBIDDEN");
  if (poll.anonymous)
    bad(
      "This poll is anonymous — who voted for what is not recorded for anyone to see.",
      409,
      "POLL_ANONYMOUS",
    );
  const rows = await db.polls.voters(pollId);
  const users = await db.users.getByIds(rows.map((r: any) => r.userId));
  const byId = new Map<string, any>((users || []).map((u: any) => [u.id, u]));
  return rows.map((r: any) => {
    const u: any = byId.get(r.userId);
    return {
      userId: r.userId,
      name: (u && u.name) || "Unknown",
      optionIndex: r.optionIndex,
      option: poll.options[r.optionIndex] ?? null,
    };
  });
}

// The wire shape. Results are visible to everyone as they come in — a poll whose
// results only the host can see is a survey, and people stop answering surveys.
function serialize(poll: any, tally: any, myVote: number[], canManage: boolean) {
  const counts = tally.counts || {};
  const total = poll.options.reduce(
    (sum: number, _o: string, i: number) => sum + (counts[i] || 0),
    0,
  );
  return {
    id: poll.id,
    meetingId: poll.meetingId,
    question: poll.question,
    status: poll.status,
    anonymous: poll.anonymous,
    multiChoice: poll.multiChoice,
    createdBy: poll.createdBy,
    createdAt: poll.createdAt,
    closedAt: poll.closedAt,
    canManage,
    myVote,
    voterCount: tally.voterCount || 0,
    options: poll.options.map((label: string, i: number) => {
      const votes = counts[i] || 0;
      return {
        index: i,
        label,
        votes,
        // Percentage of VOTES CAST, not of people present — a multi-choice poll
        // sums above 100% of voters, and "% of the room" would need a live
        // headcount that changes under the reader.
        percent: total ? Math.round((votes / total) * 100) : 0,
      };
    }),
  };
}
