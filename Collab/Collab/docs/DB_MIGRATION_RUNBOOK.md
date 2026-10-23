# DB migration runbook — bundled container → durable target (zero data loss)

Moves **all** CoLab data (every table, every row — users, profiles, conversations,
messages, meetings, files, calls, e2ee keys…) from the live server's **bundled
`colab-db` container** into a durable target DB (the corporate MySQL
`10.101.3.2:3603/colab`, or any MySQL 8 you choose), and **proves** nothing was lost
with a table-by-table row-count check.

Three scripts in `scripts/`:
| Step | Script | Runs where | What it does |
|---|---|---|---|
| 1 | `dump-colab-live.sh` | **live server** | Complete, read-only `mysqldump` → `colab-live-data.sql` + per-table source baseline + sha256 |
| 2 | `load-colab-target.sh` | load host | Backs up the target first, then loads the dump |
| 3 | `verify-colab-target.cjs` | load host | `COUNT(*)` per table, source vs target, **PASS/FAIL** |

## Runbook (in order)

```bash
# ── 1. ON THE LIVE SERVER (10.200.3.17), in the deployment dir ───────────────
bash scripts/dump-colab-live.sh
#   → colab-live-data.sql        (the data — schema+rows+triggers, hex-blob, utf8mb4)
#   → colab-source-counts.txt    (real per-table COUNT(*) baseline)
#   → colab-live-data.sql.sha256
#   Prints a per-table count table. READ-ONLY on the live DB — safe to run anytime.

# ── 2. Transfer BOTH files (colab-live-data.sql + colab-source-counts.txt) ────
#   to the machine that can reach the target DB (on the corporate net/VPN).

# ── 3. LOAD into the target (default = corporate DB, creds from .env.live) ────
CONFIRM=yes bash scripts/load-colab-target.sh
#   • Takes a TIMESTAMPED backup of the target first (rollback path), aborts if empty.
#   • Loads with FK/UNIQUE checks off, utf8mb4, 1G packet.
#   • Realigns audit_log AUTO_INCREMENT and stamps deploy_state='existing'.
#   To target a different DB:  CONFIRM=yes bash scripts/load-colab-target.sh mysql://user:pass@host:3603/colab

# ── 4. VERIFY (required — must be all-PASS before go-live) ────────────────────
node scripts/verify-colab-target.cjs colab-source-counts.txt
#   Prints SRC vs TGT per table + PASS/FAIL. Exits non-zero if ANY app table is short.

# ── 5. Cut the app over to the durable DB ────────────────────────────────────
#   Deploy with DB_PROFILE=live so the app now uses the corporate DB:
docker compose --env-file .env.live -f docker-compose.live.yml up -d --force-recreate backend
```

## Safety guarantees (built into the scripts)

- **Read-only source** — step 1 uses `--single-transaction`; it never writes to the live DB.
- **Truncated-dump trap closed** — the dump asserts the `-- Dump completed` trailer and writes
  a sha256; the loader **refuses** any file missing that trailer.
- **Backup-before-load** — step 3 dumps the target first and aborts if that backup is empty.
  Rollback command is printed (and is `mysql … < colab-target-backup-<stamp>.sql`).
- **No silent corruption** — `--hex-blob` (byte-exact avatars/recordings/LONGBLOB),
  `--default-character-set=utf8mb4` both ends (emoji/non-ASCII names & messages),
  `--max-allowed-packet=1G` (multi-MB rows), real `COUNT(*)` (never the InnoDB estimate).
- **Completeness proof** — verification covers **all 34 app tables** (the list the audit
  enumerated, which `schema.sql` alone would under-count by 13), FAILs on any mismatch, and
  checks `audit_log` AUTO_INCREMENT continuity.
- **No re-import after cutover** — `deploy_state='existing'` + the populated-target guard in
  `promoteIfNeeded()` mean the app will **not** overwrite this data on next boot.
  (Never set `COLAB_FORCE_REIMPORT=yes` on a populated DB.)
- **Passwords never printed** — read from `.env.live`, passed via `MYSQL_PWD`, never on a
  command line or in output.

## If verification shows a FAIL

Do **not** go live. The target backup from step 3 is your rollback
(`mysql … < colab-target-backup-<stamp>.sql`). Re-run the dump (it may have been truncated by a
network blip) and reload. The `diff` column tells you which table is short.

## Notes

- `deploy_state` is **intentionally not copied** (it's promotion control state; the loader stamps
  it). `schema_migrations` **is** copied so the app's migration runner sees everything applied and
  runs 0 new migrations on boot.
- Target must be **MySQL 8.0+** (the schema uses `utf8mb4_0900_ai_ci`); the loader version-gates this.
- All three scripts can route through the `colab-db` container (`USE_CONTAINER=colab-db`) if the host
  has no `mysql` client.
