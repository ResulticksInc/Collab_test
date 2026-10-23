import { useEffect, useRef, useState } from "react";
import { copyText } from "../lib/clipboard";
import { confirmDialog } from "../lib/dialog";
import { IconGlobe } from "../lib/icons";

// Host / co-host control for a meeting's PUBLIC (guest) link.
//
// The link lets anyone — including people with no Collab account — open
// /join/<token>, enter a name and join. It is created on demand (one click) and
// can be turned off at any time, which kills the URL immediately. The secret
// token is fetched from the host-gated endpoint only when needed; meeting payloads
// carry just the `publicLinkEnabled` boolean.

const joinUrl = (path: string) => {
  const origin = (typeof window !== "undefined" && window.location && window.location.origin) || "";
  return origin + path;
};

/** The three host-gated calls, injected (like every other data call in CalendarView). */
export type PublicLinkActions = {
  get: (meetingId: string) => Promise<{ enabled: boolean; path: string | null }>;
  create: (meetingId: string) => Promise<{ enabled: boolean; path: string | null }>;
  revoke: (meetingId: string) => Promise<unknown>;
};

export default function PublicLinkControl({
  actions,
  meetingId,
  enabled,
  onToast,
  onChanged,
  className,
}: {
  actions: PublicLinkActions;
  /** Series/meeting id — an occurrence id ("<id>__occ_N") is accepted too. */
  meetingId: string;
  /** From the meeting payload (`publicLinkEnabled`). */
  enabled: boolean;
  onToast: (msg: string) => void;
  /** Called after the link is created / turned off so the list can refetch. */
  onChanged?: () => void;
  className?: string;
}) {
  // The parent builds `actions` inline each render; read the latest through a ref
  // so a re-render never re-triggers the link fetch below.
  const act = useRef(actions);
  act.current = actions;
  const [on, setOn] = useState(!!enabled);
  const [url, setUrl] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // Follow the meeting payload (another host / a refetch can change it).
  useEffect(() => {
    setOn(!!enabled);
    if (!enabled) setUrl(null);
  }, [enabled, meetingId]);

  // When a link exists, load it so the host can see and copy exactly what guests get.
  useEffect(() => {
    if (!on || url) return;
    let live = true;
    act.current
      .get(meetingId)
      .then((r: any) => {
        if (live && r && r.path) setUrl(joinUrl(r.path));
      })
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [on, url, meetingId]);

  const copy = async (u: string) => {
    const ok = await copyText(u);
    onToast(ok ? "Public link copied" : u);
  };

  const create = async () => {
    if (busy) return;
    setBusy(true);
    try {
      const r: any = await act.current.create(meetingId);
      const u = joinUrl(r.path);
      setOn(true);
      setUrl(u);
      onChanged && onChanged();
      await copy(u);
    } catch (e: any) {
      onToast((e && e.message) || "Couldn't create the public link");
    } finally {
      setBusy(false);
    }
  };

  const turnOff = async () => {
    if (busy) return;
    const yes = await confirmDialog(
      "Turn off the public link? Anyone using the old link will no longer be able to join. People already in the meeting stay until they leave.",
      { confirmText: "Turn off", danger: true },
    );
    if (!yes) return;
    setBusy(true);
    try {
      await act.current.revoke(meetingId);
      setOn(false);
      setUrl(null);
      onChanged && onChanged();
      onToast("Public link turned off");
    } catch (e: any) {
      onToast((e && e.message) || "Couldn't turn off the public link");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className={"pl-ctl" + (className ? " " + className : "")}>
      {on ? (
        <>
          <div className="pl-row">
            <span className="pl-ico" aria-hidden="true">
              <IconGlobe size={14} />
            </span>
            <span className="pl-url" title={url || undefined}>
              {url ? url.replace(/^https?:\/\//, "") : "Loading link…"}
            </span>
          </div>
          <div className="pl-actions">
            <button
              type="button"
              className="btn-c pl-btn"
              disabled={!url || busy}
              onClick={() => url && void copy(url)}
            >
              Copy public link
            </button>
            <button type="button" className="btn-c pl-btn pl-off" disabled={busy} onClick={() => void turnOff()}>
              Turn off
            </button>
          </div>
          <div className="pl-hint">Anyone with this link can join as a guest — no account needed.</div>
        </>
      ) : (
        <>
          <button type="button" className="btn-c pl-btn" disabled={busy} onClick={() => void create()}>
            <IconGlobe size={14} /> {busy ? "Creating…" : "Create public link"}
          </button>
          <div className="pl-hint">Lets people without a Collab account join by entering their name.</div>
        </>
      )}
    </div>
  );
}
