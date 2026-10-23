import React from "react";
import Spinner from "./Spinner";

export type ButtonVariant =
  | "primary"
  | "secondary"
  | "ghost"
  | "danger"
  | "danger-soft"
  | "accent-soft";
export type ButtonSize = "sm" | "md" | "lg";

export type ButtonProps = Omit<React.ButtonHTMLAttributes<HTMLButtonElement>, "type"> & {
  variant?: ButtonVariant;
  size?: ButtonSize;
  /** Shows a spinner in place of the label and blocks clicks. */
  loading?: boolean;
  /** Square button holding only an icon — pass aria-label. */
  iconOnly?: boolean;
  /** Stretch to the container width. */
  block?: boolean;
  /** Optional leading / trailing adornments. */
  leading?: React.ReactNode;
  trailing?: React.ReactNode;
  type?: "button" | "submit" | "reset";
};

/**
 * The one button. Class-driven (see styles/ui.css) so the Figma restyle is a
 * token edit, not a hunt through inline styles. Covers hover / active / focus
 * / disabled / loading; `Btn` in Modal.tsx delegates here for legacy callers.
 */
const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  {
    variant = "secondary",
    size = "md",
    loading = false,
    iconOnly = false,
    block = false,
    leading,
    trailing,
    disabled,
    className,
    children,
    type = "button",
    onClick,
    ...rest
  },
  ref,
) {
  const isDisabled = !!disabled || loading;
  return (
    <button
      ref={ref}
      type={type}
      className={"ui-btn" + (className ? " " + className : "")}
      data-variant={variant}
      data-size={size}
      data-loading={loading ? "true" : undefined}
      data-icon-only={iconOnly ? "true" : undefined}
      data-block={block ? "true" : undefined}
      disabled={isDisabled}
      aria-busy={loading || undefined}
      onClick={isDisabled ? undefined : onClick}
      {...rest}
    >
      {loading ? (
        <span className="ui-btn-spin" aria-hidden="true">
          <Spinner size="sm" />
        </span>
      ) : null}
      <span className="ui-btn-label" style={{ display: "inline-flex", alignItems: "center", gap: 8 }}>
        {leading}
        {children}
        {trailing}
      </span>
    </button>
  );
});

export default Button;
