// Deployment / restart ledger writer. One row per backend boot captures exactly
// which version + commit went live and when — the spine the ops portal uses to
// correlate error spikes and outages against releases ("did the deploy cause
// it?"). Fail-soft: a ledger hiccup must never block startup.
import os from "os";
import { db, config } from "../platform";

export async function recordBoot(kind: "boot" | "deploy" | "restart" | "migrate" = "boot"): Promise<void> {
  try {
    await db.pool.query(
      "INSERT INTO deployments (kind, version, git_commit, env, node_version, hostname, pid) VALUES (?, ?, ?, ?, ?, ?, ?)",
      [
        kind,
        config.version || null,
        config.gitCommit || null,
        config.env || "unknown",
        process.version,
        os.hostname(),
        process.pid,
      ],
    );
    console.log(`[deploy] recorded ${kind}: v${config.version} (${config.gitCommit || "no-commit"}) env=${config.env}`);
  } catch (e: any) {
    // Table may not exist yet on the very first boot before migrations; never throw.
    console.warn("[deploy] could not record boot:", e?.message || e);
  }
}

export async function listDeployments(limit = 40): Promise<any[]> {
  try {
    const [rows] = await db.pool.query(
      "SELECT id, kind, version, git_commit, env, node_version, hostname, pid, started_at, notes FROM deployments ORDER BY started_at DESC LIMIT ?",
      [Math.min(200, Math.max(1, limit))],
    );
    return (rows as any[]) || [];
  } catch {
    return [];
  }
}
