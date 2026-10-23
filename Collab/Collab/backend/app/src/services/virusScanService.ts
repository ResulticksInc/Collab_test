// Virus-scan integration point (P0-E) — HOOK ONLY, NO-OP BY DEFAULT.
//
// This is the single, clearly-marked place a real malware scanner (ClamAV via
// clamd, an AV gateway, a cloud scanning API, etc.) gets wired in later. It is
// intentionally a no-op until FILES_VIRUS_SCAN_ENABLED is set AND a scanner
// backend is provisioned — actual scanning needs INFRASTRUCTURE (a clamd daemon
// / scanning service reachable from the backend, with the malware signature DB
// kept current). That infra is NOT part of this change, so shipping a real
// scanner here would either silently pass everything (false security) or block
// every upload (false positives). Hence: hook only.
//
// Contract for a future implementor:
//   • Called fire-and-forget from the upload-complete path (see routes/files.ts)
//     so it NEVER blocks or slows the streaming upload response.
//   • On a real positive, quarantine the file via the normal soft-delete path
//     (fileService.remove with a system actor) and notify the uploader — do NOT
//     hard-delete here (the GC sweeper owns permanent deletion).
//   • Must tolerate the object still settling in S3 (read via storageService).
//
// Until then this records intent (debug log when enabled) and returns a stable
// "skipped" result so callers can branch without special-casing.

import { config } from "../platform";

export interface ScanResult {
  scanned: boolean;
  clean: boolean | null; // null = unknown / not scanned
  reason: string;
}

function scanEnabled(): boolean {
  // Reads an explicit opt-in flag. Absent/false ⇒ disabled (the default).
  return Boolean((config as any)?.files?.virusScanEnabled) === true;
}

// scanFile(key, meta): the clean integration point. NO-OP by default.
//   key  — the storage (S3) object key for the uploaded blob (null for the rare
//          BLOB-fallback path; a real scanner would read the row's `data`).
//   meta — { id, uploaderId, name, mime, size, conversationId } upload context.
export async function scanFile(
  key: string | null,
  meta: { id: string; name?: string; mime?: string; size?: number } & Record<string, any>,
): Promise<ScanResult> {
  if (!scanEnabled()) {
    return { scanned: false, clean: null, reason: "scanning disabled (no-op hook)" };
  }
  // ── INFRA-DEPENDENT: real scanner goes here ───────────────────────────────
  // A real implementation would stream the object (storageService.getStream(key))
  // to a clamd socket / scanning API and map the verdict onto ScanResult, then
  // quarantine on a positive. Left unimplemented on purpose — it requires a
  // scanner backend that is not provisioned in this environment. We log the
  // intent so an operator can confirm the hook fired once a scanner is wired.
  console.log(
    "[virus-scan] enabled but no scanner backend wired — skipping",
    meta && meta.id,
    key || "(blob)",
  );
  return { scanned: false, clean: null, reason: "no scanner backend configured" };
}
