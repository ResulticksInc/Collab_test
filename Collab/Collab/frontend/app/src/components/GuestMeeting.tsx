"use client";
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import dynamic from "next/dynamic";
import { api } from "../lib/api";
import { connectSocket } from "../lib/socket";
import { validateGuestName, GUEST_NAME_MAX } from "../lib/guestName";
import { getGuestDeviceId } from "../lib/guestDevice";
import { Button, Spinner } from "./ui";
import DialogHost from "./DialogHost";
import GlobalTooltip from "./GlobalTooltip";
import { IconAlertTriangle, IconCheck, IconVideoOff } from "../lib/icons";
import config from "../lib/config";

const PreJoinMeeting = dynamic(() => import("./PreJoinMeeting"), { ssr: false });
const MeetingRoom = dynamic(() => import("./MeetingRoom"), { ssr: false });

// PUBLIC MEETING LINK — the guest side (/join/<token>).
//
// Anyone holding the link can join the meeting without a Collab account:
//   1. the lobby shows what the meeting is and asks for a name,
//   2. Join stays disabled until the name is valid (same rules as the server),
//   3. Join mints a short-lived GUEST session (server-side it is bound to the
//      meeting's organisation — nothing here chooses the tenant) and then enters
//      the room through the SAME endpoints a member uses, so the meeting's own
//      lobby / lock / eject rules apply unchanged,
//   4. leaving ends the guest session.
// The guest bearer lives only in memory (and sessionStorage for refresh); it is
// never written to the keys the signed-in app uses, so opening a link in a
// browser that is also signed in to Collab cannot touch that account.
//
// ONE IDENTITY PER BROWSER PROFILE: the lobby sends a persistent device id
// (lib/guestDevice.ts) with the lookup and the join. Once this browser has joined
// a meeting, the server reuses that guest for every later join from it — the name
// field shows the original name read-only, and a join under a different name
// still comes back as the same participant — so refreshes, reconnects and
// "rejoin with another name" never create a second entry in the roster or logs.

type Phase = "loading" | "invalid" | "error" | "ended" | "lobby" | "room" | "left" | "blocked";
type Info = {
  meetingId: string;
  title: string;
  hostName: string | null;
  organizationName: string | null;
  ended: boolean;
  lobby: boolean;
  /** Set when this browser profile already joined: the identity it will rejoin as. */
  identity: { name: string; joinCount: number } | null;
};
type Saved = { token: string; user: any; meetingId: string; rawName: string };

const SAVE_KEY = (linkToken: string) => "clb_guest_" + linkToken;

function loadSaved(linkToken: string): Saved | null {
  try {
    const raw = sessionStorage.getItem(SAVE_KEY(linkToken));
    if (!raw) return null;
    const s = JSON.parse(raw);
    return s && s.token && s.user && s.user.id && s.meetingId ? s : null;
  } catch {
    return null;
  }
}
function saveSession(linkToken: string, s: Saved | null) {
  try {
    if (s) sessionStorage.setItem(SAVE_KEY(linkToken), JSON.stringify(s));
    else sessionStorage.removeItem(SAVE_KEY(linkToken));
  } catch {
    /* private mode — the session just won't survive a refresh */
  }
}

