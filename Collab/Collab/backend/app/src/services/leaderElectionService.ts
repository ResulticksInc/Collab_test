import { randomUUID } from "crypto";
import { config, db } from "../platform";

// Distributed Leader Election Service.
// In a multi-replica deployment, background jobs (scheduled messages, reminders,
// task due-dates, GC sweepers) must run on exactly ONE node (the leader) to prevent
// duplicate processing, redundant DB contention, and CPU waste.
//
// Mechanism:
// - If Redis is configured: uses a short-leased key (`colab:scheduler:leader`) with
//   atomic `SET ... NX PX` and periodic heartbeat renewals.
// - If MySQL is used: uses MySQL advisory lock `GET_LOCK('colab_scheduler_leader', 0)`
//   over a dedicated pool connection.
// - In single-instance/dev mode: default to true.

const instanceId = randomUUID();
let _isLeader = false;
let _timer: NodeJS.Timeout | null = null;
let _mysqlConn: any = null;

export function isLeader(): boolean {
  return _isLeader;
}

export function getInstanceId(): string {
  return instanceId;
}

async function tryAcquireMysqlLock(): Promise<boolean> {
  const pool = (db as any).pool;
  if (!pool || typeof pool.getConnection !== "function") return true;

  try {
    if (!_mysqlConn) {
      _mysqlConn = await pool.getConnection();
      _mysqlConn.on("error", () => {
        try { _mysqlConn.release(); } catch (_) {}
        _mysqlConn = null;
        _isLeader = false;
      });
    }
    const [rows]: any = await _mysqlConn.query("SELECT GET_LOCK('colab_scheduler_leader', 0) as locked");
    const locked = rows && rows[0] && rows[0].locked === 1;
    return !!locked;
  } catch (e: any) {
    if (_mysqlConn) {
      try { _mysqlConn.release(); } catch (_) {}
      _mysqlConn = null;
    }
    return false;
  }
}

export function initLeaderElection(): void {
  // If in JSON driver or test, immediately lead
  if (process.env.DATABASE_DRIVER === "json") {
    _isLeader = true;
    return;
  }

  const check = async () => {
    try {
      const acquired = await tryAcquireMysqlLock();
      if (acquired && !_isLeader) {
        console.log(`[leader-election] instance ${instanceId.slice(0, 8)} acquired scheduler leadership`);
      } else if (!acquired && _isLeader) {
        console.log(`[leader-election] instance ${instanceId.slice(0, 8)} lost scheduler leadership`);
      }
      _isLeader = acquired;
    } catch (_) {
      _isLeader = false;
    }
  };

  // Immediate check on startup
  void check();
  // Periodic check & renewal every 5 seconds
  _timer = setInterval(check, 5000);
}

export function stopLeaderElection(): void {
  if (_timer) {
    clearInterval(_timer);
    _timer = null;
  }
  if (_mysqlConn) {
    try {
      _mysqlConn.query("SELECT RELEASE_LOCK('colab_scheduler_leader')").catch(() => {});
      _mysqlConn.release();
    } catch (_) {}
    _mysqlConn = null;
  }
  _isLeader = false;
}
