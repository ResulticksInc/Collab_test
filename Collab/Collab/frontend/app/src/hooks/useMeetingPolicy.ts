import { useEffect, useState } from "react";
import { api } from "../lib/api";
import { EVENTS } from "../lib/socket";

// Per-meeting options (0116), as the in-meeting UI needs them.
//
// Extracted from MeetingStage (Phase 0 decomposition). It owns three things
// that belong together and nothing else: fetching the policy on entry,
// following MEETING_OPTIONS while the meeting runs, and turning the raw options
// into the five booleans the controls actually ask about.
//
// The server enforces all of it — the LiveKit grant refuses a disallowed
// publish and the socket handlers drop disallowed chat/reactions — so this hook
// exists only so the UI never offers a control that is going to fail.

export interface MeetingCapabilities {
  /** Raw options as the server sent them, or null while loading / on error. */
  options: any | null;
  allowMic: boolean;
  allowCam: boolean;
  /** May this person present? Meeting-wide switch AND the host's per-person one. */
  allowScreen: boolean;
  allowChat: boolean;
  allowReact: boolean;
  /** Admin portal OR the host's Settings modal. Applies to EVERYONE, hosts included. */
  allowWhiteboard: boolean;
  /** Why the board is off: the admin portal, the host's meeting-wide switch, or a block on this user. */
  whiteboardOffBy: "admin" | "host" | "you" | null;
}

export function useMeetingPolicy({
  token,
  meetingId,
  socket,
  isPrivileged,
}: {
  token?: string | null;
  meetingId?: string | null;
  socket?: any;
  /** Host or co-host — never restricted by a policy they can change. */
  isPrivileged: boolean;
}): MeetingCapabilities {
  const [options, setOptions] = useState<any>(null);
  // Admin blocked THIS user from the whiteboard (per-user). Kept apart from
  // `options`: MEETING_OPTIONS replaces the whole object and carries the
  // meeting-wide policy only, so a personal flag stored in it would be wiped.
  const [wbBlocked, setWbBlocked] = useState(false);
  // The HOST restricted THIS user's camera / screen share (per person). Same
  // reasoning as wbBlocked for living outside `options`.
  const [camBlocked, setCamBlocked] = useState(false);
  const [screenBlocked, setScreenBlocked] = useState(false);

  // Fetch once on entry. Failures stay SILENT and leave options null, which
  // reads as permissive below: a policy request that 500s must not lock someone
  // out of their own meeting — the server is still the real gate.
  useEffect(() => {
    if (!meetingId || !token) return;
    let alive = true;
    api
      .getMeetingOptions(token, meetingId)
      .then((o: any) => {
        if (!alive) return;
        setOptions(o);
        setWbBlocked(!!(o && o.whiteboardBlocked));
        setCamBlocked(!!(o && o.cameraBlocked));
        setScreenBlocked(!!(o && o.screenShareBlocked));
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [meetingId, token]);

  // Follow live changes. The server re-permissions the LiveKit session at the
  // same moment, so the button state and what the SFU will accept move together.
  useEffect(() => {
    if (!socket || !meetingId) return;
    const onOptions = (d: any) => {
      if (d && d.meetingId === meetingId) setOptions(d);
    };
    const onWbAccess = (d: any) => {
      if (d && d.meetingId === meetingId) setWbBlocked(!!d.blocked);
    };
    // The host's Settings modal: one event carries all three personal flags.
    const onPerms = (d: any) => {
      if (!d || d.meetingId !== meetingId) return;
      setCamBlocked(!!d.cameraBlocked);
      setScreenBlocked(!!d.screenShareBlocked);
      setWbBlocked(!!d.whiteboardBlocked);
    };
    socket.on(EVENTS.MEETING_OPTIONS, onOptions);
    socket.on(EVENTS.MEETING_WHITEBOARD_ACCESS, onWbAccess);
    socket.on(EVENTS.MEETING_PARTICIPANT_PERMISSIONS, onPerms);
    return () => {
      socket.off(EVENTS.MEETING_OPTIONS, onOptions);
      socket.off(EVENTS.MEETING_WHITEBOARD_ACCESS, onWbAccess);
      socket.off(EVENTS.MEETING_PARTICIPANT_PERMISSIONS, onPerms);
    };
  }, [socket, meetingId]);

  // Who switched the board off — drives the toast when it closes mid-draw.
  const whiteboardOffBy: MeetingCapabilities["whiteboardOffBy"] =
    options && options.allowWhiteboard === false
      ? "admin"
      : wbBlocked
        ? "you"
        : options && options.hostAllowWhiteboard === false
          ? "host"
          : null;
  return {
    options,
    allowMic: isPrivileged || !options || options.allowMic !== false,
    allowCam: isPrivileged || (!camBlocked && (!options || options.allowCamera !== false)),
    allowScreen:
      isPrivileged || (!screenBlocked && (!options || options.allowScreenShare !== false)),
    allowChat: isPrivileged || !options || options.allowChat !== false,
    allowReact: isPrivileged || !options || options.allowReactions !== false,
    // Neither whiteboard switch exempts the host. The administrator's exists
    // precisely for a meeting whose host is the one misusing the board; the
    // host's own switch closes the board for the WHOLE meeting, host included —
    // there is no lockout risk, because the Settings modal that flips it back
    // is always reachable. (Camera and screen share above DO exempt the host.)
    allowWhiteboard: whiteboardOffBy === null,
    whiteboardOffBy,
  };
}
