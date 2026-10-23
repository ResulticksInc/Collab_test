/* Generates the CoLab Feature Status Report as a .docx (for the business analyst). */
const fs = require("fs");
const GROOT = require("child_process").execSync("npm root -g").toString().trim();
const {
  Document, Packer, Paragraph, TextRun, Table, TableRow, TableCell,
  HeadingLevel, BorderStyle, WidthType, ShadingType, VerticalAlign,
} = require(GROOT + "/docx");

const CONTENT_W = 9360;
const COLS = [3120, 1560, 4680]; // Feature | Status | Reason  (sum = 9360)

const STATUS = {
  Working: { fill: "E6F4EA", color: "1E7E34" },
  "In Progress": { fill: "FFF4E5", color: "9C5700" },
  "Pending / Blocked": { fill: "FDE7E9", color: "B71C1C" },
  Pending: { fill: "FDE7E9", color: "B71C1C" },
};

const border = { style: BorderStyle.SINGLE, size: 1, color: "C9CCD1" };
const borders = { top: border, bottom: border, left: border, right: border };
const cellMargins = { top: 60, bottom: 60, left: 120, right: 120 };

function cell(text, w, opts = {}) {
  const runs = Array.isArray(text) ? text : [new TextRun({ text: String(text), bold: !!opts.bold, color: opts.color, size: opts.size || 19 })];
  return new TableCell({
    width: { size: w, type: WidthType.DXA }, borders, margins: cellMargins,
    shading: opts.fill ? { fill: opts.fill, type: ShadingType.CLEAR } : undefined,
    verticalAlign: VerticalAlign.CENTER,
    children: [new Paragraph({ children: runs, spacing: { after: 0 } })],
  });
}

function headerRow() {
  const h = (t, w) => new TableCell({
    width: { size: w, type: WidthType.DXA }, borders, margins: cellMargins,
    shading: { fill: "1F3864", type: ShadingType.CLEAR }, verticalAlign: VerticalAlign.CENTER,
    children: [new Paragraph({ children: [new TextRun({ text: t, bold: true, color: "FFFFFF", size: 19 })] })],
  });
  return new TableRow({ tableHeader: true, children: [h("Feature", COLS[0]), h("Status", COLS[1]), h("Reason", COLS[2])] });
}

function featureTable(rows) {
  const trs = [headerRow()];
  for (const [feature, status, reason] of rows) {
    const s = STATUS[status] || {};
    trs.push(new TableRow({ children: [
      cell(feature, COLS[0]),
      cell([new TextRun({ text: status, bold: true, color: s.color, size: 19 })], COLS[1], { fill: s.fill }),
      cell(reason || "—", COLS[2], { color: reason ? "333333" : "999999" }),
    ] }));
  }
  return new Table({ width: { size: CONTENT_W, type: WidthType.DXA }, columnWidths: COLS, rows: trs });
}

const h2 = (t) => new Paragraph({ heading: HeadingLevel.HEADING_2, children: [new TextRun(t)], spacing: { before: 240, after: 100 } });
const para = (runs, opts = {}) => new Paragraph({ children: Array.isArray(runs) ? runs : [new TextRun(runs)], spacing: { after: opts.after ?? 120 } });

