import http from "http";
import { config, db, seedIfNeeded, shared } from "./platform";
import {
  ensureDatabase,
  migrate,
  promoteIfNeeded,
  isTransientDbError,
} from "../../../database/src";
import { createApp } from "./app";
import { recordBoot } from "./services/deploymentService";
import { attachRealtime, broadcast } from "./realtime/socket";
import { purgeOlderThan } from "./services/recordingService";
import { runGc as runFilesGc } from "./services/fileGcService";
import { runTier as runFilesTier } from "./services/fileTierService";
import * as diskStorage from "./services/diskStorageService";
import { tierOrder as fileTierOrder } from "./services/fileService";
import { runDue as runDueScheduled } from "./services/scheduledMessageService";
import { runDue as runDueBroadcasts } from "./services/orgBroadcastService";
import { runDue as runDueReminders } from "./services/reminderFireService";
import { runDue as runDueMeetingReminders } from "./services/meetingReminderFireService";
import { runDue as runDueEndWarnings } from "./services/meetingEndWarningService";
import { pruneOldOccurrences as pruneOldReminders } from "./services/reminderService";
import { runDue as runDueTasks } from "./services/taskDueFireService";
import { sweepSessions } from "./services/sessionGcService";
import { sweepExpiredTempGroups } from "./services/conversationGcService";
import { pushNotif } from "./realtime/notify";
import * as callService from "./services/callService";
import { ensureBucket } from "./services/storageService";
import { init as initWebPush } from "./services/webPushService";
import { initLeaderElection, isLeader } from "./services/leaderElectionService";
import { drain as drainWebhooks, sweep as sweepWebhooks } from "./services/webhookService";
import {
  drain as drainConnectors,
  sweep as sweepConnectors,
  enqueueCalendarPulls as pullConnectorCalendars,
} from "./services/connectorService";
const { EVENTS } = shared;

// Production safety net: a single rejected request promise (e.g. unexpected DB
// error) must never take the whole server down. Log and keep serving.
process.on("unhandledRejection", (reason: any) => {
  console.error("[unhandledRejection]", reason);
  // Ledger (error_logs table) — lazy import so a broken build of the service
  // can never stop the process-level safety net from installing.
  import("./services/logService")
    .then((m) =>
      m.record({
        source: "process",
        severity: "error",
        code: reason?.code,
        message: reason?.message || String(reason),
        stack: reason?.stack,
      }),
    )
    .catch(() => {});
});
process.on("uncaughtException", (err: any) => {
  console.error("[uncaughtException]", err);
  import("./services/logService")
    .then((m) =>
      m.record({
        source: "process",
        severity: "fatal",
        code: err?.code,
        message: err?.message || String(err),
        stack: err?.stack,
      }),
    )
    .catch(() => {});
});

// Fail fast in production if security-critical secrets are still the dev
// defaults (or too short to be safe). Better to refuse to boot than to run a
// production server anyone can forge tokens for.
function assertProductionSecrets() {
  if (config.env !== "production") return;
  const weak: string[] = [];
  if (
    config.auth.jwtSecret === "dev-only-change-me" ||
    config.auth.jwtSecret.length < 32
  )
    weak.push("AUTH_JWT_SECRET (set a random value of at least 32 chars)");
  if (config.livekit.apiSecret === "devsecret_change_me_to_a_long_random_value_min32")
    weak.push("LIVEKIT_API_SECRET (set the real LiveKit secret)");
  // SECURITY: if the ops portal is enabled in production, its password must not be
  // a known default. An empty password already disables the portal entirely — this
  // guard only fires when a password IS set but looks like the committed default.
  const knownOpsDefaults = ["CollabOps!2026", "admin", "changeme", "password"];
  if (
    config.ops?.portalPassword &&
    knownOpsDefaults.includes(config.ops.portalPassword)
  )
    weak.push(`OPS_PORTAL_PASSWORD must not be a known default (rotate immediately; found: "${config.ops.portalPassword}")`);
  // Admin portal: a known default password is only dangerous when the portal is
  // actually reachable, i.e. an admin email is configured.
  if (config.admin?.email && ["admin1234", "admin", "changeme", "password"].includes(config.admin.password))
    weak.push("ADMIN_PASSWORD must not be a known default (set a strong unique value)");
  // E2EE escrow: without its own secret the account-key escrow silently falls
  // back to the JWT secret, so rotating either breaks recovery and the JWT
  // secret doubles as the backup key.
  if (config.e2ee?.enabled && config.e2ee?.autoRecovery && !config.e2ee?.escrowSecret)
    weak.push("E2EE_ESCROW_SECRET (required when E2EE_ENABLED and E2EE_AUTO_RECOVERY are on)");
  // NOTE: the internal DB + MinIO creds are intentionally NOT gated here. This
  // deployment runs on a private, firewalled, single-tenant corporate network
  // where the bundled datastore creds are acceptable and these values never
  // surface in the product UI. The JWT/LiveKit secrets above ARE real and gated.
  if (weak.length) {
    console.error(
      "[boot] FATAL: refusing to start in production with weak/default secrets:\n  - " +
        weak.join("\n  - "),
    );
    process.exit(1);
  }
}

