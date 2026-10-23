export default function NotFound() {
  return (
    <div
      style={{
        minHeight: "100vh",
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        gap: 12,
        fontFamily: "system-ui, sans-serif",
        color: "#0D2144",
      }}
    >
      <h2 style={{ fontSize: 22, fontWeight: 800 }}>404 — Page not found</h2>
      <p style={{ color: "#4b5563" }}>
        This page doesn&rsquo;t exist in Collab.
      </p>
      <a href="/" style={{ color: "#8b29be", fontWeight: 600 }}>
        Go back home
      </a>
    </div>
  );
}