const areas = [
  ["1. Authentication & Access", [
    ["Login & session (JWT, scrypt hashing)", "Working", ""],
    ["Self-service sign-up", "In Progress", "The sign-up entry was removed from the front end; re-enabling it is the first task of the current hardening sprint. Backend registration is supported."],
    ["Connection requests / invites", "Working", ""],
    ["Presence (online / away / offline)", "Working", ""],
    ["Login landing consistency", "In Progress", "Should always land on the Dashboard after login/logout; needs to be made consistent."],
  ]],
  ["2. Conversations & Messaging", [
    ["Real-time text messaging", "Working", "Verified end-to-end (socket send → persist → broadcast)."],
    ["Inline replies / threading (incl. voice→voice)", "Working", "Verified this session across text and voice combinations; replies stay threaded."],
    ["Message delivery reliability (retry / no silent failure)", "In Progress", "There is no delivery acknowledgement or retry; a failed socket send can be lost silently. Sprint requires that messages never fail silently."],
    ["Duplicate DM prevention", "In Progress", "Messaging a user can create a new DM even when one already exists for that pair. Backend uniqueness enforcement (one DM per user pair) is required."],
    ["Conversation list stability", "In Progress", "Conversations can disappear on unread/state changes; they must remain visible (only unread / pinned / archived state should change)."],
    ["Contacts → Message flow", "In Progress", "Inconsistent; a single click should open the existing DM or create one, with no duplicates."],
    ["Empty / placeholder chat state", "In Progress", "Placeholder states are inconsistent; needs one consistent 'Select a conversation' / 'Start a conversation' design."],
    ["Group conversations & channels", "Working", ""],
    ["Personal space (“message yourself”)", "Working", ""],
    ["Emoji reactions", "Working", ""],
    ["Edit & delete messages", "Working", ""],
    ["Forward messages", "Working", ""],
    ["Bookmarks / saved messages", "Working", ""],
    ["@mentions", "Working", ""],
    ["Typing indicators", "Working", ""],
    ["Link previews", "Working", ""],
    ["Scheduled (“send later”) messages", "In Progress", "Implemented end-to-end but not validated at runtime; depends on the server-side scheduler firing at the due time."],
  ]],
  ["3. Voice Messages", [
    ["Record & send voice notes", "Working", "Verified this session (MediaRecorder → upload → persist as type='voice')."],
    ["Voice duration", "Working", "Fixed this session — the recorded length is captured and displayed (e.g. 0:03)."],
    ["Voice playback (sender's own view)", "Working", "Fixed this session — audio is fetched with the auth token (previously 401)."],
    ["Voice playback (recipient)", "In Progress", "Reported broken for the receiver. The same authentication/loading fix was applied this session and is expected to resolve it, but it still needs two-user verification."],
    ["Voice waveform", "In Progress", "The player renders a placeholder waveform (deterministic bars), not one derived from the actual audio samples."],
    ["Legacy voice messages (pre-fix)", "In Progress", "Older recordings stored no duration and still display 0:00; not back-fillable without re-processing the stored audio."],
  ]],
  ["4. Attachments & Files", [
    ["File upload / download / list (file API)", "Working", "Verified this session (raw-bytes upload, authenticated download returns 200)."],
    ["DM attachments — all types (image, PDF, video, audio, ZIP)", "In Progress", "Reported failing in DMs. The file API works, but the in-DM attachment flow, previews and downloads need end-to-end validation for every file type."],
    ["Receiver file permissions (view / download / preview)", "In Progress", "Recipient access must be validated to ensure no permission errors when opening attachments."],
    ["File sharing links & permissions", "Working", ""],
  ]],
  ["5. Calls", [
    ["1:1 audio calls (WebRTC)", "In Progress", "Call connects but participants report no audio (muted). The microphone track → peer connection → remote audio routing path is under investigation."],
    ["1:1 video calls (WebRTC)", "In Progress", "Signalling implemented; end-to-end media not validated (needs two live peers + STUN/TURN)."],
    ["Call recording", "In Progress", "A recording is produced but contains no conversation audio (silent). Mixing of local + remote audio into the saved file is not working."],
    ["Screen share", "In Progress", "Usability is poor; needs a Teams-style sharing indicator, a 'Currently Sharing' banner, and one-click stop. The shared window can become unusable."],
    ["Group calls / huddles (LiveKit SFU)", "In Progress", "Requires a reachable LiveKit media server and multiple participants; not validated."],
    ["Voicemails", "In Progress", "Dependent on the call flow; not validated."],
  ]],
  ["6. Meetings", [
    ["Meeting scheduling, list & RSVP", "Working", ""],
    ["Schedule meeting from a DM", "In Progress", "Currently generic; should prepopulate the participant, conversation and a suggested title when launched from a DM."],
    ["Meeting join / leave / reconnect", "In Progress", "Create→invite→join→leave→reconnect flow needs full validation; live A/V is LiveKit-dependent."],
    ["Calendar view", "Working", ""],
  ]],
  ["7. Productivity", [
    ["Tasks (board, CRUD, comments, dependencies)", "Working", ""],
    ["Reminders & folders", "Working", ""],
    ["Contacts directory", "Working", ""],
  ]],
  ["8. Search & Navigation", [
    ["In-conversation search", "Working", ""],
    ["Global search (unified: users, messages, groups, files, meetings, tasks)", "In Progress", "A global search exists but must be unified into a single experience covering users, messages, groups, files, meetings and tasks."],
    ["Open chat in a new window", "In Progress", "Currently opens the login + dashboard instead of reusing the session to open the conversation directly."],
    ["Back / cancel / close on every workflow", "In Progress", "Some workflows lack a consistent exit path (potential dead ends)."],
    ["Sidebar collapse responsiveness", "In Progress", "Overlapping / clipping UI and hidden controls when collapsed; needs to be fully responsive."],
  ]],
  ["9. Settings & Experience", [
    ["Light / Dark / OLED themes", "Working", "Verified — text contrast checked across themes."],
    ["Accent colour, density & zoom", "Working", ""],
    ["Typeface picker", "Working", "Redesigned this session to a compact layout."],
    ["Accessibility (high contrast, reduce motion, larger text)", "Working", ""],
    ["Server-synced settings persistence", "Working", ""],
    ["Desktop & sound notifications", "In Progress", "Permission-gated browser notifications; not validated this session."],
  ]],
  ["10. AI", [
    ["“Catch me up” conversation summary", "In Progress", "An LLM endpoint is configured, but provider reachability/validity was not validated; the feature is flag-gated."],
    ["Agen-X assistant (Agents)", "In Progress", "Depends on the external LLM provider; not validated."],
  ]],
  ["11. Infrastructure", [
    ["Database — local MySQL migration", "Pending", "Planned move from the shared remote MySQL to a local instance (localhost / colab) for performance. Not started; affects backend, env, migrations and seed data."],
    ["Real-time transport (Socket.IO) & presence", "Working", "Verified — socket connects, presence and typing events flow."],
  ]],
  ["12. Security & Encryption (paused this sprint)", [
    ["1:1 message end-to-end encryption (E2EE)", "Pending / Blocked", "Runtime proof: messages are stored as plaintext (encryption_version = 0, ciphertext_json = NULL). The Signal library in use is Node-native and not browser-compatible, so E2EE is disabled. Paused for the V1 hardening sprint."],
    ["Media (file) encryption", "Pending / Blocked", "Depends on the 1:1 E2EE foundation above."],
    ["Multi-device key sync", "Pending / Blocked", "Device / pre-key tables exist but are not populated by an active registration flow."],
    ["Group E2EE (Sender Keys, membership rotation)", "Pending / Blocked", "Explicitly on hold until a browser-compatible crypto library is approved."],
    ["Encrypted client-side search & Private AI", "Pending", "Depend on E2EE being in place."],
  ]],
];

