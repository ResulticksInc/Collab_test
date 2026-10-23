"use client";
import dynamic from "next/dynamic";

// Collab Admin Portal ("/admin") — Administrative Control Plane.
// Rendered CLIENT-ONLY (no SSR): first render depends on browser-only admin JWT
// in localStorage (clb_admin_token), preventing hydration mismatches.
const AdminPortal = dynamic(() => import("../../components/admin/AdminPortal"), {
  ssr: false,
  loading: () => <div style={{ position: "fixed", inset: 0, background: "#090d16" }} />,
});

export default function AdminPage() {
  return <AdminPortal />;
}
