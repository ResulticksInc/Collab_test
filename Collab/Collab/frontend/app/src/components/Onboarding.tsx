"use client";
import React, { useEffect, useState } from "react";
import { api } from "../lib/api";
import { BUBBLE_ACCENTS, bubbleAccentColor } from "../lib/bubbleAccent";
import PremiumSelect from "./PremiumSelect";

/**
 * First-run onboarding — shown ONCE, only right after sign-up (never on login,
 * never for existing users). Afterward it's reachable from Settings → "Run setup
 * again". Enterprise/professional, no emoji. A guided front-end over the SAME
 * settings/profile contract, so every answer persists immediately and is
 * editable later. Ends with a Welcome animation that transitions to the
 * dashboard (the fixed landing view). See docs/ONBOARDING_DESIGN.md.
 */
// Two-tone swatches: each theme's actual surface + a representative second tone,
// so every option is visually distinct (a single dot left the dark themes
// indistinguishable from one another).
// NOTE: Midnight and Slate were removed by request. The "slate" entry in
// ACCENTS below is a DIFFERENT thing — an accent colour, not a theme — and
// stays.
const THEMES: [string, string, string][] = [
  ["light", "Light", "linear-gradient(135deg, #ffffff 0 50%, #e7e9ee 50%)"],
];
// The stored value "indigo" is the brand default; it renders as Collab Purple
// everywhere (--ac #8b29be). Keep the swatch + label in step with Settings.tsx.
const ACCENTS: [string, string][] = [
  ["indigo", "#8b29be"], ["cobalt", "#2563EB"], ["emerald", "#10B981"],
  ["violet", "#8B5CF6"], ["rose", "#F43F5E"], ["amber", "#F59E0B"], ["slate", "#64748B"],
];
const FONTS: [string, string, string][] = [
  ["plus-jakarta", "Plus Jakarta Sans", '"Plus Jakarta Sans","Segoe UI",system-ui,sans-serif'],
  ["inter", "Inter", '"Inter","Segoe UI",system-ui,sans-serif'],
  ["geist", "Geist", '"Geist","Inter",system-ui,sans-serif'],
  ["ibm-plex", "IBM Plex Sans", '"IBM Plex Sans","Inter",system-ui,sans-serif'],
  ["poppins", "Poppins", '"Poppins","Inter",system-ui,sans-serif'],
  ["system", "System", 'system-ui,-apple-system,"Segoe UI",sans-serif'],
];
const SIZES: [string, string][] = [["12px", "Smaller"], ["13px", "Small"], ["14px", "Default"], ["15px", "Large"]];
// Chat wallpaper was removed (#12) — first-run personalization now picks the
// messenger-style sent-bubble color instead (shared with Settings → bubbleAccent).

const STEPS = ["Welcome", "Profile", "Appearance", "Your team", "Notifications"];