export default function GuestMeeting({ linkToken }: { linkToken: string }) {
  const [phase, setPhase] = useState<Phase>("loading");
  const [info, setInfo] = useState<Info | null>(null);
  const [blockedMsg, setBlockedMsg] = useState("");
  const [name, setName] = useState("");
  // The server already knows this browser as a guest of this meeting: the name is
  // fixed to that identity (see Info.identity / the join response's `resumed`).
  const [lockedName, setLockedName] = useState<string | null>(null);
  const [touched, setTouched] = useState(false);
  const [joining, setJoining] = useState(false);
  const [joinError, setJoinError] = useState<string | null>(null);
  const [room, setRoom] = useState<any>(null);
  const [me, setMe] = useState<any>(null);
  const [toast, setToast] = useState<string | null>(null);
  const [settings, setSettings] = useState<Record<string, any>>({});
  const [prefs, setPrefs] = useState<{ mic: boolean; cam: boolean }>({ mic: true, cam: false });

  const tokenRef = useRef<string | null>(null);
  const socketRef = useRef<any>(null);
  const toastTimer = useRef<any>(null);
  const [socket, setSocket] = useState<any>(null);

  const showToast = useCallback((msg: string) => {
    setToast(msg);
    if (toastTimer.current) clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToast(null), 4000);
  }, []);

  // ── Look the link up ───────────────────────────────────────────────────────
  const lookup = useCallback(async () => {
    setPhase("loading");
    try {
      const i: Info = await api.getPublicMeeting(linkToken, getGuestDeviceId());
      setInfo(i);
      if (i.identity && i.identity.name) {
        // This browser has joined before → rejoin as the same guest, same name.
        setLockedName(i.identity.name);
        setName(i.identity.name);
      } else {
        const saved = loadSaved(linkToken);
        if (saved && !name) setName(saved.rawName || "");
      }
      setPhase(i.ended ? "ended" : "lobby");
    } catch (e: any) {
      // 404 = unknown / revoked link. Anything else (network, 5xx) is retryable.
      setPhase(e && e.status === 404 ? "invalid" : "error");
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [linkToken]);

  useEffect(() => {
    void lookup();
  }, [lookup]);

  // Don't leak the link (a credential) to anything we load, and keep it out of
  // search results. The route also sets noindex via its layout.
  useEffect(() => {
    document.title = info?.title ? `${info.title} — Join meeting` : "Join meeting";
  }, [info]);

  useEffect(
    () => () => {
      if (toastTimer.current) clearTimeout(toastTimer.current);
      try {
        socketRef.current && socketRef.current.disconnect();
      } catch {
        /* ignore */
      }
    },
    [],
  );

  const check = useMemo(() => validateGuestName(name), [name]);
  const nameError = touched && !check.ok ? check.error || null : null;

  // ── Join ───────────────────────────────────────────────────────────────────
  // A refresh reuses the saved guest session (same tab) when the same name is
  // being used. Otherwise a session is minted with the browser's device id: the
  // server hands back the identity this browser ALREADY holds for the meeting
  // (`resumed`, original name) rather than a second participant.
  const obtainSession = useCallback(
    async (
      cleanName: string,
    ): Promise<{ token: string; user: any; meetingId: string; resumed?: boolean; name?: string }> => {
      const saved = loadSaved(linkToken);
      if (saved && saved.rawName === cleanName) return saved;
      const s = await api.joinPublicMeeting(linkToken, cleanName, getGuestDeviceId());
      const rawName = (s && s.name) || cleanName;
      saveSession(linkToken, { token: s.token, user: s.user, meetingId: s.meetingId, rawName });
      if (s && s.resumed && rawName) {
        setLockedName(rawName);
        setName(rawName);
      }
      return s;
    },
    [linkToken],
  );

  const endGuestSession = useCallback(async () => {
    const t = tokenRef.current;
    tokenRef.current = null;
    saveSession(linkToken, null);
    try {
      socketRef.current && socketRef.current.disconnect();
    } catch {
      /* ignore */
    }
    socketRef.current = null;
    setSocket(null);
    // Revokes the guest session server-side. Best-effort: it expires on its own.
    if (t) await api.logout(t);
  }, [linkToken]);

  const enter = useCallback(
    async (s: { token: string; user: any; meetingId: string }) => {
      const r: any = await api.enterMeetingRoom(s.token, s.meetingId);
      return r;
    },
    [],
  );

  const onJoin = useCallback(
    async (p: { mic: boolean; cam: boolean; micId?: string; camId?: string; spkId?: string }) => {
      setTouched(true);
      const v = validateGuestName(name);
      if (!v.ok || !info || joining) return;
      setJoining(true);
      setJoinError(null);
      setPrefs({ mic: p.mic, cam: p.cam });
      setSettings((cur) => ({
        ...cur,
        ...(p.micId ? { micId: p.micId } : {}),
        ...(p.camId ? { cameraId: p.camId } : {}),
        ...(p.spkId ? { speakerId: p.spkId } : {}),
      }));
      try {
        let sess = await obtainSession(v.name as string);
        let r: any;
        try {
          r = await enter(sess);
        } catch (e: any) {
          // A saved session the server no longer honours (expired / revoked):
          // drop it and mint a fresh one once.
          if (e && (e.status === 401 || e.status === 403) && loadSaved(linkToken)) {
            saveSession(linkToken, null);
            sess = await obtainSession(v.name as string);
            r = await enter(sess);
          } else {
            throw e;
          }
        }
        if (r && r.closed) {
          setBlockedMsg("This meeting has ended.");
          setPhase("ended");
          await endGuestSession();
          return;
        }
        if (r && r.ejected) {
          setBlockedMsg("You were removed from this meeting by the host.");
          setPhase("blocked");
          await endGuestSession();
          return;
        }
        if (r && r.locked && !r.meeting) {
          setBlockedMsg("This meeting is locked — the host isn't admitting new participants.");
          setPhase("blocked");
          await endGuestSession();
          return;
        }
        if (!r || (!r.meeting && r.lobbyStatus !== "waiting")) {
          setJoinError("Couldn't open the meeting room. Please try again.");
          return;
        }
        tokenRef.current = sess.token;
        const sock = connectSocket(sess.token);
        socketRef.current = sock;
        setSocket(sock);
        setMe(sess.user);
        setRoom(r);
        setPhase("room");
        if (sess.resumed && sess.name && sess.name !== (v.name as string))
          showToast(`You rejoined as ${sess.name} — this browser already joined this meeting under that name.`);
      } catch (e: any) {
        setJoinError(
          e && e.status === 429
            ? "Too many attempts. Please wait a moment and try again."
            : e && e.status === 404
              ? "This meeting link isn't valid or was turned off."
              : (e && e.message) || "Couldn't join the meeting. Please try again.",
        );
        if (e && e.status === 404) setPhase("invalid");
        // 410: the meeting was cancelled / ended while the lobby was open.
        if (e && e.status === 410) {
          setBlockedMsg("This meeting has ended.");
          setPhase("ended");
        }
      } finally {
        setJoining(false);
      }
    },
    [name, info, joining, obtainSession, enter, endGuestSession, linkToken, showToast],
  );

  const onLeave = useCallback(async () => {
    const t = tokenRef.current;
    const mid = room?.meeting?.id || room?.meetingId || info?.meetingId;
    if (t && mid) {
      try {
        await api.leaveMeetingRoom(t, mid);
      } catch {
        /* best-effort */
      }
    }
    await endGuestSession();
    setRoom(null);
    setPhase("left");
  }, [room, info, endGuestSession]);

  const onChangeSetting = useCallback((k: string, v: any) => {
    setSettings((cur) => ({ ...cur, [k]: v }));
  }, []);

  // ── Screens ────────────────────────────────────────────────────────────────
  const shell = (children: ReactNode) => (
    <main className="gj-page">
      <div className="gj-card">
        <div className="gj-brand">{config.appName}</div>
        {children}
      </div>
    </main>
  );

  if (phase === "loading")
    return shell(
      <div className="gj-center" role="status" aria-live="polite">
        <Spinner size="lg" tone="accent" />
        <p className="gj-muted">Opening meeting…</p>
      </div>,
    );

  if (phase === "invalid")
    return shell(
      <div className="gj-center">
        <span className="gj-icon warn" aria-hidden="true"><IconAlertTriangle size={26} /></span>
        <h1 className="gj-h">This meeting link isn't valid</h1>
        <p className="gj-muted">
          It may have been turned off by the host, or copied incorrectly. Ask the host to send
          you a new link.
        </p>
      </div>,
    );

  if (phase === "error")
    return shell(
      <div className="gj-center">
        <span className="gj-icon warn" aria-hidden="true"><IconAlertTriangle size={26} /></span>
        <h1 className="gj-h">Couldn't reach the meeting</h1>
        <p className="gj-muted">Check your connection and try again.</p>
        <Button variant="primary" onClick={() => void lookup()}>Try again</Button>
      </div>,
    );

  if (phase === "ended")
    return shell(
      <div className="gj-center">
        <span className="gj-icon" aria-hidden="true"><IconVideoOff size={26} /></span>
        <h1 className="gj-h">{blockedMsg || "This meeting has ended"}</h1>
        {info?.title ? <p className="gj-muted">{info.title}</p> : null}
      </div>,
    );

  if (phase === "blocked")
    return shell(
      <div className="gj-center">
        <span className="gj-icon warn" aria-hidden="true"><IconAlertTriangle size={26} /></span>
        <h1 className="gj-h">{blockedMsg || "You can't join this meeting"}</h1>
        {info?.title ? <p className="gj-muted">{info.title}</p> : null}
      </div>,
    );

  if (phase === "left")
    return shell(
      <div className="gj-center">
        <span className="gj-icon ok" aria-hidden="true"><IconCheck size={26} /></span>
        <h1 className="gj-h">You left the meeting</h1>
        {info?.title ? <p className="gj-muted">{info.title}</p> : null}
        <Button
          variant="primary"
          onClick={() => {
            setPhase("lobby");
            setJoinError(null);
          }}
        >
          Rejoin
        </Button>
      </div>,
    );

  if (phase === "room" && room && me)
    return (
      <>
        <MeetingRoom
          room={room}
          me={me}
          token={tokenRef.current}
          socket={socket}
          offline={false}
          onLeave={onLeave}
          onToast={showToast}
          settings={settings}
          onChangeSetting={onChangeSetting}
          users={[]}
          conversations={[]}
          initialMic={prefs.mic}
          initialCam={prefs.cam}
          pip={false}
          isGuest
        />
        {toast ? (
          <div className="cv-toast-stack">
            <div role="status" className="cv-toast">
              <span>{toast}</span>
            </div>
          </div>
        ) : null}
        <DialogHost />
        <GlobalTooltip />
      </>
    );

  // phase === "lobby": the name prompt (green room).
  const context = [
    info?.hostName ? `Hosted by ${info.hostName}` : null,
    info?.organizationName,
  ]
    .filter(Boolean)
    .join(" · ");
  return (
    <>
      <PreJoinMeeting
        title={info?.title}
        guestName={{
          value: name,
          onChange: (v) => {
            if (lockedName) return;
            setName(v);
            setTouched(true);
            setJoinError(null);
          },
          error: nameError || joinError,
          locked: !!lockedName,
          context: lockedName
            ? `This browser already joined this meeting as ${lockedName}. You'll rejoin with the same name.${
                info?.lobby ? " The host may need to let you in." : ""
              }`
            : context
              ? `${context}${info?.lobby ? " · The host may need to let you in." : ""}`
              : info?.lobby
                ? "The host may need to let you in."
                : null,
          maxLength: GUEST_NAME_MAX + 12, // typing room; the validator enforces the real limit
        }}
        joinDisabled={!check.ok}
        joining={joining}
        onJoin={onJoin}
      />
      <DialogHost />
    </>
  );
}
