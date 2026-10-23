// scripts/seed-5-call-users.cjs
// Creates 5 test users for testing audio & video calls at http://localhost:7524/
const crypto = require("crypto");
const mysql = require("mysql2/promise");

const PASSWORD = "TestCall@123";

function hashPassword(pw) {
  const salt = crypto.randomBytes(16);
  return salt.toString("hex") + ":" + crypto.scryptSync(pw, salt, 64).toString("hex");
}

const USERS = [
  { id: "u_user1", email: "user1@colab.test", name: "User One", initials: "U1", color: "#2563EB", role: "admin" },
  { id: "u_user2", email: "user2@colab.test", name: "User Two", initials: "U2", color: "#7C3AED", role: "member" },
  { id: "u_user3", email: "user3@colab.test", name: "User Three", initials: "U3", color: "#059669", role: "member" },
  { id: "u_user4", email: "user4@colab.test", name: "User Four", initials: "U4", color: "#DC2626", role: "member" },
  { id: "u_user5", email: "user5@colab.test", name: "User Five", initials: "U5", color: "#D97706", role: "member" },
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
    // 0. Clean old test rows
    console.log("Cleaning old test records...");
    await conn.query(`SET FOREIGN_KEY_CHECKS = 0`);
    await conn.query(`DELETE FROM messages WHERE conversation_id LIKE 'conv_%'`);
    await conn.query(`DELETE FROM conversation_members WHERE user_id LIKE 'u_user%'`);
    await conn.query(`DELETE FROM conversations WHERE id LIKE 'conv_%'`);
    await conn.query(`DELETE FROM invites WHERE from_user_id LIKE 'u_user%' OR to_user_id LIKE 'u_user%'`);
    await conn.query(`DELETE FROM auth_sessions WHERE user_id LIKE 'u_user%'`);
    await conn.query(`DELETE FROM users WHERE email LIKE '%@colab.test' OR email LIKE '%@test.com'`);
    await conn.query(`SET FOREIGN_KEY_CHECKS = 1`);

    // 1. Upsert Users
    console.log("Upserting 5 test users...");
    for (const u of USERS) {
      const pwHash = hashPassword(PASSWORD);
      await conn.query(
        `INSERT INTO users (id, email, name, initials, color, role, presence, password_hash)
         VALUES (?, ?, ?, ?, ?, ?, 'offline', ?)
         ON DUPLICATE KEY UPDATE
           name = VALUES(name),
           initials = VALUES(initials),
           color = VALUES(color),
           role = VALUES(role),
           password_hash = VALUES(password_hash)`,
        [u.id, u.email, u.name, u.initials, u.color, u.role, pwHash]
      );
      console.log(`  ✓ ${u.name} (${u.email}) - id: ${u.id}`);
    }

    // 2. Pairwise accepted invites & DMs
    console.log("Creating pairwise connections and DM conversations...");
    for (let i = 0; i < USERS.length; i++) {
      for (let j = i + 1; j < USERS.length; j++) {
        const uA = USERS[i];
        const uB = USERS[j];
        const [first, second] = [uA.id, uB.id].sort();
        const dmKey = `${first}|${second}`;
        const convId = `conv_dm_${uA.id}_${uB.id}`;

        // Create DM conversation
        await conn.query(
          `INSERT INTO conversations (id, kind, created_by, dm_key)
           VALUES (?, 'dm', ?, ?)
           ON DUPLICATE KEY UPDATE dm_key = VALUES(dm_key)`,
          [convId, uA.id, dmKey]
        );

        // Add both members
        await conn.query(
          `INSERT IGNORE INTO conversation_members (conversation_id, user_id, role)
           VALUES (?, ?, 'member'), (?, ?, 'member')`,
          [convId, uA.id, convId, uB.id]
        );

        // Create accepted invite between them so contacts / call permissions are active
        const inviteId = `inv_${uA.id}_${uB.id}`;
        await conn.query(
          `INSERT INTO invites (id, from_user_id, to_user_id, status, conversation_id, responded_at)
           VALUES (?, ?, ?, 'accepted', ?, NOW())
           ON DUPLICATE KEY UPDATE status = 'accepted', responded_at = NOW()`,
          [inviteId, uA.id, uB.id, convId]
        );
      }
    }

    // 3. Create a Group Call / Meeting room conversation for all 5 users
    console.log("Creating Group Room 'Test Call Pod' with all 5 users...");
    const groupId = "conv_test_call_pod";
    await conn.query(
      `INSERT INTO conversations (id, kind, title, icon, created_by)
       VALUES (?, 'group', 'Test Call Pod', '📞', ?)
       ON DUPLICATE KEY UPDATE title = VALUES(title), icon = VALUES(icon)`,
      [groupId, USERS[0].id]
    );

    for (const u of USERS) {
      await conn.query(
        `INSERT IGNORE INTO conversation_members (conversation_id, user_id, role)
         VALUES (?, ?, 'member')`,
        [groupId, u.id]
      );
    }

    // 4. Create General channel with all 5 users
    console.log("Creating #general channel...");
    const chanId = "conv_general";
    await conn.query(
      `INSERT INTO conversations (id, kind, title, icon, created_by)
       VALUES (?, 'channel', 'general', '#', ?)
       ON DUPLICATE KEY UPDATE title = VALUES(title), icon = VALUES(icon)`,
      [chanId, USERS[0].id]
    );

    for (const u of USERS) {
      await conn.query(
        `INSERT IGNORE INTO conversation_members (conversation_id, user_id, role)
         VALUES (?, ?, 'member')`,
        [chanId, u.id]
      );
    }

    // Insert a welcome message in general
    await conn.query(
      `INSERT INTO messages (id, conversation_id, sender_id, body)
       VALUES (?, ?, ?, ?)`,
      ["msg_welcome", chanId, USERS[0].id, "Welcome to CoLab! Test users are ready for audio and video calls."]
    );

    console.log("\nAll 5 users and conversations created successfully!");
  } finally {
    await conn.end();
  }
})().catch((err) => {
  console.error("Failed to seed test users:", err);
  process.exit(1);
});
