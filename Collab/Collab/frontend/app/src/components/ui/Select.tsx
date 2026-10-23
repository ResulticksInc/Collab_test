import React, {
  useState,
  useRef,
  useEffect,
  useCallback,
  useMemo,
  useId,
} from "react";
import { createPortal } from "react-dom";
import { calculatePosition, type Placement } from "../../lib/positioning";
import { useEsc } from "../../lib/escStack";
import { IconChevronDown, IconCheck } from "../../lib/icons";

export interface SelectOption {
  value: string;
  label: React.ReactNode;
  disabled?: boolean;
  icon?: React.ReactNode;
  swatch?: string;
  fontFamily?: string;
  className?: string;
}

export interface SelectProps
  extends Omit<React.ButtonHTMLAttributes<HTMLButtonElement>, "onChange" | "value"> {
  value?: string | number;
  defaultValue?: string | number;
  onChange?: (e: any) => void;
  onValueChange?: (value: string) => void;
  options?: SelectOption[] | Array<{ value: string; label: string; [key: string]: any }>;
  children?: React.ReactNode;
  placeholder?: string;
  name?: string;
  disabled?: boolean;
  required?: boolean;
  autoFocus?: boolean;
  className?: string;
  style?: React.CSSProperties;
  popupStyle?: React.CSSProperties;
  popupClassName?: string;
  placement?: Placement;
  size?: "sm" | "md" | "lg";
  ariaLabel?: string;
}

