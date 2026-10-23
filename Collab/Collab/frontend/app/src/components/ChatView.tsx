/**
 * ChatView — Teams-fidelity message interaction refactor
 *
 * Architecture:
 * - MessageHoverToolbar is the ONLY message interaction surface
 * - ReactionBar, Reply button, FloatingMenu triggers are REMOVED
 * - All floating UI renders via React.createPortal directly under document.body
 * - Full viewport collision detection + automatic flipping on all axes
 * - Mobile: long-press triggers bottom action sheet (no hover)
 * - Reaction pills appear inline under bubble (Teams-style compact pills)
 * - Tap a message to open its action toolbar; tap again or click away to close
 */


import React from "react";
import ChatViewShell from "./chat/ChatViewShell";
import { useChatView0 } from "./chat/useChatView0";
import { useChatView1 } from "./chat/useChatView1";
import { useChatView2 } from "./chat/useChatView2";

export { useEscapeKey, fmtTime, renderBody } from "./chat/helpers";

// ChatView has been split: the ~7.8k-line component body now lives in the
// useChatView0..2 session hooks (chat/useChatView*) and the render tree in
// chat/ChatViewShell.tsx (+ ChatColumn/ChatMainPane/ChatDetails sub-shells).
// This file only assembles the hook chain and hands the accumulated
// session object to the shell.
function ChatViewImpl(props: any) {
  const s0 = useChatView0(props);
  const s1 = useChatView1(s0);
  const s01 = { ...s0, ...s1 };
  const s2 = useChatView2(s01);
  const s = { ...s01, ...s2 };
  return <ChatViewShell s={s} />;
}

export default React.memo(ChatViewImpl);