export default function Onboarding({
  settings,
  me,
  token,
  onChangeSetting,
  onUpdateProfile,
  onFinish,
  onContinueLater,
}: any) {
  const [step, setStep] = useState<number>(Math.min(Number(settings?.onboardingStep) || 0, STEPS.length - 1));
  const [name, setName] = useState<string>((me && me.name) || "");
  const [about, setAbout] = useState<string>((me && me.about) || "");
  const [people, setPeople] = useState<any[]>([]);
  const [invited, setInvited] = useState<Record<string, boolean>>({});
  const [finishing, setFinishing] = useState(false); // welcome-animation phase
  const [exiting, setExiting] = useState(false); // finale fade-out → dashboard

  const total = STEPS.length;

  // Load directory for the "Your team" step (real connection invites, userId-only).
  useEffect(() => {
    if (!token) return;
    api.getUsers(token).then((u: any[]) => setPeople((u || []).filter((p) => p && p.id !== (me && me.id)).slice(0, 8))).catch(() => {});
  }, [token, me]);

  const go = (n: number) => {
    const next = Math.max(0, Math.min(total - 1, n));
    setStep(next);
    onChangeSetting("onboardingStep", next);
  };
  const saveIdentity = () => {
    const patch: any = {};
    if (name.trim() && name.trim() !== (me && me.name)) patch.name = name.trim();
    if (about !== ((me && me.about) || "")) patch.about = about;
    if (Object.keys(patch).length && onUpdateProfile) onUpdateProfile(patch);
  };
  const invite = async (uid: string) => {
    setInvited((p) => ({ ...p, [uid]: true }));
    try {
      await api.sendInvite(token, uid);
    } catch {
      // Don't leave a falsely-"Requested" chip if the invite didn't actually
      // send — revert so the button is honest and the user can retry.
      setInvited((p) => ({ ...p, [uid]: false }));
    }
  };
  const finish = () => {
    saveIdentity();
    onChangeSetting("onboardingStep", 0);
    // Play the welcome animation, then cross-fade smoothly into the dashboard:
    // the finale holds, then fades out (revealing the already-mounted dashboard
    // behind it) before we unmount — no abrupt cut.
    setFinishing(true);
    setTimeout(() => setExiting(true), 1800); // begin the 0.7s fade-out
    setTimeout(() => onFinish(), 2600); // unmount only AFTER the fade fully completes
  };

  // ── Welcome finale ───────────────────────────────────────────────────────
  if (finishing) {
    return (
      <div className={"ob-overlay ob-finale" + (exiting ? " exiting" : "")}>
        <div className="ob-finale-inner">
          <div className="ob-finale-mark">Collab</div>
          <div className="ob-finale-title">Welcome{me && me.name ? ", " + (me.name || "").split(" ")[0] : ""}</div>
          <div className="ob-finale-sub">Your workspace is ready.</div>
          <div className="ob-finale-bar"><span /></div>
        </div>
      </div>
    );
  }

  const Chip = ({ active, onClick, children, style }: any) => (
    <button type="button" className={"ob-chip" + (active ? " active" : "")} style={style} onClick={onClick}>{children}</button>
  );

  return (
    <div className="ob-overlay">
      <div className="ob-card">
        <div className="ob-progress">
          {STEPS.map((_, i) => <span key={i} className={"ob-dot" + (i <= step ? " on" : "")} />)}
        </div>

        <div className="ob-body">
          {step === 0 && (
            <>
              <div className="ob-brandmark">Collab</div>
              <h2 className="ob-h">Welcome to Collab{me && me.name ? ", " + (me.name || "").split(" ")[0] : ""}</h2>
              <p className="ob-p">Let’s set up your workspace — your profile, a look that suits you, and the people you work with. It takes under a minute, and you can change anything later in Settings.</p>
            </>
          )}

          {step === 1 && (
            <>
              <h2 className="ob-h">Your profile</h2>
              <p className="ob-p">How teammates see you across chats, calls and meetings.</p>
              <label className="ob-label">Display name</label>
              <input className="ob-input" value={name} maxLength={60} onChange={(e) => setName(e.target.value)} onBlur={saveIdentity} placeholder="Your name" />
              <label className="ob-label">About <span className="ob-opt">— optional</span></label>
              <input className="ob-input" value={about} maxLength={140} onChange={(e) => setAbout(e.target.value)} onBlur={saveIdentity} placeholder="Role, team, or a short line about you" />
              <p className="ob-hint">Add a profile photo any time from Settings → Profile.</p>
            </>
          )}

          {step === 2 && (
            <div className="ob-scroll">
              <h2 className="ob-h">Make it yours</h2>
              <p className="ob-p">Pick a theme, accent, type and message color. Changes apply instantly — preview on the right.</p>
              <div className="ob-make">
                <div className="ob-fields">
                <div className="ob-field">
                  <label className="ob-label">Theme</label>
                  <PremiumSelect
                    ariaLabel="Theme"
                    value="light"
                    onChange={(v) => onChangeSetting("theme", v)}
                    options={THEMES.map(([val, label, c]) => ({ value: val, label, swatch: c }))}
                  />
                </div>
                <div className="ob-field">
                  <label className="ob-label">Accent</label>
                  <PremiumSelect
                    ariaLabel="Accent colour"
                    value={settings?.accent || "indigo"}
                    onChange={(v) => onChangeSetting("accent", v)}
                    options={ACCENTS.map(([val, c]) => ({ value: val, label: val === "indigo" ? "Collab Purple" : val.charAt(0).toUpperCase() + val.slice(1), swatch: c }))}
                  />
                </div>
                <div className="ob-field">
                  <label className="ob-label">Typeface</label>
                  <PremiumSelect
                    ariaLabel="Typeface"
                    value={settings?.fontFamily || "poppins"}
                    onChange={(v) => onChangeSetting("fontFamily", v)}
                    options={FONTS.map(([val, label, stack]) => ({ value: val, label, fontFamily: stack }))}
                  />
                </div>
                <div className="ob-field">
                  <label className="ob-label">Text size</label>
                  <PremiumSelect
                    ariaLabel="Text size"
                    value={settings?.fontSize || "14px"}
                    onChange={(v) => onChangeSetting("fontSize", v)}
                    options={SIZES.map(([val, label]) => ({ value: val, label }))}
                  />
                </div>
                <div className="ob-field">
                  <label className="ob-label">Message color</label>
                  <PremiumSelect
                    ariaLabel="Message color"
                    value={settings?.bubbleAccent || "accent"}
                    onChange={(v) => onChangeSetting("bubbleAccent", v)}
                    options={BUBBLE_ACCENTS.map(({ key, label, color }) => ({ value: key, label, swatch: color || "var(--ac)" }))}
                  />
                </div>
              </div>
                {/* Compact live preview — reflects the selected text size + message colour. */}
                <div className="ob-mini-preview" aria-hidden="true">
                  <div className="ob-mini-lbl">Preview</div>
                  <div className="ob-mini-chat" style={{ fontSize: settings?.fontSize || "14px" }}>
                    <div className="ob-mini-in">Your chats will look like this</div>
                    <div className="ob-mini-out" style={{ background: bubbleAccentColor(settings?.bubbleAccent || "accent") || "var(--ac)" }}>
                      Clean and on-brand
                    </div>
                  </div>
                </div>
              </div>
            </div>
          )}

          {step === 3 && (
            <>
              <h2 className="ob-h">Connect with your team</h2>
              <p className="ob-p">Send a connection request to start a direct message. You can find more people any time from Contacts.</p>
              <div className="ob-people">
                {people.length === 0 ? <div className="ob-hint">No one else here yet — invite teammates from Contacts later.</div> :
                  people.map((p) => (
                    <div className="ob-person" key={p.id}>
                      <span className="ob-person-av" style={{ background: p.color || "var(--ac)" }}>{(p.initials || (p.name || "?")[0] || "?").slice(0, 2).toUpperCase()}</span>
                      <span className="ob-person-n">{p.name}</span>
                      <button type="button" className={"ob-person-btn" + (invited[p.id] ? " done" : "")} disabled={!!invited[p.id]} onClick={() => invite(p.id)}>
                        {invited[p.id] ? "Requested" : "Connect"}
                      </button>
                    </div>
                  ))}
              </div>
            </>
          )}

          {step === 4 && (
            <>
              <h2 className="ob-h">Notifications</h2>
              <p className="ob-p">Choose how much Collab notifies you. Fine-tune later in Settings → Notifications.</p>
              <div className="ob-stack">
                {[["all", "Everything", "Every new message and call"], ["mentions", "Mentions only", "Only when someone @mentions you"], ["none", "Nothing", "Stay heads-down; check on your own time"]].map(([v, t, d]) => (
                  <button key={v} type="button" className={"ob-opt-row" + (settings?.notifyLevel === v ? " active" : "")} onClick={() => onChangeSetting("notifyLevel", v)}>
                    <span className="ob-opt-t">{t}</span><span className="ob-opt-d">{d}</span>
                  </button>
                ))}
              </div>
              <p className="ob-hint">You’re all set. Finish to enter your workspace.</p>
            </>
          )}
        </div>

        <div className="ob-foot">
          <button type="button" className="ob-skip" onClick={() => { saveIdentity(); onContinueLater(); }}>Skip for now</button>
          <div className="ob-nav">
            {step > 0 ? <button type="button" className="ob-btn" onClick={() => go(step - 1)}>Back</button> : null}
            {step < total - 1
              ? <button type="button" className="ob-btn primary" onClick={() => { if (step === 1) saveIdentity(); go(step + 1); }}>{step === 0 ? "Get started" : "Continue"}</button>
              : <button type="button" className="ob-btn primary" onClick={finish}>Finish</button>}
          </div>
        </div>
      </div>
    </div>
  );
}