// Production LIVEKIT_WS_URL must point to a real server, not localhost. If it's
// blank or uses localhost/127.0.0.1, the browser will try to connect to itself
// and calls/meetings will fail silently.
function assertLiveKitUrl() {
  if (config.env !== "production") return;
  const url = config.livekit.wsUrl;
  if (!url || url.includes("localhost") || url.includes("127.0.0.1")) {
    console.error(
      "[boot] FATAL: LIVEKIT_WS_URL must point to the public server (e.g. ws://10.205.11.8:7530/livekit).\n" +
        "  Current value: " + (url || "(empty)") + "\n" +
        "  Set LIVEKIT_WS_URL in .env to the browser-reachable LiveKit signalling URL.",
    );
    process.exit(1);
  }
}

// Multi-instance safety: a fleet of ≥2 backend replicas MUST share a Redis or
// cross-instance message/call/presence fan-out is silently lost (each process
// falls back to its own in-memory Socket.IO adapter). REDIS_REQUIRED=true turns
// that silent degradation into a loud, fail-closed boot error.
function assertRedisRequired() {
  if (config.redis.required && !config.redis.url) {
    console.error(
      "[boot] FATAL: REDIS_REQUIRED=true but REDIS_URL is empty.\n" +
        "  A multi-replica deployment must share a Redis, or cross-instance\n" +
        "  message/call/presence delivery breaks. Set REDIS_URL, or set\n" +
        "  REDIS_REQUIRED=false for a single-instance deployment.",
    );
    process.exit(1);
  }
}

// If DB_PROFILE is set in .env, the corresponding DATABASE_URL_<PROFILE> must
// exist. Prevents silent fallback to the wrong database.
function assertDbProfile() {
  const profile = process.env.DB_PROFILE || "";
  if (profile) {
    const key = "DATABASE_URL_" + profile.toUpperCase();
    if (!process.env[key]) {
      console.error(
        "[boot] FATAL: DB_PROFILE is set to '" + profile + "' but " + key + " is not set.\n" +
          "  Add " + key + "=mysql://user:pass@host:port/db to .env, or clear DB_PROFILE to use DATABASE_URL directly.",
      );
      process.exit(1);
    }
  }
}

