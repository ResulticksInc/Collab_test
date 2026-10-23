import React from "react";

export type SkeletonProps = {
  width?: number | string;
  height?: number | string;
  shape?: "rect" | "circle" | "text";
  className?: string;
  style?: React.CSSProperties;
};

/** Shimmering placeholder. Compose several for a row / card skeleton. */
export default function Skeleton({ width, height, shape = "rect", className, style }: SkeletonProps) {
  return (
    <span
      className={"ui-skel" + (className ? " " + className : "")}
      data-shape={shape}
      aria-hidden="true"
      style={{
        width: width ?? (shape === "circle" ? height ?? 32 : "100%"),
        height: height ?? (shape === "circle" ? width ?? 32 : shape === "text" ? 12 : 16),
        ...style,
      }}
    />
  );
}

/** A list-row skeleton: avatar + two text lines. */
export function SkeletonRow({ avatar = 36 }: { avatar?: number }) {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 12, padding: "10px 14px" }} aria-hidden="true">
      <Skeleton shape="circle" width={avatar} height={avatar} />
      <div style={{ flex: 1, display: "flex", flexDirection: "column", gap: 8 }}>
        <Skeleton shape="text" width="55%" />
        <Skeleton shape="text" width="80%" />
      </div>
    </div>
  );
}