// ---- assemble ----
const children = [];
children.push(new Paragraph({ heading: HeadingLevel.HEADING_1, spacing: { after: 60 }, children: [new TextRun("CoLab — Feature Status Report")] }));
children.push(para([
  new TextRun({ text: "Prepared for: Business Analyst", color: "555555", size: 19 }),
  new TextRun({ text: "    •    Date: 10 June 2026", color: "555555", size: 19 }),
  new TextRun({ text: "    •    Platform: CoLab (Slack/Teams-style collaboration)", color: "555555", size: 19 }),
], { after: 160 }));

children.push(para([new TextRun({ text: "Purpose. ", bold: true }), new TextRun("This report summarises the current implementation status of CoLab’s features across three states — Working, In Progress, and Pending / Blocked — and gives a reason for every item that is not yet fully working. It reflects the scope of the current V1 hardening sprint (making the core collaboration workflows feel as seamless as WhatsApp, Teams and Slack). Security / E2EE work is paused during this sprint.")]));

children.push(h2("Status legend"));
children.push(new Table({ width: { size: CONTENT_W, type: WidthType.DXA }, columnWidths: [1560, 7800], rows: [
  new TableRow({ children: [cell([new TextRun({ text: "Working", bold: true, color: STATUS.Working.color, size: 19 })], 1560, { fill: STATUS.Working.fill }), cell("Implemented and confirmed functioning.", 7800)] }),
  new TableRow({ children: [cell([new TextRun({ text: "In Progress", bold: true, color: STATUS["In Progress"].color, size: 19 })], 1560, { fill: STATUS["In Progress"].fill }), cell("Implemented but not fully working / not fully validated — includes known defects being addressed this sprint and items needing a second user or external service to exercise.", 7800)] }),
  new TableRow({ children: [cell([new TextRun({ text: "Pending / Blocked", bold: true, color: STATUS["Pending / Blocked"].color, size: 19 })], 1560, { fill: STATUS["Pending / Blocked"].fill }), cell("Not started, or intentionally on hold pending a decision or dependency.", 7800)] }),
]}));

