"use client";
import { useMemo } from "react";
import qrcode from "qrcode-generator";

/**
 * Inline SVG QR code (one <path> of all dark modules, crisp at any size).
 * Used by the meeting-info popover to offer the join link as a scannable code.
 * `value` is encoded at error-correction level M with auto type sizing.
 */
export default function QrCode({
  value,
  size = 84,
  className,
  title,
}: {
  value: string;
  size?: number;
  className?: string;
  title?: string;
}) {
  const { d, n } = useMemo(() => {
    try {
      const qr = qrcode(0, "M");
      qr.addData(String(value || ""));
      qr.make();
      const n = qr.getModuleCount();
      let d = "";
      for (let r = 0; r < n; r++)
        for (let c = 0; c < n; c++) if (qr.isDark(r, c)) d += `M${c} ${r}h1v1h-1z`;
      return { d, n };
    } catch {
      return { d: "", n: 0 };
    }
  }, [value]);
  if (!n) return null;
  return (
    <svg
      viewBox={`0 0 ${n} ${n}`}
      width={size}
      height={size}
      className={className}
      shapeRendering="crispEdges"
      role="img"
      aria-label={title || "QR code"}
    >
      {title ? <title>{title}</title> : null}
      <path d={d} fill="#111" />
    </svg>
  );
}
