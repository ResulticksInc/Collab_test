// scripts/seed-contacts.cjs
// Populates the Contacts screen with a realistic directory for local testing at
// http://localhost:7524/. Additive and idempotent — safe to re-run:
//   • upserts 24 people (ids u_seed_*, emails @colab.demo, password TestCall@123)
//   • adds a few PENDING connection requests to user1/user2 so the
//     "Connection Requests" section shows. Accepting one in the UI creates the
//     DM through the normal backend path.
// Does NOT touch the u_user* accounts from seed-5-call-users.cjs.
//
// Run inside the backend container (the DB port isn't published on the host):
//   docker cp scripts/seed-contacts.cjs colab-backend-1:/tmp/ && \
//   docker exec -w /app colab-backend-1 node /tmp/seed-contacts.cjs
// Remove everything it added:  ... node /tmp/seed-contacts.cjs --remove
const crypto = require("crypto");
const mysql = require("mysql2/promise");

const PASSWORD = "TestCall@123";

function hashPassword(pw) {
  const salt = crypto.randomBytes(16);
  return salt.toString("hex") + ":" + crypto.scryptSync(pw, salt, 64).toString("hex");
}

const COLORS = ["#2563EB", "#7C3AED", "#059669", "#DC2626", "#D97706", "#0891B2", "#DB2777", "#4F46E5"];

// [name, title, about, phone, timezone]
const PEOPLE = [
  ["Aarav Sharma", "Engineering Manager", "Platform & infra", "+91 98450 11201", "Asia/Kolkata"],
  ["Priya Nair", "Senior Product Designer", "Design systems, Figma", "+91 98450 11202", "Asia/Kolkata"],
  ["Karthik Raman", "Backend Engineer", "Node, MySQL, Redis", "+91 98450 11203", "Asia/Kolkata"],
  ["Divya Menon", "QA Lead", "Automation & release sign-off", "+91 98450 11204", "Asia/Kolkata"],
  ["Rohan Gupta", "Frontend Engineer", "React / Next.js", "+91 98450 11205", "Asia/Kolkata"],
  ["Ananya Iyer", "Product Manager", "Messaging & calls", "+91 98450 11206", "Asia/Kolkata"],
  ["Vikram Patel", "DevOps Engineer", "CI/CD, Docker, LiveKit", "+91 98450 11207", "Asia/Kolkata"],
  ["Meera Krishnan", "HR Business Partner", "People ops", "+91 98450 11208", "Asia/Kolkata"],
  ["Sanjay Reddy", "Sales Director", "Enterprise accounts, APAC", "+91 98450 11209", "Asia/Kolkata"],
  ["Lakshmi Subramanian", "Finance Manager", "Budgets & invoicing", "+91 98450 11210", "Asia/Kolkata"],
  ["Arjun Das", "Mobile Engineer", "Flutter, iOS CallKit", "+91 98450 11211", "Asia/Kolkata"],
  ["Nisha Verma", "Customer Success Manager", "Onboarding & renewals", "+91 98450 11212", "Asia/Kolkata"],
  ["Emily Carter", "Solutions Architect", "Integrations & SSO", "+1 415 555 0131", "America/Los_Angeles"],
  ["James Wilson", "VP Engineering", "", "+1 212 555 0142", "America/New_York"],
  ["Sofia Martinez", "Marketing Lead", "Campaigns & launches", "+1 305 555 0153", "America/New_York"],
  ["Daniel Kim", "Data Engineer", "Analytics pipelines", "+1 206 555 0164", "America/Los_Angeles"],
  ["Olivia Brown", "Legal Counsel", "Contracts & compliance", "+44 20 7946 0175", "Europe/London"],
  ["Lucas Müller", "Security Engineer", "E2EE, audits, pen-testing", "+49 30 5557 0186", "Europe/Berlin"],
  ["Chloé Dubois", "UX Researcher", "Interviews & usability tests", "+33 1 5555 0197", "Europe/Paris"],
  ["Hiroshi Tanaka", "Support Engineer", "Tier-2 escalations", "+81 3 5555 0208", "Asia/Tokyo"],
  ["Fatima Al-Sayed", "Operations Manager", "Vendor & facilities", "+971 4 555 0219", "Asia/Dubai"],
  ["Wei Chen", "ML Engineer", "Assistant & summaries", "+65 6555 0220", "Asia/Singapore"],
  ["Grace Thompson", "Technical Writer", "Docs & release notes", "+61 2 5555 0231", "Australia/Sydney"],
  ["Mohammed Khan", "IT Administrator", "Devices & access", "+91 98450 11232", "Asia/Kolkata"],
];

