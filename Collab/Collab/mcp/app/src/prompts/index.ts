import type { McpPrompt } from "../types";

// Reusable prompt templates. Each prompt ORCHESTRATES tools — it tells the
// assistant which MCP tools to call and how to shape the answer. Prompts never
// duplicate backend logic; they are instruction scaffolds over the tool layer.
const user = (text: string) => [{ role: "user", text }];

export const prompts: McpPrompt[] = [
  {
    name: "daily_summary",
    description:
      "A concise start-of-day briefing across messages, meetings, tasks, and reminders.",
    build: () =>
      user(
        [
          "Produce my daily summary. Use these tools and synthesize the results:",
          "- unread_activity (what needs my attention)",
          "- upcoming_meetings (today's schedule)",
          "- list_tasks (open items, highlight overdue / due today)",
          "- upcoming_reminders (due today/soon)",
          "Format as short sections: Needs attention, Today's meetings, Tasks, Reminders.",
          "Be concise; surface only what is actionable today.",
        ].join("\n"),
      ),
  },
  {
    name: "meeting_summary",
    description: "Summarize a meeting and its linked discussion.",
    arguments: [
      {
        name: "meetingId",
        description: "Meeting id to summarize",
        required: true,
      },
    ],
    build: (a) =>
      user(
        [
          `Summarize the meeting ${a.meetingId}.`,
          "1. Call meeting_details to get its title, time, attendees, and status.",
          "2. If it has a linked conversationId, call conversation_summary on that conversation.",
          "Produce: purpose, key points/decisions, action items (with owners if known), and next steps.",
        ].join("\n"),
      ),
  },
  {
    name: "task_summary",
    description: "Summarize the user's task board with priorities and risks.",
    build: () =>
      user(
        [
          "Summarize my tasks. Call list_tasks, then group by status.",
          "Call out: overdue items, items due soon, high/urgent priority, and anything blocked.",
          "End with a short recommended focus order for today.",
        ].join("\n"),
      ),
  },
  {
    name: "unread_messages",
    description: "Triage unread messages and notifications.",
    build: () =>
      user(
        [
          "Triage what I've missed. Call unread_activity for notifications,",
          "and for the most active relevant conversations call list_messages (small limit) to get context.",
          "Group by conversation/person. For each, give a one-line gist and whether it needs a reply.",
          "Do NOT quote messages verbatim at length — summarize.",
        ].join("\n"),
      ),
  },
  {
    name: "project_status",
    description:
      "Status report for a project, from its tasks and related discussion.",
    arguments: [
      { name: "project", description: "Project name", required: true },
    ],
    build: (a) =>
      user(
        [
          `Build a status report for project "${a.project}".`,
          "1. Call list_tasks and filter to this project; summarize progress by status.",
          `2. Call global_search with the project name to find related messages, files, and meetings.`,
          "Produce: progress summary, completed vs remaining, risks/blockers, and recommended next actions.",
        ].join("\n"),
      ),
  },
  {
    name: "upcoming_meetings",
    description: "Brief the user on their upcoming meetings.",
    build: () =>
      user(
        [
          "Call upcoming_meetings and brief me. For each: title, when (relative + absolute),",
          "duration, attendees, and whether a lobby/lock is set. Flag conflicts or back-to-backs.",
        ].join("\n"),
      ),
  },
  {
    name: "recent_activity",
    description: "Recap the user's recent activity.",
    build: () =>
      user(
        [
          "Call recent_activity and give me a brief recap of what I've done recently,",
          "grouped by type (messages, tasks, meetings, files). Keep it short.",
        ].join("\n"),
      ),
  },
];