export default function Select({
  value: controlledValue,
  defaultValue,
  onChange,
  onValueChange,
  options,
  children,
  placeholder = "Select an option…",
  name,
  disabled = false,
  className = "",
  style,
  popupStyle,
  popupClassName = "",
  placement = "bottom-start",
  size,
  ariaLabel,
  id: explicitId,
  ...restTriggerProps
}: SelectProps) {
  const generatedId = useId();
  const id = explicitId || generatedId;

  // Uncontrolled vs controlled value
  const [internalValue, setInternalValue] = useState<string>(() => {
    if (controlledValue !== undefined) return String(controlledValue);
    if (defaultValue !== undefined) return String(defaultValue);
    return "";
  });

  const isControlled = controlledValue !== undefined;
  const currentValue = isControlled ? String(controlledValue) : internalValue;

  // Parse options from props or children (<option>, <optgroup>)
  const parsedOptions: SelectOption[] = useMemo(() => {
    if (options && options.length > 0) {
      return options.map((o: any) => {
        if (typeof o === "string") {
          return { value: o, label: o };
        }
        return {
          value: String(o.value ?? ""),
          label: o.label ?? o.value ?? "",
          disabled: !!o.disabled,
          icon: o.icon,
          swatch: o.swatch,
          fontFamily: o.fontFamily,
          className: o.className,
        };
      });
    }

    const opts: SelectOption[] = [];
    React.Children.forEach(children, (child) => {
      if (!React.isValidElement(child)) return;
      const type = (child.type as any)?.displayName || child.type;

      if (type === "option" || child.type === "option") {
        const p: any = child.props;
        const val = p.value !== undefined ? String(p.value) : String(p.children ?? "");
        opts.push({
          value: val,
          label: p.children ?? val,
          disabled: !!p.disabled,
          swatch: p["data-swatch"],
          fontFamily: p.style?.fontFamily,
          className: p.className,
        });
      } else if (type === "optgroup" || child.type === "optgroup") {
        const grpProps: any = child.props;
        React.Children.forEach(grpProps.children, (sub) => {
          if (!React.isValidElement(sub)) return;
          const subP: any = sub.props;
          const val = subP.value !== undefined ? String(subP.value) : String(subP.children ?? "");
          opts.push({
            value: val,
            label: subP.children ?? val,
            disabled: !!subP.disabled || !!grpProps.disabled,
            swatch: subP["data-swatch"],
            fontFamily: subP.style?.fontFamily,
            className: subP.className,
          });
        });
      }
    });

    return opts;
  }, [options, children]);

  // Current selected option object
  const currentOption = useMemo(() => {
    return parsedOptions.find((o) => o.value === currentValue) || null;
  }, [parsedOptions, currentValue]);

  // State
  const [isOpen, setIsOpen] = useState(false);
  const [coords, setCoords] = useState<{ top: number; left: number; width: number; maxHeight: number } | null>(null);
  const [focusedIndex, setFocusedIndex] = useState<number>(-1);

  const triggerRef = useRef<HTMLButtonElement>(null);
  const popupRef = useRef<HTMLDivElement>(null);

  // Position calculation matching FloatingMenu popup
  const updatePosition = useCallback(() => {
    if (!triggerRef.current || !popupRef.current) return;
    const triggerRect = triggerRef.current.getBoundingClientRect();
    const contentRect = popupRef.current.getBoundingClientRect();

    const result = calculatePosition({
      triggerRect,
      contentRect,
      placement,
      offset: 4,
      flip: true,
      shift: true,
      padding: 8,
    });

    // Space checks
    const viewportHeight = window.innerHeight;
    const spaceBelow = viewportHeight - triggerRect.bottom - 12;
    const spaceAbove = triggerRect.top - 12;
    const availableHeight = Math.max(140, Math.min(280, Math.max(spaceBelow, spaceAbove)));

    setCoords({
      top: result.top,
      left: result.left,
      width: Math.max(triggerRect.width, 160),
      maxHeight: availableHeight,
    });
  }, [placement]);

  // Esc key closes the dropdown and returns focus to trigger
  useEsc(isOpen, () => {
    setIsOpen(false);
    triggerRef.current?.focus();
  });

  // Handle open / outside clicks / scroll / resize
  useEffect(() => {
    if (!isOpen) return;

    updatePosition();
    const curIdx = parsedOptions.findIndex((o) => o.value === currentValue);
    setFocusedIndex(curIdx >= 0 ? curIdx : 0);

    const onMouseDown = (e: MouseEvent) => {
      const target = e.target as Node;
      if (triggerRef.current?.contains(target)) return;
      if (popupRef.current?.contains(target)) return;
      setIsOpen(false);
    };

    const onReposition = () => updatePosition();

    document.addEventListener("mousedown", onMouseDown);
    window.addEventListener("resize", onReposition);
    window.addEventListener("scroll", onReposition, { capture: true, passive: true });

    return () => {
      document.removeEventListener("mousedown", onMouseDown);
      window.removeEventListener("resize", onReposition);
      window.removeEventListener("scroll", onReposition, true);
    };
  }, [isOpen, currentValue, parsedOptions, updatePosition]);

  // Scroll active item into view on open
  useEffect(() => {
    if (isOpen && popupRef.current && focusedIndex >= 0) {
      const items = popupRef.current.querySelectorAll<HTMLButtonElement>(".ui-select-item");
      const target = items[focusedIndex];
      if (target) {
        target.scrollIntoView({ block: "nearest" });
      }
    }
  }, [isOpen, focusedIndex]);

  // Handle value change
  const selectValue = useCallback(
    (newVal: string) => {
      if (!isControlled) {
        setInternalValue(newVal);
      }
      setIsOpen(false);
      triggerRef.current?.focus();

      if (onValueChange) {
        onValueChange(newVal);
      }

      if (onChange) {
        // Create an event object that fulfills React synthetic event requirements
        // AND converts seamlessly to string if passed to a string-expecting callback
        const syntheticEvent = {
          target: { value: newVal, name: name || "" },
          currentTarget: { value: newVal, name: name || "" },
          value: newVal,
          preventDefault: () => {},
          stopPropagation: () => {},
          toString: () => newVal,
          valueOf: () => newVal,
        };

        try {
          onChange(syntheticEvent);
        } catch {
          try {
            (onChange as any)(newVal);
          } catch {
            // ignore
          }
        }
      }
    },
    [isControlled, name, onChange, onValueChange]
  );

  // Keyboard navigation on trigger
  const handleTriggerKeyDown = (e: React.KeyboardEvent<HTMLButtonElement>) => {
    if (disabled) return;

    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      setIsOpen(true);
    } else if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      setIsOpen((prev) => !prev);
    }
  };

  // Keyboard navigation inside popup
  const handlePopupKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    const enabledIndices = parsedOptions
      .map((opt, idx) => (opt.disabled ? -1 : idx))
      .filter((idx) => idx !== -1);

    if (enabledIndices.length === 0) return;

    if (e.key === "ArrowDown") {
      e.preventDefault();
      setFocusedIndex((prev) => {
        const curPos = enabledIndices.indexOf(prev);
        const nextPos = curPos < enabledIndices.length - 1 ? curPos + 1 : 0;
        return enabledIndices[nextPos];
      });
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setFocusedIndex((prev) => {
        const curPos = enabledIndices.indexOf(prev);
        const prevPos = curPos > 0 ? curPos - 1 : enabledIndices.length - 1;
        return enabledIndices[prevPos];
      });
    } else if (e.key === "Home") {
      e.preventDefault();
      setFocusedIndex(enabledIndices[0]);
    } else if (e.key === "End") {
      e.preventDefault();
      setFocusedIndex(enabledIndices[enabledIndices.length - 1]);
    } else if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      if (focusedIndex >= 0 && focusedIndex < parsedOptions.length) {
        const opt = parsedOptions[focusedIndex];
        if (!opt.disabled) {
          selectValue(opt.value);
        }
      }
    } else if (e.key === "Escape") {
      e.preventDefault();
      setIsOpen(false);
      triggerRef.current?.focus();
    }
  };

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        id={id}
        name={name}
        role="combobox"
        aria-haspopup="listbox"
        aria-expanded={isOpen}
        aria-label={ariaLabel}
        disabled={disabled}
        data-size={size}
        className={`ui-select-trigger ${className} ${isOpen ? "open" : ""}`}
        style={style}
        onClick={() => {
          if (!disabled) setIsOpen((prev) => !prev);
        }}
        onKeyDown={handleTriggerKeyDown}
        {...restTriggerProps}
      >
        {currentOption?.swatch ? (
          <span className="ui-select-swatch" style={{ background: currentOption.swatch }} />
        ) : null}
        {currentOption?.icon ? (
          <span className="ui-select-icon">{currentOption.icon}</span>
        ) : null}

        <span
          className="ui-select-label"
          style={currentOption?.fontFamily ? { fontFamily: currentOption.fontFamily } : undefined}
        >
          {currentOption ? currentOption.label : placeholder}
        </span>

        <IconChevronDown size={14} className="ui-select-chev" />
      </button>

      {isOpen && typeof document !== "undefined"
        ? createPortal(
            <div
              ref={popupRef}
              role="listbox"
              aria-label={ariaLabel || "Options"}
              tabIndex={-1}
              onKeyDown={handlePopupKeyDown}
              className={`ui-select-popup ${popupClassName}`}
              style={{
                position: "fixed",
                top: coords ? coords.top : -9999,
                left: coords ? coords.left : -9999,
                minWidth: coords ? coords.width : 160,
                maxHeight: coords ? coords.maxHeight : 280,
                visibility: coords ? "visible" : "hidden",
                ...popupStyle,
              }}
            >
              {parsedOptions.map((opt, idx) => {
                const isSelected = opt.value === currentValue;
                const isFocused = idx === focusedIndex;

                return (
                  <button
                    key={`${opt.value}-${idx}`}
                    type="button"
                    role="option"
                    aria-selected={isSelected}
                    disabled={opt.disabled}
                    className={`ui-select-item ${isSelected ? "selected" : ""} ${
                      isFocused ? "focused" : ""
                    } ${opt.className || ""}`}
                    onClick={() => {
                      if (!opt.disabled) selectValue(opt.value);
                    }}
                    onMouseEnter={() => {
                      if (!opt.disabled) setFocusedIndex(idx);
                    }}
                    style={opt.fontFamily ? { fontFamily: opt.fontFamily } : undefined}
                  >
                    <div style={{ display: "flex", alignItems: "center", gap: 8, minWidth: 0, flex: 1 }}>
                      {opt.swatch ? (
                        <span className="ui-select-swatch" style={{ background: opt.swatch }} />
                      ) : null}
                      {opt.icon ? (
                        <span className="ui-select-icon">{opt.icon}</span>
                      ) : null}
                      <span className="ui-select-item-label">{opt.label}</span>
                    </div>

                    {isSelected ? (
                      <IconCheck size={14} className="ui-select-item-check" />
                    ) : null}
                  </button>
                );
              })}
            </div>,
            document.body
          )
        : null}
    </>
  );
}
