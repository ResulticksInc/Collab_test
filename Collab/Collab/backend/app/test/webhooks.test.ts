import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { useTestDatabase } from "./_setup";

// CHAT WEBHOOKS — driven through the real webhookService + MySQL driver against
// the throwaway `colab_test` schema (same DB strategy as messaging.test.ts: skip
// if MySQL is unreachable).
//
// The value here is that the persistence layer carries the parts most likely to
// be silently wrong — the FIND_IN_SET event filter, the atomic delivery claim,
// the INTERVAL-based backoff, and the ON DELETE CASCADE — none of which a
// typecheck can catch. The service layer carries the authorization rules, which
// are the security boundary.
//
// Covers:
//   - scoping to a GROUP and to a PARTICULAR USER (their DM)
//   - the membership gate on create / list / manage, and on ingest
//   - incoming tokens: hashed at rest, rotation kills the old one, disable kills it
//   - the outgoing event-subscription filter and the enqueue/claim/retry queue
//   - the incoming→outgoing loop guard
//   - SSRF refusal of a private target

let dbUp = false;
let db: any;
let webhookService: any;
let shared: any;

const A = "u_whtest_a";
const B = "u_whtest_b";
const OUTSIDER = "u_whtest_x";
let groupId: string;
let dmId: string;

