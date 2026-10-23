// useChatView2.tsx — ChatView session hook segment 2.
// Mechanical extraction from ChatView.tsx (statements 189–201).
// Statements pulled forward so this hook is self-contained.

import { messagePlain } from "../../lib/messageText";
import { isBlankRich, SLASH_COMMANDS } from "./helpers";
import { api } from "../../lib/api";
import { computeWaveform } from "../../lib/voiceWaveform";

export type ChatViewSession2 = {
  aiLoading: any; audioChunksRef: any; commitStaged: any; composerImportant: any;
  composerRef: any; conversation: any; editingSched: any; flash: any;
  meId: any; mediaRecorderRef: any; mentionPeople: any; onReply: any;
  onReschedule: any; onSchedule: any; onSend: any; onTaskCreated: any;
  onTyping: any; recordingIntervalRef: any; recordingTimeRef: any; replyTo: any;
  schedAt: any; schedOpen: any; sendFileDirect: any; setAiErr: any;
  setAiLoading: any; setAiSummary: any; setComposerImportant: any; setEditingSched: any;
  setRecording: any; setRecordingPaused: any; setRecordingTime: any; setReplyTo: any;
  setSchedAt: any; setSchedOpen: any; setText: any; showToast: any;
  slashPlain: any; slashTyping: any; staged: any; tab: any;
  text: any; token: any; typingActiveRef: any; typingTimer: any;
  typingUserId: any;
};

