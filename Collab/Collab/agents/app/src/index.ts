// AI Workspace Companion — SCAFFOLD (Sprint 6).
// NOT a greeting/quote generator. Designed to read real workspace context
// (messages, meetings, calendar, activity) via backend services and produce
// briefings, summaries and insights. No model calls are wired yet; this declares
// the interface so the architecture supports it cleanly.
const companion = {
  async dailyBriefing(/* userId, ctx */) {
    throw new Error(
      "not implemented (Sprint 6): aggregates unread, meetings, mentions into a briefing",
    );
  },
  async summarizeConversation(/* conversationId */) {
    throw new Error("not implemented (Sprint 6)");
  },
  async workspaceInsights(/* scope */) {
    throw new Error("not implemented (Sprint 6)");
  },
};
export { companion };