before(async () => {
  await useTestDatabase();
  process.env.AUTH_JWT_SECRET = "test-secret-colab";
  process.env.LIVEKIT_API_KEY = "testkey";
  process.env.LIVEKIT_API_SECRET = "testsecret_at_least_32_characters_long_xx";
  process.env.LIVEKIT_WS_URL = "ws://localhost:7534";
  // Keep the SSRF refusal on for this suite — one of the cases asserts it.
  process.env.WEBHOOKS_ALLOW_PRIVATE_TARGETS = "false";

  try {
    const { migrate } = await import("../../../database/src");
    const platform = await import("../src/platform");
    db = platform.db;
    shared = platform.shared;
    await migrate(platform.config.database.url);
    webhookService = await import("../src/services/webhookService");

    for (const [id, name] of [
      [A, "Webhook Test A"],
      [B, "Webhook Test B"],
      [OUTSIDER, "Webhook Test Outsider"],
    ] as const) {
      await db.users.upsert({
        id,
        email: id + "@ex.com",
        name,
        initials: "WT",
        color: "#2563EB",
        presence: "off",
        passwordHash: null,
      });
    }
    const group = await db.conversations.create({
      kind: shared.CONVERSATION.GROUP,
      title: "Webhook Test Group",
      icon: "🔗",
      createdBy: A,
    });
    groupId = group.id;
    await db.conversations.addMember(groupId, A, { role: "owner" });
    await db.conversations.addMember(groupId, B, { role: "member" });

    // Reuse the DM if a previous run of this suite already made one — the test
    // schema is migrated, not dropped, between runs, and findDmBetween returns
    // the FIRST match, so blindly creating a second DM would desync the assertion.
    const existingDm = await db.conversations.findDmBetween(A, B);
    if (existingDm) {
      dmId = existingDm;
    } else {
      const dm = await db.conversations.create({ kind: "dm", createdBy: A });
      dmId = dm.id;
      await db.conversations.addMember(dmId, A, { role: "member" });
      await db.conversations.addMember(dmId, B, { role: "member" });
    }
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

// ── Scoping ─────────────────────────────────────────────────────────────────

dbTest("an incoming webhook can be scoped to a GROUP", async () => {
  const r = await webhookService.create({
    ownerId: A,
    direction: "in",
    conversationId: groupId,
    name: "CI",
  });
  assert.equal(r.webhook.conversationId, groupId);
  assert.equal(r.webhook.scope, "group");
  assert.match(
    r.token,
    /^whin_/,
    "the plaintext token is returned exactly once",
  );
  assert.equal(r.webhook.tokenHint, r.token.slice(-6));
});

dbTest(
  "a webhook can be scoped to a PARTICULAR USER via their DM",
  async () => {
    const r = await webhookService.create({
      ownerId: A,
      direction: "in",
      userId: B,
      name: "Alerts for B",
    });
    assert.equal(
      r.webhook.conversationId,
      dmId,
      "userId resolves to the existing DM",
    );
    assert.equal(r.webhook.scope, "user");
  },
);

dbTest(
  "a user with no DM to the target gets a clear 404, not a new DM",
  async () => {
    await assert.rejects(
      () =>
        webhookService.create({
          ownerId: A,
          direction: "in",
          userId: OUTSIDER,
        }),
      (e: any) => e.status === 404,
      "creating a webhook never opens an unsolicited DM",
    );
  },
);

// ── Authorization ───────────────────────────────────────────────────────────

dbTest("a non-member cannot create a webhook on a conversation", async () => {
  await assert.rejects(
    () =>
      webhookService.create({
        ownerId: OUTSIDER,
        direction: "in",
        conversationId: groupId,
      }),
    (e: any) => e.status === 403,
  );
});

dbTest(
  "a non-member cannot list or manage a conversation's webhooks",
  async () => {
    const { webhook } = await webhookService.create({
      ownerId: A,
      direction: "in",
      conversationId: groupId,
      name: "Managed",
    });
    await assert.rejects(
      () => webhookService.listForConversation(groupId, OUTSIDER),
      (e: any) => e.status === 403,
    );
    await assert.rejects(
      () => webhookService.remove(webhook.id, OUTSIDER),
      (e: any) => e.status === 403,
    );
    await assert.rejects(
      () => webhookService.deliveries(webhook.id, OUTSIDER),
      (e: any) => e.status === 403,
    );
  },
);

dbTest(
  "a plain member cannot manage someone else's webhook, an admin can",
  async () => {
    const { webhook } = await webhookService.create({
      ownerId: A,
      direction: "in",
      conversationId: groupId,
      name: "A's hook",
    });
    // B is a plain member of the group.
    await assert.rejects(
      () => webhookService.update(webhook.id, B, { name: "hijacked" }),
      (e: any) => e.status === 403,
    );
    await db.conversations.setMemberRole(groupId, B, "admin");
    const updated = await webhookService.update(webhook.id, B, {
      name: "renamed by admin",
    });
    assert.equal(updated.name, "renamed by admin");
    await db.conversations.setMemberRole(groupId, B, "member");
  },
);

// ── Incoming credentials ────────────────────────────────────────────────────

dbTest("the incoming token is stored hashed, never in plaintext", async () => {
  const { token, webhook } = await webhookService.create({
    ownerId: A,
    direction: "in",
    conversationId: groupId,
    name: "Hashing",
  });
  const [rows]: any = await db.pool.query(
    "SELECT token_hash, token_hint FROM chat_webhooks WHERE id = ?",
    [webhook.id],
  );
  assert.equal(rows[0].token_hash.length, 64, "stored as a sha256 hex digest");
  assert.ok(
    !rows[0].token_hash.includes(token),
    "the plaintext is not in the row",
  );
  assert.ok(!JSON.stringify(rows[0]).includes(token.slice(0, 20)));
});

dbTest(
  "resolveIngest accepts the live token and rejects a bogus one as 404",
  async () => {
    const { token } = await webhookService.create({
      ownerId: A,
      direction: "in",
      conversationId: groupId,
      name: "Ingest",
    });
    const r = await webhookService.resolveIngest(token, { text: "hello" });
    assert.equal(r.text, "hello");
    assert.equal(r.webhook.conversationId, groupId);
    await assert.rejects(
      () =>
        webhookService.resolveIngest("whin_not_a_real_token", { text: "x" }),
      (e: any) => e.status === 404,
      "an unknown token reveals nothing — same 404 as a disabled one",
    );
  },
);

dbTest("resolveIngest understands Slack- and Teams-shaped bodies", async () => {
  const { token } = await webhookService.create({
    ownerId: A,
    direction: "in",
    conversationId: groupId,
    name: "Shapes",
  });
  assert.equal(
    (await webhookService.resolveIngest(token, { text: "slack" })).text,
    "slack",
  );
  assert.equal(
    (
      await webhookService.resolveIngest(token, {
        title: "Deploy",
        text: "v2 live",
      })
    ).text,
    "**Deploy**\n\nv2 live",
  );
  await assert.rejects(
    () => webhookService.resolveIngest(token, {}),
    (e: any) => e.status === 400,
    "an empty body is a clear 400, not an empty message in the conversation",
  );
});

dbTest("rotating an incoming webhook kills the previous token", async () => {
  const first = await webhookService.create({
    ownerId: A,
    direction: "in",
    conversationId: groupId,
    name: "Rotate",
  });
  await webhookService.resolveIngest(first.token, { text: "before" }); // works
  const second = await webhookService.rotate(first.webhook.id, A);
  assert.notEqual(second.token, first.token);
  await assert.rejects(
    () => webhookService.resolveIngest(first.token, { text: "after" }),
    (e: any) => e.status === 404,
  );
  const after = await webhookService.resolveIngest(second.token, {
    text: "after",
  });
  assert.equal(
    after.webhook.id,
    first.webhook.id,
    "same webhook, new credential",
  );
});

dbTest(
  "disabling an incoming webhook makes its token stop working",
  async () => {
    const { token, webhook } = await webhookService.create({
      ownerId: A,
      direction: "in",
      conversationId: groupId,
      name: "Disable",
    });
    await webhookService.update(webhook.id, A, { enabled: false });
    await assert.rejects(
      () => webhookService.resolveIngest(token, { text: "x" }),
      (e: any) => e.status === 404,
    );
  },
);

dbTest(
  "an incoming webhook dies when its owner leaves the conversation",
  async () => {
    const conv = await db.conversations.create({
      kind: shared.CONVERSATION.GROUP,
      title: "Leaver",
      createdBy: A,
    });
    await db.conversations.addMember(conv.id, A, { role: "owner" });
    await db.conversations.addMember(conv.id, B, { role: "member" });
    const { token } = await webhookService.create({
      ownerId: B,
      direction: "in",
      conversationId: conv.id,
      name: "B's hook",
    });
    await webhookService.resolveIngest(token, { text: "while a member" });
    await db.conversations.removeMember(conv.id, B, A);
    await assert.rejects(
      () => webhookService.resolveIngest(token, { text: "after leaving" }),
      (e: any) => e.status === 403,
      "a webhook is never more privileged than the member who created it",
    );
  },
);

// ── Outgoing ────────────────────────────────────────────────────────────────

dbTest(
  "an outgoing target on a private address is refused (SSRF)",
  async () => {
    for (const url of [
      "http://127.0.0.1:9000/hook",
      "http://localhost/hook",
      "http://169.254.169.254/latest/meta-data",
      "http://10.0.0.5/hook",
    ]) {
      await assert.rejects(
        () =>
          webhookService.create({
            ownerId: A,
            direction: "out",
            conversationId: groupId,
            targetUrl: url,
          }),
        (e: any) => e.status === 400,
        `refused: ${url}`,
      );
    }
    await assert.rejects(
      () =>
        webhookService.create({
          ownerId: A,
          direction: "out",
          conversationId: groupId,
          targetUrl: "ftp://example.com/x",
        }),
      (e: any) => e.status === 400,
      "non-http schemes are refused",
    );
  },
);

dbTest("the outgoing fan-out honours the event subscription", async () => {
  const conv = await db.conversations.create({
    kind: shared.CONVERSATION.GROUP,
    title: "Events",
    createdBy: A,
  });
  await db.conversations.addMember(conv.id, A, { role: "owner" });
  await webhookService.create({
    ownerId: A,
    direction: "out",
    conversationId: conv.id,
    name: "Created only",
    targetUrl: "https://example.com/a",
    events: ["message.created"],
  });
  await webhookService.create({
    ownerId: A,
    direction: "out",
    conversationId: conv.id,
    name: "Deleted only",
    targetUrl: "https://example.com/b",
    events: ["message.deleted"],
  });
  assert.equal(
    (await db.webhooks.listOutgoingFor(conv.id, "message.created")).length,
    1,
  );
  assert.equal(
    (await db.webhooks.listOutgoingFor(conv.id, "message.deleted")).length,
    1,
  );
  assert.equal(
    (await db.webhooks.listOutgoingFor(conv.id, "message.updated")).length,
    0,
  );
});

dbTest(
  "an unknown event name falls back to message.created rather than subscribing to nothing",
  async () => {
    const conv = await db.conversations.create({
      kind: shared.CONVERSATION.GROUP,
      title: "Bad events",
      createdBy: A,
    });
    await db.conversations.addMember(conv.id, A, { role: "owner" });
    const r = await webhookService.create({
      ownerId: A,
      direction: "out",
      conversationId: conv.id,
      name: "Bad events",
      targetUrl: "https://example.com/c",
      events: ["nonsense", "also.nonsense"],
    });
    assert.deepEqual(r.webhook.events, ["message.created"]);
  },
);

dbTest(
  "a delivery is claimed exactly once, then retried on its backoff",
  async () => {
    const conv = await db.conversations.create({
      kind: shared.CONVERSATION.GROUP,
      title: "Queue",
      createdBy: A,
    });
    await db.conversations.addMember(conv.id, A, { role: "owner" });
    const { webhook } = await webhookService.create({
      ownerId: A,
      direction: "out",
      conversationId: conv.id,
      name: "Queue",
      targetUrl: "https://example.com/queue",
    });
    const id = await db.webhooks.enqueue(
      webhook.id,
      "message.created",
      JSON.stringify({ a: 1 }),
    );

    const first = await db.webhooks.claimDue(10);
    assert.ok(
      first.find((d: any) => d.id === id),
      "the pending delivery is claimed",
    );
    assert.equal(
      first.find((d: any) => d.id === id).secret.startsWith("whsec_"),
      true,
      "the claim carries the signing secret",
    );
    assert.equal(
      (await db.webhooks.claimDue(10)).find((d: any) => d.id === id),
      undefined,
      "a claimed delivery is never handed out twice",
    );

    await db.webhooks.markFailed(id, 503, "HTTP 503", 45);
    assert.equal(
      (await db.webhooks.claimDue(10)).find((d: any) => d.id === id),
      undefined,
      "a backed-off delivery is not due yet",
    );
    await db.pool.query(
      "UPDATE chat_webhook_deliveries SET next_attempt_at = now(3) WHERE id = ?",
      [id],
    );
    const retried = (await db.webhooks.claimDue(10)).find(
      (d: any) => d.id === id,
    );
    assert.equal(
      retried.attempts,
      1,
      "it comes back for a second attempt once the backoff elapses",
    );

    await db.webhooks.markFailed(id, 503, "HTTP 503", null);
    const log = await webhookService.deliveries(webhook.id, A);
    assert.equal(
      log.find((d: any) => d.id === id).status,
      "failed",
      "a null backoff is terminal",
    );
  },
);

dbTest("a delivery for a webhook disabled mid-flight is not sent", async () => {
  const conv = await db.conversations.create({
    kind: shared.CONVERSATION.GROUP,
    title: "Revoke",
    createdBy: A,
  });
  await db.conversations.addMember(conv.id, A, { role: "owner" });
  const { webhook } = await webhookService.create({
    ownerId: A,
    direction: "out",
    conversationId: conv.id,
    name: "Revoked",
    targetUrl: "https://example.com/revoked",
  });
  await db.webhooks.enqueue(webhook.id, "message.created", "{}");
  await webhookService.update(webhook.id, A, { enabled: false });
  const claimed = (await db.webhooks.claimDue(10)).find(
    (d: any) => d.webhookId === webhook.id,
  );
  assert.equal(
    claimed.hookLive,
    false,
    "the drain sees the revocation and drops the payload",
  );
});

dbTest(
  "a signature verifies against the exact bytes and timestamp",
  async () => {
    const crypto = await import("crypto");
    const payload = JSON.stringify({ event: "message.created", n: 1 });
    const header = webhookService.signPayload(
      "whsec_test",
      payload,
      1700000000,
    );
    const parts: any = Object.fromEntries(
      header.split(",").map((kv: string) => kv.split("=")),
    );
    assert.equal(parts.t, "1700000000");
    assert.equal(
      parts.v1,
      crypto
        .createHmac("sha256", "whsec_test")
        .update(`1700000000.${payload}`)
        .digest("hex"),
    );
    const tampered = webhookService.signPayload(
      "whsec_test",
      payload + " ",
      1700000000,
    );
    assert.notEqual(
      tampered.split("v1=")[1],
      parts.v1,
      "a one-byte change breaks the signature",
    );
  },
);

// ── Loop safety ─────────────────────────────────────────────────────────────

dbTest(
  "a message that ARRIVED via an incoming webhook is not re-emitted outward",
  async () => {
    const conv = await db.conversations.create({
      kind: shared.CONVERSATION.GROUP,
      title: "Loop",
      createdBy: A,
    });
    await db.conversations.addMember(conv.id, A, { role: "owner" });
    const { webhook: outHook } = await webhookService.create({
      ownerId: A,
      direction: "out",
      conversationId: conv.id,
      name: "Bridge",
      targetUrl: "https://example.com/loop",
    });
    const messageService = await import("../src/services/messageService");

    // A human message queues a delivery.
    await messageService.send({
      conversationId: conv.id,
      senderId: A,
      text: "human",
    });
    await new Promise((r) => setTimeout(r, 300)); // dispatch is fire-and-forget
    const afterHuman = (await webhookService.deliveries(outHook.id, A)).length;
    assert.equal(afterHuman, 1, "an ordinary message fans out");

    // The same send marked as webhook-originated must NOT.
    await messageService.send({
      conversationId: conv.id,
      senderId: A,
      text: "from a webhook",
      viaWebhookId: "some-incoming-hook",
    } as any);
    await new Promise((r) => setTimeout(r, 300));
    assert.equal(
      (await webhookService.deliveries(outHook.id, A)).length,
      afterHuman,
      "wiring an incoming hook to an outgoing hook cannot loop",
    );
  },
);

dbTest(
  "a conversation cannot exceed the per-conversation webhook cap",
  async () => {
    const conv = await db.conversations.create({
      kind: shared.CONVERSATION.GROUP,
      title: "Capped",
      createdBy: A,
    });
    await db.conversations.addMember(conv.id, A, { role: "owner" });
    const platform = await import("../src/platform");
    const cap = platform.config.webhooks.maxPerConversation;
    for (let i = 0; i < cap; i++)
      await webhookService.create({
        ownerId: A,
        direction: "in",
        conversationId: conv.id,
        name: `hook ${i}`,
      });
    await assert.rejects(
      () =>
        webhookService.create({
          ownerId: A,
          direction: "in",
          conversationId: conv.id,
          name: "one too many",
        }),
      (e: any) => e.status === 409 && e.code === "LIMIT_REACHED",
    );
  },
);

dbTest(
  "editing and deleting a message fan out as their own events",
  async () => {
    const conv = await db.conversations.create({
      kind: shared.CONVERSATION.GROUP,
      title: "Edits",
      createdBy: A,
    });
    await db.conversations.addMember(conv.id, A, { role: "owner" });
    const { webhook } = await webhookService.create({
      ownerId: A,
      direction: "out",
      conversationId: conv.id,
      name: "All events",
      targetUrl: "https://example.com/all",
      events: ["message.created", "message.updated", "message.deleted"],
    });
    const messageService = await import("../src/services/messageService");

    const sent = await messageService.send({
      conversationId: conv.id,
      senderId: A,
      text: "first",
    });
    await messageService.edit({
      messageId: sent.id,
      userId: A,
      text: "second",
      encrypted: null,
    });
    await messageService.remove({ messageId: sent.id, userId: A });
    await new Promise((r) => setTimeout(r, 500)); // dispatch is fire-and-forget

    const events = (await webhookService.deliveries(webhook.id, A))
      .map((d: any) => d.event)
      .sort();
    assert.deepEqual(events, [
      "message.created",
      "message.deleted",
      "message.updated",
    ]);
  },
);

// ── Lifecycle ───────────────────────────────────────────────────────────────

dbTest(
  "deleting the conversation removes its webhooks and their delivery log",
  async () => {
    const conv = await db.conversations.create({
      kind: shared.CONVERSATION.GROUP,
      title: "Cascade",
      createdBy: A,
    });
    await db.conversations.addMember(conv.id, A, { role: "owner" });
    const { webhook } = await webhookService.create({
      ownerId: A,
      direction: "out",
      conversationId: conv.id,
      name: "Doomed",
      targetUrl: "https://example.com/doomed",
    });
    await db.webhooks.enqueue(webhook.id, "message.created", "{}");
    await db.pool.query("DELETE FROM conversations WHERE id = ?", [conv.id]);
    const [hooks]: any = await db.pool.query(
      "SELECT COUNT(*) n FROM chat_webhooks WHERE id = ?",
      [webhook.id],
    );
    const [dels]: any = await db.pool.query(
      "SELECT COUNT(*) n FROM chat_webhook_deliveries WHERE webhook_id = ?",
      [webhook.id],
    );
    assert.equal(hooks[0].n, 0, "no orphaned webhook rows");
    assert.equal(
      dels[0].n,
      0,
      "no orphaned payloads (they embed message text)",
    );
  },
);
