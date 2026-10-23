// AUDIT #43: promise-based, app-styled replacements for the native window.prompt /
// window.confirm / window.alert dialogs. Core enterprise flows (remove a member,
// delete a role, force-logout, create an org, destructive resets) must NOT fall
// back to the browser's unstyled, un-branded, non-theme-aware system dialogs.
//
// Design: a tiny module-level FIFO queue of pending requests. Any call site —
// component or not — awaits confirmDialog/promptDialog/alertDialog; the singleton
// <DialogHost/> (mounted once in CoLabV1) subscribes, renders the current request
// in the app's Modal, and resolves the awaited promise on the user's choice. This
// mirrors the existing `colab:toast` singleton pattern so a single host serves the
// whole app and no call site needs its own modal state.

export type DialogKind = "confirm" | "prompt" | "alert" | "choice";

export interface DialogChoiceOption {
  value: string;
  label: string;
  description?: string;
}

export interface DialogRequest {
  kind: DialogKind;
  title?: string;
  message: string;
  // prompt only:
  defaultValue?: string;
  placeholder?: string;
  multiline?: boolean;
  // choice only: radio options + an optional "remember my choice" checkbox.
  options?: DialogChoiceOption[];
  rememberLabel?: string;
  // labels + styling:
  confirmText?: string;
  cancelText?: string;
  danger?: boolean; // style the confirm button as destructive
}

// A queued request paired with its promise resolver. `resolve` receives:
//  • confirm → boolean
//  • prompt  → string (submitted value) or null (cancelled)
//  • alert   → true (dismissed)
export interface PendingDialog {
  id: number;
  req: DialogRequest;
  resolve: (value: any) => void;
}

let seq = 0;
const queue: PendingDialog[] = [];
let listener: ((current: PendingDialog | null) => void) | null = null;

function notify() {
  if (listener) listener(queue[0] || null);
}

// Subscribed by <DialogHost/>. Returns an unsubscribe fn. Only one host is
// expected; a later subscribe replaces the earlier listener.
export function subscribeDialogs(
  fn: (current: PendingDialog | null) => void,
): () => void {
  listener = fn;
  notify();
  return () => {
    if (listener === fn) listener = null;
  };
}

// Called by the host when the user resolves the FRONT request. Advances the queue.
export function resolveDialog(id: number, value: any) {
  const idx = queue.findIndex((p) => p.id === id);
  if (idx === -1) return;
  const [p] = queue.splice(idx, 1);
  p.resolve(value);
  notify();
}

function ask(req: DialogRequest): Promise<any> {
  // SSR / non-browser guard: fall back to a resolved default so awaiting never
  // hangs where there's no host (e.g. pre-hydration). confirm→false, prompt→null.
  if (typeof window === "undefined") {
    return Promise.resolve(
      req.kind === "alert" ? true : req.kind === "confirm" ? false : null,
    );
  }
  return new Promise((resolve) => {
    queue.push({ id: ++seq, req, resolve });
    notify();
  });
}

/** App-styled confirm. Resolves true if the user confirms, false otherwise. */
export function confirmDialog(
  message: string,
  opts: Partial<Omit<DialogRequest, "kind" | "message">> = {},
): Promise<boolean> {
  return ask({ kind: "confirm", message, ...opts }).then((v) => v === true);
}

/** App-styled prompt. Resolves the entered string, or null if cancelled. */
export function promptDialog(
  message: string,
  defaultValue = "",
  opts: Partial<Omit<DialogRequest, "kind" | "message" | "defaultValue">> = {},
): Promise<string | null> {
  return ask({ kind: "prompt", message, defaultValue, ...opts });
}

/** App-styled multi-option chooser with an optional "remember my choice"
 *  checkbox. Resolves { value, remember } on confirm, or null if cancelled. */
export function chooseDialog(
  message: string,
  options: DialogChoiceOption[],
  opts: Partial<Omit<DialogRequest, "kind" | "message" | "options">> = {},
): Promise<{ value: string; remember: boolean } | null> {
  return ask({ kind: "choice", message, options, ...opts });
}

/** App-styled alert. Resolves once dismissed. */
export function alertDialog(
  message: string,
  opts: Partial<Omit<DialogRequest, "kind" | "message">> = {},
): Promise<void> {
  return ask({ kind: "alert", message, ...opts }).then(() => undefined);
}
