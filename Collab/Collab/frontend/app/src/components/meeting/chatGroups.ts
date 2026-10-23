// In-call chat: group consecutive messages from the same sender (within 5
// minutes, same day) into one "run" — avatar + name once, bubbles stacked,
// time + ticks under the run — and insert "Today / Yesterday / date" dividers.
// Shared by the meeting panel (MeetingStage) and the call panel (CallModal).
export type ChatRun<T> = {
  kind: "run";
  key: string;
  mine: boolean;
  sender: string;
  senderName: string;
  items: T[];
  last: number;
};
export type ChatDay = { kind: "day"; key: string; label: string };

const RUN_GAP_MS = 5 * 60 * 1000;

export function dayLabelOf(ts: number): string {
  const d = new Date(ts);
  const now = new Date();
  const sameDay = (a: Date, b: Date) =>
    a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
  if (sameDay(d, now)) return "Today";
  const y = new Date(now);
  y.setDate(now.getDate() - 1);
  if (sameDay(d, y)) return "Yesterday";
  return d.toLocaleDateString(undefined, { weekday: "short", day: "numeric", month: "short" });
}

export function groupChatMessages<T>(
  msgs: T[],
  f: { id: (m: T) => string; sender: (m: T) => string; name: (m: T) => string; ts: (m: T) => number; mine: (m: T) => boolean },
): Array<ChatRun<T> | ChatDay> {
  const out: Array<ChatRun<T> | ChatDay> = [];
  let run: ChatRun<T> | null = null;
  let lastDay = "";
  for (const m of msgs || []) {
    const ts = Number(f.ts(m)) || Date.now();
    const day = dayLabelOf(ts);
    if (day !== lastDay) {
      out.push({ kind: "day", key: "day:" + day + ":" + f.id(m), label: day });
      lastDay = day;
      run = null;
    }
    const sender = f.sender(m);
    if (run && run.sender === sender && ts - run.last <= RUN_GAP_MS) {
      run.items.push(m);
      run.last = ts;
    } else {
      run = { kind: "run", key: "run:" + f.id(m), mine: f.mine(m), sender, senderName: f.name(m), items: [m], last: ts };
      out.push(run);
    }
  }
  return out;
}
