import { createMysqlDb } from "./drivers/mysql";
import { migrate } from "./bootstrap";
import { seedDemo } from "../seeds/demo.seed";
import { CONVERSATION } from "../../shared/src";

const DEFAULT_DATABASE_URLS = [
  "mysql://colab:colab@localhost:3306/colab",
  "mysql://colab:colab@localhost:3306/colab_demo",
];

function urls() {
  const raw = process.env.COLAB_DATABASE_URLS || "";
  return raw
    ? raw
        .split(",")
        .map((x) => x.trim())
        .filter(Boolean)
    : DEFAULT_DATABASE_URLS;
}

async function ensureConv(
  db,
  { id, kind, title = null, icon = null, members },
) {
  await db.conversations.create({
    id,
    kind,
    title,
    icon,
    createdBy: "u_you",
  });
  for (const uid of members) await db.conversations.addMember(id, uid);
}

async function prepareDatabase(url: string) {
  await migrate(url);
  const db = createMysqlDb({ database: { url } });
  try {
    await seedDemo(db, { usersOnly: true });
    await ensureConv(db, {
      id: "conv_emily",
      kind: CONVERSATION.DM,
      members: ["u_you", "u_emily"],
    });
    await ensureConv(db, {
      id: "conv_general",
      kind: CONVERSATION.CHANNEL,
      title: "general",
      icon: "#",
      members: [
        "u_you",
        "u_emily",
        "u_marcus",
        "u_priya",
        "u_david",
        "u_lena",
      ],
    });
  } finally {
    if (db.pool?.end) await db.pool.end();
  }
}

export async function prepareReleaseDatabases() {
  for (const url of urls()) {
    await prepareDatabase(url);
  }
}

if (require.main === module) {
  prepareReleaseDatabases()
    .then(() => console.log("[db] release databases prepared"))
    .catch((e) => {
      console.error("[db] release database prep failed:", e);
      process.exit(1);
    });
}
