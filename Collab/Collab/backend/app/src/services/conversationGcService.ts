import { db } from "../platform";

// BA/CEO: daily sweep — soft-delete AUTO-EXPIRING temporary groups (created from
// an ended call/meeting's chat) once they pass their 7-day TTL. Mirrors the
// files-GC retention pattern; scheduled daily from index.ts.
export async function sweepExpiredTempGroups(): Promise<{ deleted: number }> {
  try {
    const deleted = await (db as any).conversations.sweepExpiredTemporary();
    return { deleted: Number(deleted) || 0 };
  } catch (e: any) {
    console.error("[temp-group-gc] sweep failed:", e?.message || e);
    return { deleted: 0 };
  }
}
