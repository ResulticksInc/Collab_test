import React, { useEffect, useImperativeHandle, forwardRef, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  useEditor,
  EditorContent,
  ReactNodeViewRenderer,
  NodeViewWrapper,
  NodeViewContent,
} from "@tiptap/react";
import { Extension } from "@tiptap/core";
import StarterKit from "@tiptap/starter-kit";
import Link from "@tiptap/extension-link";
import Placeholder from "@tiptap/extension-placeholder";
import CodeBlockLowlight from "@tiptap/extension-code-block-lowlight";
import TaskList from "@tiptap/extension-task-list";
import TaskItem from "@tiptap/extension-task-item";
import Typography from "@tiptap/extension-typography";
import Mention from "@tiptap/extension-mention";
import Underline from "@tiptap/extension-underline";
import { Table } from "@tiptap/extension-table";
import { TableRow } from "@tiptap/extension-table-row";
import { TableCell } from "@tiptap/extension-table-cell";
import { TableHeader } from "@tiptap/extension-table-header";
import { TextAlign } from "@tiptap/extension-text-align";
import { TextStyle } from "@tiptap/extension-text-style";
import { Color } from "@tiptap/extension-color";
import { Highlight } from "@tiptap/extension-highlight";
import { Image } from "@tiptap/extension-image";
import { common, createLowlight } from "lowlight";
// These grammars ship with highlight.js but are NOT in lowlight's `common` set,
// yet the language picker offers them — register them so the selected language
// actually highlights instead of silently falling back to auto-detection.
import hljsDockerfile from "highlight.js/lib/languages/dockerfile";
import hljsDart from "highlight.js/lib/languages/dart";
import hljsPowershell from "highlight.js/lib/languages/powershell";

const lowlight = createLowlight(common);
lowlight.register({
  dockerfile: hljsDockerfile,
  dart: hljsDart,
  powershell: hljsPowershell,
});

// Block indent for paragraphs & headings (Word/Teams-style). TipTap has no
// built-in paragraph indent, so this stores an `indent` level (0..8) as a
// margin-left inline style and exposes indentBlock()/outdentBlock() commands.
// List/task items keep using sink/liftListItem (see the indent handle below).
const INDENT_STEP = 24;
const INDENT_MAX = 8;
const IndentExtension = Extension.create({
  name: "blockIndent",
  addGlobalAttributes() {
    return [
      {
        types: ["paragraph", "heading"],
        attributes: {
          indent: {
            default: 0,
            renderHTML: (attrs: any) =>
              attrs.indent
                ? { style: `margin-left:${attrs.indent * INDENT_STEP}px` }
                : {},
            parseHTML: (el: HTMLElement) => {
              const ml = parseInt(el.style.marginLeft || "0", 10);
              return ml ? Math.round(ml / INDENT_STEP) : 0;
            },
          },
        },
      },
    ];
  },
  addCommands() {
    const shift =
      (delta: number) =>
      ({ state, dispatch }: any) => {
        const { from, to } = state.selection;
        const tr = state.tr;
        let changed = false;
        state.doc.nodesBetween(from, to, (node: any, pos: number) => {
          if (node.type.name === "paragraph" || node.type.name === "heading") {
            const cur = node.attrs.indent || 0;
            const next = Math.min(INDENT_MAX, Math.max(0, cur + delta));
            if (next !== cur) {
              tr.setNodeMarkup(pos, undefined, { ...node.attrs, indent: next });
              changed = true;
            }
          }
        });
        if (changed && dispatch) dispatch(tr);
        return changed;
      };
    return {
      indentBlock: () => shift(1),
      outdentBlock: () => shift(-1),
    } as any;
  },
});

