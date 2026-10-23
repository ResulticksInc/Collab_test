// ─────────────────────────────────────────────────────────────────────────────
// useInlineMentions — the ONE @-mention behaviour shared by the plain single-line
// chat composers in Calls (CoLabV1) and Meetings (MeetingStage).
//
// The MAIN chat composer is a full TipTap editor with its own Mention plugin;
// this hook is deliberately separate and lightweight — it drives a plain <input>
// holding a string draft, so both in-call and in-meeting chat get the SAME
// searchable, keyboard-navigable @-mention popover (ArrowUp/Down to move, Enter or
// Tab to pick, Esc to dismiss) instead of the meeting's old mouse-only list and
// the call's nothing-at-all.
//
// It resolves names against whatever participant/roster array the surface already
// has ({ name, isLocal }); self (isLocal) is excluded. The regex matches "@word"
// at the caret (end of a single-line draft), matching the surfaces' prior behaviour.
// ─────────────────────────────────────────────────────────────────────────────
import React, { useCallback, useEffect, useMemo, useState } from "react";

export interface MentionPerson {
  name?: string;
  isLocal?: boolean;
  id?: string;
}

// "@" preceded by start-or-whitespace, capturing the partial word up to the caret.
const MENTION_RE = /(^|\s)@(\w*)$/;

export interface InlineMentions {
  /** The popover should render (there's an active query AND matching people). */
  open: boolean;
  /** Up-to-`max` matching people for the current query. */
  options: MentionPerson[];
  /** Keyboard-highlighted row index. */
  activeIndex: number;
  setActiveIndex: (i: number) => void;
  /** Replace the trailing "@query" with "@Name " and refocus the input. */
  insert: (name: string) => void;
  /**
   * Feed the composer's onKeyDown here FIRST. Returns true when it consumed the
   * key (navigation / selection / dismiss) — the caller must then early-return so
   * the same key doesn't also send the message or bubble to the global Esc/Back.
   */
  onKeyDown: (e: React.KeyboardEvent) => boolean;
}

export function useInlineMentions(opts: {
  draft: string;
  setDraft: (updater: (d: string) => string) => void;
  people: ReadonlyArray<MentionPerson>;
  inputRef?: React.RefObject<HTMLInputElement | HTMLTextAreaElement | null>;
  max?: number;
}): InlineMentions {
  const { draft, setDraft, people, inputRef, max = 6 } = opts;
  const [activeIndex, setActiveIndex] = useState(0);
  // Esc dismisses the popover for the CURRENT query; typing changes the query,
  // which clears the dismissal (see the effect) so it can reappear.
  const [dismissed, setDismissed] = useState(false);

  const query = useMemo(() => {
    const m = MENTION_RE.exec(draft);
    return m ? m[2].toLowerCase() : null;
  }, [draft]);

  const options = useMemo(() => {
    if (query === null) return [];
    return people
      .filter((p) => !p.isLocal && (p.name || "").toLowerCase().includes(query))
      .slice(0, max);
  }, [query, people, max]);

  const open = query !== null && options.length > 0 && !dismissed;

  // Reset the highlight and the dismissal whenever the query itself changes.
  useEffect(() => {
    setActiveIndex(0);
    setDismissed(false);
  }, [query]);

  const insert = useCallback(
    (name: string) => {
      setDraft((d) => d.replace(MENTION_RE, `$1@${name} `));
      setActiveIndex(0);
      inputRef?.current?.focus();
    },
    [setDraft, inputRef],
  );

  const onKeyDown = useCallback(
    (e: React.KeyboardEvent): boolean => {
      if (!open) return false;
      switch (e.key) {
        case "ArrowDown":
          e.preventDefault();
          setActiveIndex((i) => (i + 1) % options.length);
          return true;
        case "ArrowUp":
          e.preventDefault();
          setActiveIndex((i) => (i - 1 + options.length) % options.length);
          return true;
        case "Enter":
        case "Tab": {
          const pick = options[activeIndex] || options[0];
          if (!pick) return false;
          e.preventDefault();
          insert(pick.name || "");
          return true;
        }
        case "Escape":
          // Consume Esc so it closes the popover only — stopPropagation keeps it
          // from bubbling to the window-level Esc handler (which would otherwise
          // close the call/meeting or navigate the module back).
          e.preventDefault();
          e.stopPropagation();
          setDismissed(true);
          return true;
        default:
          return false;
      }
    },
    [open, options, activeIndex, insert],
  );

  return { open, options, activeIndex, setActiveIndex, insert, onKeyDown };
}

// Shared popover UI — identical markup/classes on both surfaces so styling and
// positioning (the .ms-chat-mention-* rules) stay a single source of truth.
export function InlineMentionPopover({
  mentions,
}: {
  mentions: InlineMentions;
}): React.ReactElement | null {
  if (!mentions.open) return null;
  return (
    <div className="ms-chat-mention-pop" role="listbox" aria-label="Mention a participant">
      {mentions.options.map((p, i) => (
        <button
          key={(p.id || p.name || "") + i}
          type="button"
          role="option"
          aria-selected={i === mentions.activeIndex}
          className={"ms-chat-mention-opt" + (i === mentions.activeIndex ? " active" : "")}
          onMouseDown={(e) => {
            e.preventDefault();
            mentions.insert(p.name || "");
          }}
          onMouseEnter={() => mentions.setActiveIndex(i)}
        >
          @{p.name}
        </button>
      ))}
    </div>
  );
}