(async () => {
  assertProductionSecrets();
  assertLiveKitUrl();
  assertDbProfile();
  assertRedisRequired();

  // Self-provision: create the database if missing, then apply (idempotent)
  // migrations, so the app boots against a bare MySQL with no manual setup.
  //
  // Resilient boot: if the database simply isn't up YET (cold Docker Desktop,
  // container still initializing, VPN flake) we wait and retry — by default
  // forever — instead of dying. `tsx watch` does NOT restart an exited
  // process until a file changes, so exiting here used to strand dev until a
  // manual re-run even after MySQL came up. Real config errors (bad SQL,
  // wrong database name, etc.) still crash loudly. Cap the wait with
  // DB_BOOT_RETRY_MS if you prefer fail-fast (e.g. in CI).
  // JSON driver: skip the MySQL provision / migration / promote / seed loop —
  // the JSON file driver self-initialises its local-data/ directory on first use
  // and seeds itself when DEMO_MODE=yes is set. No MySQL connection needed.
  const _isJsonDriver = (process.env.DATABASE_DRIVER || "mysql").toLowerCase().trim() === "json";
  if (_isJsonDriver) {
    console.log("[boot] DATABASE_DRIVER=json — skipping MySQL provision/migrate (no Docker needed).");
    await seedIfNeeded();
  } else {
    const capMs = Number(process.env.DB_BOOT_RETRY_MS) || 0; // 0 = forever
    const deadline = capMs > 0 ? Date.now() + capMs : Infinity;
    const target = (() => {
      try {
        const u = new URL(config.database.url);
        return `${u.hostname}:${u.port || 3306}`;
      } catch {
        return "the database";
      }
    })();
    for (let attempt = 1; ; attempt++) {
      try {
        await ensureDatabase(config.database.url);
        await migrate(config.database.url);
        // Auto-promote: on the very FIRST live boot, import the bundled
        // localhost-DB snapshot into the target DB so the team's last weeks of
        // signups + messages survive the cutover. Idempotent (consults
        // deploy_state); refuses to clobber a populated target. See
        // database/src/bootstrap.ts -> promoteIfNeeded().
        await promoteIfNeeded(config.database.url);
        await seedIfNeeded();
        break;
      } catch (e: any) {
        if (!isTransientDbError(e) || Date.now() > deadline) throw e;
        console.warn(
          `[boot] database not reachable yet at ${target} (${e.code || e.message}) — ` +
            `retrying; it will connect automatically once MySQL is up ` +
            `(start it with: docker compose up -d db).`,
        );
        if (attempt === 3)
          console.warn(
            `[boot] still waiting — if the host/credentials in DATABASE_URL are wrong, ` +
              `this will never succeed; double-check .env.`,
          );
        await new Promise((r) => setTimeout(r, 5000));
      }
    }
  }

  // Record this boot in the deployment ledger (fire-and-forget; runs after
  // migrations so the table exists). The ops portal correlates error spikes and
  // outages against these timestamps to attribute incidents to a release.
  void recordBoot("boot");
  initWebPush();
  initLeaderElection();
  const app = createApp();
  const server = http.createServer(app);
  const io = attachRealtime(server);
  app.set("io", io);
  // Ensure the S3/MinIO bucket exists. MinIO can still be starting when the
  // backend boots (compose depends_on uses condition: service_started, and the
  // image ships no healthcheck), so a one-shot best-effort check would lose the
  // race, leave the bucket uncreated, and make uploads fail with NoSuchBucket.
  // Retry with backoff so it's created as soon as MinIO is ready. Non-fatal:
  // storageService.upload() ALSO lazily ensures the bucket, and small uploads
  // fall back to BLOB storage.
  // Local file-storage tier (docs/FILE_UPLOAD_STORAGE_CHAIN.md): make sure the
  // volume root exists and log where it is + how full. Never fatal — a missing
  // or read-only volume just means the upload chain falls through to MinIO.
  void diskStorage
    .ping()
    .then((d) =>
      console.log(
        "[boot] file storage tiers=%s dir=%s free=%d MB (%d%% used)",
        fileTierOrder().join(","),
        d.dir,
        Math.round(d.freeBytes / 1048576),
        d.usedPct,
      ),
    )
    .catch((e: any) =>
      console.warn(
        "[boot] local file-storage tier unavailable (uploads will use the next tier):",
        e?.message || e,
      ),
    );
  void (async () => {
    for (let attempt = 1; attempt <= 10; attempt++) {
      try {
        await ensureBucket();
        return;
      } catch (e: any) {
        if (attempt === 10) {
          console.warn(
            "[boot] S3 bucket not ready after retries:",
            e?.message,
          );
          return;
        }
        await new Promise((r) => setTimeout(r, 3000));
      }
    }
  })();
  // Sweep stale ringing calls from before server restart
  void (async () => {
    try {
      const { db } = await import("./platform");
      const stale = await db.calls.findStaleRinging(config.calls.missedTimeoutMs);
      for (const c of stale) {
        const missed = await callService.markMissed(c.id);
        if (missed) console.log("[boot] swept stale ringing call id=%s", c.id);
      }
      if (stale.length) console.log("[boot] swept %d stale ringing calls", stale.length);
    } catch (e: any) {
      console.warn("[boot] stale call sweep failed:", e?.message);
    }
  })();
  // Scheduled messages (P1.7): poll for due messages and deliver each through
  // the normal message path, then broadcast it like any other new message.
  // Interval is configurable; defaults to 20s.
  const tickScheduled = () => {
    if (!isLeader()) return Promise.resolve([]);
    return runDueScheduled()
      .then((sent) => {
        for (const s of sent) {
          io.to(broadcast.room(s.conversationId)).emit(
            EVENTS.MESSAGE_NEW,
            s.message,
          );
          io.to(broadcast.userRoom(s.senderId)).emit(EVENTS.SCHEDULED_CHANGED, {
            conversationId: s.conversationId,
          });
        }
      })
      .catch((e) => console.error("[scheduled] tick failed:", e));
  };
  // Scheduled times are minute-precise (HH:MM:00), so fire SHARPLY at the top of
  // each minute — a message due at HH:MM sends right at HH:MM:00, not up to a
  // poll-interval later. The +60ms nudge guarantees we're just past the boundary
  // so `send_at <= now`. A light safety poll (default 15s) covers timer drift /
  // a missed tick / odd-second schedules.
  // Reminders firing engine: at each minute boundary, fire any due reminders and
  // deliver each as a live notification (toast + Activity badge + notification
  // center) plus a REMINDER_CHANGED nudge so the list restyles. Same
  // minute-aligned + safety-poll shape as scheduled messages. Pure DB-scan +
  // notification fan-out — never touches the call/meeting media path.
  const tickReminders = () => {
    if (!isLeader()) return Promise.resolve([]);
    return runDueReminders()
      .then((fired) => {
        for (const f of fired) {
          pushNotif(io, f.notification);
          io.to(broadcast.userRoom(f.userId)).emit(EVENTS.REMINDER_CHANGED, {});
        }
      })
      .catch((e) => console.error("[reminders] tick failed:", e));
  };
  // Task due-date firing: at each minute boundary (+ a safety poll), fire any due
  // tasks and deliver each as a live notification (toast + Activity badge +
  // notification center) plus a TASK_CHANGED nudge so the board restyles. Same
  // minute-aligned shape as reminders; routes through pushNotif so it inherits the
  // same quiet-hours/mute gate. Pure DB-scan + notification fan-out — never touches
  // the call/meeting media path.
  const tickTasks = () => {
    if (!isLeader()) return Promise.resolve([]);
    return runDueTasks()
      .then((fired) => {
        for (const f of fired) {
          pushNotif(io, f.notification);
          io.to(broadcast.userRoom(f.userId)).emit(EVENTS.TASK_CHANGED, {});
        }
      })
      .catch((e) => console.error("[tasks] due tick failed:", e));
  };
  // Meeting reminders (#53): at each minute boundary (+ a safety poll), notify a
  // meeting's attendees + host a configurable lead before it starts — EXACTLY ONCE
  // per occurrence (recurring meetings included, via the meeting_reminders_sent
  // ledger). Routes through pushNotif so it inherits the quiet-hours/mute gate, and
  // nudges the calendar via MEETING_UPDATED. Pure DB-scan + notification fan-out —
  // never touches the call/meeting MEDIA path.
  const tickMeetingReminders = () => {
    if (!isLeader()) return Promise.resolve([]);
    return runDueMeetingReminders()
      .then((fired) => {
        for (const f of fired) {
          pushNotif(io, f.notification);
          io.to(broadcast.userRoom(f.userId)).emit(EVENTS.MEETING_UPDATED, {});
        }
      })
      .catch((e) => console.error("[meeting-reminders] tick failed:", e));
  };
  // Scheduled ORG BROADCASTS (BA #6): same minute-aligned + safety-poll shape as
  // scheduled messages. The service claims each due row atomically, so running
  // several app instances can never double-send an announcement.
  const tickBroadcasts = () => {
    if (!isLeader()) return Promise.resolve([]);
    return runDueBroadcasts()
      .then((sent) => {
        for (const s of sent)
          for (const n of s.notifications) pushNotif(io, n);
      })
      .catch((e) => console.error("[org-broadcast] tick failed:", e));
  };
  // MEETING END WARNINGS: "ends in 10 minutes", then "…in 5". Scans only
  // meetings with live participants, so this is a cheap tick even on a busy
  // deployment. Leader-gated like every other fan-out timer, and the ledger
  // claim makes it exactly-once regardless.
  const tickEndWarnings = () => {
    if (!isLeader()) return Promise.resolve([]);
    return runDueEndWarnings()
      .then((fired) => {
        for (const f of fired) pushNotif(io, f.notification);
      })
      .catch((e) => console.error("[meeting-end] tick failed:", e));
  };
  const alignToMinute = () => {
    const delay = 60000 - (Date.now() % 60000) + 60;
    setTimeout(() => {
      tickScheduled();
      tickReminders();
      tickMeetingReminders();
      tickEndWarnings();
      tickTasks();
      tickBroadcasts();
      alignToMinute();
    }, delay);
  };
  alignToMinute();
  const schedSeconds = Number(process.env.SCHEDULED_POLL_SECONDS) || 15;
  setInterval(tickScheduled, schedSeconds * 1000);
  setInterval(tickReminders, schedSeconds * 1000);
  setInterval(tickMeetingReminders, schedSeconds * 1000);
  setInterval(tickEndWarnings, schedSeconds * 1000);
  setInterval(tickTasks, schedSeconds * 1000);
  setInterval(tickBroadcasts, schedSeconds * 1000);
  // Reminder occurrence prune (#53): soft-delete very old COMPLETED recurrence
  // occurrences so a long-running recurring reminder doesn't accumulate hundreds of
  // dead rows. Window configurable via REMINDER_PRUNE_RETENTION_DAYS (default 90);
  // 0/disabled skips scheduling. Runs shortly after boot, then daily (same cadence
  // as the files/recording retention sweepers). Never prunes active/future rows.
  {
    const reminderPruneDays = Number(process.env.REMINDER_PRUNE_RETENTION_DAYS ?? 90);
    if (reminderPruneDays > 0) {
      const tickReminderPrune = () =>
        pruneOldReminders(reminderPruneDays)
          .then((r) => r && r.pruned && console.log(`[reminder-prune] soft-deleted ${r.pruned} old occurrence(s)`))
          .catch((e) => console.error("[reminder-prune] sweep failed:", e));
      setTimeout(tickReminderPrune, 90 * 1000);
      setInterval(tickReminderPrune, 24 * 60 * 60 * 1000);
    } else {
      console.log("[reminder-prune] disabled (REMINDER_PRUNE_RETENTION_DAYS=0)");
    }
  }
  // Recording retention: when RECORDING_RETENTION_DAYS is set (>0), purge
  // recordings older than that window once a day.
  const retentionDays = Number(process.env.RECORDING_RETENTION_DAYS) || 0;
  if (retentionDays > 0)
    setInterval(
      () => {
        purgeOlderThan(retentionDays).catch((e) =>
          console.error("[retention] failed:", e),
        );
      },
      24 * 60 * 60 * 1000,
    );
  // Files GC / retention: permanently reclaim soft-deleted files (S3 blob + row)
  // older than FILES_GC_RETENTION_DAYS (default 30). CONSERVATIVE: only touches
  // deleted=1 rows past the window, deletes the blob before the row, logs every
  // object removed, and tolerates an S3 failure (retried next run). When the
  // retention window is 0/disabled the sweeper no-ops, so we skip scheduling it
  // entirely. Runs daily (same cadence as recording retention). Never touches the
  // call/meeting media path.
  {
    const filesGcRetentionDays = Number(config.files.gcRetentionDays) || 0;
    if (filesGcRetentionDays > 0) {
      const tickFilesGc = () =>
        runFilesGc().catch((e) =>
          console.error("[files-gc] sweep failed:", e),
        );
      // Kick one sweep shortly after boot, then daily.
      setTimeout(tickFilesGc, 60 * 1000);
      setInterval(tickFilesGc, 24 * 60 * 60 * 1000);
    } else {
      console.log(
        "[files-gc] disabled (FILES_GC_RETENTION_DAYS=0) — soft-deleted files are retained indefinitely",
      );
    }
  }
  // Cold-tier job: move aged / pressure-selected disk-tier files to MinIO so the
  // files volume stays a bounded hot set (docs/FILE_UPLOAD_STORAGE_CHAIN.md
  // §11.3). Also reaps orphaned .part temp files from interrupted uploads.
  {
    if (config.files.tierEnabled) {
      const tickFilesTier = () =>
        runFilesTier().catch((e) => console.error("[files-tier] run failed:", e));
      const everyMs = Math.max(1, Number(config.files.tierIntervalMinutes) || 60) * 60 * 1000;
      setTimeout(tickFilesTier, 2 * 60 * 1000);
      setInterval(tickFilesTier, everyMs);
    } else {
      console.log("[files-tier] disabled (FILE_TIER_ENABLED=false) — disk-tier files stay on disk");
    }
    const tickParts = () =>
      diskStorage
        .sweepParts()
        .then((n) => n > 0 && console.log(`[files] reaped ${n} orphaned .part upload(s)`))
        .catch(() => {});
    setTimeout(tickParts, 5 * 60 * 1000);
    setInterval(tickParts, 24 * 60 * 60 * 1000);
  }
  // BA/CEO: temporary-group GC — soft-delete auto-expiring groups (created from an
  // ended call/meeting's chat) once past their 7-day TTL. Daily, like files-GC.
  {
    const tickTempGroupGc = () =>
      sweepExpiredTempGroups()
        .then(
          (r) =>
            r.deleted > 0 &&
            console.log(`[temp-group-gc] removed ${r.deleted} expired group(s)`),
        )
        .catch((e) => console.error("[temp-group-gc] sweep failed:", e));
    setTimeout(tickTempGroupGc, 90 * 1000);
    setInterval(tickTempGroupGc, 24 * 60 * 60 * 1000);
  }
  // Session GC (Session Mgmt Phase 5): revoke + live-disconnect expired sessions
  // and enforce each org's idle timeout (Phase 4 config). Runs shortly after boot,
  // then every SESSION_GC_MINUTES (default 5). Best-effort; never touches live
  // calls/media. Skips still-connected sessions in the idle pass.
  {
    const gcMinutes = Math.max(1, Number(process.env.SESSION_GC_MINUTES) || 5);
    const tickSessionGc = () =>
      sweepSessions(io)
        .then(
          (r) =>
            (r.expired || r.idle) &&
            console.log(`[session-gc] revoked ${r.expired} expired + ${r.idle} idle session(s)`),
        )
        .catch((e) => console.error("[session-gc] sweep failed:", e));
    setTimeout(tickSessionGc, 45 * 1000);
    setInterval(tickSessionGc, gcMinutes * 60 * 1000);
  }
  // OUTGOING CHAT WEBHOOKS. Deliveries are queued on the message send path and
  // POSTed from here, so a slow or dead consumer endpoint never adds latency to
  // sending a chat message. An enqueue also nudges the drain directly (~1s), so
  // this poll is the safety net that covers a missed nudge, a process restart
  // mid-flight, and rows whose backoff has just come due. Leader-gated like the
  // other fan-out timers, and the claim in the driver keeps it correct even if
  // two replicas ever drain at once.
  if (config.webhooks.enabled) {
    const drainSeconds = Math.max(5, Number(process.env.WEBHOOKS_DRAIN_SECONDS) || 20);
    setInterval(() => {
      if (!isLeader()) return;
      drainWebhooks().catch((e) => console.error("[webhooks] drain tick failed:", e));
    }, drainSeconds * 1000);
    // Hourly housekeeping: re-arm deliveries a crashed process left claimed, and
    // prune the delivery log (it embeds message text, so it is not kept forever).
    const tickWebhookSweep = () => {
      if (!isLeader()) return;
      sweepWebhooks()
        .then(
          (r) =>
            (r.requeued || r.pruned) &&
            console.log(`[webhooks] re-armed ${r.requeued} stale, pruned ${r.pruned} old delivery row(s)`),
        )
        .catch((e) => console.error("[webhooks] sweep failed:", e));
    };
    setTimeout(tickWebhookSweep, 90 * 1000);
    setInterval(tickWebhookSweep, 60 * 60 * 1000);
  }
  // UNIFIED CONNECTOR ENGINE (docs/CONNECTOR_ENGINE.md). Outbound platform
  // posts and calendar writes are queued on the send path and executed here,
  // so a slow Slack/Graph/WhatsApp API never adds latency to a chat message or
  // a meeting save. An enqueue nudges the drain directly (~0.5s); this poll is
  // the safety net for a missed nudge, a restart mid-flight and rows whose
  // backoff has just come due. Leader-gated; the claim in the driver keeps it
  // correct even if two replicas ever drain at once.
  if (config.connectors.enabled) {
    const drainSeconds = Math.max(5, Number(config.connectors.drainSeconds) || 15);
    setInterval(() => {
      if (!isLeader()) return;
      drainConnectors().catch((e) => console.error("[connectors] drain tick failed:", e));
    }, drainSeconds * 1000);
    const tickConnectorSweep = () => {
      if (!isLeader()) return;
      sweepConnectors()
        .then(
          (r) =>
            (r.requeued || r.pruned) &&
            console.log(`[connectors] re-armed ${r.requeued} stale, pruned ${r.pruned} old job row(s)`),
        )
        .catch((e) => console.error("[connectors] sweep failed:", e));
    };
    setTimeout(tickConnectorSweep, 2 * 60 * 1000);
    setInterval(tickConnectorSweep, 60 * 60 * 1000);
    // Calendar delta pulls (Google sync token / Graph delta link) for every
    // calendar account with pulls enabled. Observe-only unless the account opts
    // into applying external changes.
    const pullMinutes = Math.max(1, Number(config.connectors.calendarPullMinutes) || 10);
    setInterval(() => {
      if (!isLeader()) return;
      pullConnectorCalendars().catch((e) => console.error("[connectors] calendar pull failed:", e));
    }, pullMinutes * 60 * 1000);
  }
  // Mechanism A: expire opaque E2EE history-sync relay chunks hourly, and the
  // durable re-delivery asks (0126) with them.
  setInterval(
    () => {
      db.e2ee
        .purgeExpiredRedeliverRequests?.()
        .catch(() => { });
      db.e2ee
        .purgeExpiredHistorySync()
        .then(
          (r) =>
            r.purged &&
            console.log("[e2ee-sync] purged " + r.purged + " expired chunk(s)"),
        )
        .catch((e) => console.error("[e2ee-sync] purge failed:", e));
    },
    60 * 60 * 1000,
  );
  // Telemetry retention: drop client-error groups older than 14 days hourly, so
  // the aggregation table stays small (it's already fingerprint-grouped, so this
  // only sheds long-stale groups). Tune the window with TELEMETRY_RETENTION_DAYS.
  {
    const telemetryRetentionDays = Number(process.env.TELEMETRY_RETENTION_DAYS) || 14;
    setInterval(
      () => {
        db.telemetry
          .purgeOldClientErrors(telemetryRetentionDays)
          .then(
            (r) =>
              r.purged &&
              console.log("[telemetry] purged " + r.purged + " old client-error group(s)"),
          )
          .catch((e) => console.error("[telemetry] purge failed:", e));
      },
      60 * 60 * 1000,
    );
  }
  server.listen(config.backend.port, config.backend.host, () => {
    console.log(
      `[backend] CoLab V1 API on http://${config.backend.host}:${config.backend.port}${config.constants.api.prefix} (env=${config.env}, demo=${config.features.demoMode})`,
    );
  });

  // Graceful shutdown: on a redeploy/restart (Docker sends SIGTERM), stop taking
  // new work, close sockets, let in-flight HTTP finish, and END the DB pool
  // cleanly — instead of hard-killing live calls/requests and risking half-cut
  // transactions. Falls back to a forced exit if draining exceeds the grace
  // window. Set SHUTDOWN_GRACE_MS / compose stop_grace_period to tune.
  let shuttingDown = false;
  const shutdown = (sig: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`[shutdown] ${sig} received — draining…`);
    const graceMs = Number(process.env.SHUTDOWN_GRACE_MS) || 10000;
    const hard = setTimeout(() => {
      console.warn("[shutdown] grace elapsed — forcing exit");
      process.exit(0);
    }, graceMs);
    if (typeof hard.unref === "function") hard.unref();
    void (async () => {
      try { io.emit("server:restarting"); } catch (_) {}
      try { await new Promise<void>((r) => io.close(() => r())); } catch (_) {}
      try { server.close(); } catch (_) {}
      try {
        const { db } = await import("./platform");
        if ((db as any).pool) await (db as any).pool.end();
      } catch (_) {}
      clearTimeout(hard);
      console.log("[shutdown] clean exit");
      process.exit(0);
    })();
  };
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
})().catch((e) => {
  console.error("[boot] failed:", e);
  process.exit(1);
});