// Teams-style code-block language picker. CodeBlockLowlight stores the chosen
// language on node.attrs.language (which also drives lowlight syntax
// highlighting); a custom React NodeView renders a dropdown on the block so the
// user can pick it — exactly like Teams' code block.
const CODE_LANGUAGES: { value: string; label: string }[] = [
  // "Automatic" auto-IDENTIFIES the language from the code (lowlight.highlightAuto)
  // and applies the detected grammar — a one-shot detect, not a persisted value.
  { value: "auto", label: "Automatic" },
  { value: "plaintext", label: "Plain Text" },
  { value: "bash", label: "Bash" },
  { value: "c", label: "C" },
  { value: "cpp", label: "C++" },
  { value: "csharp", label: "C#" },
  { value: "css", label: "CSS" },
  { value: "dart", label: "Dart" },
  { value: "dockerfile", label: "DockerFile" },
  { value: "go", label: "Go" },
  { value: "graphql", label: "GraphQL" },
  { value: "xml", label: "HTML / XML" },
  { value: "java", label: "Java" },
  { value: "javascript", label: "JavaScript" },
  { value: "json", label: "JSON" },
  { value: "kotlin", label: "Kotlin" },
  { value: "markdown", label: "Markdown" },
  { value: "php", label: "PHP" },
  { value: "powershell", label: "PowerShell" },
  { value: "python", label: "Python" },
  { value: "ruby", label: "Ruby" },
  { value: "rust", label: "Rust" },
  { value: "scss", label: "SCSS" },
  { value: "shell", label: "Shell" },
  { value: "sql", label: "SQL" },
  { value: "swift", label: "Swift" },
  { value: "typescript", label: "TypeScript" },
  { value: "yaml", label: "YAML" },
];

function CodeBlockView({ node, updateAttributes }: any) {
  const language = (node?.attrs?.language as string) || "plaintext";
  const [open, setOpen] = useState(false);
  const [menuPos, setMenuPos] = useState<{
    left: number;
    top?: number;
    bottom?: number;
  } | null>(null);
  const btnRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  // Fall back to the RAW language value (not "Plain Text") when a block carries a
  // grammar that's valid in lowlight but absent from the picker list (e.g. a
  // pasted `language-diff` block) — so the header labels it honestly instead of
  // mislabeling it, and picking a new one is a deliberate override.
  const current =
    CODE_LANGUAGES.find((l) => l.value === language) || {
      value: language,
      label: language,
    };

  // The dropdown is PORTALED to <body> and fixed-positioned so it is never
  // clipped by the composer's overflow (the code block lives inside a rounded,
  // scrolling composer box). Opens upward when there's room above (the composer
  // sits at the bottom of the viewport), otherwise downward. A native <select>
  // was replaced by this custom themed dropdown because its OS-drawn option list
  // couldn't be styled — on dark mode it was an unreadable white popup.
  const openMenu = () => {
    const btn = btnRef.current;
    if (!btn) {
      setOpen(true);
      return;
    }
    const r = btn.getBoundingClientRect();
    const gap = 4;
    const openUp = r.top > 200; // enough room above for the menu
    setMenuPos(
      openUp
        ? { left: r.left, bottom: window.innerHeight - r.top + gap }
        : { left: r.left, top: r.bottom + gap },
    );
    setOpen(true);
  };

  // Close on any click outside the trigger or the (portaled) menu.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node;
      if (btnRef.current && btnRef.current.contains(t)) return;
      if (menuRef.current && menuRef.current.contains(t)) return;
      setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open]);

  return (
    <NodeViewWrapper className="cb-node">
      <div className="cb-head" contentEditable={false}>
        <button
          ref={btnRef}
          type="button"
          className="cb-lang"
          // preventDefault keeps the editor selection/focus from moving when the
          // picker is used (the NodeView content stays put).
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => (open ? setOpen(false) : openMenu())}
          aria-haspopup="listbox"
          aria-expanded={open}
        >
          <span>{current.label}</span>
          <svg viewBox="0 0 12 12" width="11" height="11" aria-hidden="true">
            <path
              d="M3 4.5 L6 7.5 L9 4.5"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.3"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        </button>
      </div>
      <pre>
        {/* `as` is typed too narrowly (only "div") in this tiptap version, but a
            code block's content must live in <code>; the cast is safe at runtime. */}
        <NodeViewContent as={"code" as any} />
      </pre>
      {open && menuPos
        ? createPortal(
            <div
              ref={menuRef}
              className="cb-langmenu"
              role="listbox"
              style={{
                position: "fixed",
                left: menuPos.left,
                top: menuPos.top,
                bottom: menuPos.bottom,
              }}
            >
              {CODE_LANGUAGES.map((l) => (
                <button
                  key={l.value}
                  type="button"
                  role="option"
                  aria-selected={l.value === language}
                  className={
                    "cb-langopt" + (l.value === language ? " active" : "")
                  }
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => {
                    if (l.value === "auto") {
                      // Auto-identify: detect the grammar from the block's text and
                      // apply it (falls back to Plain Text if nothing is confident).
                      const text = (node?.textContent as string) || "";
                      let detected = "plaintext";
                      try {
                        const res: any = lowlight.highlightAuto(text);
                        detected =
                          (res && res.data && res.data.language) || "plaintext";
                      } catch (_) {
                        detected = "plaintext";
                      }
                      updateAttributes({ language: detected });
                    } else {
                      updateAttributes({ language: l.value });
                    }
                    setOpen(false);
                  }}
                >
                  {l.label}
                </button>
              ))}
            </div>,
            document.body,
          )
        : null}
    </NodeViewWrapper>
  );
}

