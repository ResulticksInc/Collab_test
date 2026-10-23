import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { useTestDatabase } from "./_setup";

// MESSAGING critical-path tests. Driven through the real messageService +
// conversationService against the seeded `colab` MySQL DB (same DB strategy as
// calls-signalling.test.ts: skip if MySQL is unreachable). These call the
// service layer directly (not HTTP) — the membership gate, edit, and soft-delete
// tombstone behavior all live in the service/driver, so this is the tightest
// place to pin them.
//
// Covers:
//   - send() persists a message that history() retrieves
//   - the conversation membership gate (a non-member can't read or post → 403)
//   - edit() updates a plaintext body; encrypted edit nulls the stored body
//   - soft-delete (remove) tombstones the message (row kept, content cleared)

let dbUp = false;
let db: any;
let messageService: any;
let conversationService: any;
let shared: any;

// Two isolated test users created just for this suite, so we never collide with
// or mutate seeded demo conversations.
const A = "u_msgtest_a";
const B = "u_msgtest_b";
const OUTSIDER = "u_msgtest_x";
let convId: string;

before(async () => {
  await useTestDatabase();
  process.env.AUTH_JWT_SECRET = "test-secret-colab";
  process.env.LIVEKIT_API_KEY = "testkey";
  process.env.LIVEKIT_API_SECRET = "testsecret_at_least_32_characters_long_xx";
  process.env.LIVEKIT_WS_URL = "ws://localhost:7534";

  try {
    const { migrate } = await import("../../../database/src");
    const platform = await import("../src/platform");
    db = platform.db;
    shared = platform.shared;
    await migrate(platform.config.database.url);
    messageService = await import("../src/services/messageService");
    conversationService = await import("../src/services/conversationService");

    // Provision isolated users + a group conversation with A and B as members.
    for (const [id, name] of [
      [A, "Msg Test A"],
      [B, "Msg Test B"],
      [OUTSIDER, "Msg Test Outsider"],
    ] as const) {
      await db.users.upsert({
        id,
        email: id + "@ex.com",
        name,
        initials: "MT",
        color: "#2563EB",
        presence: "off",
        passwordHash: null,
      });
    }
    const conv = await db.conversations.create({
      kind: shared.CONVERSATION.GROUP,
      title: "Msg Test Group",
      icon: "💬",
      createdBy: A,
    });
    convId = conv.id;
    await db.conversations.addMember(convId, A, { role: "owner" });
    await db.conversations.addMember(convId, B, { role: "member" });
    dbUp = true;
  } catch (e: any) {
    console.error("[test] MySQL unavailable — DB cases will skip:", e.message);
  }
});

after(async () => {
  if (db?.pool?.end) await db.pool.end();
});

const dbTest = (name: string, fn: any) =>
  test(name, async (t) => {
    if (!dbUp) {
      t.skip("MySQL not available");
      return;
    }
    await fn(t);
  });

dbTest("send() persists a message that history() retrieves", async () => {
  const sent = await messageService.send({
    conversationId: convId,
    senderId: A,
    text: "hello from A",
  });
  assert.ok(sent.id, "send returns a serialized message with an id");
  assert.equal(sent.text, "hello from A");

  const hist = await messageService.history(convId, B); // B is a member → can read
  const found = hist.find((m: any) => m.id === sent.id);
  assert.ok(found, "the sent message is retrievable from history");
  assert.equal(found.text, "hello from A");
});

dbTest("a non-member cannot read history (403)", async () => {
  await assert.rejects(
    () => messageService.history(convId, OUTSIDER),
    (e: any) => e.status === 403,
    "history() rejects a non-member with 403",
  );
});

dbTest("a non-member cannot post a message (403)", async () => {
  await assert.rejects(
    () => messageService.send({ conversationId: convId, senderId: OUTSIDER, text: "sneaky" }),
    (e: any) => e.status === 403,
    "send() rejects a non-member with 403",
  );
});

dbTest("edit() updates a plaintext body; only the author may edit", async () => {
  const sent = await messageService.send({
    conversationId: convId,
    senderId: A,
    text: "original",
  });
  const edited = await messageService.edit({
    messageId: sent.id,
    userId: A,
    text: "edited text",
  });
  assert.ok(edited, "edit returns the updated message");
  assert.equal(edited.text, "edited text");
  assert.equal(edited.edited, true, "edited flag is set");

  // A different user cannot edit someone else's message (returns null, no change).
  const byOther = await messageService.edit({
    messageId: sent.id,
    userId: B,
    text: "hijacked",
  });
  assert.equal(byOther, null, "a non-author edit is refused");
  // Confirm the body was NOT changed by the refused edit.
  const stillEdited = await db.messages.getById(sent.id);
  assert.equal(stillEdited.body, "edited text", "body unchanged after refused edit");
});

