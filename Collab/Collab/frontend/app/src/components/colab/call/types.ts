// Shared prop/session types for the call UI (CallModal + its hooks). All call
// shapes flow up from CoLabV1's `activeCall`/`huddles` state which is `any`-typed,
// so these stay intentionally loose.

export interface CallModalProps {
  call: any;
  // The chat this call lives in (group: the call's conversation; 1:1: the DM
  // with the peer), resolved by the shell. Feeds the info popover's join link
  // (?conversation=<id>) and its QR. Null when unknown — the row is hidden.
  chatConversationId?: string | null;
  huddles: any[];
  token: string | null;
  meId: string | null;
  onTempGroupCreated: (conv: any) => void;
  onAccept: () => void;
  onDecline: () => void;
  onCancel: () => void;
  onHangup: (...args: any[]) => void;
  onAddPeople: ((ids: string[]) => void) | null;
  addPeople: any[];
  onSearchPeople: (q: string) => void;
  showToast: (msg: string) => void;
  socket: any;
  settings: any;
  onChangeSetting: (key: string, value: any) => void;
  isGroupHost?: boolean;
  onMinimize: () => void;
  pip: boolean;
  resolveCallMediaCtx: any;
  onMoveDevice: any;
  onOpenComms: () => void;
  commsUnread: number;
}