interface Props {
  value: string;
  onChange: (value: string) => void;
  onSend: () => void;
  placeholder?: string;
  mentionUsers?: Array<{ id: string; name: string; initials: string; color: string }>;
  // Show the @everyone broadcast row. Off for 1:1 DMs and self-notes, where
  // "notify all members" is meaningless.
  allowBroadcast?: boolean;
  // Add-People entry in the @ menu (Teams parity). Opens the existing add-members
  // flow; only offered to people who can actually add members (owner/admin).
  onAddPeople?: () => void;
  canAddPeople?: boolean;
  enterToSend?: boolean;
  disabled?: boolean;
  // Called with any image/file extracted from a paste or drop. Return true if
  // handled (the editor then suppresses its own default paste/drop for them).
  onFiles?: (files: File[]) => boolean;
}

// Pull real files out of a clipboard/drag payload (screenshots, copied images,
// dragged docs). Ignores the synthetic text/html entries.
function extractFiles(dt: DataTransfer | null): File[] {
  if (!dt) return [];
  const out: File[] = [];
  if (dt.files && dt.files.length) {
    for (let i = 0; i < dt.files.length; i++) out.push(dt.files[i]);
  } else if (dt.items && dt.items.length) {
    for (let i = 0; i < dt.items.length; i++) {
      const it = dt.items[i];
      if (it.kind === "file") {
        const f = it.getAsFile();
        if (f) out.push(f);
      }
    }
  }
  return out;
}

// A pasted text/html flavour counts as "styled" when it carries inline styles,
// classes or formatting/structure tags (plain copies from editors are bare <p>/<span>).
const PASTE_STYLE_RE = /style\s*=|class\s*=|<(?:b|strong|i|em|u|s|a|h[1-6]|ul|ol|li|table|font|code|pre|blockquote|mark)[\s>]/i;

// True when the caret/selection sits inside a list, blockquote, or code block —
// where Enter should add an item/line rather than send the message.
function isInListLike(state: any): boolean {
  try {
    const $f = state.selection.$from;
    for (let d = $f.depth; d > 0; d--) {
      const n = $f.node(d).type.name;
      if (n === "bulletList" || n === "orderedList" || n === "listItem" || n === "taskList" || n === "taskItem" || n === "blockquote" || n === "codeBlock") return true;
    }
  } catch (_) { /* ignore */ }
  return false;
}

export interface RichTextEditorHandle {
  toggleBold: () => void;
  toggleItalic: () => void;
  toggleUnderline: () => void;
  toggleStrike: () => void;
  toggleCode: () => void;
  toggleBulletList: () => void;
  toggleOrderedList: () => void;
  toggleBlockquote: () => void;
  toggleCodeBlock: () => void;
  setHorizontalRule: () => void;
  insertTable: () => void;
  addColumnAfter: () => void;
  addRowAfter: () => void;
  deleteTable: () => void;
  deleteRow: () => void;
  deleteColumn: () => void;
  undo: () => void;
  redo: () => void;
  clearFormatting: () => void;
  // Insert plain text (e.g. an emoji from the shared picker) at the caret.
  insertText: (text: string) => void;
  focus: () => void;
  indent: () => void;
  outdent: () => void;
  setLink: (url: string) => void;
  unsetLink: () => void;
  setColor: (color: string) => void;
  unsetColor: () => void;
  insertImage: (src: string, alt?: string) => void;
  isBold: () => boolean;
  isItalic: () => boolean;
  isUnderline: () => boolean;
  isStrike: () => boolean;
  isCode: () => boolean;
  isBulletList: () => boolean;
  isOrderedList: () => boolean;
  isBlockquote: () => boolean;
  isLink: () => boolean;
}

