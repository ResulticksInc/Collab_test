import { config, db } from "../platform";

// OpenAI-compatible chat-completions call. Used for in-product AI features.
async function chatComplete(messages: any[], opts: any = {}) {
  const base = config.ai.baseUrl;
  if (!base) {
    const e: any = new Error("AI is not configured");
    e.code = "AI_DISABLED";
    throw e;
  }
  const url = base.replace(/\/+$/, "") + "/chat/completions";
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), config.ai.timeoutMs || 30000);
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer " + (config.ai.apiKey || ""),
      },
      body: JSON.stringify({
        model: config.ai.model,
        messages,
        temperature: opts.temperature ?? 0.3,
        max_tokens: opts.maxTokens ?? 600,
        stream: false,
      }),
      signal: ctrl.signal,
    });
    if (!res.ok) {
      const t = await res.text().catch(() => "");
      const e: any = new Error(
        "AI upstream " + res.status + (t ? ": " + t.slice(0, 200) : ""),
      );
      e.code = "AI_UPSTREAM";
      throw e;
    }
    const data: any = await res.json();
    const text =
      data &&
      data.choices &&
      data.choices[0] &&
      data.choices[0].message &&
      data.choices[0].message.content;
    if (!text) {
      const e: any = new Error("AI returned no content");
      e.code = "AI_EMPTY";
      throw e;
    }
    return String(text).trim();
  } finally {
    clearTimeout(timer);
  }
}

async function senderName(id: string) {
  try {
    const u = await db.users.getById(id);
    return (u && u.name) || "Member";
  } catch (_) {
    return "Member";
  }
}

// Summarize a conversation the caller is a member of. Membership is enforced
// before any messages are read (no IDOR).
async function summarizeConversation({
  userId,
  conversationId,
}: {
  userId: string;
  conversationId: string;
}) {
  const member = await db.conversations.isMember(conversationId, userId);
  if (!member) {
    const e: any = new Error("Not a member of this conversation");
    e.code = "FORBIDDEN";
    throw e;
  }
  const conv = await db.conversations.getById(conversationId);
  // AUDIT P2 (#37): pass viewerId so the SAME per-member history_visible_from cutoff
  // the chat UI applies is enforced on the transcript fed to the LLM — otherwise a
  // member who joined without prior history could extract it via "Catch me up".
  const rows = await db.messages.listForConversation(conversationId, {
    limit: 60,
    viewerId: userId,
  });
  if (!rows || rows.length === 0) {
    return { summary: "There are no messages in this conversation yet." };
  }
  const lines: string[] = [];
  // A conversation's 60 rows come from only a handful of DISTINCT senders, so the
  // old `await senderName()` per row fired up to 60 serial user queries. Memoize
  // per summary: each distinct sender resolves ONCE (still via senderName, so its
  // per-user "Member" error fallback is preserved exactly), repeats are free.
  const nameCache = new Map<string, string>();
  for (const m of rows) {
    // E2EE: never feed encrypted content (or its file placeholders) to the LLM.
    // body is already NULL for encrypted rows; skip them explicitly too.
    if (Number((m as any).encryptionVersion) > 0) continue;
    let who = nameCache.get(m.senderId);
    if (who === undefined) {
      who = await senderName(m.senderId);
      nameCache.set(m.senderId, who);
    }
    const body = (m.body || (m.file ? "[shared a file]" : "") || "")
      .toString()
      .replace(/\s+/g, " ")
      .trim();
    if (body) lines.push(who + ": " + body);
  }
  // AUDIT P3 (#50): if every readable row was encrypted/empty, the transcript is
  // empty even though rows.length > 0 — sending that to the LLM yields a
  // hallucinated summary. Return a clear message instead.
  if (lines.length === 0) {
    return {
      summary:
        "There’s nothing to summarize here — this conversation is end-to-end encrypted, so its messages can’t be read on the server.",
    };
  }
  const transcript = lines.join("\n").slice(0, 6000);
  const title =
    conv && (conv.title || conv.name) ? conv.title || conv.name : "";
  const messages = [
    {
      role: "system",
      content:
        "You summarize a workplace chat into a short catch-up. Give 2-5 concise bullet points covering the key points and any decisions, then a short 'Action items:' list only if clear action items exist (omit it otherwise). Plain text, no preamble, no markdown headings.",
    },
    {
      role: "user",
      content:
        "Conversation" +
        (title ? ' "' + title + '"' : "") +
        ":\n\n" +
        transcript,
    },
  ];
  const summary = await chatComplete(messages, {
    temperature: 0.2,
    maxTokens: 500,
  });
  return { summary };
}

function styleDirective(style?: string) {
  if (style === "concise")
    return {
      sys: "You are Agen-X, a concise assistant inside the Collab workspace. Answer in 1-3 short sentences, briefly and helpfully.",
      maxTokens: 350,
    };
  if (style === "detailed")
    return {
      sys: "You are Agen-X, a thorough assistant inside the Collab workspace. Answer in depth: explain the reasoning and cover the relevant detail, using short paragraphs or lists where helpful.",
      maxTokens: 900,
    };
  return {
    sys: "You are Agen-X, a helpful assistant inside the Collab workspace. Answer helpfully with a useful level of detail \u2014 neither terse nor padded.",
    maxTokens: 500,
  };
}

async function ask(prompt: string, style?: string) {
  const d = styleDirective(style);
  return chatComplete(
    [
      { role: "system", content: d.sys },
      { role: "user", content: String(prompt) },
    ],
    { maxTokens: d.maxTokens },
  );
}

export { summarizeConversation, ask };
