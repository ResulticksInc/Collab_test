// Exercise the REAL backend signup code path (authService + db) to capture the
// exact error/stack behind the 500.
import { signup } from "../backend/app/src/services/authService";
import { db } from "../backend/app/src/platform";

(async () => {
  const email = "diag_be_" + Date.now() + "@colab.test";
  try {
    const out: any = await signup({ email, name: "Diag BE", password: "test123456" });
    console.log("signup RETURNED:", JSON.stringify({ hasToken: !!out?.token, user: out?.user }));
  } catch (e: any) {
    console.log("signup THREW:\n", e?.stack || e?.message);
  }
  // also call upsert directly through the app db layer
  try {
    const u: any = await db.users.upsert({
      id: "u_diagbe2_" + Date.now(), email: "diagbe2_" + Date.now() + "@colab.test",
      name: "Diag BE2", initials: "D", color: "#2563EB", role: "member", presence: "online",
      passwordHash: "x:y",
    });
    console.log("db.users.upsert RETURNED:", u === undefined ? "undefined" : JSON.stringify({ id: u.id, name: u.name }));
  } catch (e: any) {
    console.log("db.users.upsert THREW:\n", e?.stack || e?.message);
  }
  process.exit(0);
})();