export function useChatView2(ctx: ChatViewSession2) {

  const {
    aiLoading, audioChunksRef, commitStaged, composerImportant,
    composerRef, conversation, editingSched, flash,
    meId, mediaRecorderRef, mentionPeople, onReply,
    onReschedule, onSchedule, onSend, onTaskCreated,
    onTyping, recordingIntervalRef, recordingTimeRef, replyTo,
    schedAt, schedOpen, sendFileDirect, setAiErr,
    setAiLoading, setAiSummary, setComposerImportant, setEditingSched,
    setRecording, setRecordingPaused, setRecordingTime, setReplyTo,
    setSchedAt, setSchedOpen, setText, showToast,
    slashPlain, slashTyping, staged, tab,
    text, token, typingActiveRef, typingTimer,
    typingUserId
  } = ctx;

  // ---- ChatView.tsx statements ----
  const slashMatches = slashTyping
    ? SLASH_COMMANDS.filter((c) =>
      c.cmd.startsWith(slashTyping[1].toLowerCase()),
    )
    : [];
  const slashActive = (() => {
    const m = /^\/(\w+)\s/.exec(slashPlain);
    return m
      ? SLASH_COMMANDS.find((c) => c.cmd === m[1].toLowerCase()) || null
      : null;
  })();
  const firstNameOf = (p: any) =>
    (((p && p.name) || "").split(/\s+/)[0] || "").replace(/\W/g, "");
  const runSlash = async (cmd: string, arg: string) => {
    if (cmd === "help") {
      // Personalised, not a bare command dump: use a REAL member of this
      // conversation and its type (DM vs group) so the tip is actionable here.
      const mate = mentionPeople.find((p: any) => p.id !== meId);
      const mateFirst = mate ? firstNameOf(mate) : "";
      const isGroup =
        conversation &&
        (conversation?.kind === "group" || conversation?.kind === "channel");
      flash(
        (isGroup && mateFirst
          ? `Delegate right here — “/task @${mateFirst} <what to do>” assigns ${(mate.name || "").split(" ")[0]
          } and posts a card everyone sees. `
          : `Turn this chat into action — “/task <what to do>”. `) +
        `Also: /remind <what & when> (private, just you) · /meet <title> (starts a call here).`,
      );
      return;
    }
    const prev = text;
    setText("");
    try {
      if (cmd === "task") {
        if (!arg) {
          setText(prev);
          flash("Usage: /task [@person …] <title> — @mention members here to assign them");
          return;
        }
        // Conversation-aware assignment, parsed token-by-token so a MULTI-WORD
        // name ("@Aravinth KP") matches fully: the composer inserts "@First",
        // but a user may type the whole name, so once the first name matches a
        // member we greedily consume the following words that continue THAT
        // member's name. Everything not consumed is the title.
        const nameParts = (p: any): string[] =>
          (((p && p.name) || "") as string)
            .split(/\s+/)
            .map((x) => x.replace(/\W/g, "").toLowerCase())
            .filter(Boolean);
        const words = arg.split(/\s+/).filter(Boolean);
        const assignees: any[] = [];
        const titleWords: string[] = [];
        let i = 0;
        while (i < words.length) {
          const w = words[i];
          if (w[0] === "@" && w.length > 1) {
            const tok = w.slice(1).replace(/\W/g, "").toLowerCase();
            const cand = mentionPeople.find((p: any) => nameParts(p)[0] === tok);
            if (cand) {
              const parts = nameParts(cand);
              let pi = 1;
              let j = i + 1;
              while (
                pi < parts.length &&
                j < words.length &&
                words[j][0] !== "@" &&
                words[j].replace(/\W/g, "").toLowerCase() === parts[pi]
              ) {
                pi++;
                j++;
              }
              if (!assignees.some((a) => a.id === cand.id)) assignees.push(cand);
              i = j;
              continue;
            }
          }
          titleWords.push(w); // unknown @token or plain word → title text
          i++;
        }
        const title = titleWords.join(" ").trim();
        if (!title) {
          setText(prev);
          flash("Add a task title after the @mentions.");
          return;
        }
        // No @mention → assign to yourself. The card names whoever it's for.
        const finalIds = assignees.length
          ? assignees.map((a) => a.id)
          : meId
            ? [meId]
            : [];
        // conversationId → the server posts an actionable TASK CARD into this
        // chat (routes/tasks.ts), same engagement loop as the meeting invite:
        // visible to everyone, anchored in the thread, "View task" deep-opens.
        const t = await api.createTask(token, {
          title: title.slice(0, 200),
          assigneeId: finalIds[0] || null,
          assigneeIds: finalIds,
          conversationId: conversation && conversation.id,
        });
        if (finalIds.length > 1 && t && t.id) {
          try {
            await api.setTaskAssignees(token, t.id, finalIds);
          } catch (_) {
            /* primary assignee already set — extras are best-effort */
          }
        }
        // Refresh the creator's Tasks module NOW (the modal path already does
        // this; the chat path previously relied only on the socket, so a freshly
        // created task could seem to "not appear" until the next event).
        onTaskCreated && onTaskCreated();
        showToast(`Task created: “${title.slice(0, 60)}”`);
      } else if (cmd === "remind") {
        if (!arg) {
          setText(prev);
          flash("Usage: /remind <what & when> — e.g. /remind call Priya tomorrow 5pm");
          return;
        }
        const r = await api.quickAddReminder(token, arg);
        if (r && r.created) {
          showToast(
            "Reminder set" +
            (r.reminder && r.reminder.dueLabel
              ? " — " + r.reminder.dueLabel
              : "") +
            ".",
          );
        } else {
          // Not confident about the time — keep the user's text so they can
          // refine it rather than silently storing a timeless reminder.
          setText(prev);
          flash("Couldn't parse a time — try “/remind call Priya tomorrow 5pm”.");
        }
      } else if (cmd === "meet") {
        const title = arg ? arg.slice(0, 120) : "Instant meeting";
        // The server requires a FUTURE start; the Join card unlocks 10 min
        // before start. So a few minutes ahead satisfies validation AND makes
        // the card joinable immediately — an effectively-instant meeting.
        // People are mandatory on a meeting: invite everyone else in this
        // conversation, which is who an instant meeting "here" is for anyway.
        const attendees = (mentionPeople || [])
          .map((p: any) => p && p.id)
          .filter((id: string) => id && id !== meId);
        if (!attendees.length) {
          setText(prev);
          flash("Add someone to this conversation before starting a meeting.");
          return;
        }
        await api.createMeeting(token, {
          title,
          startsAt: new Date(Date.now() + 5 * 60 * 1000).toISOString(),
          durationMin: 30,
          conversationId: conversation && conversation.id,
          attendees,
        });
        showToast(`Meeting “${title}” created — invite card posted here.`);
      }
    } catch (e: any) {
      setText(prev);
      showToast((e && e.message) || "Command failed.");
    }
  };
  const submit = () => {
    // Editing a scheduled message (Edit → picker open): Enter / Send must APPLY
    // the edit — not fire the text as an immediate NEW message, which cleared
    // the composer and left the scheduled row untouched (the edit "didn't
    // work"). confirmSchedule PATCHes body + time and closes the picker.
    if (editingSched && schedOpen) {
      confirmSchedule();
      return;
    }
    // Staged attachments take priority: Send dispatches the files with the
    // typed text as a caption (WhatsApp-style preview-then-send).
    if (staged.length) {
      commitStaged();
      return;
    }
    const v = text.trim();
    if (isBlankRich(v)) return; // empty composer → Send is disabled; nothing to send (also guards Enter-to-send)
    // Unified Action Bar: a KNOWN slash command dispatches to the in-app module
    // instead of sending. Unknown "/" text falls through as a normal message.
    {
      const sm = /^\/(\w+)(?:\s+([\s\S]*))?$/.exec(messagePlain(v).trim());
      if (sm && SLASH_COMMANDS.some((c) => c.cmd === sm[1].toLowerCase())) {
        void runSlash(sm[1].toLowerCase(), (sm[2] || "").trim());
        return;
      }
    }
    const MAX_LEN = 65536;
    const WARN_LEN = 4000;
    if (v.length > MAX_LEN) {
      showToast(`Message exceeds maximum length (${MAX_LEN} characters).`);
      return;
    }
    if (v.length > WARN_LEN) {
      showToast(
        `Message is very long (${v.length} characters). It will be sent but consider splitting it.`,
      );
    }
    if (replyTo && onReply) {
      onReply(conversation.id, replyTo.id, v);
      setReplyTo(null);
    } else {
      onSend(v, undefined, composerImportant);
    }
    setComposerImportant(false);
    setText("");
    if (onTyping) {
      clearTimeout(typingTimer.current);
      typingActiveRef.current = false;
      onTyping(false);
    }
  };
  const confirmSchedule = () => {
    const v = text.trim();
    if (isBlankRich(v)) return; // empty composer → Schedule is disabled
    if (!schedAt) {
      showToast && showToast("Pick a date and time.");
      return;
    }
    const when = new Date(schedAt);
    if (Number.isNaN(when.getTime())) {
      showToast("Pick a valid date and time.");
      return;
    }
    if (when.getTime() <= Date.now()) {
      showToast("Pick a time in the future.");
      return;
    }
    const iso = when.toISOString();
    if (editingSched) {
      if (onReschedule) onReschedule(editingSched, { body: v, sendAt: iso });
    } else if (onSchedule) {
      onSchedule(v, iso);
    }
    setText("");
    setSchedOpen(false);
    setEditingSched(null);
    setSchedAt("");
  };
  const runSummary = async () => {
    if (aiLoading) return;
    setAiErr(null);
    setAiSummary(null);
    setAiLoading(true);
    try {
      const r = await api.summarizeConversation(token, conversation.id);
      setAiSummary((r && r.summary) || "No summary available.");
    } catch (e) {
      setAiErr(
        "Couldn't generate a summary — Collab AI may be unavailable.",
      );
    } finally {
      setAiLoading(false);
    }
  };
  const startRecording = async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      let options: MediaRecorderOptions = {};
      if (typeof MediaRecorder.isTypeSupported === "function") {
        if (MediaRecorder.isTypeSupported("audio/webm"))
          options = { mimeType: "audio/webm" };
        else if (MediaRecorder.isTypeSupported("audio/mp4"))
          options = { mimeType: "audio/mp4" };
      }
      const mr = new MediaRecorder(stream, options);
      mediaRecorderRef.current = mr;
      audioChunksRef.current = [];
      mr.ondataavailable = (e) => {
        if (e.data.size > 0) audioChunksRef.current.push(e.data);
      };
      mr.start(100);
      setRecording(true);
      setRecordingPaused(false);
      setRecordingTime(0);
      recordingIntervalRef.current = setInterval(() => {
        setRecordingTime((t) => {
          if (t >= 5 * 60) {
            stopRecording(false);
            return t;
          }
          return t + 1;
        });
      }, 1000);
    } catch (err) {
      flash("Microphone access denied or not available.");
    }
  };
  const pauseRecording = () => {
    if (mediaRecorderRef.current?.state === "recording") {
      mediaRecorderRef.current.pause();
      setRecordingPaused(true);
      clearInterval(recordingIntervalRef.current);
    } else if (mediaRecorderRef.current?.state === "paused") {
      mediaRecorderRef.current.resume();
      setRecordingPaused(false);
      recordingIntervalRef.current = setInterval(() => {
        setRecordingTime((t) => {
          if (t >= 5 * 60) {
            stopRecording(false);
            return t;
          }
          return t + 1;
        });
      }, 1000);
    }
  };
  const stopRecording = (cancel = false) => {
    if (mediaRecorderRef.current?.state !== "inactive") {
      mediaRecorderRef.current!.stop();
      mediaRecorderRef.current!.stream.getTracks().forEach((t) => t.stop());
    }
    clearInterval(recordingIntervalRef.current);
    setRecording(false);
    setRecordingPaused(false);
    if (!cancel && mediaRecorderRef.current) {
      mediaRecorderRef.current.onstop = async () => {
        const type = mediaRecorderRef.current?.mimeType || "audio/webm";
        const blob = new Blob(audioChunksRef.current, { type });
        // Don't send an empty/near-empty clip (mic produced no data) — it would
        // arrive as an unplayable voice message.
        if (blob.size < 1024) {
          flash("Nothing was recorded — please try again.");
          return;
        }
        const ext = type.includes("mp4") ? "m4a" : "webm";
        const file = new File([blob], `Voice Message.${ext}`, { type });
        (file as any).durationSec = recordingTimeRef.current || 0;
        // Real waveform (WhatsApp model): decode the clip we just recorded and
        // ship its true peaks in voice.waveform. Raced against a short timeout
        // so a pathological decode can never delay the send — on any failure
        // the receiver's player just falls back to its synthetic bars.
        try {
          (file as any).waveform = await Promise.race([
            computeWaveform(blob),
            new Promise<null>((r) => setTimeout(() => r(null), 3000)),
          ]);
        } catch (_) {
          (file as any).waveform = null;
        }
        sendFileDirect(file);
      };
    }
  };
  const startReply = (m: any) => {
    setReplyTo(m);
    // Focus after the menu/toolbar has closed and released focus, and again
    // once the reply banner has mounted, so the composer reliably ends up active.
    const focusComposer = () => {
      const ed = (ctx as any).editorRef?.current ?? composerRef.current;
      ed && ed.focus && ed.focus();
    };
    requestAnimationFrame(focusComposer);
    setTimeout(focusComposer, 60);
    setTimeout(focusComposer, 200);
  };
  const TABS = ([["chat", "Chat"]] as [string, string][])
    .concat(tab === "files" ? ([["files", "Files"]] as [string, string][]) : [])
    .concat(tab === "links" ? ([["links", "Links"]] as [string, string][]) : []);
  const typingName =
    typingUserId && typingUserId !== meId
      ? conversation?.kind === "dm"
        ? conversation?.name
        : "Someone"
      : null;

  return {
    slashMatches,
    slashActive,
    firstNameOf,
    runSlash,
    submit,
    confirmSchedule,
    runSummary,
    startRecording,
    pauseRecording,
    stopRecording,
    startReply,
    TABS,
    typingName,
  };
}
