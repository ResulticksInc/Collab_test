import { useEffect, useState } from "react";

// Gallery page size by device tier (VIEW-20): phone 4 · tablet 9 · laptop 16 ·
// desktop 25. Shared by meetings (MeetingStage) and calls (useCallSessionMedia)
// so a large group call pages exactly like a large meeting.
export function pageSizeForWidth(w: number): number {
  return w < 640 ? 4 : w < 1024 ? 9 : w < 1440 ? 16 : 25;
}

// Live page size. It used to be read from window.innerWidth inline during
// render, with nothing listening for resize — so dragging the window narrower
// (or rotating a tablet) kept the old page size until some unrelated re-render.
export function useGalleryPageSize(): number {
  const [size, setSize] = useState(() =>
    typeof window !== "undefined" ? pageSizeForWidth(window.innerWidth) : 16,
  );
  useEffect(() => {
    const onResize = () => {
      const next = pageSizeForWidth(window.innerWidth);
      setSize((prev) => (prev === next ? prev : next)); // re-render only on a tier change
    };
    window.addEventListener("resize", onResize);
    window.addEventListener("orientationchange", onResize);
    return () => {
      window.removeEventListener("resize", onResize);
      window.removeEventListener("orientationchange", onResize);
    };
  }, []);
  return size;
}

// Which tiles are on `page`, given a ranking (lower rank = earlier). Stable for
// equal ranks, so people don't reshuffle as they talk. Returns the clamped page
// index too, so a caller can correct a page that no longer exists.
export function pageSlice<T>(
  items: T[],
  rank: (item: T) => number,
  page: number,
  pageSize: number,
): { visible: T[]; pages: number; page: number } {
  const ordered = items
    .map((item, i) => ({ item, i, r: rank(item) }))
    .sort((a, b) => a.r - b.r || a.i - b.i)
    .map((x) => x.item);
  const pages = Math.max(1, Math.ceil(ordered.length / pageSize));
  const cur = Math.min(Math.max(0, page), pages - 1);
  return { visible: ordered.slice(cur * pageSize, cur * pageSize + pageSize), pages, page: cur };
}
