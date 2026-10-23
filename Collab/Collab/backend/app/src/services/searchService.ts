import { db } from "../platform";
import {
  serializeMessage,
  serializeMessageList,
  serializeConversation,
  serializeConversationList,
  serializeTask,
  serializeReminder,
  serializeMeeting,
  serializeMeetingList,
  pubUser,
} from "../serialize";
async function search(userId, q, orgId?) {
  if (!q || !q.trim())
    return {
      messages: [],
      people: [],
      conversations: [],
      tasks: [],
      reminders: [],
      meetings: [],
    };
  // Organizations: scope message search to the active tenant (closes the confirmed
  // cross-org FTS leak). Other domains follow the same pattern as Phase 1 proceeds.
  //
  // PERF: these domain reads are mutually INDEPENDENT — the handler used to await
  // them one after another, so its latency was the SUM of every round-trip. Fire
  // them concurrently in ONE Promise.all; only genuinely dependent work
  // (presenceCounts after meetings, and all serialization) stays sequential below.
  // interactionScores keeps its best-effort semantics via .catch (ranking is
  // optional — a failure must NOT abort search), matching the original try/catch.
  const [
    msgs,
    peopleSearchRaw,
    scores,
    convsRaw,
    tasksRaw,
    remindersRaw,
    meetingsRaw,
    filesRaw,
  ] = await Promise.all([
    db.messages.search(userId, q, orgId),
    db.users.search(q, orgId),
    db.users.interactionScores(userId).catch(() => null),
    db.conversations.listForUser(userId),
    db.tasks.search(userId, q, orgId),
    db.reminders.search(userId, q, orgId),
    db.meetings.search(userId, q, orgId),
    db.files.listAllForIndex(userId),
  ]);
  // People matches ranked by interaction frequency (most-interacted first),
  // matching the frequency ordering used across every people picker.
  const peopleRaw = peopleSearchRaw.map(pubUser).filter(Boolean);
  let people = peopleRaw;
  try {
    if (scores) {
      const rank = new Map(scores.map((s: any) => [s.userId, s.score]));
      people = peopleRaw
        .slice()
        .sort(
          (a: any, b: any) =>
            ((rank.get(b.id) as number) || 0) - ((rank.get(a.id) as number) || 0) ||
            String(a.name || "").localeCompare(String(b.name || "")),
        );
    }
  } catch (_) {
    /* ranking is best-effort; fall back to name order from the query */
  }
  // Serialize only rows that CAN match, not the whole workspace. For TITLED
  // groups/channels the display name IS the title (serialize.ts uses conv.title
  // verbatim), so a non-matching title can be skipped up front — provably
  // equivalent. DM/self/untitled-group names are DERIVED during serialization
  // (peer/member names), so those must still serialize. The post-serialization
  // name filter below stays the source of truth.
  const qlConv = q.toLowerCase();
  const candidates = convsRaw.filter(
    (c: any) =>
      !c.title || String(c.title).toLowerCase().includes(qlConv),
  );
  const convs = await serializeConversationList(candidates, userId);
  const matchedConvs = convs.filter((c) =>
    c.name.toLowerCase().includes(q.toLowerCase()),
  );
  const messages = await serializeMessageList(msgs, userId);
  const tasks = await Promise.all(tasksRaw.map((t) => serializeTask(t)));
  const reminders = remindersRaw.map(serializeReminder);
  // meetingsRaw is fetched above; presenceCounts DEPENDS on its ids so it stays
  // sequential (it can't run until we know which meetings matched).
  const mIds = meetingsRaw.map((m) => m.id);
  const mPresence = await db.meetings.presenceCounts(mIds);
  const meetings = await serializeMeetingList(meetingsRaw, userId, mPresence);
  // Files the user can access, matched by name (completes unified search: #17).
  // Uses the dedicated FULL-set index read (listAllForIndex), NOT the paginated
  // listForUser — otherwise pagination would silently truncate file search to
  // the first page (a file just stops being findable). The index must see every
  // file the user can access. (fetched above in the parallel batch.)
  const ql = q.toLowerCase();
  const files = filesRaw
    .filter((f) => (f.name || "").toLowerCase().includes(ql))
    .slice(0, 20)
    .map((f) => ({
      id: f.id,
      name: f.name,
      mime: f.mime || "application/octet-stream",
      size: f.size || 0,
      conversationId: f.conversationId || null,
    }));
  return {
    messages,
    people,
    conversations: matchedConvs,
    tasks,
    reminders,
    meetings,
    files,
  };
}
export { search };
