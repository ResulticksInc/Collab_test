import React, { useEffect, useRef, useState } from "react";
import RichTextEditor, { RichTextEditorHandle } from "./RichTextEditor";
import { api } from "../lib/api";
import {
  IconBold, IconItalic, IconUnderline, IconStrikethrough, IconList, IconListOrdered,
  IconIndentIncrease, IconIndentDecrease, IconQuote, IconLink, IconCode, IconMoreHorizontal, IconUndo,
  IconMic, IconClock, IconPaperclip, IconSend, IconX, IconTrash,
} from "../lib/icons";

// BA #6: the org broadcast composer, at parity with the message composer —
// rich-text formatting (with the same ⋯ overflow menu), an attachment, a
// recorded VOICE NOTE, and SCHEDULED send. It deliberately reuses the chat
// composer's CSS classes (.ci-box/.ci-tb/.cb/.ci-sep/.ci-more) so it looks and
// behaves identically instead of being a second, drifting design.
//
// Kept OUT of ChatView's composer: that one is bound to a conversation
// (mentions, slash commands, staged multi-file uploads, reply targets, E2EE
// per-conversation keys). A broadcast has no conversation, so sharing that
// component would mean threading a null conversation through all of it.

const isBlankHtml = (html: string) =>
  !String(html || "")
    .replace(/<[^>]*>/g, "")
    .replace(/&nbsp;/g, " ")
    .trim();