dbTest("encrypted edit nulls the stored plaintext body", async () => {
  // Start from a plaintext message, then edit it with an encrypted envelope.
  const sent = await messageService.send({
    conversationId: convId,
    senderId: A,
    text: "plaintext to be encrypted",
  });
  const envelope = { version: 1, envelopes: [{ deviceId: "d1", ciphertext: "opaque" }] };
  const edited = await messageService.edit({
    messageId: sent.id,
    userId: A,
    encrypted: envelope,
  });
  assert.ok(edited, "encrypted edit returns the message");
  const row = await db.messages.getById(sent.id);
  assert.equal(row.body, null, "stored body is NULL after an encrypted edit");
  assert.ok(Number(row.encryptionVersion) > 0, "encryption_version is bumped");
});

dbTest("soft-delete tombstones the message (row kept, content cleared)", async () => {
  const sent = await messageService.send({
    conversationId: convId,
    senderId: A,
    text: "delete me",
  });
  const res = await messageService.remove({ messageId: sent.id, userId: A });
  assert.equal(res.deleted, true, "remove reports the message deleted");

  // The row is KEPT as a tombstone (content cleared) so the client can render
  // "This message was deleted" in place — it is NOT physically removed.
  const row = await db.messages.getById(sent.id);
  assert.ok(row, "the message row still exists (tombstone, not a hard delete)");
  assert.equal(row.body, null, "tombstoned body is cleared");
  assert.equal(row.deleted, true, "the row is flagged deleted");

  // It still appears in history (as a deleted tombstone), proving soft-delete
  // semantics rather than hiding. The serialized form carries deleted=true.
  const hist = await messageService.history(convId, A);
  const inHist = hist.find((m: any) => m.id === sent.id);
  assert.ok(inHist, "tombstone is still returned by history");
  assert.equal(inHist.deleted, true, "history marks it deleted");

  // A non-author cannot delete someone else's message.
  const sent2 = await messageService.send({
    conversationId: convId,
    senderId: A,
    text: "you can't delete this",
  });
  const refused = await messageService.remove({ messageId: sent2.id, userId: B });
  assert.equal(refused.deleted, false, "a non-author delete is refused");
});

// FORWARDED ATTACHMENTS. A forward re-references the ORIGINAL file id from a
// different conversation. Members of that conversation never had any grant on
// the file (the model only knew the upload conversation), so every forwarded
// image/document rendered "File no longer available" for them. send() now
// grants the target conversation a view share — and refuses to carry a file
// the sender can't see themselves (forwarding must not be an access bypass).
dbTest("forwarding a file into another conversation makes it readable there", async () => {
  const fileService = await import("../src/services/fileService");
  const conv2 = await db.conversations.create({
    kind: shared.CONVERSATION.GROUP,
    title: "Msg Test Forward Target",
    icon: "➡️",
    createdBy: A,
  });
  await db.conversations.addMember(conv2.id, A, { role: "owner" });
  await db.conversations.addMember(conv2.id, OUTSIDER, { role: "member" });

  // A's file, uploaded into the FIRST group (B is a member there, OUTSIDER is not).
  const f = await db.files.create({
    conversationId: convId,
    uploaderId: A,
    name: "shot.png",
    mime: "image/png",
    size: 3,
    data: Buffer.from("png"),
  });
  assert.equal(await fileService.permissionFor(f.id, B), "view", "a member of the upload conversation can view");
  assert.equal(await fileService.permissionFor(f.id, OUTSIDER), null, "the forward recipient has no access yet");

  // A forwards it into the second group.
  const fwd = await messageService.send({
    conversationId: conv2.id,
    senderId: A,
    file: { id: f.id, name: "shot.png", type: "image/png", size: 3 },
    forwarded: true,
    forwardCount: 1,
  });
  assert.ok(fwd.id);
  assert.equal(await fileService.permissionFor(f.id, OUTSIDER), "view", "the forward recipient can now open the file");
  const dl = await fileService.getDownload({ fileId: f.id, userId: OUTSIDER });
  assert.ok(dl, "download is no longer a 404 for the recipient");
});

dbTest("a sender cannot forward a file they cannot see (403)", async () => {
  // B's private file in a conversation OUTSIDER is not part of.
  const f = await db.files.create({
    conversationId: convId,
    uploaderId: B,
    name: "secret.pdf",
    mime: "application/pdf",
    size: 3,
    data: Buffer.from("pdf"),
  });
  const convX = await db.conversations.create({
    kind: shared.CONVERSATION.GROUP,
    title: "Msg Test Outsider Group",
    icon: "🙈",
    createdBy: OUTSIDER,
  });
  await db.conversations.addMember(convX.id, OUTSIDER, { role: "owner" });
  await assert.rejects(
    () => messageService.send({ conversationId: convX.id, senderId: OUTSIDER, file: { id: f.id, name: "secret.pdf" }, forwarded: true }),
    (e: any) => e.status === 403 && e.code === "FILE_FORBIDDEN",
    "send() refuses to carry a file the sender has no access to",
  );
  const fileService = await import("../src/services/fileService");
  assert.equal(await fileService.permissionFor(f.id, OUTSIDER), null, "no share was created as a side effect");
});
