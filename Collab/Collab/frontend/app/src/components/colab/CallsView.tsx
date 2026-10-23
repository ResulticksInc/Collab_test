"use client";

import React, { useState, useEffect, useCallback, useRef } from "react";
import Avatar from "../Avatar";
import { api } from "../../lib/api";
import { sidebarTime } from "../../lib/time";
import {
  IconPhone,
  IconVideo,
  IconCalendarDays,
  IconInfo,
  IconX,
  IconPlay,
  IconPause,
  IconChevronRight,
  IconPhoneMissed,
  IconLock,
  IconClock,
} from "../../lib/icons";

export interface CallsViewProps {
  calls: any[];
  users: any[];
  onStartCall: (peer: any, video: boolean) => void;
  showToast: (msg: string) => void;
  meId?: string | null;
  onNewCall?: (type: "audio" | "video") => void;
  meetings?: any[];
  onJoinMeeting?: (id: string) => void;
  onMode?: (mode: string) => void;
  /** Opens the calendar with the scheduler already open. Falls back to plain navigation. */
  onSchedule?: () => void;
  onLoadOlder?: (oldestIso: string | null) => Promise<any[]>;
  token: string;
  externalSearch?: string;
  scope?: "all" | "missed" | "dialled";
  onScope?: (scope: "all" | "missed" | "dialled") => void;
}

