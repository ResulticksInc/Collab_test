"use client";
import React, { useEffect, useRef } from "react";
import { useSingleTab } from "../lib/singleTab";

// Enforces one active Collab tab. While the tab is "active" it renders the app;
// in every other state the app is NOT mounted (so a parked/stopped tab holds no
// socket, call or timer) and a small blocking screen is shown instead.
// See lib/singleTab.ts for the protocol.
export default function SingleTabGuard({ children }: { children: React.ReactNode }) {
  const { state, continueHere, cancel } = useSingleTab();

  if (state === "active") return <>{children}</>;
  if (state === "checking") {
    // ≤250ms handshake — same themed placeholder as the app's chunk-load fallback.
    return <div style={{ minHeight: "100vh", background: "var(--boot-bg, #e8ddff)" }} />;
  }

  if (state === "conflict") {
    return (
      <Screen>
        <Card
          title="Collab is already open in another tab"
          body="Collab is already open in another tab. Would you like to continue in this tab?"
          primary={{ label: "Continue", onClick: continueHere }}
          secondary={{ label: "Cancel", onClick: cancel }}
        />
      </Screen>
    );
  }

  if (state === "superseded") {
    return (
      <Screen>
        <Card
          title="Collab is open in another tab"
          body="You continued in a different tab, so this one was paused. You can close it, or use Collab here instead."
          primary={{ label: "Use Collab in this tab", onClick: continueHere }}
        />
      </Screen>
    );
  }

  // stopped (Cancel)
  return (
    <Screen>
      <Card
        title="Collab is open in another tab"
        body="Your existing Collab tab is still active. You can close this tab, or switch to using Collab here."
        primary={{ label: "Use Collab in this tab", onClick: continueHere }}
      />
    </Screen>
  );
}

function Screen({ children }: { children: React.ReactNode }) {
  return (
    <div
      style={{
        minHeight: "100vh",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: 16,
        background: "var(--boot-bg, #e8ddff)",
      }}
    >
      {children}
    </div>
  );
}

type Btn = { label: string; onClick: () => void };

function Card({
  title,
  body,
  primary,
  secondary,
}: {
  title: string;
  body: string;
  primary: Btn;
  secondary?: Btn;
}) {
  const ref = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    ref.current?.focus();
  }, []);
  const btn: React.CSSProperties = {
    font: "inherit",
    fontSize: 14,
    fontWeight: 600,
    borderRadius: 10,
    padding: "10px 18px",
    cursor: "pointer",
    border: "1px solid transparent",
    lineHeight: 1,
  };
  return (
    <div
      role="alertdialog"
      aria-modal="true"
      aria-labelledby="stg-title"
      aria-describedby="stg-body"
      style={{
        width: 420,
        maxWidth: "100%",
        background: "var(--card, #fff)",
        color: "var(--g900, #111827)",
        border: "1px solid var(--g200, #e5e7eb)",
        borderRadius: 16,
        boxShadow: "0 12px 40px rgba(16,24,40,.18)",
        padding: "24px 24px 20px",
        fontFamily: "inherit",
      }}
    >
      <h2 id="stg-title" style={{ margin: 0, fontSize: 17, fontWeight: 650, lineHeight: 1.3 }}>
        {title}
      </h2>
      <p
        id="stg-body"
        style={{ margin: "10px 0 20px", fontSize: 14, lineHeight: 1.5, color: "var(--g600, #4b5563)" }}
      >
        {body}
      </p>
      <div style={{ display: "flex", justifyContent: "flex-end", gap: 10 }}>
        {secondary ? (
          <button
            type="button"
            onClick={secondary.onClick}
            style={{
              ...btn,
              background: "transparent",
              color: "var(--g700, #374151)",
              borderColor: "var(--g200, #e5e7eb)",
            }}
          >
            {secondary.label}
          </button>
        ) : null}
        <button
          ref={ref}
          type="button"
          onClick={primary.onClick}
          style={{ ...btn, background: "var(--ac, #6d28d9)", color: "#fff" }}
        >
          {primary.label}
        </button>
      </div>
    </div>
  );
}