const RichTextEditor = forwardRef<RichTextEditorHandle, Props>(function RichTextEditor({
  value,
  onChange,
  onSend,
  placeholder = "Type a message",
  mentionUsers = [],
  allowBroadcast = true,
  onAddPeople,
  canAddPeople = false,
  enterToSend = true,
  disabled = false,
  onFiles,
}, ref) {
  // The editor instance is created once; route file handling through a ref so
  // the paste/drop handlers always call the latest closure (current replyTo etc.).
  const onFilesRef = useRef(onFiles);
  useEffect(() => { onFilesRef.current = onFiles; }, [onFiles]);
  // useEditor below is called with NO dependency array, so tiptap builds the
  // editor ONCE and freezes this options closure at first render — the mention
  // `items` callback would keep reading the mentionUsers array captured at mount
  // even after switching conversations.
  //
  // HONESTY NOTE: this was investigated as the cause of the "@ picker shows the
  // wrong people" report and it is NOT — a same-session conversation-switch test
  // (no reloads) passes both with and without this change, because something
  // upstream keeps the list current in practice. The real defect was server-side
  // (mentions were never dispatched for encrypted messages, and were re-resolved
  // by first name); see notifyMentionedIds. Kept anyway because depending on a
  // frozen closure staying accidentally correct is fragile, and reading the live
  // value costs nothing. Recreating the editor on prop change would destroy the
  // draft and caret, so mirror into refs — the pattern onFilesRef uses above.
  const mentionUsersRef = useRef(mentionUsers);
  useEffect(() => { mentionUsersRef.current = mentionUsers; }, [mentionUsers]);
  const allowBroadcastRef = useRef(allowBroadcast);
  useEffect(() => { allowBroadcastRef.current = allowBroadcast; }, [allowBroadcast]);
  const onAddPeopleRef = useRef(onAddPeople);
  useEffect(() => { onAddPeopleRef.current = onAddPeople; }, [onAddPeople]);
  const canAddPeopleRef = useRef(canAddPeople);
  useEffect(() => { canAddPeopleRef.current = canAddPeople; }, [canAddPeople]);
  // "Paste as plain text" chip: shown at the end of a paste that carried
  // formatting (Word/Teams-style paste options). Click replaces the pasted
  // range with its plain text.
  const [pasteChip, setPasteChip] = useState<{ left: number; top: number; from: number; to: number; text: string } | null>(null);
  const editor = useEditor({
    extensions: [
      // Disable StarterKit's BUNDLED underline (tiptap v3 ships it) so the
      // explicit @tiptap/extension-underline below is the single instance —
      // otherwise both register "underline" ("Duplicate extension names" warning).
      StarterKit.configure({ codeBlock: false, link: false, underline: false }),
      Underline,
      Link.configure({ openOnClick: false, HTMLAttributes: { class: "msg-link", target: "_blank", rel: "noopener noreferrer" } }),
      Placeholder.configure({ placeholder }),
      CodeBlockLowlight.extend({
        addNodeView() {
          return ReactNodeViewRenderer(CodeBlockView);
        },
      }).configure({ lowlight }),
      TaskList,
      TaskItem.configure({ nested: true }),
      IndentExtension,
      Typography,
      TextStyle,
      Color,
      Highlight.configure({ multicolor: true }),
      TextAlign.configure({ types: ["heading", "paragraph"] }),
      Image,
      Table.configure({ resizable: false }),
      TableRow,
      TableCell,
      TableHeader,
      Mention.configure({
        HTMLAttributes: { class: "mention" },
        renderHTML({ node }) {
          return ["span", { class: "mention", "data-user-id": node.attrs.id }, "@" + node.attrs.label];
        },
        renderText({ node }) {
          return "@" + node.attrs.label;
        },
        suggestion: {
          items: ({ query }) => {
            const q = (query || "").toLowerCase();
            // Read through the refs, NOT the captured props — this closure is
            // frozen at first render (see the note on mentionUsersRef above).
            // One broadcast row only (Teams uses a single "Everyone"). id stays
            // "__here__" so extractMentionMeta already skips it in its user-id set
            // and the backend still routes it to notifyChannel over all members.
            // name must be lowercase — items() filters broadcasts by startsWith(q)
            // against a lower-cased query.
            const broadcasts = (allowBroadcastRef.current
              ? [
                  { id: "__here__", name: "everyone", initials: "@", color: "var(--ac)", label: "Notifies All Members" },
                ]
              : []
            ).filter((b) => b.name.startsWith(q));
            const users = (mentionUsersRef.current || [])
              .filter((u) => u.name.toLowerCase().includes(q))
              .slice(0, 6);
            // Add-People pseudo-item (Teams parity). Sentinel id — NEVER inserted
            // as a mention (handled in select()), so no data-user-id leaks.
            const addPeople =
              canAddPeopleRef.current && onAddPeopleRef.current && "add people".includes(q)
                ? [{ id: "__addpeople__", name: "Add People", initials: "+", color: "var(--ac)", label: "Invite Members To This Conversation" }]
                : [];
            return [...broadcasts, ...users, ...addPeople];
          },
          render: () => {
            // Working suggestion renderer: positions at the CARET (props.clientRect,
            // which the old code clobbered → it rendered at 0,0), inserts on click
            // AND keyboard, and arrow-keys move the selection. (audit: was fully broken.)
            let el: HTMLElement | null = null;
            let items: any[] = [];
            let index = 0;
            let command: ((i: any) => void) | null = null;
            let getRect: (() => DOMRect | null) | null = null;
            let ed: any = null;
            let range: any = null;
            let edDom: HTMLElement | null = null;
            let onDocDown: ((e: MouseEvent) => void) | null = null;
            const select = (i: number) => {
              const u = items[i];
              if (!u) return;
              // Add People opens the members modal instead of inserting a mention;
              // remove the typed "@add" first so no stray text is left behind.
              if (u.id === "__addpeople__") {
                if (ed && range) ed.chain().focus().deleteRange(range).run();
                if (el) el.style.display = "none";
                onAddPeopleRef.current && onAddPeopleRef.current();
                return;
              }
              if (command) command({ id: u.id, label: u.name });
            };
            const draw = () => {
              if (!el) return;
              if (!items.length) { el.style.display = "none"; return; }
              el.style.display = "";
              el.innerHTML = items
                .map(
                  (u: any, i: number) =>
                    `<div class="mention-item${i === index ? " active" : ""}" data-index="${i}"><span class="mention-avatar" style="background:${u.color}">${u.initials}</span><span class="mention-name">${u.name}${u.label ? `<span class="mention-sublabel"> — ${u.label}</span>` : ""}</span></div>`,
                )
                .join("");
            };
            const place = () => {
              if (!el || !getRect) return;
              const r = getRect();
              if (!r) return;
              const m = 8;
              el.style.position = "fixed";
              el.style.left =
                Math.max(m, Math.min(r.left, window.innerWidth - el.offsetWidth - m)) + "px";
              const below = r.bottom + 4;
              el.style.top =
                (below + el.offsetHeight > window.innerHeight - m ? r.top - el.offsetHeight - 4 : below) + "px";
            };
            return {
              onStart: (props: any) => {
                items = props.items || [];
                index = 0;
                command = props.command;
                getRect = props.clientRect;
                ed = props.editor;
                range = props.range;
                edDom = (props.editor && props.editor.view && props.editor.view.dom) || null;
                el = document.createElement("div");
                el.className = "tiptap-mention-popover";
                document.body.appendChild(el);
                el.addEventListener("mousedown", (e) => {
                  const t = (e.target as HTMLElement)?.closest?.(".mention-item") as HTMLElement | null;
                  if (t) { e.preventDefault(); select(Number(t.dataset.index)); }
                });
                // Close on outside click: ignore clicks inside the popover (the
                // el.mousedown above already handles those and preventDefaults the
                // item pick) and inside the editor (the trigger); any other click
                // hides the popover. Not preventDefaulted, so the click still lands.
                onDocDown = (e: MouseEvent) => {
                  const t = e.target as Node;
                  if (el && !el.contains(t) && !(edDom && edDom.contains(t))) {
                    el.style.display = "none";
                  }
                };
                document.addEventListener("mousedown", onDocDown);
                draw();
                place();
              },
              onUpdate(props: any) {
                items = props.items || [];
                command = props.command;
                getRect = props.clientRect;
                ed = props.editor;
                range = props.range;
                if (index > items.length - 1) index = Math.max(0, items.length - 1);
                draw();
                place();
              },
              onKeyDown(props: any) {
                const k = props.event.key;
                const n = items.length;
                if (!n) return false;
                if (k === "ArrowDown") { props.event.preventDefault(); index = (index + 1) % n; draw(); return true; }
                if (k === "ArrowUp") { props.event.preventDefault(); index = (index - 1 + n) % n; draw(); return true; }
                if (k === "Enter" || k === "Tab") { props.event.preventDefault(); select(index); return true; }
                if (k === "Escape") { props.event.preventDefault(); if (el) el.style.display = "none"; return true; }
                return false;
              },
              onExit() {
                if (onDocDown) document.removeEventListener("mousedown", onDocDown);
                onDocDown = null;
                el?.remove();
                el = null;
              },
            };
          },
        },
      }),
    ],
    content: value,
    editable: !disabled,
    onUpdate: ({ editor }) => {
      onChange(editor.getHTML());
    },
    editorProps: {
      attributes: {
        class: "tiptap-editor",
        spellcheck: "true",
      },
      // Paste of an image/screenshot (or any file) → hand to the uploader and
      // suppress the editor's default (which would inline a huge base64 blob).
      // Pasted rich text / tables (no files) fall through so Tiptap parses them
      // into proper nodes.
      handlePaste: (_view: any, event: ClipboardEvent) => {
        const handler = onFilesRef.current;
        const cd = event.clipboardData;
        if (handler && cd) {
          const files = extractFiles(cd);
          if (files.length) {
            event.preventDefault();
            return handler(files);
          }
        }
        // Robustness: if the clipboard carries NO real text/html but the plain
        // text is actually HTML markup (e.g. a copied message body like
        // "<p>hi</p>"), parse it as HTML so it pastes as formatted content
        // instead of showing literal <p> tags. Normal text/html pastes and
        // ordinary plain text fall through to Tiptap's default parser.
        if (cd) {
          const html = cd.getData("text/html");
          const text = cd.getData("text/plain");
          if (!html && text && /^\s*<(?:p|div|ul|ol|li|h[1-6]|blockquote|pre|span|strong|em|b|i|br)[\s>/]/i.test(text) && /<\/[a-z]+>|\/>/i.test(text)) {
            event.preventDefault();
            editor?.chain().focus().insertContent(text).run();
            return true;
          }
        }
        // Formatted paste → let Tiptap insert it as usual, then offer the
        // "paste as plain text" chip at the end of what was pasted.
        if (cd) {
          const html = cd.getData("text/html");
          const text = cd.getData("text/plain");
          if (html && text && PASTE_STYLE_RE.test(html)) {
            const from = _view.state.selection.from;
            setTimeout(() => {
              try {
                const ed = editor;
                if (!ed || ed.isDestroyed) return;
                const to = ed.state.selection.to;
                if (to <= from) return;
                const c = ed.view.coordsAtPos(to);
                setPasteChip({ left: c.right, top: c.bottom, from, to, text });
              } catch (_) { /* no chip is fine */ }
            }, 0);
          }
        }
        return false;
      },
      // Drop of files onto the composer → upload + send. Dropped text/HTML
      // falls through to Tiptap.
      handleDrop: (_view: any, event: DragEvent) => {
        const handler = onFilesRef.current;
        if (!handler) return false;
        const files = extractFiles(event.dataTransfer);
        if (files.length) {
          event.preventDefault();
          return handler(files);
        }
        return false;
      },
      handleKeyDown: (view: any, event: KeyboardEvent) => {
        if (event.key === "Enter" && !event.shiftKey && !event.ctrlKey && !event.metaKey) {
          // If the @mention suggestion popover is open, let IT consume Enter (to
          // pick the highlighted person). ProseMirror checks these direct editor
          // props BEFORE plugin handlers, so without this bail-out we'd send the
          // message and the keyboard-selected mention would never insert.
          const pop = document.querySelector(".tiptap-mention-popover") as HTMLElement | null;
          if (pop && pop.style.display !== "none") return false;
          // Inside a list / quote / code block, let the editor handle Enter
          // (new bullet / new quote line / newline) instead of sending — so you
          // can actually build a multi-item list. Double-Enter exits the list as
          // usual; use the Send button (or Enter outside the list) to send.
          if (isInListLike(view.state)) return false;
          if (enterToSend) {
            event.preventDefault();
            onSend();
            return true;
          }
        }
        // Enterprise block model: Shift+Enter starts a NEW PARAGRAPH (its own
        // block) rather than a soft <br>. This makes every line a real block, so
        // selecting several lines and applying a bullet/numbered list (or quote)
        // turns each line into its own item natively — no fragile <br> surgery.
        // Inside a list/quote/code block we keep the editor's default (a soft
        // line break within the current item/line), which is the expected feel.
        if (event.key === "Enter" && event.shiftKey && !event.ctrlKey && !event.metaKey) {
          if (isInListLike(view.state)) return false;
          event.preventDefault();
          editor?.chain().focus().splitBlock().run();
          return true;
        }
        if ((event.key === "Enter" || event.key === "Tab") && (event.ctrlKey || event.metaKey)) {
          if (!enterToSend) {
            event.preventDefault();
            onSend();
            return true;
          }
        }
        return false;
      },
    },
  });

  // Before turning a selection into a list, convert any soft line-breaks
  // (Shift+Enter <br>) within the selected paragraphs into separate paragraphs,
  // so each visual line becomes its OWN bullet/number instead of all of them
  // collapsing into a single list item. (In a chat composer Enter sends, so
  // multi-line text is usually soft-breaks in one block — this is what made
  // "select all → bullet list" produce a single bullet.)
  const splitHardBreaksInSelection = () => {
    if (!editor || editor.isActive("codeBlock")) return;
    const { state } = editor;
    const { from, to } = state.selection;
    const positions: number[] = [];
    state.doc.nodesBetween(from, to, (node: any, pos: number) => {
      if (node.type && node.type.name === "hardBreak") positions.push(pos);
    });
    if (!positions.length) return;
    let tr = state.tr;
    // Descending so earlier (lower) positions stay valid as we edit.
    positions.sort((a, b) => b - a).forEach((pos) => {
      try {
        tr = tr.delete(pos, pos + 1);
        tr = tr.split(pos);
      } catch (_) { /* skip a break we can't split cleanly */ }
    });
    if (tr.docChanged) editor.view.dispatch(tr);
  };

  useImperativeHandle(ref, () => ({
    toggleBold: () => editor?.chain().focus().toggleBold().run(),
    toggleItalic: () => editor?.chain().focus().toggleItalic().run(),
    toggleUnderline: () => editor?.chain().focus().toggleUnderline().run(),
    toggleStrike: () => editor?.chain().focus().toggleStrike().run(),
    toggleCode: () => editor?.chain().focus().toggleCode().run(),
    toggleBulletList: () => { if (!editor?.isActive("bulletList")) splitHardBreaksInSelection(); editor?.chain().focus().toggleBulletList().run(); },
    toggleOrderedList: () => { if (!editor?.isActive("orderedList")) splitHardBreaksInSelection(); editor?.chain().focus().toggleOrderedList().run(); },
    toggleBlockquote: () => editor?.chain().focus().toggleBlockquote().run(),
    toggleCodeBlock: () => editor?.chain().focus().toggleCodeBlock().run(),
    setHorizontalRule: () => editor?.chain().focus().setHorizontalRule().run(),
    insertTable: () => editor?.chain().focus().insertTable({ rows: 3, cols: 3, withHeaderRow: true }).run(),
    addColumnAfter: () => editor?.chain().focus().addColumnAfter().run(),
    addRowAfter: () => editor?.chain().focus().addRowAfter().run(),
    deleteTable: () => editor?.chain().focus().deleteTable().run(),
    deleteRow: () => editor?.chain().focus().deleteRow().run(),
    deleteColumn: () => editor?.chain().focus().deleteColumn().run(),
    undo: () => editor?.chain().focus().undo().run(),
    redo: () => editor?.chain().focus().redo().run(),
    clearFormatting: () => editor?.chain().focus().clearNodes().unsetAllMarks().run(),
    insertText: (text: string) => editor?.chain().focus().insertContent(text).run(),
    focus: () => editor?.chain().focus().run(),
    indent: () => {
      if (editor?.isActive("listItem"))
        editor.chain().focus().sinkListItem("listItem").run();
      else if (editor?.isActive("taskItem"))
        editor.chain().focus().sinkListItem("taskItem").run();
      else (editor?.chain().focus() as any)?.indentBlock().run();
    },
    outdent: () => {
      if (editor?.isActive("listItem"))
        editor.chain().focus().liftListItem("listItem").run();
      else if (editor?.isActive("taskItem"))
        editor.chain().focus().liftListItem("taskItem").run();
      else (editor?.chain().focus() as any)?.outdentBlock().run();
    },
    setLink: (url: string) => {
      if (url) {
        editor?.chain().focus().extendMarkRange("link").setLink({ href: url }).run();
      } else {
        editor?.chain().focus().extendMarkRange("link").unsetLink().run();
      }
    },
    unsetLink: () => editor?.chain().focus().unsetLink().run(),
    // Text colour (@tiptap/extension-color, registered below). Cast because the
    // setColor/unsetColor commands aren't in the base ChainedCommands types.
    setColor: (color: string) =>
      (editor?.chain().focus() as any)?.setColor(color).run(),
    unsetColor: () => (editor?.chain().focus() as any)?.unsetColor().run(),
    insertImage: (src: string, alt?: string) => {
      editor?.chain().focus().setImage({ src, alt: alt || "" }).run();
    },
    isBold: () => editor?.isActive("bold") ?? false,
    isItalic: () => editor?.isActive("italic") ?? false,
    isUnderline: () => editor?.isActive("underline") ?? false,
    isStrike: () => editor?.isActive("strike") ?? false,
    isCode: () => editor?.isActive("code") ?? false,
    isBulletList: () => editor?.isActive("bulletList") ?? false,
    isOrderedList: () => editor?.isActive("orderedList") ?? false,
    isBlockquote: () => editor?.isActive("blockquote") ?? false,
    isLink: () => editor?.isActive("link") ?? false,
  }), [editor]);

  useEffect(() => {
    if (!editor) return;
    // CRITICAL: only push EXTERNAL value changes into the editor. Previously this
    // ran editor.commands.setContent(value) on EVERY value change — including the
    // echo from our own onUpdate (onChange → parent setText → value) — which reset
    // the caret/selection on each keystroke. That ate trailing spaces (you had to
    // backspace before a space would "stick") and collapsed multi-line selections
    // so bulk formatting (bold/list) only applied to the first line. Guarding on
    // value !== editor.getHTML() means a keystroke echo is a no-op (caret stays
    // put), while genuine external changes — clearing after send, loading a
    // scheduled draft — still sync. `false` suppresses a re-emitted update.
    if (value !== editor.getHTML()) {
      editor.commands.setContent(value || "", { emitUpdate: false } as any);
      // Clearing after a send replaces the whole doc; ProseMirror can leave the
      // selection as a range over the now-empty paragraph, which renders as a
      // stray thick blue caret/selection next to the placeholder. Collapse it to
      // a clean caret at the start so the emptied composer looks normal.
      //
      // Position 1 — NOT 0. Position 0 resolves to the spot BEFORE the paragraph
      // node, where ProseMirror has no valid text selection and falls back to a
      // GAP CURSOR, drawn as a thick blue bar beside the placeholder (the very
      // artifact this line exists to remove). 1 is the first text position
      // inside the empty <p>, which renders as an ordinary caret. Clamped for a
      // degenerate empty doc.
      if (!value)
        editor.commands.setTextSelection(
          Math.min(1, editor.state.doc.content.size),
        );
    }
  }, [value, editor]);

  // Dismiss the chip on the next edit, blur, scroll, or after a few seconds.
  useEffect(() => {
    if (!pasteChip || !editor) return;
    const hide = () => setPasteChip(null);
    editor.on("update", hide);
    editor.on("blur", hide);
    window.addEventListener("scroll", hide, true);
    const t = setTimeout(hide, 10000);
    return () => {
      editor.off("update", hide);
      editor.off("blur", hide);
      window.removeEventListener("scroll", hide, true);
      clearTimeout(t);
    };
  }, [pasteChip, editor]);

  const pasteAsPlainText = () => {
    const chip = pasteChip;
    if (!editor || !chip) return;
    const lines = chip.text.replace(/\r\n?/g, "\n").replace(/\n+$/, "").split("\n");
    const content: any = lines.length === 1
      ? { type: "text", text: lines[0] }
      : lines.map((l) => (l ? { type: "paragraph", content: [{ type: "text", text: l }] } : { type: "paragraph" }));
    editor.chain().focus().insertContentAt({ from: chip.from, to: chip.to }, content).run();
    setPasteChip(null);
  };

  return (
    <div className="rich-editor-wrapper">
      <EditorContent editor={editor} />
      {pasteChip && (
        <button
          type="button"
          className="paste-plain-chip"
          title="Paste as plain text"
          aria-label="Paste as plain text"
          onMouseDown={(e) => e.preventDefault()}
          onClick={pasteAsPlainText}
          style={{
            position: "fixed",
            left: Math.max(8, pasteChip.left - 4),
            top: pasteChip.top + 4,
            zIndex: 60,
            display: "flex",
            alignItems: "center",
            gap: 4,
            padding: "3px 7px",
            fontSize: 11,
            lineHeight: 1,
            borderRadius: 6,
            cursor: "pointer",
            border: "1px solid var(--border, #cfd4da)",
            background: "var(--surface, #fff)",
            color: "var(--text, #1b2430)",
            boxShadow: "0 2px 8px rgba(0,0,0,.18)",
          }}
        >
          <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" aria-hidden="true">
            <path d="M3 4h10M8 4v9M5.5 13h5" />
          </svg>
          Plain text
        </button>
      )}
    </div>
  );
});

export default RichTextEditor;
