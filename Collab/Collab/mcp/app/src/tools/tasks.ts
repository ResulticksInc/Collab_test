import type { BackendGateway, McpTool } from "../types";
import { api } from "../server/gateway";
import { objectSchema, f, clampLimit, seg, page } from "./helpers";

// Task tools — orchestrate taskService via the existing /tasks routes. Status
// transitions go through POST /tasks/:id/move (the canonical board move); other
// field edits go through PATCH /tasks/:id. Assignment notifications are emitted
// by the backend, not duplicated here.
const STATUSES = ["todo", "in_progress", "review", "done"];
const PRIORITIES = ["Low", "Medium", "High", "Urgent"];

export function taskTools(gw: BackendGateway): McpTool[] {
  return [
    {
      name: "list_tasks",
      title: "List tasks",
      category: "tasks",
      description:
        "List tasks visible to the user (their board), across statuses.",
      annotations: { readOnlyHint: true },
      inputSchema: objectSchema({ limit: f.limit() }),
      run: async (i, c) => {
        // GET /tasks now returns a paginated envelope { tasks, hasMore, count,
        // nextCursor }. Unwrap to the array (tolerating the legacy bare-array
        // shape) before paging the MCP result.
        const res = (await gw.get(api("/tasks"), c)) as any;
        const data = Array.isArray(res) ? res : res && res.tasks ? res.tasks : [];
        return page(data, clampLimit(i.limit));
      },
    },
    {
      name: "create_task",
      title: "Create task",
      category: "tasks",
      description:
        "Create a task. Only `title` is required; everything else is optional.",
      annotations: { readOnlyHint: false, destructiveHint: false },
      inputSchema: objectSchema(
        {
          title: f.text("Task title", 255),
          description: f.text("Task description", 4000),
          status: {
            type: "string",
            description: "Initial status.",
            enum: STATUSES,
            default: "todo",
          },
          priority: {
            type: "string",
            description: "Priority.",
            enum: PRIORITIES,
            default: "Medium",
          },
          assigneeId: f.id("User id to assign to"),
          dueAt: f.isoDate("Due date/time"),
          dueLabel: f.shortText("Human-friendly due label (e.g. 'Friday')"),
          project: f.shortText("Project name"),
          labels: f.stringArray("Labels/tags"),
        },
        ["title"],
      ),
      run: (i, c) =>
        gw.post(
          api("/tasks"),
          {
            title: i.title,
            description: i.description,
            status: i.status,
            priority: i.priority,
            assigneeId: i.assigneeId,
            dueAt: i.dueAt,
            dueLabel: i.dueLabel,
            project: i.project,
            labels: i.labels || [],
          },
          c,
        ),
    },
    {
      name: "assign_task",
      title: "Assign task",
      category: "tasks",
      description:
        "Assign (or reassign) a task to a user. Notifies the assignee.",
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
      },
      inputSchema: objectSchema(
        { taskId: f.id("Task id"), assigneeId: f.id("User id to assign to") },
        ["taskId", "assigneeId"],
      ),
      run: (i, c) =>
        gw.patch(
          api(`/tasks/${seg(i.taskId)}`),
          { assigneeId: i.assigneeId },
          c,
        ),
    },
    {
      name: "update_status",
      title: "Update task status",
      category: "tasks",
      description:
        "Move a task to a different status column (todo / in_progress / review / done).",
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
      },
      inputSchema: objectSchema(
        {
          taskId: f.id("Task id"),
          status: {
            type: "string",
            description: "Target status.",
            enum: STATUSES,
          },
        },
        ["taskId", "status"],
      ),
      run: (i, c) =>
        gw.post(api(`/tasks/${seg(i.taskId)}/move`), { status: i.status }, c),
    },
    {
      name: "update_task",
      title: "Update task fields",
      category: "tasks",
      description:
        "Update one or more task fields (title, description, priority, due date, project, labels).",
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
      },
      inputSchema: objectSchema(
        {
          taskId: f.id("Task id"),
          title: f.text("New title", 255),
          description: f.text("New description", 4000),
          priority: {
            type: "string",
            description: "Priority.",
            enum: PRIORITIES,
          },
          dueAt: f.isoDate("Due date/time"),
          dueLabel: f.shortText("Due label"),
          project: f.shortText("Project name"),
          labels: f.stringArray("Labels/tags"),
        },
        ["taskId"],
      ),
      run: (i, c) => {
        const patch: Record<string, unknown> = {};
        for (const k of [
          "title",
          "description",
          "priority",
          "dueAt",
          "dueLabel",
          "project",
          "labels",
        ])
          if (i[k] !== undefined) patch[k] = i[k];
        return gw.patch(api(`/tasks/${seg(i.taskId)}`), patch, c);
      },
    },
  ];
}