const slug = (name) =>
  name.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z]+/g, ".").replace(/^\.|\.$/g, "");
const initials = (name) =>
  name.split(/\s+/).map((p) => p[0]).join("").slice(0, 2).toUpperCase();

const USERS = PEOPLE.map(([name, title, about, phone, timezone], i) => ({
  id: "u_seed_" + slug(name).replace(/\./g, "_"),
  email: slug(name) + "@colab.demo",
  name,
  initials: initials(name),
  color: COLORS[i % COLORS.length],
  title,
  about: about || null,
  phone,
  timezone,
}));

// Pending requests → [from seeded person index, to test user id]
const REQUESTS = [
  [0, "u_user1"],
  [1, "u_user1"],
  [13, "u_user1"],
  [5, "u_user2"],
  [17, "u_user2"],
];

(async () => {
  const host = process.env.DB_HOST || "db";
  const port = Number(process.env.DB_PORT) || 3306;
  const user = process.env.DB_USER || "colab";
  const password = process.env.DB_PASSWORD || "colab";
  const database = process.env.DB_NAME || "colab";

  console.log(`Connecting to MySQL ${host}:${port}/${database} ...`);
  const conn = await mysql.createConnection({ host, port, user, password, database });

  try {
    if (process.argv.includes("--remove")) {
      const [inv] = await conn.query(`DELETE FROM invites WHERE id LIKE 'inv_seed_%'`);
      const [usr] = await conn.query(`DELETE FROM users WHERE id LIKE 'u_seed_%'`);
      console.log(`Removed ${usr.affectedRows} seeded contacts and ${inv.affectedRows} requests.`);
      return;
    }

    console.log(`Upserting ${USERS.length} contacts...`);
    for (const u of USERS) {
      await conn.query(
        `INSERT INTO users (id, email, name, initials, color, role, presence, password_hash, title, about, phone, timezone)
         VALUES (?, ?, ?, ?, ?, 'member', 'off', ?, ?, ?, ?, ?)
         ON DUPLICATE KEY UPDATE
           name = VALUES(name), initials = VALUES(initials), color = VALUES(color),
           title = VALUES(title), about = VALUES(about), phone = VALUES(phone),
           timezone = VALUES(timezone), deleted = 0, deleted_at = NULL, deleted_by = NULL`,
        [u.id, u.email, u.name, u.initials, u.color, hashPassword(PASSWORD), u.title, u.about, u.phone, u.timezone],
      );
      console.log(`  ✓ ${u.name.padEnd(22)} ${u.title.padEnd(26)} ${u.email}`);
    }

    console.log("Adding pending connection requests...");
    for (const [fromIdx, toId] of REQUESTS) {
      const from = USERS[fromIdx];
      const [[target]] = await conn.query(`SELECT id FROM users WHERE id = ? AND deleted = 0`, [toId]);
      if (!target) {
        console.log(`  – skip ${from.name} → ${toId} (no such user)`);
        continue;
      }
      await conn.query(
        `INSERT INTO invites (id, from_user_id, to_user_id, status)
         VALUES (?, ?, ?, 'pending')
         ON DUPLICATE KEY UPDATE status = IF(status = 'accepted', status, 'pending'), deleted = 0`,
        [`inv_seed_${from.id.slice(7)}_${toId}`, from.id, toId],
      );
      console.log(`  ✓ ${from.name} → ${toId}`);
    }

    const [[{ n }]] = await conn.query(`SELECT COUNT(*) AS n FROM users WHERE deleted = 0`);
    console.log(`Done. Directory now has ${n} people. Seeded logins: <name>@colab.demo / ${PASSWORD}`);
  } finally {
    await conn.end();
  }
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
