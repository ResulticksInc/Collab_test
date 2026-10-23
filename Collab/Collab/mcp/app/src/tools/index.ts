import type { BackendGateway, McpTool } from "../types";
import { messagingTools } from "./messaging";
import { contactsTools } from "./contacts";
import { calendarTools } from "./calendar";
import { taskTools } from "./tasks";
import { fileTools } from "./files";
import { activityTools } from "./activity";
import { reminderTools } from "./reminders";
import { searchTools } from "./search";

// Assemble the full tool inventory. Each module owns one feature area and maps
// exclusively to existing CoLab REST endpoints (no duplicated business logic).
export function createTools(gateway: BackendGateway): McpTool[] {
  const tools = [
    ...messagingTools(gateway),
    ...contactsTools(gateway),
    ...calendarTools(gateway),
    ...taskTools(gateway),
    ...fileTools(gateway),
    ...activityTools(gateway),
    ...reminderTools(gateway),
    ...searchTools(gateway),
  ];
  // Fail fast on duplicate tool names (a registration bug would otherwise let
  // one tool silently shadow another).
  const seen = new Set<string>();
  for (const t of tools) {
    if (seen.has(t.name)) throw new Error(`Duplicate MCP tool name: ${t.name}`);
    seen.add(t.name);
  }
  return tools;
}
