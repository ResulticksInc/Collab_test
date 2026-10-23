import React from "react";

export type EmptyStateProps = {
  icon?: React.ReactNode;
  title: React.ReactNode;
  description?: React.ReactNode;
  /** Usually one or two <Button>s. */
  actions?: React.ReactNode;
  size?: "default" | "compact";
  className?: string;
};

/**
 * Shared empty state — icon tile, title, one-line description, optional CTA.
 * Replaces the ~17 bespoke per-module `.xxx-empty` blocks as screens are
 * redesigned; the layout stays uniform and only the copy/icon vary.
 */
export default function EmptyState({ icon, title, description, actions, size = "default", className }: EmptyStateProps) {
  return (
    <div className={"ui-empty" + (className ? " " + className : "")} data-size={size === "compact" ? "compact" : undefined}>
      {icon ? (
        <div className="ui-empty-icon" aria-hidden="true">
          {icon}
        </div>
      ) : null}
      <div className="ui-empty-title">{title}</div>
      {description ? <div className="ui-empty-desc">{description}</div> : null}
      {actions ? <div className="ui-empty-actions">{actions}</div> : null}
    </div>
  );
}
