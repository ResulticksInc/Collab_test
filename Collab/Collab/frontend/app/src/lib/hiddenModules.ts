// Modules that are switched OFF in the frontend.
//
// Their components, routes and APIs are all intact — this is a visibility gate,
// not a deletion, so re-enabling a module is removing its entry here.
//
// This list is the SINGLE source of truth, shared by:
//   • Rail.tsx        — drops the nav entries
//   • CoLabV1.tsx     — guards setMode(), so NOTHING can route into a hidden
//                       module: not a notification click, not a deep link, not
//                       a service-worker navigation intent, not a restored
//                       `clb_mode`, not an Activity row.
//   • the Activity feed — filters out rows that would target one
//
// Hiding only the nav entry was not enough: the modules stayed fully reachable
// through every other entry point. Clicking a notification in Activity landed
// the user in Files — a module they are not supposed to have access to.
export const HIDDEN_MODULES = new Set<string>([
  "tasks",
  "reminders",
  "files",
]);

// Where to send someone who tried to reach a hidden module.
export const HIDDEN_MODULE_FALLBACK = "dashboard";

export function isHiddenModule(mode: unknown): boolean {
  return typeof mode === "string" && HIDDEN_MODULES.has(mode);
}
