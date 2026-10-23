// Route-level loading fallback (Next App Router). Shown while the page chunk
// loads — a minimal, theme-aware centered spinner so the first paint isn't blank.
export default function Loading() {
  return (
    <div
      style={{
        minHeight: "100vh",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        background: "var(--boot-bg, #e8ddff)",
      }}
    >
      <div
        style={{
          width: 34,
          height: 34,
          borderRadius: "50%",
          border: "3px solid var(--g200, #e5e7eb)",
          borderTopColor: "var(--ac, #2563EB)",
          animation: "clb-spin 0.8s linear infinite",
        }}
      />
      <style>{`@keyframes clb-spin { to { transform: rotate(360deg); } }`}</style>
    </div>
  );
}
