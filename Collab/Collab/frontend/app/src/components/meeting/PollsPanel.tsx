import { useCallback, useEffect, useState } from "react";
import { api } from "../../lib/api";
import { EVENTS } from "../../lib/socket";
import { IconX, IconPlus, IconCheck } from "../../lib/icons";

// Polls in the meeting side panel (0121).
//
// Kept OUT of MeetingStage on purpose: that component is 4,970 lines and every
// feature added inside it makes the next one harder. This owns its own fetch,
// socket subscription and form state, and the stage mounts it in one line.
//
// Results are visible to everyone as votes land — a poll whose results only the
// host can see is a survey, and people stop answering surveys.

interface PollOption {
  index: number;
  label: string;
  votes: number;
  percent: number;
}
interface Poll {
  id: string;
  question: string;
  status: "open" | "closed" | string;
  anonymous: boolean;
  multiChoice: boolean;
  canManage: boolean;
  myVote: number[];
  voterCount: number;
  options: PollOption[];
}

export default function PollsPanel({
  token,
  meetingId,
  socket,
  canManage,
  onToast,
}: {
  token?: string | null;
  meetingId?: string | null;
  socket?: any;
  /** Host or co-host — may create and close polls. */
  canManage: boolean;
  onToast?: (msg: string) => void;
}) {
  const [polls, setPolls] = useState<Poll[]>([]);
  const [loading, setLoading] = useState(true);
  const [composing, setComposing] = useState(false);
  const [question, setQuestion] = useState("");
  const [options, setOptions] = useState<string[]>(["", ""]);
  const [anonymous, setAnonymous] = useState(true);
  const [multiChoice, setMultiChoice] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!token || !meetingId) return;
    let alive = true;
    api
      .getMeetingPolls(token, meetingId)
      .then((p: any) => alive && setPolls(p || []))
      .catch(() => {})
      .finally(() => alive && setLoading(false));
    return () => {
      alive = false;
    };
  }, [token, meetingId]);

  // Every mutation broadcasts the poll's FULL state, so this replaces by id
  // rather than merging — the last event always wins and two clients can never
  // drift apart. The broadcast deliberately carries an empty myVote, so it must
  // never clobber this viewer's own answer.
  useEffect(() => {
    if (!socket || !meetingId) return;
    const onPoll = (p: any) => {
      if (!p || p.meetingId !== meetingId) return;
      setPolls((cur) => {
        const i = cur.findIndex((x) => x.id === p.id);
        if (i === -1) return [...cur, p];
        const next = cur.slice();
        next[i] = { ...p, myVote: cur[i].myVote, canManage: cur[i].canManage };
        return next;
      });
    };
    const onRemoved = (d: any) => {
      if (!d || d.meetingId !== meetingId) return;
      setPolls((cur) => cur.filter((x) => x.id !== d.pollId));
    };
    socket.on(EVENTS.MEETING_POLL, onPoll);
    socket.on(EVENTS.MEETING_POLL_REMOVED, onRemoved);
    return () => {
      socket.off(EVENTS.MEETING_POLL, onPoll);
      socket.off(EVENTS.MEETING_POLL_REMOVED, onRemoved);
    };
  }, [socket, meetingId]);

  const replace = (p: Poll) =>
    setPolls((cur) => {
      const i = cur.findIndex((x) => x.id === p.id);
      if (i === -1) return [...cur, p];
      const next = cur.slice();
      next[i] = p;
      return next;
    });

  const submit = useCallback(async () => {
    if (!token || !meetingId) return;
    setBusy(true);
    try {
      const created = await api.createMeetingPoll(token, meetingId, {
        question,
        options: options.map((o) => o.trim()).filter(Boolean),
        anonymous,
        multiChoice,
      });
      replace(created);
      setComposing(false);
      setQuestion("");
      setOptions(["", ""]);
      setAnonymous(true);
      setMultiChoice(false);
    } catch (e: any) {
      onToast && onToast((e && e.message) || "Couldn't start that poll.");
    } finally {
      setBusy(false);
    }
  }, [token, meetingId, question, options, anonymous, multiChoice, onToast]);

  const castVote = async (poll: Poll, index: number) => {
    if (!token || !meetingId || poll.status !== "open") return;
    const next = poll.multiChoice
      ? poll.myVote.includes(index)
        ? poll.myVote.filter((i) => i !== index)
        : [...poll.myVote, index]
      : [index];
    if (!next.length) return; // un-picking your only answer would be a no-op
    try {
      replace(await api.voteMeetingPoll(token, meetingId, poll.id, next));
    } catch (e: any) {
      onToast && onToast((e && e.message) || "Couldn't record that vote.");
    }
  };

  const act = async (poll: Poll, what: "close" | "delete") => {
    if (!token || !meetingId) return;
    try {
      if (what === "close") replace(await api.closeMeetingPoll(token, meetingId, poll.id));
      else {
        await api.deleteMeetingPoll(token, meetingId, poll.id);
        setPolls((cur) => cur.filter((x) => x.id !== poll.id));
      }
    } catch (e: any) {
      onToast && onToast((e && e.message) || "That didn't work.");
    }
  };

  if (loading) return <div className="mp-empty">Loading polls…</div>;

  return (
    <div className="mp-wrap">
      {canManage && !composing && (
        <button className="mp-new" onClick={() => setComposing(true)}>
          <IconPlus size={14} />
          New poll
        </button>
      )}

      {composing && (
        <div className="mp-compose">
          <input
            className="mp-input"
            autoFocus
            value={question}
            onChange={(e) => setQuestion(e.target.value)}
            placeholder="Ask the room a question…"
            maxLength={500}
          />
          {options.map((o, i) => (
            <div className="mp-optrow" key={i}>
              <input
                className="mp-input"
                value={o}
                onChange={(e) =>
                  setOptions((cur) => cur.map((x, j) => (j === i ? e.target.value : x)))
                }
                placeholder={`Option ${i + 1}`}
                maxLength={200}
              />
              {options.length > 2 && (
                <button
                  className="mp-optdel"
                  onClick={() => setOptions((cur) => cur.filter((_, j) => j !== i))}
                  aria-label={`Remove option ${i + 1}`}
                >
                  <IconX size={13} />
                </button>
              )}
            </div>
          ))}
          {options.length < 10 && (
            <button className="mp-addopt" onClick={() => setOptions((cur) => [...cur, ""])}>
              <IconPlus size={12} />
              Add option
            </button>
          )}
          <label className="mp-check">
            <input
              type="checkbox"
              checked={anonymous}
              onChange={(e) => setAnonymous(e.target.checked)}
            />
            <span>
              Anonymous
              <em className="mp-hint">
                {anonymous
                  ? "Nobody, including you, can see who answered what"
                  : "You'll be able to see who voted for what"}
              </em>
            </span>
          </label>
          <label className="mp-check">
            <input
              type="checkbox"
              checked={multiChoice}
              onChange={(e) => setMultiChoice(e.target.checked)}
            />
            <span>Allow more than one answer</span>
          </label>
          <div className="mp-actions">
            <button className="mp-cancel" onClick={() => setComposing(false)} disabled={busy}>
              Cancel
            </button>
            <button
              className="mp-submit"
              onClick={submit}
              disabled={
                busy ||
                !question.trim() ||
                options.map((o) => o.trim()).filter(Boolean).length < 2
              }
            >
              {busy ? "Starting…" : "Start poll"}
            </button>
          </div>
        </div>
      )}

      {!polls.length && !composing && (
        <div className="mp-empty">
          {canManage
            ? "No polls yet. Start one to ask the room a question."
            : "No polls yet. The host can start one at any time."}
        </div>
      )}

      {polls.map((p) => {
        const closed = p.status !== "open";
        return (
          <div className={"mp-poll" + (closed ? " closed" : "")} key={p.id}>
            <div className="mp-q">{p.question}</div>
            <div className="mp-meta">
              {closed ? "Closed" : "Open"}
              {" · "}
              {p.voterCount} {p.voterCount === 1 ? "vote" : "votes"}
              {p.anonymous ? " · anonymous" : ""}
              {p.multiChoice ? " · pick any" : ""}
            </div>
            {p.options.map((o) => {
              const mine = p.myVote.includes(o.index);
              return (
                <button
                  key={o.index}
                  className={"mp-opt" + (mine ? " mine" : "") + (closed ? " static" : "")}
                  onClick={() => castVote(p, o.index)}
                  disabled={closed}
                  title={closed ? "This poll is closed" : `Vote for "${o.label}"`}
                >
                  {/* The bar IS the result — no separate chart to read. */}
                  <span className="mp-bar" style={{ width: `${o.percent}%` }} />
                  <span className="mp-optlabel">
                    {mine && <IconCheck size={12} />}
                    {o.label}
                  </span>
                  <span className="mp-optpct">
                    {o.votes} · {o.percent}%
                  </span>
                </button>
              );
            })}
            {p.canManage && (
              <div className="mp-manage">
                {!closed && (
                  <button className="mp-mbtn" onClick={() => act(p, "close")}>
                    Close poll
                  </button>
                )}
                <button className="mp-mbtn danger" onClick={() => act(p, "delete")}>
                  Delete
                </button>
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
