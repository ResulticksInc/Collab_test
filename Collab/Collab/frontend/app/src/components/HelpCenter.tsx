import React, { useEffect, useRef, useState } from "react";
import {
  HELP_MODULES,
  HELP_BY_ID,
  detectHelpPlatform,
  platformLabel,
  shortcutGroupsFor,
  renderKeyToken,
  platformShortcutNote,
} from "../lib/helpContent";

/**
 * Global Help Center — a self-service product guide reachable from every screen
 * (Rail: Settings → Help → Logout). Context-aware: opens to the module that
 * matches the screen you came from. Search spans every module's steps,
 * troubleshooting and FAQs. User-facing content lives in lib/helpContent.ts.
 */
export default function HelpCenter({ initialModuleId, onClose }: { initialModuleId?: string; onClose: () => void }) {
  const firstValid = HELP_MODULES[0]?.id || "messaging";
  const [activeId, setActiveId] = useState<string>(
    initialModuleId && HELP_BY_ID[initialModuleId] ? initialModuleId : firstValid,
  );
  const contentRef = useRef<HTMLDivElement | null>(null);

  // Follow the target when a Help result is opened from global search while Help
  // is ALREADY the active screen: `mode` doesn't change, so this component isn't
  // remounted and the useState initializer above won't re-run. Sync the open
  // article to the (new) initialModuleId here so the click always lands on the
  // right topic instead of silently keeping the previous one.
  useEffect(() => {
    if (initialModuleId && HELP_BY_ID[initialModuleId]) {
      setActiveId(initialModuleId);
      if (contentRef.current) contentRef.current.scrollTop = 0;
    }
  }, [initialModuleId]);

  // Detect the platform (web | windows | mac | linux) once on mount so the
  // Keyboard-shortcuts table shows the right modifier and only offers the
  // desktop-only global hotkeys in the desktop app. SSR-safe: defaults to "web".
  const [platform, setPlatform] = useState<ReturnType<typeof detectHelpPlatform>>("web");
  useEffect(() => { setPlatform(detectHelpPlatform()); }, []);

  const active = HELP_BY_ID[activeId] || HELP_MODULES[0];

  // Integrate with the app's global ESC priority: consume the cancelable
  // "colab:esc" event so Escape closes Help instead of triggering a global Back.
  useEffect(() => {
    const onEsc = (e: Event) => { e.preventDefault(); onClose(); };
    window.addEventListener("colab:esc", onEsc);
    return () => window.removeEventListener("colab:esc", onEsc);
  }, [onClose]);

  const openModule = (id: string) => {
    setActiveId(id);
    if (contentRef.current) contentRef.current.scrollTop = 0;
  };

  const Section = ({ title, children }: any) => (
    <section className="hc-section">
      <h3 className="hc-h3">{title}</h3>
      {children}
    </section>
  );

  // Platform-aware keyboard-shortcuts table. Renders one grouped block per
  // category; desktop-only (global) groups appear only in the desktop app.
  const ShortcutsView = () => {
    const groups = shortcutGroupsFor(platform);
    return (
      <>
        <div className="hc-kbd-platform">
          Showing shortcuts for <strong>{platformLabel(platform)}</strong>
        </div>
        {groups.map((g) => (
          <Section key={g.heading} title={g.heading}>
            <div className="hc-kbd-rows">
              {g.rows.map((r, i) => (
                <div className="hc-kbd-row" key={i}>
                  <span className="hc-kbd-label">{r.label}</span>
                  <span className="hc-kbd-keys">
                    {r.keys.map((tok, j) => (
                      <React.Fragment key={j}>
                        {j > 0 ? <span className="hc-kbd-plus">+</span> : null}
                        <kbd className="hc-kbd">{renderKeyToken(tok, platform)}</kbd>
                      </React.Fragment>
                    ))}
                  </span>
                </div>
              ))}
            </div>
          </Section>
        ))}
        <p className="hc-kbd-note">{platformShortcutNote(platform)}</p>
      </>
    );
  };

  return (
    // BA/CEO #24: Help renders as a full page (a routed mode), not a floating
    // modal — so it fills the content column beside the Rail like Settings.
    <div id="help" className="screen hc-screen" role="region" aria-label="Help Center">
      <div className="hc-panel">
        {/* The Help title + the single global search bar now live in the shared
            top bar (standardized header); the in-module title bar and duplicate
            "Search help" field were removed. Esc or the Rail closes Help. */}
        <div className="hc-body">
          <nav className="hc-nav" aria-label="Help modules">
            <label className="hc-nav-lbl">Select module</label>
            {HELP_MODULES.map((m) => (
              <button
                key={m.id}
                className={"hc-nav-item" + (m.id === activeId ? " active" : "")}
                onClick={() => openModule(m.id)}
              >
                <span>{m.title}</span>
              </button>
            ))}
          </nav>

          <div className="hc-content" ref={contentRef}>
              <article className="hc-article">
                <h2 className="hc-h2">{active.title}</h2>

                {active.overview ? <p className="hc-overview">{active.overview}</p> : null}

                {active.kind === "shortcuts" ? <ShortcutsView /> : null}

                {active.kind !== "shortcuts" && active.howTo.length ? (
                  <Section title="How to use">
                    <ol className="hc-steps">
                      {active.howTo.map((s, i) => <li key={i}>{s}</li>)}
                    </ol>
                  </Section>
                ) : null}

                {active.bestPractices.length ? (
                  <Section title="Best practices">
                    <ul className="hc-list">
                      {active.bestPractices.map((s, i) => <li key={i}>{s}</li>)}
                    </ul>
                  </Section>
                ) : null}

                {active.commonIssues.length ? (
                  <Section title="Common mistakes">
                    <ul className="hc-list">
                      {active.commonIssues.map((s, i) => <li key={i}>{s}</li>)}
                    </ul>
                  </Section>
                ) : null}

                {active.troubleshooting.length ? (
                  <Section title="Troubleshooting">
                    <div className="hc-trouble">
                      {active.troubleshooting.map((t, i) => (
                        <div className="hc-trouble-item" key={i}>
                          <div className="hc-trouble-p">
                            <span className="hc-pill hc-pill-p">Problem</span>{t.problem}
                          </div>
                          <div className="hc-trouble-s">
                            <span className="hc-pill hc-pill-s">Fix</span>{t.solution}
                          </div>
                        </div>
                      ))}
                    </div>
                  </Section>
                ) : null}

                {active.faqs.length ? (
                  <Section title="FAQs">
                    <div className="hc-faqs">
                      {active.faqs.map((f, i) => (
                        <details className="hc-faq" key={i}>
                          <summary>{f.q}</summary>
                          <p>{f.a}</p>
                        </details>
                      ))}
                    </div>
                  </Section>
                ) : null}

                {active.related.length ? (
                  <Section title="Related features">
                    <div className="hc-related">
                      {active.related.map((rid) => {
                        const rm = HELP_BY_ID[rid];
                        if (!rm) return null;
                        return (
                          <button key={rid} className="hc-chip" onClick={() => openModule(rid)}>
                            {rm.title}
                          </button>
                        );
                      })}
                    </div>
                  </Section>
                ) : null}

                {!active.overview && !active.howTo.length ? (
                  <p className="hc-empty">Documentation for this section is coming soon.</p>
                ) : null}
              </article>
          </div>
        </div>
      </div>
    </div>
  );
}
