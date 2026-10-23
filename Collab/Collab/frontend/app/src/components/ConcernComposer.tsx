import React, { useEffect, useRef, useState } from "react";
import RichTextEditor, { RichTextEditorHandle } from "./RichTextEditor";
import Select from "./ui/Select";
import { EmojiPicker, type Rect } from "./EmojiPicker";
import { api } from "../lib/api";
import {
  IconBold, IconItalic, IconUnderline, IconStrikethrough, IconList, IconListOrdered,
  IconIndentIncrease, IconIndentDecrease, IconQuote, IconLink, IconCode, IconMoreHorizontal,
  IconUndo, IconMic, IconPaperclip, IconSend, IconX, IconTrash, IconSmile,
} from "../lib/icons";

// "Report a concern" (Skype/Teams-style), filed from Settings. The composer is
// at parity with the message panel — the same rich-text toolbar and ⋯ overflow,
// emoji, an attachment, and a recorded voice note — reusing the chat composer's
// CSS classes (.ci-box/.ci-tb/.cb/.ci-sep/.ci-more) so it looks and behaves
// identically instead of being a second, drifting design. (Structure mirrors
// BroadcastComposer; scheduling is replaced by the concern CATEGORY, and the
// title by an optional subject.)

const isBlankHtml = (html: string) =>
  !String(html || "")
    .replace(/<[^>]*>/g, "")
    .replace(/&nbsp;/g, " ")
    .trim();

// Which part of the product the concern is about — MANDATORY before submission
// (mirrors the backend's MODULES set; the route is the authoritative gate).
const MODULES: Array<[string, string]> = [
  ["chat", "Chat & messaging"],
  ["calls", "Calls"],
  ["meetings", "Meetings"],
  ["contacts", "Contacts & invitations"],
  ["tasks", "Tasks"],
  ["reminders", "Reminders"],
  ["files", "Files"],
  ["calendar", "Calendar"],
  ["organization", "Organization"],
  ["notifications", "Notifications"],
  ["search", "Search"],
  ["settings", "Settings"],
  ["desktop", "Desktop app"],
  ["account", "Sign-in & account"],
  ["other", "Something else"],
];

const CATEGORIES: Array<[string, string]> = [
  ["harassment", "Harassment or bullying"],
  ["safety", "Safety concern"],
  ["privacy", "Privacy issue"],
  ["content", "Inappropriate content"],
  ["technical", "Technical problem"],
  ["other", "Something else"],
];

export default function ConcernComposer({
  token,
  onSent,
  onError,
}: {
  token: string | null;
  onSent: () => void;
  onError: (msg: string) => void;
}) {
  const [category, setCategory] = useState("other");
  // No default: the reporter must actively choose the module (mandatory).
  const [module, setModule] = useState("");
  const [subject, setSubject] = useState("");
  const [body, setBody] = useState("");
  const [busy, setBusy] = useState(false);
  const [more, setMore] = useState(false);
  const editorRef = useRef<RichTextEditorHandle>(null);
  const moreRef = useRef<HTMLDivElement>(null);

  // Emoji (shared portal picker, same as the chat composer).
  const [emojiAnchor, setEmojiAnchor] = useState<Rect | null>(null);

  // Attachment / voice note: uploaded immediately, referenced by id on submit.
  const [file, setFile] = useState<{ id: string; name: string; voice: boolean } | null>(null);
  const [uploading, setUploading] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Voice recording (same 5-minute cap + empty-clip guard as the chat panel).
  const [recording, setRecording] = useState(false);
  const [recSecs, setRecSecs] = useState(0);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<BlobPart[]>([]);
  const recTimerRef = useRef<any>(null);
  const recSecsRef = useRef(0);

  useEffect(() => {
    recSecsRef.current = recSecs;
  }, [recSecs]);

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
      if (blob.size < 1024) {
        onError("Nothing was recorded — please try again.");
        return;
      }
      const ext = type.includes("mp4") ? "m4a" : "webm";
      const f = new File([blob], `Concern Voice Note.${ext}`, { type });
      (f as any).durationSec = recSecsRef.current || 0;
      void upload(f, true);
    };
    try {
      mr.stop();
    } catch (_) {}
  };

  const submit = async () => {
    if (busy || !token) return;
    if (!module) return onError("Please select which part of Collab this is about.");
    if (isBlankHtml(body)) return onError("Please describe your concern.");
    setBusy(true);
    try {
      await api.submitConcern(token, {
        category,
        module,
        subject: subject.trim() || null,
        body,
        fileId: file?.id || null,
      });
      setCategory("other");
      setModule("");
      setSubject("");
      setBody("");
      setFile(null);
      onSent();
    } catch (e: any) {
      onError((e && e.message) || "Couldn't submit your report.");
    } finally {
      setBusy(false);
    }
  };

  const cb = (on: boolean) => "cb" + (on ? " active" : "");
  const canSend = !!module && !isBlankHtml(body) && !busy && !uploading && !recording;
  const mmss = `${String(Math.floor(recSecs / 60)).padStart(2, "0")}:${String(recSecs % 60).padStart(2, "0")}`;

  return (
    <div className="bc-composer">
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
        <Select
          className="bc-title"
          style={{ flex: "0 0 auto", cursor: "pointer", width: "auto", borderColor: module ? undefined : "var(--ac)" }}
          value={module}
          onChange={(e) => setModule(e.target.value)}
          title="Which part of Collab is this about? (required)"
          placeholder="Module (required)…"
        >
          <option value="" disabled>
            Module (required)…
          </option>
          {MODULES.map(([k, label]) => (
            <option key={k} value={k}>
              {label}
            </option>
          ))}
        </Select>
        <Select
          className="bc-title"
          style={{ flex: "0 0 auto", cursor: "pointer", width: "auto" }}
          value={category}
          onChange={(e) => setCategory(e.target.value)}
          title="What kind of concern?"
        >
          {CATEGORIES.map(([k, label]) => (
            <option key={k} value={k}>
              {label}
            </option>
          ))}
        </Select>
        <input
          className="bc-title"
          style={{ flex: "1 1 180px" }}
          placeholder="Subject (optional)"
          value={subject}
          maxLength={200}
          onChange={(e) => setSubject(e.target.value)}
        />
      </div>
      <div className="ci-box" style={{ marginTop: 8 }}>
        {/* Formatting toolbar — same classes/order as the chat composer. */}
        <div className="ci-tb">
          <button className="cb" title="Attach a file or screenshot" onClick={() => fileInputRef.current?.click()}>
            <IconPaperclip />
          </button>
          <button
            className="cb"
            title="Emoji"
            onClick={(e) => setEmojiAnchor((e.currentTarget as HTMLElement).getBoundingClientRect())}
          >
            <IconSmile />
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
              placeholder="Describe what happened — ⌘/Ctrl+Enter to submit"
            />
          )}
          {!recording ? (
            <>
              <button className="sb-btn" title="Record a voice note" onClick={startRecording}>
                <IconMic />
              </button>
              <button className="bc-send" disabled={!canSend} title="Submit report" onClick={submit}>
                <IconSend />
              </button>
            </>
          ) : null}
        </div>
      </div>

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
        Your report goes to your organization's administrators for review. You
        can follow its status below, and you'll be notified when it's handled.
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

      {emojiAnchor ? (
        <EmojiPicker
          anchorRect={emojiAnchor}
          onSelect={(emoji) => {
            editorRef.current?.insertText(emoji);
            setEmojiAnchor(null);
          }}
          onClose={() => setEmojiAnchor(null)}
        />
      ) : null}
    </div>
  );
}