export default function CallsView({
  calls,
  users,
  onStartCall,
  showToast,
  meId,
  onNewCall,
  meetings,
  onJoinMeeting,
  onMode,
  onSchedule,
  onLoadOlder,
  token,
  externalSearch,
  scope = "all",
  onScope,
}: CallsViewProps) {
  const dirIcon = (dir: string) =>
    dir === "in" ? (
      <>
        <line x1="17" y1="7" x2="7" y2="17" />
        <polyline points="17 17 7 17 7 7" />
      </>
    ) : dir === "out" ? (
      <>
        <polyline points="7 7 17 7 17 17" />
        <line x1="7" y1="17" x2="17" y2="7" />
      </>
    ) : (
      <>
        <line x1="23" y1="1" x2="1" y2="23" />
        <path d="M16.72 11.06A10.94 10.94 0 0119 12.55" />
      </>
    );

  const active = (calls || []).filter(
    (c) => c.status === "ringing" || c.status === "connected",
  );

  const [extra, setExtra] = useState<any[]>([]);
  const [selectedCall, setSelectedCall] = useState<any>(null);
  const [exhausted, setExhausted] = useState(false);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [q, setQ] = useState("");

  useEffect(() => {
    setQ(externalSearch || "");
  }, [externalSearch]);

  const _ql = q.trim().toLowerCase();
  const seenIds = new Set<string>();

  const allLoaded = [...(calls || []), ...extra]
    .filter((c) => {
      if (seenIds.has(c.id)) return false;
      seenIds.add(c.id);
      return true;
    })
    .sort((a, b) => Date.parse(b.startedAt) - Date.parse(a.startedAt));

  const combined = _ql
    ? allLoaded.filter((c: any) =>
        ((c.peer && c.peer.name) || "").toLowerCase().includes(_ql),
      )
    : allLoaded;

  const outcome = (c: any) => {
    switch (c.status) {
      case "connected":
      case "ended":
        return "Call ended";
      case "missed":
        return c.direction === "out" ? "No answer" : "Missed";
      case "declined":
        return "Declined";
      case "cancelled":
        return c.direction === "out" ? "Cancelled" : "Missed";
      case "busy":
        return "Busy";
      default:
        return c.direction === "in" ? "Incoming" : "Outgoing";
    }
  };

  const neg = (c: any) =>
    ["missed", "declined", "busy", "cancelled"].includes(c.status);

  const scoped =
    scope === "missed"
      ? combined.filter((c: any) => outcome(c) === "Missed")
      : scope === "dialled"
        ? combined.filter((c: any) => c.direction === "out")
        : combined;

  const callRoleLabel = (role: string) => {
    if (!role) return "Other";
    const cap = role.charAt(0).toUpperCase() + role.slice(1);
    return /s$/i.test(cap) ? cap : cap + "s";
  };

  const loadOlder = async () => {
    if (!onLoadOlder || loadingOlder || exhausted) return;
    setLoadingOlder(true);
    const oldest = allLoaded.length
      ? allLoaded[allLoaded.length - 1].startedAt
      : null;
    const older = await onLoadOlder(oldest);
    setLoadingOlder(false);
    const fresh = (older || []).filter((c: any) => !seenIds.has(c.id));
    if (fresh.length) setExtra((p) => [...p, ...fresh]);
    if (!older || older.length < 50) setExhausted(true);
  };

  const fullWhen = (iso: string) => {
    const d = new Date(iso);
    return Number.isFinite(d.getTime())
      ? d.toLocaleString([], {
          weekday: "short",
          month: "short",
          day: "numeric",
          hour: "numeric",
          minute: "2-digit",
        })
      : "";
  };

  const [voicemails, setVoicemails] = useState<any[]>([]);
  const [playingVm, setPlayingVm] = useState<string | null>(null);
  const vmAudioRef = useRef<HTMLAudioElement | null>(null);

  const refreshVoicemails = useCallback(async () => {
    return;
  }, []);

  useEffect(() => {
    refreshVoicemails();
  }, [refreshVoicemails]);

  const playVm = async (vm: any) => {
    try {
      if (playingVm === vm.id) {
        vmAudioRef.current && vmAudioRef.current.pause();
        setPlayingVm(null);
        return;
      }
      const blob = await api.getVoicemailAudio(token, vm.id);
      const url = URL.createObjectURL(blob);
      if (vmAudioRef.current) {
        vmAudioRef.current.src = url;
        await vmAudioRef.current.play();
      }
      setPlayingVm(vm.id);
      if (!vm.listened) {
        await api.markVoicemailListened(token, vm.id).catch(() => {});
        refreshVoicemails();
      }
    } catch {
      showToast("Couldn't play voicemail");
    }
  };

  const deleteVm = async (vm: any) => {
    await api.deleteVoicemail(token, vm.id).catch(() => {});
    if (playingVm === vm.id) {
      try {
        vmAudioRef.current && vmAudioRef.current.pause();
      } catch {
        /* ignore */
      }
      setPlayingVm(null);
    }
    refreshVoicemails();
    showToast("Voicemail deleted");
  };

  /* ── derived stats for the summary cards ── */
  const sameDay = (iso: string, d: Date) => {
    const x = new Date(iso);
    return Number.isFinite(x.getTime()) && x.toDateString() === d.toDateString();
  };
  const _today = new Date();
  const _yest = new Date();
  _yest.setDate(_today.getDate() - 1);
  const todayCount = allLoaded.filter((c: any) => sameDay(c.startedAt, _today)).length;
  const yestCount = allLoaded.filter((c: any) => sameDay(c.startedAt, _yest)).length;
  const missedCount = allLoaded.filter((c: any) => outcome(c) === "Missed").length;
  const talked = allLoaded.filter((c: any) => c.durationSec > 0);
  const avgSec = talked.length
    ? Math.round(talked.reduce((s: number, c: any) => s + c.durationSec, 0) / talked.length)
    : 0;
  const mmss = (n: number) => `${Math.floor(n / 60)}:${String(n % 60).padStart(2, "0")}`;
  const delta = todayCount - yestCount;
  const clock = (iso: string) => {
    const d = new Date(iso);
    return Number.isFinite(d.getTime())
      ? d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })
      : "";
  };
  const shortDate = (iso: string) => {
    const d = new Date(iso);
    if (!Number.isFinite(d.getTime())) return "";
    if (sameDay(iso, _today)) return "Today";
    if (sameDay(iso, _yest)) return "Yesterday";
    return d.toLocaleDateString([], { weekday: "short", day: "numeric", month: "short" });
  };
  const peerCalls = selectedCall
    ? allLoaded.filter((c: any) => c.peer && selectedCall.peer && c.peer.id === selectedCall.peer.id)
    : [];
  const activityBars = (() => {
    const days: number[] = [];
    for (let i = 6; i >= 0; i--) {
      const d = new Date();
      d.setDate(d.getDate() - i);
      days.push(peerCalls.filter((c: any) => sameDay(c.startedAt, d)).length);
    }
    return days;
  })();
  const peerAv = (p: any, size: number) => (
    <Avatar
      avatar={{ kind: "user", initials: p.initials, color: p.color, avatarUrl: p.avatarUrl }}
      size={size}
    />
  );

  return (
    <div className="view active" id="vcalls">
      <div className="cx">
        {/* ── toolbar: scope tabs + call actions ── */}
        <div className="cx-bar">
          <div className="cx-bar-l">
            <h2 className="cx-h">
              {scope === "missed" ? "Missed calls" : scope === "dialled" ? "Dialled calls" : "All calls"}
            </h2>
            {onScope ? (
              <div className="cx-seg" role="tablist" aria-label="Call filter">
                {(["all", "missed", "dialled"] as const).map((k) => (
                  <button
                    key={k}
                    type="button"
                    role="tab"
                    aria-selected={scope === k}
                    className={"cx-seg-b" + (scope === k ? " on" : "")}
                    onClick={() => onScope(k)}
                    title={k === "dialled" ? "Calls you placed" : undefined}
                  >
                    {k === "missed" ? <i className="cx-red-dot" /> : null}
                    {k === "all" ? "All" : k === "missed" ? "Missed" : "Dialled"}
                  </button>
                ))}
              </div>
            ) : null}
          </div>
          <div className="cx-bar-r">
            <button className="cx-btn" aria-label="Start an audio call" onClick={() => onNewCall && onNewCall("audio")}>
              <IconPhone size={16} /> Audio call
            </button>
            <button className="cx-btn" aria-label="Start a video call" onClick={() => onNewCall && onNewCall("video")}>
              <IconVideo size={16} /> Video call
            </button>
            <button className="cx-btn cx-btn-p" aria-label="Schedule a call" onClick={() => (onSchedule ? onSchedule() : onMode && onMode("calendar"))}>
              <IconCalendarDays size={16} /> Schedule
            </button>
          </div>
        </div>

        {/* ── summary cards ── */}
        <div className="cx-stats">
          <div className="cx-stat">
            <div>
              <div className="cx-stat-k">Total today</div>
              <div className="cx-stat-v">
                <b>{todayCount}</b>
                <span className={"cx-chip " + (delta >= 0 ? "ok" : "bad")}>
                  {delta >= 0 ? "+" : "−"}
                  {Math.abs(delta)} vs yesterday
                </span>
              </div>
            </div>
            <span className="cx-stat-i"><IconPhone size={18} /></span>
          </div>
          <div className="cx-stat">
            <div>
              <div className="cx-stat-k">Missed</div>
              <div className="cx-stat-v">
                <b>{missedCount}</b>
                {missedCount ? <span className="cx-chip bad">Needs callback</span> : <span className="cx-chip ok">All caught up</span>}
              </div>
            </div>
            <span className="cx-stat-i red"><IconPhoneMissed size={18} /></span>
          </div>
          <div className="cx-stat">
            <div>
              <div className="cx-stat-k">Avg duration</div>
              <div className="cx-stat-v">
                <b className="mono">{mmss(avgSec)}</b>
                <span className="cx-stat-u">min</span>
              </div>
            </div>
            <span className="cx-stat-i amber"><IconClock size={18} /></span>
          </div>
        </div>

        <div className="cx-body">
          <div className="cx-card cx-list">
            <div className="cx-scroll" id="call-log-list">
              {active.length ? (
                <div className="cx-group">
                  <div className="cx-group-h"><span>Active</span><em>{active.length} live</em></div>
                  <div className="cx-rows">
                    {active.map((c) => (
                      <div className="cx-row live" key={c.id}>
                        <div className="cx-av">{peerAv(c.peer, 44)}<i className="cx-dot on" /></div>
                        <div className="cx-info">
                          <div className="cx-name">{c.peer.name}</div>
                          <div className="cx-det live">
                            <span className="cl-live-dot" />
                            {(c.video ? "Video" : "Audio") + " · " + (c.status === "connected" ? "Connected" : "Ringing")}
                          </div>
                        </div>
                        <button
                          className="cx-act on"
                          data-tip="Rejoin"
                          aria-label={"Rejoin call with " + c.peer.name}
                          onClick={() => onStartCall(c.peer, c.video)}
                        >
                          <IconPhone size={15} />
                        </button>
                      </div>
                    ))}
                  </div>
                </div>
              ) : null}

              {voicemails.length ? (
                <div className="cx-group">
                  <div className="cx-group-h"><span>Voicemail</span><em>{voicemails.length}</em></div>
                  <audio ref={vmAudioRef} onEnded={() => setPlayingVm(null)} style={{ display: "none" }} />
                  <div className="cx-rows">
                    {voicemails.map((vm) => (
                      <div className={"cx-row" + (vm.listened ? "" : " unread")} key={vm.id}>
                        <button className="cx-act on" onClick={() => playVm(vm)} aria-label="Play voicemail">
                          {playingVm === vm.id ? <IconPause size={15} /> : <IconPlay size={15} />}
                        </button>
                        <div className="cx-info">
                          <div className="cx-name">{vm.from.name}</div>
                          <div className="cx-det">
                            {vm.createdAt ? sidebarTime(vm.createdAt) : vm.time}
                            {vm.durationSec ? " · " + vm.durationSec + "s" : ""}
                            {vm.listened ? "" : " · New"}
                          </div>
                        </div>
                        <button className="cx-act" data-tip="Call back" aria-label={"Call back " + vm.from.name} onClick={() => onStartCall(vm.from, false)}>
                          <IconPhone size={15} />
                        </button>
                        <button className="cx-act" onClick={() => deleteVm(vm)} aria-label="Delete voicemail">
                          <IconX size={14} />
                        </button>
                      </div>
                    ))}
                  </div>
                </div>
              ) : null}

              {scoped.length ? (
                <>
                  {(() => {
                    let orderedGroups: { key: string; label: string; items: any[] }[];
                    if (scope === "missed") {
                      const rmap = new Map<string, { role: string; rank: number; items: any[] }>();
                      scoped.forEach((c: any) => {
                        const role = (c.peer && c.peer.role) || "";
                        const rank = typeof c.peerRoleRank === "number" ? c.peerRoleRank : 0;
                        const key = role || "_none";
                        let t = rmap.get(key);
                        if (!t) {
                          t = { role, rank, items: [] };
                          rmap.set(key, t);
                        }
                        t.items.push(c);
                      });
                      orderedGroups = [...rmap.values()]
                        .sort((a, b) => b.rank - a.rank || a.role.localeCompare(b.role))
                        .map((t) => ({ key: t.role || "_none", label: callRoleLabel(t.role), items: t.items }));
                    } else {
                      const bucketOf = (c: any) => {
                        const d = new Date(c.startedAt);
                        if (!Number.isFinite(d.getTime())) return "Earlier";
                        if (d.toDateString() === _today.toDateString()) return "Today";
                        if (d.toDateString() === _yest.toDateString()) return "Yesterday";
                        return "Earlier";
                      };
                      const g: Record<string, any[]> = { Today: [], Yesterday: [], Earlier: [] };
                      scoped.forEach((c) => g[bucketOf(c)].push(c));
                      orderedGroups = ["Today", "Yesterday", "Earlier"]
                        .filter((k) => g[k].length)
                        .map((k) => ({ key: k, label: k, items: g[k] }));
                    }
                    return orderedGroups.map((grp) => (
                      <div className="cx-group" key={grp.key}>
                        <div className="cx-group-h">
                          <span>{grp.label}</span>
                          <em>{grp.items.length} call{grp.items.length === 1 ? "" : "s"}</em>
                        </div>
                        <div className="cx-rows">
                          {(() => {
                            const runs: any[] = [];
                            grp.items.forEach((c: any) => {
                              const last = runs[runs.length - 1];
                              if (last && last.peer && c.peer && last.peer.id === c.peer.id && last.statusKey === outcome(c))
                                last.calls.push(c);
                              else runs.push({ peer: c.peer, latest: c, calls: [c], statusKey: outcome(c) });
                            });
                            return runs.map((run: any) => {
                              const c = run.latest;
                              const n = run.calls.length;
                              const miss = neg(c);
                              const sel = selectedCall && selectedCall.id === c.id;
                              const pick = () => setSelectedCall(n > 1 ? { ...c, _runCount: n } : c);
                              return (
                                <div
                                  className={"cx-row" + (miss ? " miss" : "") + (sel ? " sel" : "")}
                                  key={c.id}
                                  role="button"
                                  tabIndex={0}
                                  onClick={pick}
                                  onKeyDown={(e) => {
                                    if (e.key === "Enter" || e.key === " ") {
                                      e.preventDefault();
                                      pick();
                                    }
                                  }}
                                >
                                  {miss ? <span className="cx-row-bar" /> : null}
                                  <div className="cx-av">
                                    {peerAv(c.peer, 44)}
                                    <i className={"cx-dot " + (miss ? "bad" : "on")} />
                                  </div>
                                  <div className="cx-info">
                                    <div className="cx-name">
                                      {c.peer.name}
                                      {n > 1 ? <span className="cl-count">{n}</span> : null}
                                    </div>
                                    <div className={"cx-det" + (miss ? " miss" : "")}>
                                      <svg viewBox="0 0 24 24" style={{ stroke: miss ? "var(--red, #ef4444)" : "var(--grn, #10b981)" }}>
                                        {dirIcon(c.direction)}
                                      </svg>
                                      <span>{(c.video ? "Video" : "Audio") + " · " + outcome(c)}</span>
                                      {c.durationSec ? (
                                        <>
                                          <i className="cx-sep" />
                                          <span className="mono">{c.durLabel}</span>
                                        </>
                                      ) : null}
                                    </div>
                                  </div>
                                  <div className="cx-when">
                                    <span>{c.startedAt ? clock(c.startedAt) : c.time}</span>
                                    <em>{c.startedAt ? shortDate(c.startedAt) : ""}</em>
                                  </div>
                                  <div className="cx-acts" onClick={(e) => e.stopPropagation()}>
                                    <button className="cx-act" data-tip="Audio call" aria-label={"Audio call " + c.peer.name} onClick={() => onStartCall(c.peer, false)}>
                                      <IconPhone size={15} />
                                    </button>
                                    <button className="cx-act on" data-tip="Video call" aria-label={"Video call " + c.peer.name} onClick={() => onStartCall(c.peer, true)}>
                                      <IconVideo size={15} />
                                    </button>
                                  </div>
                                  <span className="cx-chev"><IconChevronRight size={15} /></span>
                                </div>
                              );
                            });
                          })()}
                        </div>
                      </div>
                    ));
                  })()}
                  {onLoadOlder && !exhausted && allLoaded.length >= 50 ? (
                    <button className="cx-load" onClick={loadOlder} disabled={loadingOlder}>
                      {loadingOlder ? "Loading…" : "Load older calls"}
                    </button>
                  ) : null}
                </>
              ) : (
                <div className="cx-empty">
                  <span className="cx-empty-i"><IconPhone size={20} /></span>
                  <b>
                    {scope === "missed" ? "No missed calls" : scope === "dialled" ? "No dialled calls yet" : "No calls yet"}
                  </b>
                  <p>Calls you make and receive will show up here.</p>
                </div>
              )}
            </div>
            <div className="cx-foot">
              <span><IconLock size={12} /> End-to-end encrypted</span>
              <span>{scoped.length} of {allLoaded.length}</span>
            </div>
          </div>

          {/* ── details panel (docked on wide screens, drawer on narrow) ── */}
          <aside className={"cx-card cx-detail" + (selectedCall ? " open" : "")} aria-label="Call details">
            {!selectedCall ? (
              <div className="cx-detail-empty">
                <span className="cx-detail-logo"><IconPhone size={28} /></span>
                <h3>Select a call to view details</h3>
                <p>View history, duration and quick actions for any call in your log.</p>
              </div>
            ) : (
              <>
                <div className="cx-detail-h">
                  <span>Call details</span>
                  <button className="cx-x" onClick={() => setSelectedCall(null)} aria-label="Close details">
                    <IconX size={14} />
                  </button>
                </div>
                <div className="cx-detail-b">
                  <div className="cx-who">
                    <div className="cx-who-av">
                      {peerAv(selectedCall.peer, 72)}
                      <i className={"cx-dot lg " + (neg(selectedCall) ? "bad" : "on")} />
                    </div>
                    <h3>{selectedCall.peer.name}</h3>
                    <p className={neg(selectedCall) ? "miss" : ""}>{outcome(selectedCall)} · {fullWhen(selectedCall.startedAt)}</p>
                    <div className="cx-who-acts">
                      <button className="cx-btn cx-btn-d" onClick={() => onStartCall(selectedCall.peer, false)}>
                        <IconPhone size={15} /> Call back
                      </button>
                      <button className="cx-round" data-tip="Video call" aria-label="Video call" onClick={() => onStartCall(selectedCall.peer, true)}>
                        <IconVideo size={16} />
                      </button>
                    </div>
                  </div>

                  <div className="cx-tiles">
                    <div><span>Duration</span><b className="mono">{selectedCall.durationSec ? selectedCall.durLabel : "—"}</b></div>
                    <div>
                      <span>Type</span>
                      <b>{selectedCall.video ? <IconVideo size={12} /> : <IconPhone size={12} />} {selectedCall.video ? "Video" : "Audio"}</b>
                    </div>
                    <div>
                      <span>Direction</span>
                      <b className={neg(selectedCall) ? "miss" : "ok"}>{selectedCall.direction === "in" ? "Incoming" : "Outgoing"}</b>
                    </div>
                  </div>
                  {selectedCall._runCount ? (
                    <div className="cx-note">{selectedCall._runCount} calls in this group</div>
                  ) : null}

                  <div className="cx-box">
                    <div className="cx-box-h"><b>Call activity</b><span>Last 7 days</span></div>
                    <div className="cx-bars">
                      {activityBars.map((v, i) => (
                        <div
                          key={i}
                          className={i === 6 ? "t" : ""}
                          style={{ height: Math.max(10, Math.min(100, v * 30)) + "%" }}
                          title={v + " call" + (v === 1 ? "" : "s")}
                        />
                      ))}
                    </div>
                    <div className="cx-bars-l"><span>7d ago</span><span>Today</span></div>
                  </div>

                  <div className="cx-hist">
                    <h4>Recent history</h4>
                    {peerCalls.slice(0, 4).map((c: any, i: number, arr: any[]) => (
                      <div className="cx-hist-i" key={c.id}>
                        <div className="cx-hist-r">
                          <span className={"cx-hist-d" + (i === 0 ? " on" : "")}>
                            {c.video ? <IconVideo size={12} /> : <IconPhone size={12} />}
                          </span>
                          {i < arr.length - 1 ? <i /> : null}
                        </div>
                        <div>
                          <b>{(c.video ? "Video" : "Audio") + " · " + outcome(c) + (c.durationSec ? " " + c.durLabel : "")}</b>
                          <span>{fullWhen(c.startedAt)}</span>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              </>
            )}
          </aside>
          {selectedCall ? <div className="cx-scrim" onClick={() => setSelectedCall(null)} /> : null}
        </div>
      </div>
    </div>
  );
}
