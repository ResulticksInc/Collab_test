// Demo dataset — seeded only when DEMO_MODE=true. Written through the repo
// interface so it behaves identically on memory and mysql.
import { CONVERSATION, PRESENCE } from "../../shared/src";
import { randomBytes, scryptSync } from "crypto";

// Demo accounts are sign-in-ready: all share the password "demo1234".
const hashPw = (pw: string) => {
  const salt = randomBytes(16);
  return salt.toString("hex") + ":" + scryptSync(pw, salt, 64).toString("hex");
};

const USERS = [
  {
    id: "u_you",
    email: "you@colab.app",
    name: "You",
    initials: "AJ",
    color: "#0D2144",
    avatarUrl: "",
    presence: PRESENCE.ONLINE,
    role: "owner",
  },
  {
    id: "u_emily",
    email: "emily@colab.app",
    name: "Emily Carter",
    initials: "EC",
    color: "#2563EB",
    avatarUrl: "",
    presence: PRESENCE.ONLINE,
  },
  {
    id: "u_marcus",
    email: "marcus@colab.app",
    name: "Marcus Reid",
    initials: "MR",
    color: "#7C3AED",
    avatarUrl: "",
    presence: PRESENCE.AWAY,
  },
  {
    id: "u_priya",
    email: "priya@colab.app",
    name: "Priya Nair",
    initials: "PN",
    color: "#047857",
    avatarUrl: "",
    presence: PRESENCE.ONLINE,
  },
  {
    id: "u_david",
    email: "david@colab.app",
    name: "David Kim",
    initials: "DK",
    color: "#DC2626",
    avatarUrl: "",
    presence: PRESENCE.OFFLINE,
  },
  {
    id: "u_lena",
    email: "lena@colab.app",
    name: "Lena Holt",
    initials: "LH",
    color: "#D97706",
    avatarUrl: "",
    presence: PRESENCE.ONLINE,
  },
  {
    id: "u_aisha",
    email: "aisha@colab.app",
    name: "Aisha Khan",
    initials: "AK",
    color: "#0891B2",
    avatarUrl: "",
    presence: PRESENCE.ONLINE,
  },
  {
    id: "u_ben",
    email: "ben@colab.app",
    name: "Ben Turner",
    initials: "BT",
    color: "#9333EA",
    avatarUrl: "",
    presence: PRESENCE.AWAY,
  },
  {
    id: "u_carlos",
    email: "carlos@colab.app",
    name: "Carlos Mendes",
    initials: "CM",
    color: "#EA580C",
    avatarUrl: "",
    presence: PRESENCE.ONLINE,
  },
  {
    id: "u_dana",
    email: "dana@colab.app",
    name: "Dana Wu",
    initials: "DW",
    color: "#DB2777",
    avatarUrl: "",
    presence: PRESENCE.OFFLINE,
  },
  {
    id: "u_ethan",
    email: "ethan@colab.app",
    name: "Ethan Brooks",
    initials: "EB",
    color: "#16A34A",
    avatarUrl: "",
    presence: PRESENCE.ONLINE,
  },
  {
    id: "u_fatima",
    email: "fatima@colab.app",
    name: "Fatima Ali",
    initials: "FA",
    color: "#4F46E5",
    avatarUrl: "",
    presence: PRESENCE.AWAY,
  },
];
const CONVS = [
  { id: "conv_self", kind: CONVERSATION.SELF, members: ["u_you"] },
  {
    id: "conv_emily",
    kind: CONVERSATION.DM,
    members: ["u_you", "u_emily"],
    star: true,
  },
  { id: "conv_marcus", kind: CONVERSATION.DM, members: ["u_you", "u_marcus"] },
  { id: "conv_priya", kind: CONVERSATION.DM, members: ["u_you", "u_priya"] },
  {
    id: "conv_david",
    kind: CONVERSATION.DM,
    members: ["u_you", "u_david"],
    mute: true,
  },
  {
    id: "conv_product",
    kind: CONVERSATION.GROUP,
    title: "Product Pod",
    icon: "🚀",
    members: ["u_you", "u_emily", "u_marcus", "u_priya"],
    star: true,
  },
  {
    id: "conv_design",
    kind: CONVERSATION.GROUP,
    title: "Design Guild",
    icon: "🎨",
    members: ["u_you", "u_priya", "u_lena"],
  },
  {
    id: "conv_general",
    kind: CONVERSATION.CHANNEL,
    title: "general",
    icon: "#",
    members: ["u_you", "u_emily", "u_marcus", "u_priya", "u_david", "u_lena"],
  },
  {
    id: "conv_eng",
    kind: CONVERSATION.CHANNEL,
    title: "engineering",
    icon: "#",
    members: ["u_you", "u_marcus", "u_david"],
  },
  { id: "conv_aisha", kind: CONVERSATION.DM, members: ["u_you", "u_aisha"] },
  { id: "conv_ben", kind: CONVERSATION.DM, members: ["u_you", "u_ben"] },
  { id: "conv_carlos", kind: CONVERSATION.DM, members: ["u_you", "u_carlos"], star: true },
  { id: "conv_dana", kind: CONVERSATION.DM, members: ["u_you", "u_dana"] },
  {
    id: "conv_marketing",
    kind: CONVERSATION.GROUP,
    title: "Marketing Crew",
    icon: "📣",
    members: ["u_you", "u_aisha", "u_dana", "u_ethan"],
  },
  {
    id: "conv_support",
    kind: CONVERSATION.GROUP,
    title: "Support Desk",
    icon: "🛟",
    members: ["u_you", "u_carlos", "u_fatima", "u_ben"],
  },
  {
    id: "conv_launch",
    kind: CONVERSATION.GROUP,
    title: "Launch Squad",
    icon: "🎯",
    members: ["u_you", "u_emily", "u_marcus", "u_aisha", "u_ethan"],
  },
  {
    id: "conv_random",
    kind: CONVERSATION.CHANNEL,
    title: "random",
    icon: "#",
    members: ["u_you", "u_emily", "u_ben", "u_carlos", "u_dana", "u_ethan", "u_fatima"],
  },
  {
    id: "conv_announce",
    kind: CONVERSATION.CHANNEL,
    title: "announcements",
    icon: "#",
    members: ["u_you", "u_emily", "u_marcus", "u_priya", "u_david", "u_lena", "u_aisha", "u_fatima"],
  },
];
const MSGS = {
  conv_emily: [
    ["u_emily", "Hey! Did you get a chance to look at the V1 shell?"],
    ["u_you", "Yes — rail + sidebar are in and theming works."],
    ["u_emily", "Love it. The dark mode finally looks right."],
    ["u_you", "Pulling the design tokens straight from the prototype."],
    ["u_emily", "Sounds great — let's sync at 3."],
  ],
  conv_marcus: [
    ["u_marcus", "Pushed the fix to staging."],
    ["u_marcus", "Can you verify the meeting room admits the host now?"],
  ],
  conv_priya: [
    ["u_you", "Reviewed the BRD — left two comments."],
    ["u_priya", "Thanks for the review!"],
  ],
  conv_product: [
    ["u_priya", "Sprint 1 scope is shell + messaging, right?"],
    ["u_emily", "Correct. Calls + calendar land in Sprint 3-4."],
    ["u_marcus", "Spec here: https://colab.app/specs/v1"],
  ],
  conv_general: [["u_emily", "Welcome to CoLab V1"]],
  conv_self: [["u_you", "Note to self: wire messaging to the backend next."]],
  conv_aisha: [
    ["u_aisha", "Morning! Campaign brief is ready for your review."],
    ["u_you", "Thanks Aisha — I'll go through it after standup."],
    ["u_aisha", "No rush. Also, can we move the launch post to Thursday?"],
    ["u_you", "Thursday works. Let's confirm with Emily."],
  ],
  conv_ben: [
    ["u_ben", "Quick one: do we have the staging credentials handy?"],
    ["u_you", "Check the vault — I shared the folder with you."],
    ["u_ben", "Found it, all good. Thanks!"],
  ],
  conv_carlos: [
    ["u_carlos", "Customer escalation from Acme — they can't join meetings."],
    ["u_you", "Send me the meeting ID and I'll take a look."],
    ["u_carlos", "Sent. They're on the enterprise plan, so it's high priority."],
    ["u_you", "On it. Will update you within the hour."],
  ],
  conv_dana: [
    ["u_dana", "Updated the brand guidelines PDF — v3 is in Files."],
    ["u_you", "Looks great, the new palette is much cleaner."],
  ],
  conv_marketing: [
    ["u_aisha", "Weekly metrics are in — signups are up 18%."],
    ["u_dana", "Nice! The new landing page is clearly working."],
    ["u_ethan", "I'll draft the case study this week."],
    ["u_you", "Perfect. Let's review everything on Friday."],
  ],
  conv_support: [
    ["u_carlos", "Ticket queue is at 12, down from 30 yesterday."],
    ["u_fatima", "I'll take the billing ones."],
    ["u_ben", "Taking the integration questions."],
    ["u_you", "Great teamwork, everyone."],
  ],
  conv_launch: [
    ["u_emily", "T-minus 5 days. Checklist is pinned in the channel."],
    ["u_marcus", "Backend is frozen, only hotfixes from here."],
    ["u_aisha", "Press kit and social posts are scheduled."],
    ["u_ethan", "Demo environment is reset and ready."],
    ["u_you", "Excellent. Final go/no-go on Wednesday."],
  ],
  conv_random: [
    ["u_ben", "Anyone up for coffee at 4?"],
    ["u_carlos", "Count me in ☕"],
    ["u_fatima", "Same, I'll bring the biscuits."],
  ],
  conv_announce: [
    ["u_emily", "Reminder: all-hands this Friday at 11:00."],
    ["u_priya", "Q4 roadmap doc is now open for comments."],
    ["u_fatima", "Office will be closed next Monday for the holiday."],
  ],
  conv_design: [
    ["u_priya", "Uploaded the new component library to Figma."],
    ["u_lena", "Looks sharp! Shall we review it in Thursday's critique?"],
    ["u_you", "Yes please — I'll add it to the agenda."],
  ],
  conv_eng: [
    ["u_marcus", "CI is green again after the dependency bump."],
    ["u_david", "Nice. I'll start on the migration tomorrow."],
  ],
};
async function seedDemo(db, { usersOnly = false } = {}) {
  for (const u of USERS)
    await db.users.upsert({ ...u, passwordHash: hashPw("demo1234") });
  if (usersOnly) return { users: USERS.length, conversations: 0 };
  for (const c of CONVS) {
    await db.conversations.create({
      id: c.id,
      kind: c.kind,
      title: c.title,
      icon: c.icon,
      createdBy: "u_you",
    });
    for (const uid of c.members)
      await db.conversations.addMember(c.id, uid, {
        starred: c.star && uid === "u_you",
        muted: c.mute && uid === "u_you",
      });
  }
  for (const [cid, list] of Object.entries(MSGS)) {
    for (const [sender, body] of list)
      await db.messages.create({ conversationId: cid, senderId: sender, body });
  }
  // a file message (populates the Files tab) and a meeting (populates Calendar)
  await db.messages.create({
    conversationId: "conv_emily",
    senderId: "u_emily",
    file: {
      name: "V1-Design-Tokens.pdf",
      size: "248 KB",
      icon: "📄",
      color: "#2563EB",
    },
  });
  // ── Media / mention / reply sample messages ──
  const img = (name: string, size: string) => ({ name, size, mime: "image/jpeg", type: "image/jpeg", url: "/demo-media/" + name });
  const vid = (name: string, size: string) => ({ name, size, mime: "video/mp4", type: "video/mp4", url: "/demo-media/" + name });
  const mins = (n: number) => new Date(Date.now() - n * 60000).toISOString();
  const mk = (conversationId: string, senderId: string, extra: any) =>
    db.messages.create({ conversationId, senderId, ...extra });
  // images sent + received
  await mk("conv_emily", "u_you", { file: img("team-offsite.jpg", "56 KB"), body: "Photos from last week's offsite 📸", createdAt: mins(95) });
  await mk("conv_emily", "u_emily", { file: img("dashboard-mock.jpg", "53 KB"), body: "Here's the new dashboard mock — thoughts?", createdAt: mins(90) });
  // image + caption tagging a person
  await mk("conv_product", "u_you", { file: img("launch-banner.jpg", "60 KB"), body: "@Emily @Marcus the launch banner is ready for review. Please check the spacing and the copy before Friday 🚀", createdAt: mins(80) });
  await mk("conv_product", "u_marcus", { file: img("whiteboard.jpg", "56 KB"), body: "@You whiteboard notes from today's planning session. Action items are at the bottom.", createdAt: mins(70) });
  // videos sent + received
  await mk("conv_emily", "u_you", { file: vid("standup.mp4", "23 KB"), body: "Quick standup recap video", createdAt: mins(60) });
  await mk("conv_emily", "u_emily", { file: vid("walkthrough.mp4", "34 KB"), body: "Screen walkthrough of the new flow 🎥", createdAt: mins(55) });
  await mk("conv_product", "u_priya", { file: vid("demo-clip.mp4", "34 KB"), body: "Demo clip for the release notes", createdAt: mins(45) });
  // text + reply threads
  const q = await mk("conv_product", "u_marcus", { body: "Can we move the release review to Thursday?", createdAt: mins(40) });
  await mk("conv_product", "u_you", { body: "Thursday works for me 👍", parentMessageId: q.id, createdAt: mins(38) });
  await mk("conv_product", "u_emily", { body: "Same here — I'll update the calendar invite.", parentMessageId: q.id, createdAt: mins(36) });
  const img1 = await mk("conv_emily", "u_emily", { body: "Which version of the logo do we ship?", createdAt: mins(30) });
  await mk("conv_emily", "u_you", { body: "The second one — better contrast on dark mode.", parentMessageId: img1.id, createdAt: mins(28) });
  // media-only (no caption text)
  await mk("conv_emily", "u_you", { file: img("whiteboard.jpg", "56 KB"), createdAt: mins(26) });
  await mk("conv_emily", "u_emily", { file: img("launch-banner.jpg", "60 KB"), createdAt: mins(24) });
  await mk("conv_emily", "u_you", { file: vid("demo-clip.mp4", "34 KB"), createdAt: mins(22) });
  await mk("conv_emily", "u_emily", { file: vid("standup.mp4", "23 KB"), createdAt: mins(20) });
  await mk("conv_product", "u_you", { file: img("dashboard-mock.jpg", "53 KB"), createdAt: mins(18) });
  await mk("conv_product", "u_priya", { file: vid("walkthrough.mp4", "34 KB"), createdAt: mins(16) });
  // ── Quoted replies (DM + group): to text, link, image, video, tagged message ──
  const rep = (cid: string, uid: string, parent: any, body: string, ago: number, extra: any = {}) =>
    mk(cid, uid, { body, parentMessageId: parent.id, createdAt: mins(ago), ...extra });
  // DM — Emily
  const dmText = await mk("conv_emily", "u_emily", { body: "Can you send me the final copy for the landing page?", createdAt: mins(14) });
  await rep("conv_emily", "u_you", dmText, "Sure, sending it over in 10 minutes.", 13);
  const dmLink = await mk("conv_emily", "u_you", { body: "Design reference: https://www.figma.com/community and https://colab.app/docs/design-tokens", createdAt: mins(12) });
  await rep("conv_emily", "u_emily", dmLink, "Thanks for the link, this is exactly what I needed 🙌", 11);
  const dmImg = await mk("conv_emily", "u_emily", { file: img("team-offsite.jpg", "56 KB"), body: "Look at this shot!", createdAt: mins(10) });
  await rep("conv_emily", "u_you", dmImg, "Great photo! Can you share the full album?", 9);
  await rep("conv_emily", "u_emily", dmImg, "Sure, uploading the rest tonight 📸", 8, { file: img("whiteboard.jpg", "56 KB") });
  const dmVid = await mk("conv_emily", "u_you", { file: vid("walkthrough.mp4", "34 KB"), body: "Here is the new onboarding flow", createdAt: mins(7) });
  await rep("conv_emily", "u_emily", dmVid, "Smooth! The transition on step 2 feels great 👏", 6);
  // Group — Product
  const gText = await mk("conv_product", "u_priya", { body: "Release notes draft is ready for review.", createdAt: mins(15) });
  await rep("conv_product", "u_you", gText, "@Priya I'll review it by end of day.", 14);
  await rep("conv_product", "u_marcus", gText, "@You @Emily please add the screenshots before we publish.", 13);
  const gLink = await mk("conv_product", "u_david", { body: "Sprint board: https://colab.app/boards/sprint-42", createdAt: mins(12) });
  await rep("conv_product", "u_emily", gLink, "Opened it — we're at 70% for the sprint. Looks on track.", 11);
  const gImg = await mk("conv_product", "u_emily", { file: img("dashboard-mock.jpg", "53 KB"), body: "Updated dashboard mock", createdAt: mins(10) });
  await rep("conv_product", "u_you", gImg, "@Emily the spacing looks much better. Approved ✅", 9);
  await rep("conv_product", "u_priya", gImg, "Replying with my version of the layout 👇", 8, { file: img("launch-banner.jpg", "60 KB") });
  const gVid = await mk("conv_product", "u_marcus", { file: vid("demo-clip.mp4", "34 KB"), body: "Demo clip for the stakeholder review", createdAt: mins(7) });
  await rep("conv_product", "u_you", gVid, "Nice! @Marcus can you trim the first 2 seconds?", 6);
  await rep("conv_product", "u_david", gVid, "Reply with my edit:", 5, { file: vid("standup.mp4", "23 KB") });
  const pool = db.pool;
  const orgId = "c18cfa40a454d6f6e52c8b827e852a42"; // MD5('org|resulticks')

  if (pool) {
    const at = (days: number, h: number, m = 0) => {
      const d = new Date(Date.now() + (days > 0 ? days : 1) * 86400000);
      d.setHours(h, m, 0, 0);
      return d.toISOString().slice(0, 19).replace("T", " ");
    };

    const mtgList = [
      { id: "mtg_sync", title: "V1 Sync", startsAt: new Date(Date.now() + 2 * 3600 * 1000).toISOString().slice(0, 19).replace("T", " "), durationMin: 30, createdBy: "u_you", convId: "conv_product", attendees: ["u_you", "u_emily", "u_marcus"] },
      { id: "mtg_design", title: "Design Critique", startsAt: at(1, 11, 0), durationMin: 45, createdBy: "u_emily", convId: "conv_emily", attendees: ["u_you", "u_emily", "u_priya"] },
      { id: "mtg_priya", title: "1:1 with Priya", startsAt: at(2, 14, 30), durationMin: 30, createdBy: "u_you", convId: "conv_priya", attendees: ["u_you", "u_priya"] },
      { id: "mtg_sprint", title: "Sprint Planning", startsAt: at(4, 10, 0), durationMin: 90, createdBy: "u_marcus", convId: "conv_product", attendees: ["u_you", "u_emily", "u_marcus", "u_priya"] }
    ];

    for (const m of mtgList) {
      await pool.query(
        `INSERT IGNORE INTO meetings (id, title, starts_at, duration_min, created_by, conversation_id, organization_id) VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [m.id, m.title, m.startsAt, m.durationMin, m.createdBy, m.convId, orgId]
      );
      for (const uId of m.attendees) {
        await pool.query(
          `INSERT IGNORE INTO meeting_attendees (meeting_id, user_id, status, role) VALUES (?, ?, 'invited', ?)`,
          [m.id, uId, uId === m.createdBy ? "host" : "participant"]
        );
      }
    }

    const taskProjId = "proj_v1";
    await pool.query(
      `INSERT IGNORE INTO task_projects (id, owner_id, name, organization_id) VALUES (?, 'u_you', 'CoLab V1 Release', ?)`,
      [taskProjId, orgId]
    );

    const taskList = [
      ["task_1", "Fix token refresh on staging API", "inprogress", "High", "Jun 3", "u_priya"],
      ["task_2", "Migrate auth-service to v2", "review", "High", "Jun 2", "u_marcus"],
      ["task_3", "Update pitch deck revenue (slide 7)", "todo", "Medium", "Jun 4", "u_emily"],
      ["task_4", "Add dark-mode toggle to settings", "todo", "Low", "Jun 9", "u_you"],
      ["task_5", "Design critique action items", "todo", "Low", "Jun 5", "u_lena"],
      ["task_6", "Write sprint retro notes", "inprogress", "Low", "Jun 6", "u_marcus"],
      ["task_7", "Q3 report draft to finance", "done", "Medium", "May 30", "u_you"],
      ["task_8", "Deploy release v2 to production", "done", "High", "Jun 1", "u_david"]
    ];

    for (const [id, title, status, priority, dueLabel, assigneeId] of taskList) {
      await pool.query(
        `INSERT IGNORE INTO tasks (id, title, status, priority, due_label, assignee_id, reporter_id, project_id, organization_id) VALUES (?, ?, ?, ?, ?, ?, 'u_you', ?, ?)`,
        [id, title, status, priority, dueLabel, assigneeId, taskProjId, orgId]
      );
      await pool.query(
        `INSERT IGNORE INTO task_assignees (task_id, user_id, organization_id) VALUES (?, ?, ?)`,
        [id, assigneeId, orgId]
      );
    }

    for (const u of USERS) {
      await pool.query(
        `INSERT IGNORE INTO organization_members (id, organization_id, user_id, role, status) VALUES (?, ?, ?, ?, 'active')`,
        ["mem_" + u.id, orgId, u.id, u.role === "owner" ? "owner" : "member"]
      );
      await pool.query(
        `INSERT IGNORE INTO user_settings (user_id, data) VALUES (?, ?)`,
        [u.id, JSON.stringify({ theme: "dark", notifications: true, sound: true })]
      );
    }

    const notifs = [
      ["notif_1", "u_you", "message", "Emily Carter sent a message", "Hey! Did you get a chance to look at the V1 shell?", "u_emily", "conv_emily"],
      ["notif_2", "u_you", "meeting", "Meeting invitation: V1 Sync", "V1 Sync meeting starts today at 3:00 PM", "u_emily", "conv_product"],
      ["notif_3", "u_you", "task", "Task assigned: Add dark-mode toggle", "Marcus Reid assigned a task to you", "u_marcus", null]
    ];
    for (const [id, userId, type, title, body, actorId, convId] of notifs) {
      await pool.query(
        `INSERT IGNORE INTO notifications (id, user_id, type, title, body, actor_id, conversation_id, organization_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [id, userId, type, title, body, actorId, convId, orgId]
      );
    }

    await pool.query(
      `INSERT IGNORE INTO invites (id, from_user_id, to_user_id, status, conversation_id, organization_id) VALUES ('inv_1', 'u_emily', 'u_you', 'accepted', 'conv_product', ?)`,
      [orgId]
    );
  }


  // JSON / in-memory drivers have no SQL pool — seed meetings and notifications
  // through the repository interface so Calendar, Upcoming and Activity are full.
  if (!pool || db.driver === "json") {
    const mAt = (days: number, h: number, m = 0) => {
      const d = new Date();
      d.setDate(d.getDate() + days);
      d.setHours(h, m, 0, 0);
      return d.toISOString();
    };
    const mt: any[] = [
      ["Daily Standup", -12, 9, 0, 15, "u_you", "conv_product", ["u_you", "u_emily", "u_marcus", "u_priya"]],
      ["Sprint Retro", -9, 16, 0, 60, "u_marcus", "conv_product", ["u_you", "u_emily", "u_marcus", "u_priya", "u_david"]],
      ["Brand Review", -7, 11, 30, 45, "u_dana", "conv_marketing", ["u_you", "u_dana", "u_aisha"]],
      ["Customer Escalation: Acme", -5, 14, 0, 30, "u_carlos", "conv_support", ["u_you", "u_carlos", "u_fatima"]],
      ["Design Critique", -3, 11, 0, 45, "u_emily", "conv_emily", ["u_you", "u_emily", "u_priya"]],
      ["1:1 with Marcus", -2, 15, 0, 30, "u_you", "conv_marcus", ["u_you", "u_marcus"]],
      ["Launch Readiness", -1, 10, 0, 60, "u_emily", "conv_launch", ["u_you", "u_emily", "u_marcus", "u_aisha", "u_ethan"]],
      ["V1 Sync", 0, 15, 0, 30, "u_you", "conv_product", ["u_you", "u_emily", "u_marcus"]],
      ["Marketing Weekly", 1, 10, 0, 45, "u_aisha", "conv_marketing", ["u_you", "u_aisha", "u_dana", "u_ethan"]],
      ["1:1 with Priya", 2, 14, 30, 30, "u_you", "conv_priya", ["u_you", "u_priya"]],
      ["Support Sync", 2, 17, 0, 30, "u_carlos", "conv_support", ["u_you", "u_carlos", "u_fatima", "u_ben"]],
      ["Sprint Planning", 4, 10, 0, 90, "u_marcus", "conv_product", ["u_you", "u_emily", "u_marcus", "u_priya", "u_david"]],
      ["Launch Go/No-Go", 5, 11, 0, 45, "u_emily", "conv_launch", ["u_you", "u_emily", "u_marcus", "u_aisha", "u_ethan"]],
      ["All-Hands", 6, 11, 0, 60, "u_emily", "conv_announce", ["u_you", "u_emily", "u_marcus", "u_priya", "u_david", "u_lena"]],
      ["Design Workshop", 8, 13, 0, 120, "u_lena", "conv_design", ["u_you", "u_priya", "u_lena"]],
      ["Quarterly Planning", 11, 10, 0, 90, "u_emily", "conv_general", ["u_you", "u_emily", "u_marcus", "u_priya", "u_david"]],
      ["Customer Demo", 13, 15, 30, 45, "u_ethan", "conv_launch", ["u_you", "u_ethan", "u_aisha"]],
      ["Retro & Celebration", 16, 16, 0, 60, "u_you", "conv_product", ["u_you", "u_emily", "u_marcus", "u_priya"]],
    ];
    if (db.meetings) {
      for (const [title, day, h, mi, dur, by, conv, att] of mt) {
        await db.meetings.create({
          title,
          startsAt: mAt(day, h, mi),
          durationMin: dur,
          createdBy: by,
          conversationId: conv,
          attendees: att,
        });
      }
    }
    if (db.notifications) {
      const nts: any[] = [
        ["message", "u_carlos", "Carlos Mendes sent a message", "Customer escalation from Acme — they can't join meetings."],
        ["message", "u_aisha", "Aisha Khan sent a message", "Campaign brief is ready for your review."],
        ["meeting", "u_emily", "Meeting invitation: Launch Go/No-Go", "Launch Go/No-Go is scheduled in 5 days."],
        ["meeting", "u_marcus", "Meeting invitation: Sprint Planning", "Sprint Planning is scheduled in 4 days."],
        ["task", "u_marcus", "Task assigned: Add dark-mode toggle", "Marcus Reid assigned a task to you."],
        ["message", "u_dana", "Dana Wu shared a file", "Brand guidelines v3.pdf"],
        ["message", "u_ben", "Ben Turner mentioned you", "Found it, all good. Thanks!"],
        ["meeting", "u_aisha", "Meeting invitation: Marketing Weekly", "Marketing Weekly starts tomorrow at 10:00 AM."],
      ];
      for (const [type, actorId, , body] of nts) {
        await db.notifications.create({ userId: "u_you", type, actorId, body });
      }
    }
  }
  if (db.folders && db.reminders) {
    const work = await db.folders.create({
      userId: "u_you",
      name: "Work",
      icon: "💼",
    });
    const personal = await db.folders.create({
      userId: "u_you",
      name: "Personal",
      icon: "🏠",
    });
    await db.reminders.create({
      userId: "u_you",
      text: "Send Q3 report to finance",
      folderId: work.id,
      dueLabel: "Today 5:00 PM",
    });
    await db.reminders.create({
      userId: "u_you",
      text: "Review pitch deck slide 7",
      folderId: work.id,
      dueLabel: "Today",
    });
    await db.reminders.create({
      userId: "u_you",
      text: "Book dentist appointment",
      folderId: personal.id,
      dueLabel: "Tomorrow",
    });
    const d = await db.reminders.create({
      userId: "u_you",
      text: "Reply to Emily about the V1 shell",
    });
    await db.reminders.toggle(d.id, "u_you");
  }
  if (db.calls) {
    const logCall = async (c) => {
      const row = await db.calls.create({
        conversationId: c.conversationId || null,
        initiatorId: c.initiatorId,
        peerId: c.peerId,
        kind: c.kind,
        direction: c.initiatorId === "u_you" ? "out" : "in",
      });
      await db.calls.end(row.id, {
        status: c.status,
        durationSec: c.durationSec,
      });
    };
    await logCall({
      conversationId: "conv_emily",
      initiatorId: "u_emily",
      peerId: "u_you",
      kind: "audio",
      status: "ended",
      durationSec: 372,
    });
    await logCall({
      conversationId: "conv_marcus",
      initiatorId: "u_you",
      peerId: "u_marcus",
      kind: "video",
      status: "ended",
      durationSec: 845,
    });
    await logCall({
      conversationId: "conv_priya",
      initiatorId: "u_priya",
      peerId: "u_you",
      kind: "audio",
      status: "missed",
      durationSec: 0,
    });
    await logCall({
      conversationId: "conv_carlos",
      initiatorId: "u_carlos",
      peerId: "u_you",
      kind: "video",
      status: "ended",
      durationSec: 1260,
    });
    await logCall({
      conversationId: "conv_aisha",
      initiatorId: "u_you",
      peerId: "u_aisha",
      kind: "audio",
      status: "ended",
      durationSec: 215,
    });
    await logCall({
      conversationId: "conv_david",
      initiatorId: "u_david",
      peerId: "u_you",
      kind: "audio",
      status: "missed",
      durationSec: 0,
    });
    await logCall({
      conversationId: "conv_ben",
      initiatorId: "u_ben",
      peerId: "u_you",
      kind: "video",
      status: "ended",
      durationSec: 540,
    });
    await logCall({
      conversationId: "conv_dana",
      initiatorId: "u_you",
      peerId: "u_dana",
      kind: "audio",
      status: "missed",
      durationSec: 0,
    });
    await logCall({
      conversationId: null,
      initiatorId: "u_lena",
      peerId: "u_you",
      kind: "audio",
      status: "ended",
      durationSec: 98,
    });
  }
  return { users: USERS.length, conversations: CONVS.length };
}
export { seedDemo };
