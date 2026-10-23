import React, { useMemo, useState } from "react";
import config from "../lib/config";
import { api } from "../lib/api";
import {
  emailError,
  passwordError,
  passwordRules,
  passwordStrength,
} from "../lib/passwordPolicy";
import {
  IconMail,
  IconLock,
  IconUser,
  IconArrowRight,
  IconUserPlus,
  IconShieldCheck,
  IconCheck,
  IconCircle,
  IconEye,
  IconEyeOff,
  IconChevronDown,
} from "../lib/icons";

// Brand icon (same art as the rail): inline SVG component, see components/brand/Logo.tsx.
import { CollabIcon } from "./brand/Logo";

export default function LoginScreen({ onLogin, onSignup, error, busy }) {
  const signupAllowed = config.features.signup;
  const [mode, setMode] = useState<"signin" | "signup">("signin");
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [remember, setRemember] = useState(true);
  // Desktop app only: browser-like credential autofill lives in the Electron
  // shell (OS-keychain via safeStorage). In the browser the native password
  // manager already handles save/fill, so the checkbox + prefill stay hidden.
  const isDesktop =
    typeof window !== "undefined" &&
    !!(window as unknown as { collabDesktop?: any }).collabDesktop;
  const [confirm, setConfirm] = useState("");
  const [showPw, setShowPw] = useState(false);
  const [showConfirm, setShowConfirm] = useState(false);
  // Auth-method selector (password vs SSO). Remapped from the old bottom
  // "Continue with SSO" button into an Okta/Teams-style dropdown above the fields.
  // Picking SSO from the menu redirects STRAIGHT to the IdP (no second click), so
  // there is no on-form "SSO mode" — the visible form is always the password path.
  const [methodOpen, setMethodOpen] = useState(false);
  const [hoverMethod, setHoverMethod] = useState<string | null>(null); // hover highlight in the menu
  const [chosenMethod, setChosenMethod] = useState<"password" | "sso">("password"); // drives the chip label
  const [localErr, setLocalErr] = useState<string | null>(null);
  const [touched, setTouched] = useState(false); // show inline checklist once typing
  const signup = signupAllowed && mode === "signup";

  // Password-reset is shown to match the approved design but isn't wired to a
  // backend yet — a click surfaces a friendly "coming soon" notice instead of
  // silently doing nothing (or breaking).
  const [notice, setNotice] = useState<string | null>(null);
  const [logoClicks, setLogoClicks] = useState(0);
  const [versionToast, setVersionToast] = useState<string | null>(null);

  const handleLogoClick = () => {
    setLogoClicks((prev) => {
      const next = prev + 1;
      if (next >= 10) {
        setVersionToast(`${config.appName} Version ${config.appVersion || "v1.0.1"}`);
        setTimeout(() => setVersionToast(null), 4000);
        return 0;
      }
      return next;
    });
  };
  const comingSoon = (what: string) =>
    setNotice(`${what} is coming soon — for now, please reach out to your admin.`);

  // SSO (OpenID Connect). Full-page navigation to the backend start endpoint,
  // which 302s to the shared IdP. NOT a fetch — the browser must follow the
  // redirect. An unconfigured server bounces back with ?sso_error (handled in
  // CoLabV1 → shown via the `error` prop below).
  const startSso = () => {
    if (busy) return;
    try {
      window.location.assign(api.ssoStartUrl());
    } catch {
      setNotice("Couldn't start SSO sign-in. Please try again.");
    }
  };

  // #3 — clear the error banner the moment the user edits a field, so a stale
  // "Invalid email or password" doesn't linger after they change the inputs.
  // A fresh error coming from the parent re-shows it.
  const [errDismissed, setErrDismissed] = useState(false);
  React.useEffect(() => { if (error) setErrDismissed(false); }, [error]);
  // Desktop: prefill the saved sign-in credentials (safeStorage-decrypted in the
  // main process). No-op in the browser where getCredential is undefined.
  React.useEffect(() => {
    const cd: any = (window as unknown as { collabDesktop?: any }).collabDesktop;
    if (!cd || typeof cd.getCredential !== "function") return;
    let alive = true;
    cd.getCredential()
      .then((c: any) => {
        if (!alive || !c || !c.email) return;
        setEmail(c.email);
        if (c.password) setPassword(c.password);
        setRemember(true);
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, []);
  const clearErr = () => {
    if (localErr) setLocalErr(null);
    if (notice) setNotice(null);
    setErrDismissed(true);
  };

  const strength = useMemo(
    () => passwordStrength(password, { email, name }),
    [password, email, name],
  );
  const rules = useMemo(() => passwordRules(password), [password]);
  const confirmMismatch = signup && confirm.length > 0 && confirm !== password;

  const submit = () => {
    if (busy) return;
    setLocalErr(null);
    setNotice(null);
    setErrDismissed(false);
    const e = email.trim();
    if (signup) {
      const ee = emailError(e);
      if (ee) { setLocalErr(ee); return; }
      const pe = passwordError(password, { email: e, name });
      if (pe) { setTouched(true); setLocalErr(pe); return; }
      if (password !== confirm) { setLocalErr("Passwords don't match."); return; }
      onSignup(name.trim(), e, password);
    } else {
      onLogin(e, password, remember);
    }
  };

  const switchMode = () => {
    setMode(signup ? "signin" : "signup");
    setLocalErr(null);
    setNotice(null);
    setTouched(false);
    setConfirm("");
    setShowPw(false);
    setShowConfirm(false);
    setMethodOpen(false);
  };

  // Compact field so the whole card (esp. SIGNUP: 4 fields + strength + checklist)
  // fits one screen with no scroll on common laptop heights.
  const field: React.CSSProperties = {
    width: "100%",
    padding: "9px 14px 9px 40px",
    borderRadius: 10,
    border: "1.5px solid var(--g200)",
    // Subtle neutral fill so the input reads as a field on the card surface in
    // BOTH themes (matches the reference's soft-grey inputs) without depending on
    // a theme var that may equal the card colour.
    background: "rgba(128,128,140,0.06)",
    // Explicit themed text/caret — without this the input falls back to the
    // browser default (black), invisible on the dark surface in dark mode.
    color: "var(--g900)",
    caretColor: "var(--g900)",
    fontSize: 13.5,
    outline: "none",
    boxSizing: "border-box",
  };
  const labelStyle: React.CSSProperties = {
    display: "block",
    fontSize: 13.5,
    fontWeight: 600,
    color: "var(--g900)",
    // 0.5rem between a field label and its input.
    marginBottom: "0.5rem",
  };
  const linkBtn: React.CSSProperties = {
    background: "none", border: "none", color: "var(--ac)",
    fontWeight: 600, cursor: "pointer", padding: 0, fontSize: 12.8,
  };
  // Auth-method selector chip + menu (password vs SSO). Theme-aware, matches the
  // input surface; the accent border/marker only appears on open/selection.
  const methodChip: React.CSSProperties = {
    // NOTE: no maxWidth here — `max-width:100%` on an auto-width inline-flex
    // collapses the button to ~24px (content overflows) in Chromium. The chip is
    // ~110px inside a 440px card, so it never needs a cap.
    display: "inline-flex", alignItems: "center", gap: 7, width: "auto",
    padding: "6px 11px", borderRadius: 9,
    border: `1.5px solid ${methodOpen ? "var(--ac)" : "var(--g200)"}`,
    background: "rgba(128,128,140,0.06)", color: "var(--g900)",
    fontSize: 13, fontWeight: 600, cursor: "pointer", boxSizing: "border-box",
  };
  const methodMenu: React.CSSProperties = {
    position: "absolute", top: "calc(100% + 4px)", left: 0, minWidth: 150, maxWidth: "100%",
    background: "var(--card)", border: "1.5px solid var(--ac)", borderRadius: 10,
    boxShadow: "var(--shm)", padding: 4, zIndex: 2,
    display: "flex", flexDirection: "column", gap: 1,
  };
  const onEnter = (e: React.KeyboardEvent) => {
    if (e.key === "Enter") submit();
  };

  // Leading icon inside an input (mail / lock / user), to match the design.
  const leadIcon = (children: React.ReactNode) => (
    <span
      style={{
        position: "absolute", left: 13, top: "50%", transform: "translateY(-50%)",
        color: "var(--g500)", display: "flex", alignItems: "center", pointerEvents: "none",
      }}
    >
      {children}
    </span>
  );
  const mailIcon = <IconMail size={16} />;
  const lockIcon = <IconLock size={16} />;
  const userIcon = <IconUser size={16} />;
  const arrowIcon = <IconArrowRight size={17} />;
  const userPlusIcon = <IconUserPlus size={17} />;
  const shieldIcon = <IconShieldCheck size={16} />;

  // Password input with leading lock + trailing show/hide eye. Rendered via a
  // FUNCTION CALL (not <PwField/>) on purpose: defining a component inside render
  // and using it as JSX would give it a new type each render -> React remounts it
  // every keystroke and the input loses focus. Calling it returns elements inline,
  // so the <input> keeps its identity and focus.
  const pwField = ({
    value, onChange, placeholder, show, onToggle, autoComplete, invalid, name,
  }: any) => (
    <div style={{ position: "relative" }}>
      {leadIcon(lockIcon)}
      <input
        className="auth-input"
        // A stable, conventional field name (e.g. "password") — kept separate
        // from the autocomplete token. Password managers key off type+autoComplete,
        // so this only makes the markup standard (and the field addressable).
        name={name || autoComplete}
        type={show ? "text" : "password"}
        autoComplete={autoComplete}
        placeholder={placeholder}
        value={value}
        onChange={onChange}
        onKeyDown={onEnter}
        style={{
          ...field,
          paddingRight: 42,
          borderColor: invalid ? "var(--red)" : "var(--g200)",
        }}
      />
      <button
        type="button"
        onClick={onToggle}
        aria-label={show ? "Hide password" : "Show password"}
        tabIndex={-1}
        style={{
          position: "absolute", right: 6, top: "50%", transform: "translateY(-50%)",
          background: "none", border: "none", cursor: "pointer", color: "var(--g500)",
          padding: 7, display: "flex", alignItems: "center",
        }}
      >
        {show ? <IconEyeOff size={17} /> : <IconEye size={17} />}
      </button>
    </div>
  );

  const strengthColor =
    strength.label === "Excellent" ? "var(--grn, #10b981)"
    : strength.label === "Strong" ? "var(--grn, #22c55e)"
    : strength.label === "Medium" ? "var(--amb, #f59e0b)"
    : "var(--red, #ef4444)";

  return (
    // Full-bleed (matches the reference, which has no outer frame) so the card gets
    // the ENTIRE viewport height — the framed `100vh - inset` + frame padding was
    // enough overhead to tip even the short sign-in card into a scrollbar on shorter
    // windows. overflow-y:auto stays only as a safety net for very short windows.
    <div
      className="auth-wrap"
      style={{ height: "100vh", margin: 0, borderRadius: 0, boxShadow: "none", padding: "8px", overflowY: "auto" }}
    >
      {/* Single centered card (approved reference). Inline-styled + theme-aware via
          CSS vars so it renders identically on web + Electron in light and dark. */}
      <div
        style={{
          margin: "auto",
          width: "100%",
          maxWidth: 440,
          background: "var(--card)",
          border: "1px solid var(--g200)",
          borderRadius: 18,
          boxShadow: "var(--shm)",
          // Sign-in card: 2.5rem on all four sides (signup keeps its tighter
          // padding so the taller 4-field form still fits without scrolling).
          padding: signup ? "14px 32px 18px" : "2.5rem",
          boxSizing: "border-box",
        }}
      >
        {/* Brand mark — centered. Square (54×54) so the 100×100 icon isn't
            stretched — the old 50×70 distorted it vertically. */}
        <div style={{ display: "flex", justifyContent: "center", marginBottom: signup ? 8 : 12 }}>
          <CollabIcon
            title={config.appName}
            onClick={handleLogoClick}
            style={{ width: 54, height: 54, cursor: "pointer", userSelect: "none" }}
          />
        </div>

        {/* Sign-in has no subtitle under the heading (the <p> below is signup-only),
            so the heading carries the section break to the auth-method chip
            itself. 1.5rem, not the 2.5rem this briefly had: 2.5rem was measured
            against the one-word "Collab" wordmark, and once the heading became a
            full sentence the same gap read as a hole in the card. 24px still
            separates the identity block from the form while staying in step with
            the 14px rhythm of the fields below. Signup keeps the tighter 0.5rem
            because its subtitle follows immediately. */}
        <h1 style={{ fontSize: "1.5rem", fontWeight: 800, color: "var(--g900)", margin: signup ? "0 0 0.5rem 0" : "0 0 2.5rem 0", textAlign: "center", letterSpacing: -0.4, lineHeight: 1.2 }}>
          {signup ? "Create Account" : "Sign In To Collab"}
        </h1>
        <p style={{ fontSize: 13, color: "var(--g500)", margin: signup ? "0 0 11px" : 0, textAlign: "center", display: signup ? "block" : "none" }}>
          {signup
            ? `Sign up for a new ${config.appName} account`
            : `Sign in to your ${config.appName} Workspace`}
        </p>

        {(!errDismissed && (localErr || error)) ? (
          <div
            style={{
              marginBottom: 12, fontSize: 12.5, color: "var(--red)",
              background: "var(--red-bg)", padding: "9px 12px",
              borderRadius: 10, textAlign: "left",
            }}
          >
            {localErr || error}
          </div>
        ) : null}

        {config.ssoEnabled && !signup ? (
          <div style={{ position: "relative", marginBottom: "1.25rem" }}>
            <button
              type="button"
              onClick={() => setMethodOpen((o) => !o)}
              aria-haspopup="listbox"
              aria-expanded={methodOpen}
              style={methodChip}
            >
              <span style={{ color: methodOpen ? "var(--ac)" : "var(--g500)", display: "flex" }}>{shieldIcon}</span>
              {/* "Email", not the product name: this dropdown picks the sign-in
                  METHOD, and the alternative to SSO is an email + password
                  credential. Labelling it "Collab" described the product rather
                  than the choice, which read as if SSO were somehow not Collab. */}
              <span style={{ textAlign: "left" }}>{chosenMethod === "sso" ? "SSO" : "Email"}</span>
              <span style={{ color: "var(--g500)", display: "flex", transform: methodOpen ? "rotate(180deg)" : "none", transition: "transform .15s" }}>
                <IconChevronDown size={16} />
              </span>
            </button>
            {methodOpen ? (
              <>
                {/* click-away layer */}
                <div onClick={() => setMethodOpen(false)} style={{ position: "fixed", inset: 0, zIndex: 1 }} />
                <div role="listbox" style={methodMenu}>
                  {([{ k: "password", label: "Email" }, { k: "sso", label: "SSO" }] as const).map((opt) => {
                    const sel = chosenMethod === opt.k; // the resting selection
                    // While hovering, ONLY the hovered row highlights — so Email's
                    // highlight clears the instant the cursor moves to SSO. With no
                    // hover, the resting selection shows.
                    const on = hoverMethod != null ? hoverMethod === opt.k : sel;
                    return (
                      <button
                        key={opt.k}
                        type="button"
                        role="option"
                        aria-selected={sel}
                        onMouseEnter={() => setHoverMethod(opt.k)}
                        onMouseLeave={() => setHoverMethod((h) => (h === opt.k ? null : h))}
                        onClick={() => {
                          setChosenMethod(opt.k);
                          setMethodOpen(false);
                          clearErr();
                          // Flip the chip to "SSO" first, THEN redirect to the IdP —
                          // the small delay lets "SSO" paint before the page unloads.
                          if (opt.k === "sso") setTimeout(() => startSso(), 130);
                        }}
                        style={{
                          padding: "7px 10px", borderRadius: 7, textAlign: "left", border: "none",
                          background: on ? "rgba(139,41,190,0.10)" : "transparent",
                          color: on ? "var(--ac)" : "var(--g900)", fontWeight: on ? 700 : 500,
                          fontSize: 13, cursor: "pointer", transition: "background .12s, color .12s",
                        }}
                      >
                        {opt.label}
                      </button>
                    );
                  })}
                </div>
              </>
            ) : null}
          </div>
        ) : null}

        {signup ? (
          <div style={{ marginBottom: 8 }}>
            <label style={labelStyle}>Full Name</label>
            <div style={{ position: "relative" }}>
              {leadIcon(userIcon)}
              <input
                className="auth-input"
                name="name"
                type="text"
                autoComplete="name"
                placeholder="John Doe"
                value={name}
                onChange={(e) => { setName(e.target.value); clearErr(); }}
                onKeyDown={onEnter}
                style={field}
              />
            </div>
          </div>
        ) : null}

        <div style={{ marginBottom: signup ? 8 : "1.25rem" }}>
          <label style={labelStyle}>Email Address</label>
          <div style={{ position: "relative" }}>
            {leadIcon(mailIcon)}
            <input
              className="auth-input"
              name="email"
              type="email"
              autoComplete="email"
              autoFocus
              placeholder="name@company.com"
              value={email}
              onChange={(e) => { setEmail(e.target.value); clearErr(); }}
              onKeyDown={onEnter}
              style={field}
            />
          </div>
        </div>

        <div>
          {/* "Forgot Password?" now sits BELOW the input rather than sharing the
              label's line. That dissolves the reason the label previously needed
              its margin lifted onto a flex wrapper — Password can use labelStyle
              directly, exactly as Email does above, so the two fields stay
              aligned by construction instead of by a matching magic number. */}
          <label style={labelStyle}>Password</label>
          {pwField({
            value: password,
            onChange: (e: any) => { setPassword(e.target.value); if (!touched) setTouched(true); clearErr(); },
            placeholder: "••••••••",
            show: showPw,
            onToggle: () => setShowPw((s) => !s),
            autoComplete: signup ? "new-password" : "current-password",
            name: "password",
            invalid: false,
          })}
          {!signup ? (
            <div style={{ display: "flex", justifyContent: "flex-end", marginTop: "0.5rem" }}>
              <button
                type="button"
                onClick={() =>
                  // AUDIT P3 (#45): self-serve reset isn't built; give an actionable
                  // path (admin reset / SSO) rather than a vague "coming soon".
                  setNotice(
                    "Your administrator can reset your password from the org Members list. If your team uses SSO, use “Continue with SSO” instead.",
                  )
                }
                style={linkBtn}
              >
                Forgot Password?
              </button>
            </div>
          ) : null}
        </div>

        {signup ? (
          <>
            {/* Live strength meter */}
            {password ? (
              <div style={{ marginTop: 5, textAlign: "left" }}>
                <div style={{ display: "flex", gap: 4 }}>
                  {[1, 2, 3, 4].map((i) => (
                    <span
                      key={i}
                      style={{
                        flex: 1, height: 4, borderRadius: 3,
                        background: i <= strength.score ? strengthColor : "var(--g200)",
                        transition: "background 0.2s",
                      }}
                    />
                  ))}
                </div>
                <div style={{ display: "flex", justifyContent: "space-between", marginTop: 5 }}>
                  <span style={{ fontSize: 11.5, fontWeight: 700, color: strengthColor }}>{strength.label}</span>
                  <span style={{ fontSize: 11, color: "var(--g500)" }}>{strength.hint}</span>
                </div>
              </div>
            ) : null}

            {/* Requirements checklist (appears once typing starts) */}
            {touched ? (
              <div style={{ marginTop: 7, textAlign: "left", display: "flex", flexWrap: "wrap", gap: "3px 12px" }}>
                {rules.map((r) => (
                  <span key={r.id} style={{ display: "inline-flex", alignItems: "center", gap: 5, fontSize: 11, color: r.ok ? "var(--grn, #10b981)" : "var(--g500)" }}>
                    {r.ok ? (
                      <IconCheck size={12} />
                    ) : (
                      <IconCircle size={12} />
                    )}
                    {r.label}
                  </span>
                ))}
              </div>
            ) : null}

            <div style={{ marginTop: 8 }}>
              <label style={labelStyle}>Confirm Password</label>
              {pwField({
                value: confirm,
                onChange: (e: any) => { setConfirm(e.target.value); clearErr(); },
                placeholder: "••••••••",
                show: showConfirm,
                onToggle: () => setShowConfirm((s) => !s),
                autoComplete: "new-password",
                name: "confirmPassword",
                invalid: confirmMismatch,
              })}
              {confirmMismatch ? (
                <div style={{ marginTop: 5, fontSize: 11, color: "var(--red)", textAlign: "left" }}>
                  Passwords don&apos;t match.
                </div>
              ) : null}
            </div>
          </>
        ) : null}

        {!signup && isDesktop ? (
          <label
            style={{
              display: "flex",
              alignItems: "center",
              gap: 8,
              marginTop: 14,
              fontSize: 13,
              color: "var(--muted)",
              cursor: "pointer",
              userSelect: "none",
            }}
          >
            <input
              type="checkbox"
              checked={remember}
              onChange={(ev) => setRemember(ev.target.checked)}
              style={{ width: 15, height: 15, accentColor: "var(--ac)", cursor: "pointer" }}
            />
            Remember me on this device
          </label>
        ) : null}

        <button
          className="btn-p"
          onClick={submit}
          disabled={busy}
          style={{ width: "100%", height: 44, marginTop: signup ? 10 : "1.25rem", fontSize: 15, fontWeight: 700, display: "flex", alignItems: "center", justifyContent: "center", gap: 8, opacity: busy ? 0.7 : 1 }}
        >
          {busy
            ? signup ? "Creating account…" : "Signing in…"
            : signup ? "Sign Up" : "Sign In"}
          {!busy ? (signup ? userPlusIcon : arrowIcon) : null}
        </button>

        {notice ? (
          <div
            style={{
              marginTop: 11, fontSize: 12, color: "var(--g600, var(--g500))",
              background: "rgba(128,128,140,0.09)", padding: "8px 11px",
              borderRadius: 10, textAlign: "center",
            }}
          >
            {notice}
          </div>
        ) : null}

        {signupAllowed ? (
          <div style={{ marginTop: signup ? 9 : 12, fontSize: 12.5, color: "var(--g500)", textAlign: "center" }}>
            {signup ? "Already have an account?" : "Don't have an account?"}{" "}
            <button
              type="button"
              onClick={switchMode}
              style={{
                background: "none", border: "none", color: "var(--ac)",
                fontWeight: 700, cursor: "pointer", padding: 0, fontSize: 12.5,
              }}
            >
              {signup ? "Sign In" : "Sign Up"}
            </button>
          </div>
        ) : null}
      </div>

      {versionToast ? (
        <div
          style={{
            position: "fixed",
            bottom: 24,
            left: "50%",
            transform: "translateX(-50%)",
            background: "#1e1b4b",
            color: "#fff",
            padding: "10px 20px",
            borderRadius: 20,
            fontSize: 13,
            fontWeight: 600,
            boxShadow: "0 10px 25px -5px rgba(0, 0, 0, 0.3)",
            zIndex: 99999,
            display: "flex",
            alignItems: "center",
            gap: 8,
            backdropFilter: "blur(8px)",
            border: "1px solid rgba(255, 255, 255, 0.2)",
          }}
        >
          <span style={{ display: "inline-block", width: 8, height: 8, borderRadius: "50%", background: "#10b981" }} />
          {versionToast}
        </div>
      ) : null}
    </div>
  );
}
