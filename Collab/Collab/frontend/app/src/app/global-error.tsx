"use client";
export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <html lang="en">
      <body
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
        <h2 style={{ fontSize: 22, fontWeight: 800 }}>Something went wrong</h2>
        <p style={{ color: "#4b5563" }}>An unexpected error occurred.</p>
        <button
          onClick={() => reset()}
          style={{
            padding: "9px 18px",
            borderRadius: 10,
            border: "none",
            background: "#8b29be",
            color: "#fff",
            fontWeight: 600,
            cursor: "pointer",
          }}
        >
          Try again
        </button>
      </body>
    </html>
  );
}
