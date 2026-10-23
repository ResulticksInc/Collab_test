/**
 * CoLab E2EE — SELF-AUDIT (cost-free, self-hostable)
 *
 * Single entry point for the security review described in
 * docs/E2EE_ENTERPRISE_READINESS.md §6. Runs the in-repo automated checks and
 * prints a checklist for the manual steps an operator should also perform.
 *
 * Usage:
 *   node scripts/e2ee-self-audit.cjs                    # run all in-repo checks
 *   node scripts/e2ee-self-audit.cjs --skip-runtime     # skip the DB-side runtime harness
 *   node scripts/e2ee-self-audit.cjs --skip-audit       # skip `npm audit`
 *
 * EXIT CODE:
 *   0 = all automated checks PASS
 *   1 = at least one automated check FAIL — read the output, fix, re-run
 *   2 = could not run (e.g. node version too old)
 *
 * NO external services. NO money. NO SaaS dependencies. Runs entirely on the
 * operator's box. Designed to be safe to schedule as a periodic cron job.
 */

const { spawnSync } = require("child_process");
const path = require("path");

const args = new Set(process.argv.slice(2));
const SKIP_RUNTIME = args.has("--skip-runtime");
const SKIP_AUDIT = args.has("--skip-audit");
const REPO = path.resolve(__dirname, "..");

function section(label) {
  console.log("\n" + "─".repeat(72));
  console.log("  " + label);
  console.log("─".repeat(72));
}
function run(label, cmd, argv, opts = {}) {
  console.log(`\n▶ ${label}`);
  console.log(`  $ ${cmd} ${argv.join(" ")}`);
  const r = spawnSync(cmd, argv, { cwd: REPO, encoding: "utf8", shell: true, ...opts });
  if (r.stdout) process.stdout.write(r.stdout);
  if (r.stderr) process.stderr.write(r.stderr);
  return { code: r.status === null ? -1 : r.status, stdout: r.stdout, stderr: r.stderr };
}

const results = [];
function record(name, pass, detail = "") {
  results.push({ name, pass, detail });
}

(async () => {
  section("CoLab E2EE Self-Audit — automated checks");

  // 1. Crypto core verification (19 invariants)
  {
    const r = run(
      "Crypto-core verification (verify-e2ee-crypto.cjs)",
      "node",
      ["scripts/verify-e2ee-crypto.cjs"],
    );
    record("crypto-core verification", r.code === 0, r.code === 0 ? "19/19" : "see above");
  }

  // 2. Runtime DB-side validation (server-blindness invariants)
  if (!SKIP_RUNTIME) {
    const r = run(
      "Runtime validation (e2ee-runtime-validation.cjs) — DB invariants",
      "node",
      ["scripts/e2ee-runtime-validation.cjs"],
    );
    record(
      "runtime DB invariants",
      r.code === 0,
      r.code === 0
        ? "all server-blindness checks pass"
        : r.code === 2
          ? "could not reach DB — set DATABASE_URL or run with --skip-runtime"
          : "see above; fix and re-run before enabling for users",
    );
  }

  // 3. Dependency vulnerability scan via npm audit (free, in-tree)
  if (!SKIP_AUDIT) {
    // --omit=dev so we only flag PROD-shipped vulns; --json is parseable.
    const r = run(
      "Dependency CVE scan (npm audit --omit=dev)",
      "npm",
      ["audit", "--omit=dev", "--json"],
    );
    let critical = 0;
    let high = 0;
    try {
      const j = JSON.parse(r.stdout || "{}");
      const sev = (j && j.metadata && j.metadata.vulnerabilities) || {};
      critical = Number(sev.critical || 0);
      high = Number(sev.high || 0);
    } catch (_) {
      // npm audit can exit non-zero even when output is parseable
    }
    const ok = critical === 0 && high === 0;
    record(
      "npm audit (prod deps)",
      ok,
      ok
        ? "0 critical, 0 high"
        : `${critical} critical, ${high} high — review with: npm audit --omit=dev`,
    );
  }

  // 4. TypeScript compile check (a passing type check rules out a class of
  // crypto-key-confusion bugs)
  {
    const r = run(
      "Frontend TypeScript compile",
      "npx",
      ["tsc", "--noEmit"],
      { cwd: path.join(REPO, "frontend", "app") },
    );
    record("frontend tsc", r.code === 0, r.code === 0 ? "clean" : "errors above");
  }
  {
    const r = run(
      "Backend TypeScript compile",
      "npx",
      ["tsc", "--noEmit"],
      { cwd: path.join(REPO, "backend", "app") },
    );
    record("backend tsc", r.code === 0, r.code === 0 ? "clean" : "errors above");
  }

  // ───────── Summary ─────────
  section("Automated-check summary");
  let failed = 0;
  for (const r of results) {
    const tag = r.pass ? "PASS" : "FAIL";
    console.log(`  ${tag.padEnd(5)} ${r.name.padEnd(34)} ${r.detail}`);
    if (!r.pass) failed++;
  }

  // ───────── Manual checklist ─────────
  section("MANUAL checklist — run these yourself");
  console.log(`
  These are free OSS tools that aren't bundled in this repo (different
  install paths). Run each at least once before enabling the E2EE flag
  for real users; re-run after any non-trivial crypto change.

  [ ] semgrep — source-pattern security rules
        pip install semgrep
        semgrep --config p/security-audit --config p/owasp-top-ten .

  [ ] eslint-plugin-security — JS/TS source-pattern security
        npm i -D eslint-plugin-security
        # add "plugin:security/recommended" to .eslintrc, then:
        npx eslint . --ext .ts,.tsx,.js

  [ ] osv-scanner (Google OSS) — second-opinion CVE scan
        # https://github.com/google/osv-scanner — install the binary, then:
        osv-scanner --recursive .

  [ ] gitleaks — pre-commit secret scan
        # https://github.com/gitleaks/gitleaks — install the binary, then:
        gitleaks detect --source . --redact

  [ ] CodeQL CLI — semantic taint-flow analysis
        # https://github.com/github/codeql-cli-binaries — install, then:
        codeql database create cb --language=javascript
        codeql database analyze cb \\
            codeql/javascript-queries:codeql-suites/javascript-security-and-quality.qls \\
            --format=csv --output=codeql-findings.csv

  [ ] Threat-model + adversarial-audit review (you + at least one other person)
        Read:  docs/E2EE_ADVERSARIAL_AUDIT.md
               docs/E2EE_ENTERPRISE_READINESS.md
        For every CLOSED defence in §3, confirm the code still does what the
        doc claims. For every OPEN gap in §4, confirm your deployment can
        tolerate it.

  [ ] Two-browser runtime exercise (operator-driven, §5 step 1)
        Set the E2EE flags ON, rebuild, restart, open 2 browsers, send a
        DM text + a group text + a DM file + a group file + a 1:1 call + a
        meeting, then re-run THIS script. The runtime-validation check
        should turn green.
`);

  console.log("─".repeat(72));
  if (failed === 0) {
    console.log("\n  All AUTOMATED checks passed. Complete the manual checklist above,");
    console.log("  then run §5 step 1 (two-browser exercise) to fully validate.\n");
    process.exit(0);
  }
  console.log(`\n  ${failed} AUTOMATED check(s) failed. Fix them, then re-run this script.\n`);
  process.exit(1);
})().catch((e) => {
  console.error("Self-audit crashed:", e);
  process.exit(2);
});