function toLocalInput(d: Date) {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export default function BroadcastComposer({
  token,
  onSent,
  onError,
  edit = null,
  onCancelEdit,
}: {
  token: string | null;
  onSent: (scheduled: boolean) => void;
  onError: (msg: string) => void;
  // EDIT MODE: an existing broadcast to amend. Reusing this component (rather
  // than a second, plainer edit form) keeps the full formatting toolbar — an
  // edit must be able to produce the same rich body the original did.
  edit?: { id: string; title: string; body: string; sendAt: string | null; status: string } | null;
  onCancelEdit?: () => void;
}) {
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [busy, setBusy] = useState(false);
  const [more, setMore] = useState(false);
  const editorRef = useRef<RichTextEditorHandle>(null);
  const moreRef = useRef<HTMLDivElement>(null);

  // Attachment / voice note: uploaded immediately, referenced by id on send.
  const [file, setFile] = useState<{ id: string; name: string; voice: boolean } | null>(null);
  const [uploading, setUploading] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Scheduling
  const [schedOpen, setSchedOpen] = useState(false);
  const [schedAt, setSchedAt] = useState("");
  // The time the user last had, kept across a collapse of the schedule row so
  // reopening restores it instead of inventing a new one (see the clock button).
  const lastSchedAtRef = useRef("");

  // Voice recording
  const [recording, setRecording] = useState(false);
  const [recSecs, setRecSecs] = useState(0);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<BlobPart[]>([]);
  const recTimerRef = useRef<any>(null);
  const recSecsRef = useRef(0);

  useEffect(() => {
    recSecsRef.current = recSecs;
  }, [recSecs]);

  // Load the broadcast being edited into the composer (and restore a blank
  // draft when edit mode is cleared). Keyed on the id so re-renders don't
  // clobber what the user is typing.
  useEffect(() => {
    setTitle(edit ? edit.title || "" : "");
    setBody(edit ? edit.body || "" : "");
    setFile(null);
    if (edit && edit.status === "scheduled" && edit.sendAt) {
      const at = toLocalInput(new Date(edit.sendAt));
      setSchedOpen(true);
      setSchedAt(at);
      // Seed the restore value too, so collapsing and reopening the row brings
      // back THIS broadcast's real time rather than a fabricated one.
      lastSchedAtRef.current = at;
    } else {
      setSchedOpen(false);
      setSchedAt("");
      lastSchedAtRef.current = "";
    }
    // Keyed on status + sendAt as well as id: with `[edit?.id]` alone, clicking
    // Edit again on the SAME broadcast after it had been sent or rescheduled
    // re-opened the stale snapshot from the first click (the composer showed a
    // schedule that no longer existed).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [edit?.id, edit?.status, edit?.sendAt]);

  // Close the ⋯ menu on any outside click (matches the chat composer).
  useEffect(() => {
    if (!more) return;
    const onDoc = (e: MouseEvent) => {
      if (moreRef.current && !moreRef.current.contains(e.target as Node)) setMore(false);
    };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [more]);

  // Never leave the mic hot if the panel unmounts mid-recording.
  useEffect(
    () => () => {
      try {
        recorderRef.current?.stream?.getTracks().forEach((t) => t.stop());
      } catch (_) {}
      clearInterval(recTimerRef.current);
    },
    [],
  );

  const upload = async (f: File, voice: boolean) => {
    if (!token) return;
    setUploading(true);
    try {
      // No conversationId: a broadcast attachment is org-scoped, not chat-scoped.
      const up = await api.uploadFile(token, f);
      const id = up?.id || up?.file?.id;
      if (!id) throw new Error("Upload failed");
      setFile({ id, name: f.name, voice });
    } catch (e: any) {
      onError((e && e.message) || "Couldn't upload that file.");
    } finally {
      setUploading(false);
    }
  };

  const startRecording = async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      let options: MediaRecorderOptions = {};
      if (typeof MediaRecorder.isTypeSupported === "function") {
        if (MediaRecorder.isTypeSupported("audio/webm")) options = { mimeType: "audio/webm" };
        else if (MediaRecorder.isTypeSupported("audio/mp4")) options = { mimeType: "audio/mp4" };
      }
      const mr = new MediaRecorder(stream, options);
      recorderRef.current = mr;
      chunksRef.current = [];
      mr.ondataavailable = (e) => {
        if (e.data.size > 0) chunksRef.current.push(e.data);
      };
      mr.start(100);
      setRecording(true);
      setRecSecs(0);
      recTimerRef.current = setInterval(() => {
        setRecSecs((t) => {
          if (t >= 5 * 60) {
            stopRecording(false);
            return t;
          }
          return t + 1;
        });
      }, 1000);
    } catch (_) {
      onError("Couldn't access the microphone.");
    }
  };

  const stopRecording = (cancel: boolean) => {
    const mr = recorderRef.current;
    clearInterval(recTimerRef.current);
    setRecording(false);
    if (!mr) return;
    mr.onstop = () => {
      try {
        mr.stream.getTracks().forEach((t) => t.stop());
      } catch (_) {}
      if (cancel) return;
      const type = mr.mimeType || "audio/webm";
      const blob = new Blob(chunksRef.current, { type });
      // Guard an empty clip — it would upload as an unplayable voice note.
      if (blob.size < 1024) {
        onError("Nothing was recorded — please try again.");
        return;
      }
      const ext = type.includes("mp4") ? "m4a" : "webm";
      const f = new File([blob], `Broadcast Voice Note.${ext}`, { type });
      (f as any).durationSec = recSecsRef.current || 0;
      void upload(f, true);
    };
    try {
      mr.stop();
    } catch (_) {}
  };

  const reset = () => {
    setTitle("");
    setBody("");
    setFile(null);
    setSchedAt("");
    setSchedOpen(false);
  };

  const submit = async () => {
    const t = title.trim();
    if (!t || busy || !token) return;
    let sendAt: string | null = null;
    if (schedOpen && schedAt) {
      const when = new Date(schedAt);
      if (Number.isNaN(when.getTime())) return onError("Pick a valid date and time.");
      if (when.getTime() <= Date.now()) return onError("Pick a time in the future.");
      sendAt = when.toISOString();
    }
    setBusy(true);
    try {
      if (edit) {
        // Only send sendAt for a still-queued broadcast — rescheduling one that
        // already went out is meaningless.
        const patch: any = { title: t, body: isBlankHtml(body) ? "" : body };
        if (edit.status === "scheduled") patch.sendAt = sendAt;
        await api.orgUpdateBroadcast(token, edit.id, patch);
      } else {
        await api.orgSendBroadcast(
          token,
          t,
          isBlankHtml(body) ? "" : body,
          sendAt,
          file?.id || null,
        );
      }
      reset();
      onSent(!!sendAt);
    } catch (e: any) {
      onError((e && e.message) || "Couldn't send the broadcast.");
    } finally {
      setBusy(false);
    }
  };

  const cb = (on: boolean) => "cb" + (on ? " active" : "");
  const canSend = !!title.trim() && !busy && !uploading && !recording;
  const mmss = `${String(Math.floor(recSecs / 60)).padStart(2, "0")}:${String(recSecs % 60).padStart(2, "0")}`;

  return (
    <div className="bc-composer">
      <div style={{ fontSize: 12.5, fontWeight: 700, color: "var(--g900)", marginBottom: 8 }}>
        {edit ? "✏️ Edit broadcast" : "📢 Broadcast to everyone in the organization"}
      </div>
      <input
        className="bc-title"
        placeholder="Title"
        value={title}
        maxLength={255}
        onChange={(e) => setTitle(e.target.value)}
      />
      <div className="ci-box" style={{ marginTop: 8 }}>
        {/* Formatting toolbar — same classes/order as the chat composer. */}
        <div className="ci-tb">
          <button className="cb" title="Attach a file" onClick={() => fileInputRef.current?.click()}>
            <IconPaperclip />
          </button>
          <div className="ci-sep" />
          <button className={cb(!!editorRef.current?.isBold?.())} title="Bold" onClick={() => editorRef.current?.toggleBold()}>
            <IconBold />
          </button>
          <button className={cb(!!editorRef.current?.isItalic?.())} title="Italic" onClick={() => editorRef.current?.toggleItalic()}>
            <IconItalic />
          </button>
          <button className={cb(!!editorRef.current?.isUnderline?.())} title="Underline" onClick={() => editorRef.current?.toggleUnderline()}>
            <IconUnderline />
          </button>
          <button className={cb(!!editorRef.current?.isStrike?.())} title="Strikethrough" onClick={() => editorRef.current?.toggleStrike()}>
            <IconStrikethrough />
          </button>
          <div className="ci-sep" />
          <button className="cb" title="Bulleted list" onClick={() => editorRef.current?.toggleBulletList()}>
            <IconList />
          </button>
          <button className="cb" title="Numbered list" onClick={() => editorRef.current?.toggleOrderedList()}>
            <IconListOrdered />
          </button>
          <button className="cb" title="Outdent" onClick={() => editorRef.current?.outdent()}>
            <IconIndentDecrease />
          </button>
          <button className="cb" title="Indent" onClick={() => editorRef.current?.indent()}>
            <IconIndentIncrease />
          </button>
          <div className="ci-sep" />
          <button className="cb" title="Quote" onClick={() => editorRef.current?.toggleBlockquote()}>
            <IconQuote />
          </button>
          <button
            className="cb"
            title="Link"
            onClick={() => {
              const url = window.prompt("Link URL");
              if (url) editorRef.current?.setLink(url);
            }}
          >
            <IconLink />
          </button>
          <button className="cb" title="Inline code" onClick={() => editorRef.current?.toggleCode()}>
            <IconCode />
          </button>
          {/* ⋯ overflow — same items as the chat composer's menu. */}
          <div ref={moreRef} style={{ position: "relative" }}>
            <button className={cb(more)} title="More" onClick={() => setMore((v) => !v)}>
              <IconMoreHorizontal />
            </button>
            {more ? (
              <div className="ci-more-menu">
                <button onClick={() => { editorRef.current?.toggleCodeBlock(); setMore(false); }}>
                  <IconCode />
                  Code block
                </button>
                <button onClick={() => { editorRef.current?.clearFormatting(); setMore(false); }}>
                  <IconX />
                  Clear all formatting
                </button>
                <div className="ci-more-sep" />
                <button onClick={() => { editorRef.current?.setHorizontalRule(); setMore(false); }}>
                  Insert horizontal rule
                </button>
                <button onClick={() => { editorRef.current?.insertTable(); setMore(false); }}>
                  Insert table
                </button>
                <button onClick={() => editorRef.current?.addColumnAfter()}>Insert column</button>
                <button onClick={() => editorRef.current?.addRowAfter()}>Insert row</button>
                <button onClick={() => editorRef.current?.deleteColumn()}>Delete column</button>
                <button onClick={() => editorRef.current?.deleteRow()}>Delete row</button>
                <button onClick={() => editorRef.current?.deleteTable()}>Delete table</button>
                <div className="ci-more-sep" />
                <button onClick={() => { editorRef.current?.undo(); setMore(false); }}>
                  <IconUndo />
                  Undo typing
                </button>
              </div>
            ) : null}
          </div>
        </div>

        <div className="bc-row">
          {recording ? (
            <div className="bc-rec">
              <span className="bc-rec-dot" />
              Recording… {mmss}
              <button className="btn-c" onClick={() => stopRecording(true)}>Cancel</button>
              <button className="btn-p" onClick={() => stopRecording(false)}>Use recording</button>
            </div>
          ) : (
            <RichTextEditor
              ref={editorRef}
              value={body}
              onChange={setBody}
              onSend={submit}
              enterToSend={false}
              placeholder="Message (optional) — ⌘/Ctrl+Enter to send"
            />
          )}
          {!recording ? (
            <>
              <button className="sb-btn" title="Record a voice note" onClick={startRecording}>
                <IconMic />
              </button>
              <button
                className={"sb-btn" + (schedOpen ? " active" : "")}
                title="Schedule this broadcast"
                onClick={() => {
                  // Computed and applied OUTSIDE the state updater: React treats
                  // updaters as pure and may invoke them more than once, so
                  // writing a ref and calling setSchedAt from inside one is not
                  // safe to rely on.
                  const next = !schedOpen;
                  {
                    if (next) {
                      // Reopening must RESTORE what the user had, not invent a
                      // new time. Blindly re-seeding here meant a host editing an
                      // already-scheduled broadcast who collapsed and reopened
                      // the row saw a plausible but WRONG time and could silently
                      // reschedule. Only fall back to a fresh default when there
                      // is nothing to restore, or what we kept has since passed
                      // (which would just fail "Pick a time in the future").
                      const prev = lastSchedAtRef.current;
                      const stillFuture =
                        !!prev && new Date(prev).getTime() > Date.now();
                      if (stillFuture) {
                        setSchedAt(prev);
                      } else {
                        const d = new Date();
                        const m = d.getMinutes();
                        d.setMinutes(m + ((15 - (m % 15)) % 15) + 15, 0, 0);
                        setSchedAt(toLocalInput(d));
                      }
                    } else {
                      // Closing: remember the time but clear the field, so a
                      // collapsed row never leaves a stale schedule attached to
                      // an otherwise-immediate broadcast.
                      lastSchedAtRef.current = schedAt;
                      setSchedAt("");
                    }
                  }
                  setSchedOpen(next);
                }}
              >
                <IconClock />
              </button>
              <button
                className="bc-send"
                disabled={!canSend}
                title={
                  edit
                    ? "Save changes"
                    : schedOpen && schedAt
                      ? "Schedule broadcast"
                      : "Send broadcast"
                }
                onClick={submit}
              >
                <IconSend />
              </button>
            </>
          ) : null}
        </div>
      </div>

      {schedOpen ? (
        <div className="bc-sched">
          <span>Send at</span>
          <input
            type="datetime-local"
            value={schedAt}
            min={toLocalInput(new Date(Date.now() + 60000))}
            onChange={(e) => setSchedAt(e.target.value)}
          />
          <button className="btn-c" onClick={() => { setSchedOpen(false); setSchedAt(""); }}>
            Send immediately instead
          </button>
        </div>
      ) : null}

      {file ? (
        <div className="bc-file">
          {file.voice ? "🎤" : "📎"} {file.name}
          <button title="Remove" onClick={() => setFile(null)}>
            <IconTrash />
          </button>
        </div>
      ) : uploading ? (
        <div className="bc-hint">Uploading…</div>
      ) : null}

      <div className="bc-hint">
        {edit ? (
          <>
            {edit.status === "scheduled"
              ? "Changes apply to the queued announcement — it goes out, edited, at its send time."
              : "Updates this announcement for everyone. It does not re-notify — the original notification already went out."}
            {onCancelEdit ? (
              <button className="btn-c" style={{ marginLeft: 8, fontSize: 11.5, padding: "3px 9px" }} onClick={onCancelEdit}>
                Cancel edit
              </button>
            ) : null}
          </>
        ) : schedOpen && schedAt ? (
          "Queued — every member is notified (in-app, web push and desktop) at the scheduled time."
        ) : (
          "Delivered to every member's notifications (in-app, web push and desktop)."
        )}
      </div>

      <input
        ref={fileInputRef}
        type="file"
        style={{ display: "none" }}
        onChange={(e) => {
          const f = e.target.files && e.target.files[0];
          if (f) void upload(f, false);
          e.target.value = "";
        }}
      />
    </div>
  );
}
