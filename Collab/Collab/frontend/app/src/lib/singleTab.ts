"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { isDesktopApp } from "./platform";

// One active Collab tab per browser profile.
//
// Mechanism: a BroadcastChannel handshake — NO stored lock — so a crashed/killed tab
// can never leave a stale "already open" flag behind (the failure mode of a
// localStorage lock). A tab that is alive answers; a dead one simply doesn't.
//
//   • On load a tab broadcasts `hello` and waits briefly (HANDSHAKE_MS).
//   • An already-active tab answers `here` → the new tab is in "conflict" and asks
//     the user (Continue / Cancel).
//   • Continue → the new tab broadcasts `takeover`; every other tab becomes
//     "superseded" (it tries window.close(); browsers only allow that for tabs a
//     script opened, so it also swaps itself for a blocking notice and unmounts the
//     app — which tears down its sockets — rather than staying live in the background).
//   • Cancel → the new tab stops ("stopped"); the existing tab is untouched.
//   • Two tabs opened at the same instant: the OLDER `born` timestamp wins the tie
//     (id breaks an exact tie), so exactly one of them prompts.
//
// Exempt: the Electron desktop shell (its own window) and `?popout=1` conversation
// windows, which intentionally run alongside the main tab.

export type TabState =
  | "checking" // handshake in flight — app not mounted yet
  | "active" // this is the one live tab
  | "conflict" // another tab is open — prompt the user
  | "superseded" // another tab took over — this one is parked
  | "stopped"; // user chose Cancel in this (new) tab

const CHANNEL = "collab-single-tab";
const HANDSHAKE_MS = 250;

type Msg =
  | { t: "hello"; id: string; born: number }
  | { t: "here"; id: string; to: string }
  | { t: "takeover"; id: string };

function exempt(): boolean {
  if (typeof window === "undefined") return true;
  if (isDesktopApp) return true;
  try {
    if (new URLSearchParams(window.location.search).get("popout") === "1") return true;
  } catch {
    /* ignore */
  }
  return typeof BroadcastChannel === "undefined"; // very old browser → don't block
}

const newId = () =>
  Math.random().toString(36).slice(2) + Date.now().toString(36);

export function useSingleTab(): {
  state: TabState;
  continueHere: () => void;
  cancel: () => void;
} {
  // First render MUST be identical on the server and the client (hydration): the
  // server has no `window`, so always start in "checking" and let the effect below
  // decide. Deciding from window/BroadcastChannel here caused a hydration mismatch.
  const [state, setState] = useState<TabState>("checking");
  const stateRef = useRef<TabState>("checking");
  const chRef = useRef<BroadcastChannel | null>(null);
  const idRef = useRef<string>("");
  const bornRef = useRef<number>(0);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const set = useCallback((s: TabState) => {
    stateRef.current = s;
    setState(s);
  }, []);

  const post = useCallback((m: Msg) => {
    try {
      chRef.current?.postMessage(m);
    } catch {
      /* channel closed */
    }
  }, []);

  const handshake = useCallback(() => {
    bornRef.current = Date.now();
    set("checking");
    post({ t: "hello", id: idRef.current, born: bornRef.current });
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => {
      if (stateRef.current === "checking") set("active");
    }, HANDSHAKE_MS);
  }, [post, set]);

  useEffect(() => {
    if (exempt()) {
      // Desktop shell / popout / no BroadcastChannel — never gate.
      set("active");
      return;
    }
    idRef.current = newId();
    const ch = new BroadcastChannel(CHANNEL);
    chRef.current = ch;

    ch.onmessage = (ev: MessageEvent<Msg>) => {
      const m = ev.data;
      if (!m || typeof m !== "object" || m.id === idRef.current) return;
      const s = stateRef.current;
      if (m.t === "hello") {
        // Answer if I'm already established, or if I'm still handshaking but older
        // (so simultaneous opens resolve to exactly one prompt).
        const iWin =
          s === "active" ||
          (s === "checking" &&
            (bornRef.current < m.born ||
              (bornRef.current === m.born && idRef.current < m.id)));
        if (iWin) post({ t: "here", id: idRef.current, to: m.id });
      } else if (m.t === "here") {
        if (m.to === idRef.current && s === "checking") {
          if (timerRef.current) clearTimeout(timerRef.current);
          set("conflict");
        }
      } else if (m.t === "takeover") {
        if (s === "active" || s === "checking" || s === "conflict") {
          if (timerRef.current) clearTimeout(timerRef.current);
          set("superseded");
          // Only works for script-opened tabs; the blocking notice covers the rest.
          try {
            window.close();
          } catch {
            /* ignore */
          }
        }
      }
    };

    // A page restored from the back/forward cache never re-ran its effects and may
    // have missed a takeover while frozen — re-check on restore.
    const onShow = (e: PageTransitionEvent) => {
      if (e.persisted) handshake();
    };
    window.addEventListener("pageshow", onShow);

    handshake();
    return () => {
      window.removeEventListener("pageshow", onShow);
      if (timerRef.current) clearTimeout(timerRef.current);
      ch.onmessage = null;
      ch.close();
      chRef.current = null;
    };
  }, [handshake, post, set]);

  // Continue here (or "Use Collab in this tab" on a parked tab): claim the slot and
  // tell every other tab to step aside.
  const continueHere = useCallback(() => {
    post({ t: "takeover", id: idRef.current });
    set("active");
  }, [post, set]);

  // Cancel: leave the existing tab alone and stop this one.
  const cancel = useCallback(() => {
    set("stopped");
    try {
      window.close();
    } catch {
      /* ignore */
    }
  }, [set]);

  return { state, continueHere, cancel };
}
