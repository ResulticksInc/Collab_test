// Shared test-DB bootstrap.
//
// The backend suites drive the REAL db/platform layer, so without isolation they
// read and write the live application database. This pins them onto a throwaway
// `colab_test` schema that can be dropped at will and never touches app data.
//
// Root credentials are used on purpose: the app user (`colab`) is granted only on
// `colab`/`colab_demo` and cannot CREATE a new database, whereas root can create
// and own the throwaway schema. Override the whole thing with TEST_DATABASE_URL
// (e.g. a CI-provided test DB).
import { createConnection } from "mysql2/promise";

export const TEST_DB_URL =
  process.env.TEST_DATABASE_URL ||
  "mysql://root:colab@127.0.0.1:3306/colab_test";

// Match `colab`'s collation exactly. docker-compose creates `colab` with the
// server default (utf8mb4_0900_ai_ci); a mismatched test schema throws "illegal
// mix of collations" the moment a migration joins two string columns.
const TEST_DB_COLLATION = process.env.TEST_DB_COLLATION || "utf8mb4_0900_ai_ci";

let ensured: Promise<unknown> | null = null;

async function createTestDb(): Promise<void> {
  const u = new URL(TEST_DB_URL);
  const conn = await createConnection({
    host: u.hostname === "localhost" ? "127.0.0.1" : u.hostname,
    port: Number(u.port) || 3306,
    user: decodeURIComponent(u.username),
    password: decodeURIComponent(u.password),
  });
  try {
    const dbName = decodeURIComponent(u.pathname.replace(/^\//, "")).replace(/`/g, "");
    await conn.query(
      "CREATE DATABASE IF NOT EXISTS `" +
        dbName +
        "` CHARACTER SET utf8mb4 COLLATE " +
        TEST_DB_COLLATION,
    );
  } finally {
    await conn.end().catch(() => {});
  }
}

// Await BEFORE importing ../src/platform (config resolves the DB URL at import
// time). Forces the process onto the test schema regardless of any ambient
// DATABASE_URL / DB_PROFILE / DEMO_MODE, so a stray env var can't leak the suite
// into a real database. The CREATE is idempotent and memoised per process.
export async function useTestDatabase(): Promise<string> {
  process.env.DATABASE_URL = TEST_DB_URL;
  process.env.DB_PROFILE = "";
  process.env.DEMO_MODE = "false";
  delete process.env.DEMO_DATABASE_URL;
  if (!ensured) ensured = createTestDb();
  await ensured;
  return TEST_DB_URL;
}
