import React from "react";

export type SpinnerProps = {
  size?: "sm" | "md" | "lg";
  /** `inherit` uses currentColor; `accent` / `muted` pick a token. */
  tone?: "inherit" | "accent" | "muted";
  /** Accessible label. Omit for purely decorative spinners inside a labelled parent. */
  label?: string;
  className?: string;
  style?: React.CSSProperties;
};

/** Shared loading indicator — replaces the six per-feature keyframe rings. */
export default function Spinner({ size = "md", tone = "inherit", label, className, style }: SpinnerProps) {
  return (
    <span
      className={"ui-spinner" + (className ? " " + className : "")}
      data-size={size}
      data-tone={tone === "inherit" ? undefined : tone}
      role={label ? "status" : undefined}
      aria-label={label}
      aria-hidden={label ? undefined : true}
      style={style}
    />
  );
}

/** Centered loading block for a pane / list / panel body. */
export function LoadingBlock({ label = "Loading…", size = "md" }: { label?: string; size?: SpinnerProps["size"] }) {
  return (
    <div className="ui-loading" role="status" aria-live="polite">
      <Spinner size={size} tone="accent" />
      <span>{label}</span>
    </div>
  );
}