children.push(para([new TextRun({ text: "Verification basis. ", bold: true }), new TextRun("Items marked Working were confirmed either by direct runtime testing during this review (messaging, replies/threading, voice messages, file upload/download, themes, settings, search) or by confirming the full data path is wired and the backend endpoints respond successfully. In Progress items combine (a) defects reported by the product team for this sprint and (b) features that require live multi-user sessions or external media/AI infrastructure to fully validate.")], { after: 60 }));

for (const [title, rows] of areas) {
  children.push(h2(title));
  children.push(featureTable(rows));
  children.push(para("", { after: 40 }));
}

const counts = { Working: 0, "In Progress": 0, blocked: 0 };
for (const [, rows] of areas) for (const [, s] of rows) {
  if (s === "Working") counts.Working++;
  else if (s === "In Progress") counts["In Progress"]++;
  else counts.blocked++;
}
children.push(h2("Summary"));
children.push(para([
  new TextRun({ text: `${counts.Working}`, bold: true, color: STATUS.Working.color }),
  new TextRun(" Working,  "),
  new TextRun({ text: `${counts["In Progress"]}`, bold: true, color: STATUS["In Progress"].color }),
  new TextRun(" In Progress,  "),
  new TextRun({ text: `${counts.blocked}`, bold: true, color: STATUS["Pending / Blocked"].color }),
  new TextRun(" Pending / Blocked."),
]));
children.push(para([new TextRun({ text: "Note. ", bold: true }), new TextRun("Full end-to-end sign-off requires the two-user test matrix defined for the hardening sprint (User A ↔ User B: text, replies, voice, attachments, calls, screen share, meetings, search, navigation, reconnect). This report is the pre-sprint baseline.")], { after: 0 }));

const doc = new Document({
  styles: {
    default: { document: { run: { font: "Arial", size: 22 } } },
    paragraphStyles: [
      { id: "Heading1", name: "Heading 1", basedOn: "Normal", next: "Normal", quickFormat: true, run: { size: 34, bold: true, font: "Arial", color: "1F3864" }, paragraph: { spacing: { after: 120 }, outlineLevel: 0 } },
      { id: "Heading2", name: "Heading 2", basedOn: "Normal", next: "Normal", quickFormat: true, run: { size: 24, bold: true, font: "Arial", color: "1F3864" }, paragraph: { spacing: { before: 200, after: 100 }, outlineLevel: 1 } },
    ],
  },
  sections: [{
    properties: { page: { size: { width: 12240, height: 15840 }, margin: { top: 1440, right: 1440, bottom: 1440, left: 1440 } } },
    children,
  }],
});

Packer.toBuffer(doc).then((buf) => {
  fs.writeFileSync("CoLab_Feature_Status_Report.docx", buf);
  console.log("wrote CoLab_Feature_Status_Report.docx (" + buf.length + " bytes)");
});
