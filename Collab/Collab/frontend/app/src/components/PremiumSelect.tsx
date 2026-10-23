import React from "react";
import Select, { type SelectOption } from "./ui/Select";

export type { SelectOption };

/**
 * PremiumSelect: unified select component matching the Chat More icon popup style.
 */
export default function PremiumSelect({
  value,
  options,
  onChange,
  ariaLabel,
  className = "",
  style,
}: {
  value: string;
  options: SelectOption[];
  onChange: (v: string) => void;
  ariaLabel?: string;
  className?: string;
  style?: React.CSSProperties;
}) {
  return (
    <Select
      value={value}
      options={options}
      onValueChange={onChange}
      ariaLabel={ariaLabel}
      className={`psel-trigger ${className}`}
      style={style}
    />
  );
}

