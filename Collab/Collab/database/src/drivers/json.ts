import fs from "fs";
import path from "path";
import crypto from "crypto";
import { currentOrgId } from "../orgContext";
import { createJsonConnectorsRepo } from "./jsonConnectors";

// ─── Storage helpers ────────────────────────────────────────────────────────
const dataDir = path.resolve(process.cwd(), "database/local-data");
fs.mkdirSync(dataDir, { recursive: true });

function filePath(table: string) {
  return path.join(dataDir, `${table}.json`);
}

const store: Record<string, any[]> = {};

function load(table: string): any[] {
  if (store[table]) return store[table];
  const fp = filePath(table);
  if (fs.existsSync(fp)) {
    try { store[table] = JSON.parse(fs.readFileSync(fp, "utf8")); }
    catch { store[table] = []; }
  } else {
    store[table] = [];
  }
  return store[table];
}

function save(table: string) {
  fs.writeFileSync(filePath(table), JSON.stringify(store[table] || [], null, 2));
}

function tbl(table: string): any[] {
  return load(table);
}

const genId = () => crypto.randomUUID();
const now = () => new Date().toISOString();

// ─── Users ───────────────────────────────────────────────────────────────────
const mapUser = (r: any) =>
  r && {
    id: r.id, email: r.email, name: r.name, initials: r.initials,
    color: r.color, avatarUrl: r.avatarUrl || null, about: r.about || null,
    title: r.title || null, pronouns: r.pronouns || null, phone: r.phone || null,
    timezone: r.timezone || null, role: r.role, presence: r.presence,
    manualPresence: r.manualPresence || null, lastSeen: r.lastSeen || null,
    shareLastSeen: r.shareLastSeen == null ? true : !!r.shareLastSeen,
    passwordHash: r.passwordHash, ssoEnabled: !!r.ssoEnabled,
  };

const users = {
  async getById(id: string) { return mapUser(tbl("users").find(u => u.id === id)); },
  async getByEmail(email: string) { return mapUser(tbl("users").find(u => u.email === email && !u.deleted)); },
  async getByName(name: string) { return mapUser(tbl("users").find(u => u.name === name && !u.deleted)); },
  async getByIds(ids: string[]) { const s = new Set(ids); return tbl("users").filter(u => s.has(u.id)).map(mapUser); },
  async list(orgId?: string) {
    let rows = tbl("users").filter(u => !u.deleted);
    if (orgId) {
      const memberIds = new Set(tbl("org_members").filter(m => m.organizationId === orgId && m.status === "active" && !m.deleted).map(m => m.userId));
      rows = rows.filter(u => memberIds.has(u.id));
    }
    return rows.sort((a, b) => a.name.localeCompare(b.name)).map(mapUser);
  },
  async listPage({ orgId, q: qry, limit, offset }: any = {}) {
    const lim = Math.min(Math.max(Math.floor(Number(limit)) || 50, 1), 100);
    const off = Math.max(Math.floor(Number(offset)) || 0, 0);
    let rows = tbl("users").filter(u => !u.deleted);
    if (qry) {
      const q2 = qry.toLowerCase();
      rows = rows.filter(u => u.name?.toLowerCase().includes(q2) || u.email?.toLowerCase().includes(q2));
    }
    if (orgId) {
      const memberIds = new Set(tbl("org_members").filter(m => m.organizationId === orgId && m.status === "active" && !m.deleted).map(m => m.userId));
      rows = rows.filter(u => memberIds.has(u.id));
    }
    rows = rows.sort((a, b) => a.name.localeCompare(b.name)).slice(off);
    const hasMore = rows.length > lim;
    return { users: rows.slice(0, lim).map(mapUser), hasMore };
  },
  async upsert(u: any) {
    const arr = tbl("users");
    const idx = arr.findIndex(x => x.id === u.id);
    const row = { id: u.id, email: u.email, name: u.name, initials: u.initials, color: u.color,
      avatarUrl: u.avatarUrl || null, role: u.role || "member", presence: u.presence || "off",
      passwordHash: u.passwordHash || null, deleted: false, ssoEnabled: false,
      manualPresence: null, lastSeen: null, shareLastSeen: true,
      about: null, title: null, pronouns: null, phone: null, timezone: null };
    if (idx >= 0) { arr[idx] = { ...arr[idx], ...row, deleted: false, deletedAt: null }; }
    else { arr.push(row); }
    save("users"); return mapUser(arr.find(x => x.id === u.id));
  },
  async softDelete(id: string, actorId?: string) {
    const arr = tbl("users"); const idx = arr.findIndex(x => x.id === id);
    if (idx >= 0) {
      arr[idx] = { ...arr[idx], deleted: true, deletedAt: now(), deletedBy: actorId || null,
        email: `deleted+${id}@deleted.invalid`, name: "Deleted user", avatarUrl: null, about: null, manualPresence: null };
      save("users");
    }
    return mapUser(tbl("users").find(x => x.id === id));
  },
  async deleteAccount(userId: string, actorId?: string) {
    await this.softDelete(userId, actorId || userId);
    // Cascade soft-deletes
    for (const [t, col] of [["conversation_members","userId"],["bookmarks","userId"],["meeting_attendees","userId"],["meeting_presence","userId"],["folders","userId"],["reminders","userId"],["notifications","userId"],["scheduled_messages","senderId"],["voicemails","fromUser"],["voicemails","toUser"],["user_blocks","blockerId"],["user_blocks","blockedId"],["invites","fromUserId"],["invites","toUserId"],["org_members","userId"],["team_members","userId"]] as Array<[string, string]>) {
      const arr = tbl(t); arr.forEach(r => { if (r[col] === userId && !r.deleted) { r.deleted = true; r.deletedAt = now(); r.deletedBy = actorId || userId; } }); save(t);
    }
    const devices = tbl("e2ee_devices"); devices.forEach(r => { if (r.userId === userId && !r.revoked) r.revoked = true; }); save("e2ee_devices");
    const tasks2 = tbl("tasks"); tasks2.forEach(r => { if (r.assigneeId === userId) r.assigneeId = null; if (r.reporterId === userId) r.reporterId = null; }); save("tasks");
    return { id: userId, deleted: true };
  },
  async orgsSolelyOwnedBy(userId: string) {
    return tbl("orgs").filter(o => !o.deleted && o.status === "active").filter(o => {
      const owners = tbl("org_members").filter(m => m.organizationId === o.id && m.role === "owner" && m.status === "active" && !m.deleted);
      return owners.length === 1 && owners[0].userId === userId;
    }).map(o => ({ id: o.id, name: o.name }));
  },
  async setPresence(id: string, presence: string) {
    const arr = tbl("users"); const u = arr.find(x => x.id === id);
    if (u) { u.presence = presence; if (presence === "off") u.lastSeen = now(); save("users"); }
    return mapUser(u);
  },
  async setShareLastSeen(id: string, share: boolean) {
    const arr = tbl("users"); const u = arr.find(x => x.id === id); if (u) { u.shareLastSeen = share; save("users"); }
  },
  async setSsoEnabled(id: string) {
    const arr = tbl("users"); const u = arr.find(x => x.id === id); if (u) { u.ssoEnabled = true; save("users"); }
    return mapUser(tbl("users").find(x => x.id === id));
  },
  async updatePassword(id: string, passwordHash: string) {
    const arr = tbl("users"); const u = arr.find(x => x.id === id); if (u) { u.passwordHash = passwordHash; save("users"); }
    return mapUser(tbl("users").find(x => x.id === id));
  },
  async setManualPresence(id: string, status: string) {
    const val = ["away","busy","dnd","brb","offline"].includes(status) ? status : null;
    const arr = tbl("users"); const u = arr.find(x => x.id === id); if (u) { u.manualPresence = val; save("users"); }
    return mapUser(tbl("users").find(x => x.id === id));
  },
  async updateAvatar(id: string, avatarUrl: string) {
    const arr = tbl("users"); const u = arr.find(x => x.id === id); if (u) { u.avatarUrl = avatarUrl; save("users"); }
    return mapUser(tbl("users").find(x => x.id === id));
  },
  async updateProfile(id: string, patch: any) {
    const arr = tbl("users"); const u = arr.find(x => x.id === id);
    if (u) { Object.assign(u, patch); save("users"); }
    return mapUser(tbl("users").find(x => x.id === id));
  },
  async search(qry: string, orgId?: string) {
    const q2 = (qry || "").toLowerCase();
    let rows = tbl("users").filter(u => !u.deleted && (u.name?.toLowerCase().includes(q2) || u.email?.toLowerCase().includes(q2)));
    if (orgId) {
      const memberIds = new Set(tbl("org_members").filter(m => m.organizationId === orgId && m.status === "active" && !m.deleted).map(m => m.userId));
      const scoped = rows.filter(u => memberIds.has(u.id));
      if (scoped.length > 0) return scoped.slice(0, 20).map(mapUser);
      if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(qry)) {
        const exact = tbl("users").find(u => u.email?.toLowerCase() === qry.toLowerCase() && !u.deleted);
        return exact ? [mapUser(exact)] : [];
      }
      return [];
    }
    return rows.slice(0, 20).map(mapUser);
  },
  async interactionScores(userId: string) {
    const scores = new Map<string, number>();
    const add = (id: string, n: number) => { if (!id || id === userId) return; scores.set(id, (scores.get(id) || 0) + n); };
    const dmConvIds = new Set(tbl("conversation_members").filter(m => m.userId === userId && !m.deleted).map(m => m.conversationId));
    for (const convId of dmConvIds) {
      const peers = tbl("conversation_members").filter(m => m.conversationId === convId && m.userId !== userId && !m.deleted);
      const msgCount = tbl("messages").filter(m => m.conversationId === convId && !m.deleted).length;
      for (const p of peers) add(p.userId, msgCount);
    }
    tbl("calls").filter(c => c.initiatorId === userId || c.peerId === userId).forEach(c => {
      add(c.initiatorId === userId ? c.peerId : c.initiatorId, 3);
    });
    return Array.from(scores.entries()).map(([uid, score]) => ({ userId: uid, score })).sort((a, b) => b.score - a.score);
  },
};

// ─── Conversations ───────────────────────────────────────────────────────────
const mapMsg = (r: any) => r && ({
  id: r.id, conversationId: r.conversationId, senderId: r.senderId, body: r.body,
  file: r.file || null, type: r.type || "text", voice: r.voice || null,
  encryptionVersion: Number(r.encryptionVersion) || 0, ciphertext: r.ciphertext || null,
  forwarded: r.forwarded, forwardCount: Number(r.forwardCount) || 0,
  edited: r.edited, deleted: !!r.deleted, reactions: r.reactions || [],
  createdAt: r.createdAt, parentMessageId: r.parentMessageId || null,
  replyCount: Number(r.replyCount) || 0, lastReplyAt: r.lastReplyAt || null,
  pinned: !!r.pinned, pinnedBy: r.pinnedBy || null, pinnedAt: r.pinnedAt || null,
  important: !!r.important,
});

const conversations = {
  async create(c: any) {
    const id = c.id || genId();
    const orgId = currentOrgId();
    const arr = tbl("conversations");
    const existing = arr.find(x => (c.dmKey && x.dmKey === c.dmKey && !x.deleted) || (x.id === id));
    if (existing) {
      existing.deleted = false;
      if (c.kind) existing.kind = c.kind;
      if (c.title) existing.title = c.title;
      if (c.icon) existing.icon = c.icon;
      save("conversations");
      return { id: existing.id, kind: existing.kind, title: existing.title, icon: existing.icon };
    }
    const row = { id, kind: c.kind, title: c.title || null, icon: c.icon || null, createdBy: c.createdBy || null,
      dmKey: c.dmKey || null, organizationId: orgId, temporary: !!c.temporary,
      expiresAt: c.expiresAt || null, retentionDays: Number(c.retentionDays) > 0 ? Math.floor(Number(c.retentionDays)) : 7,
      pendingConnection: !!c.pendingConnection, deleted: false, description: null, avatarUrl: null };
    arr.push(row); save("conversations");
    return { id, kind: c.kind, title: c.title || null, icon: c.icon || null };
  },
  async sweepExpiredTemporary() {
    const arr = tbl("conversations"); let count = 0;
    arr.forEach(c => { if (c.temporary && !c.deleted && c.expiresAt && new Date(c.expiresAt) < new Date()) { c.deleted = true; c.deletedAt = now(); c.dmKey = null; count++; } });
    if (count) save("conversations"); return count;
  },
  async setPendingConnection(convId: string, val: boolean) {
    const arr = tbl("conversations"); const c = arr.find(x => x.id === convId); if (c) { c.pendingConnection = !!val; save("conversations"); }
  },
  async discardPending(convId: string) {
    const arr = tbl("conversations"); const c = arr.find(x => x.id === convId && x.pendingConnection && !x.deleted);
    if (c) { c.deleted = true; c.deletedAt = now(); c.dmKey = null; save("conversations"); return 1; } return 0;
  },
  async findByDmKey(dmKey: string) {
    if (!dmKey) return null;
    const orgId = currentOrgId();
    const c = tbl("conversations").find(x => x.dmKey === dmKey && !x.deleted && (!orgId || x.organizationId === orgId));
    return c ? c.id : null;
  },
  async touchTempExpiry(convId: string) {
    const arr = tbl("conversations"); const c = arr.find(x => x.id === convId && x.temporary && !x.deleted);
    if (c) { const d = new Date(); d.setDate(d.getDate() + (c.retentionDays || 7)); c.expiresAt = d.toISOString(); save("conversations"); return 1; } return 0;
  },
  async setTempRetention(convId: string, days: number) {
    const d = Math.max(1, Math.min(3650, Math.floor(Number(days) || 7)));
    const arr = tbl("conversations"); const c = arr.find(x => x.id === convId && x.temporary && !x.deleted);
    if (c) { c.retentionDays = d; const ex = new Date(); ex.setDate(ex.getDate() + d); c.expiresAt = ex.toISOString(); save("conversations"); }
    return { updated: c ? 1 : 0, retentionDays: d };
  },
  async convertToPermanent(convId: string) {
    const arr = tbl("conversations"); const c = arr.find(x => x.id === convId && !x.deleted);
    if (c) { c.temporary = false; c.expiresAt = null; save("conversations"); return 1; } return 0;
  },
  async addMember(convId: string, userId: string, opts: any = {}) {
    const arr = tbl("conversation_members");
    const existing = arr.find(x => x.conversationId === convId && x.userId === userId);
    if (existing) { existing.deleted = false; existing.deletedAt = null; existing.role = opts.role || existing.role || "member"; }
    else arr.push({ conversationId: convId, userId, role: opts.role || "member", starred: !!opts.starred, muted: !!opts.muted, hidden: false, unread: 0, deleted: false, lastReadAt: null, historyVisibleFrom: null });
    save("conversation_members");
  },
  async setMemberRole(convId: string, userId: string, role: string) {
    const arr = tbl("conversation_members"); const m = arr.find(x => x.conversationId === convId && x.userId === userId);
    if (m) { m.role = role; save("conversation_members"); }
    return { conversationId: convId, userId, role };
  },
  async setMemberHistoryCutoff(convId: string, userId: string) {
    const arr = tbl("conversation_members"); const m = arr.find(x => x.conversationId === convId && x.userId === userId);
    if (m) { m.historyVisibleFrom = now(); save("conversation_members"); }
  },
  async removeMember(convId: string, userId: string, actorId?: string) {
    const arr = tbl("conversation_members"); const m = arr.find(x => x.conversationId === convId && x.userId === userId && !x.deleted);
    if (m) { m.deleted = true; m.deletedAt = now(); m.deletedBy = actorId || null; save("conversation_members"); }
    return { conversationId: convId, userId, removed: true };
  },
  async setMemberFlag(convId: string, userId: string, flag: string, value: any) {
    const arr = tbl("conversation_members"); const m = arr.find(x => x.conversationId === convId && x.userId === userId);
    if (m) { if (flag === "unread") m.unread = Number(value) || 0; else m[flag] = !!value; save("conversation_members"); }
    if (flag === "unread") return { userId, unread: Number(value) || 0 };
    return { userId, [flag]: !!value };
  },
  async bumpUnread(convId: string, exceptUserId: string) {
    const arr = tbl("conversation_members");
    arr.forEach(m => { if (m.conversationId === convId && m.userId !== exceptUserId && !m.deleted) m.unread = (m.unread || 0) + 1; });
    save("conversation_members");
  },
  async unhideAll(convId: string) {
    const arr = tbl("conversation_members");
    arr.forEach(m => { if (m.conversationId === convId && !m.deleted) m.hidden = false; });
    save("conversation_members");
  },
  async unreadConversationCount(userId: string) {
    const live = new Set(tbl("conversations").filter(c => !c.deleted).map(c => c.id));
    return tbl("conversation_members").filter(m => m.userId === userId && !m.deleted && !m.muted && (m.unread || 0) > 0 && live.has(m.conversationId)).length;
  },
  async markRead(convId: string, userId: string) {
    const arr = tbl("conversation_members"); const m = arr.find(x => x.conversationId === convId && x.userId === userId);
    if (m) { m.unread = 0; m.lastReadAt = now(); save("conversation_members"); }
    return { userId, lastReadAt: m ? m.lastReadAt : null };
  },
  async readReceipts(convId: string) {
    return tbl("conversation_members").filter(m => m.conversationId === convId && m.lastReadAt && !m.deleted).map(m => ({ userId: m.userId, lastReadAt: m.lastReadAt }));
  },
  async remove(cid: string, actorId?: string) {
    const arr = tbl("conversations"); const c = arr.find(x => x.id === cid);
    if (c) { c.deleted = true; c.deletedAt = now(); c.deletedBy = actorId || null; c.dmKey = null; save("conversations"); }
    const mems = tbl("conversation_members"); mems.forEach(m => { if (m.conversationId === cid && !m.deleted) { m.deleted = true; m.deletedAt = now(); } }); save("conversation_members");
    return { id: cid, deleted: true };
  },
  async findDmBetween(a: string, b: string) {
    const orgId = currentOrgId();
    const aConvIds = new Set(tbl("conversation_members").filter(m => m.userId === a && !m.deleted).map(m => m.conversationId));
    const bConvIds = new Set(tbl("conversation_members").filter(m => m.userId === b && !m.deleted).map(m => m.conversationId));
    const c = tbl("conversations").find(x => x.kind === "dm" && !x.deleted && aConvIds.has(x.id) && bConvIds.has(x.id) && (!orgId || x.organizationId === orgId));
    return c ? c.id : null;
  },
  async findDmBetweenAny(a: string, b: string) {
    const aConvIds = new Set(tbl("conversation_members").filter(m => m.userId === a && !m.deleted).map(m => m.conversationId));
    const bConvIds = new Set(tbl("conversation_members").filter(m => m.userId === b && !m.deleted).map(m => m.conversationId));
    const c = tbl("conversations").find(x => x.kind === "dm" && !x.deleted && aConvIds.has(x.id) && bConvIds.has(x.id));
    return c ? c.id : null;
  },
  async isMember(convId: string, userId: string) {
    const mm = /^meeting:(.+)$/.exec(String(convId || ""));
    if (mm) {
      const mid = mm[1];
      return !!(tbl("meetings").find(m => m.id === mid && m.createdBy === userId && !m.deleted) ||
        tbl("meeting_attendees").find(m => m.meetingId === mid && m.userId === userId && !m.deleted) ||
        tbl("meeting_presence").find(m => m.meetingId === mid && m.userId === userId && !m.deleted));
    }
    return !!tbl("conversation_members").find(m => m.conversationId === convId && m.userId === userId && !m.deleted);
  },
  async members(convId: string) {
    return tbl("conversation_members").filter(m => m.conversationId === convId && !m.deleted).map(m => ({ userId: m.userId, role: m.role, starred: m.starred, muted: m.muted, hidden: m.hidden, unread: m.unread }));
  },
  async listPeerIds(uid: string) {
    const myConvIds = new Set(tbl("conversation_members").filter(m => m.userId === uid && !m.deleted).map(m => m.conversationId));
    const peers = new Set<string>();
    tbl("conversation_members").filter(m => myConvIds.has(m.conversationId) && m.userId !== uid && !m.deleted).forEach(m => peers.add(m.userId));
    return Array.from(peers);
  },
  async getById(id: string) {
    const orgId = currentOrgId();
    const c = tbl("conversations").find(x => x.id === id && !x.deleted && (!orgId || x.organizationId === orgId));
    if (!c) return null;
    const mem = tbl("conversation_members").filter(m => m.conversationId === id && !m.deleted).map(m => m.userId);
    return { id: c.id, kind: c.kind, title: c.title, icon: c.icon, description: c.description || null, avatarUrl: c.avatarUrl || null, members: mem, createdBy: c.createdBy || null, temporary: !!c.temporary, pendingConnection: !!c.pendingConnection, expiresAt: c.expiresAt || null, retentionDays: c.retentionDays != null ? Number(c.retentionDays) : 7 };
  },
  async update(convId: string, patch: any) {
    const arr = tbl("conversations"); const c = arr.find(x => x.id === convId);
    if (c) { if (patch.title !== undefined) c.title = patch.title; if (patch.icon !== undefined) c.icon = patch.icon; if (patch.description !== undefined) c.description = patch.description; if (patch.avatarUrl !== undefined) c.avatarUrl = patch.avatarUrl; save("conversations"); }
    return this.getById(convId);
  },
  async setKind(convId: string, kind: string) {
    const arr = tbl("conversations"); const c = arr.find(x => x.id === convId);
    if (c) { c.kind = kind; save("conversations"); }
    return { id: convId, kind };
  },
  async listForUser(uid: string) {
    const orgId = currentOrgId();
    const memRows = tbl("conversation_members").filter(m => m.userId === uid && !m.deleted);
    const myConvIds = new Set(memRows.map(m => m.conversationId));
    const rawConvs = tbl("conversations").filter(c => myConvIds.has(c.id) && !c.deleted && (!orgId || c.organizationId === orgId || c.organizationId == null));
    const seen = new Set<string>();
    const convs = rawConvs.filter(c => { if (seen.has(c.id)) return false; seen.add(c.id); return true; });
    return convs.map(c => {
      const mem = tbl("conversation_members").filter(m => m.conversationId === c.id && !m.deleted).map(m => m.userId);
      const myMem = memRows.find(m => m.conversationId === c.id);
      const msgs = tbl("messages").filter(m => m.conversationId === c.id && !m.deleted).sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
      let lastMessage = msgs[0] ? mapMsg(msgs[0]) : null;
      if (lastMessage && myMem?.historyVisibleFrom && new Date(lastMessage.createdAt) < new Date(myMem.historyVisibleFrom)) lastMessage = null;
      return { id: c.id, kind: c.kind, title: c.title, icon: c.icon, description: c.description || null, avatarUrl: c.avatarUrl || null, members: Array.from(new Set(mem)), starred: myMem?.starred, muted: myMem?.muted, hidden: myMem?.hidden, unread: myMem?.unread, role: myMem?.role || "member", createdBy: c.createdBy || null, lastMessage, temporary: !!c.temporary, pendingConnection: !!c.pendingConnection, expiresAt: c.expiresAt || null, retentionDays: c.retentionDays != null ? Number(c.retentionDays) : 7 };
    });
  },
  async listConversationIdsForUser(uid: string) {
    const orgId = currentOrgId();
    const memRows = tbl("conversation_members").filter(m => m.userId === uid && !m.deleted);
    const convIds = memRows.map(m => m.conversationId);
    return tbl("conversations").filter(c => convIds.includes(c.id) && !c.deleted && (!orgId || c.organizationId === orgId || c.organizationId == null)).map(c => c.id);
  },
};

// ─── Messages ────────────────────────────────────────────────────────────────
const messages = {
  async create(m: any) {
    const id = m.id || genId();
    const row = { id, conversationId: m.conversationId, senderId: m.senderId, body: m.body || null, file: m.file || null,
      type: m.type || "text", voice: m.voice || null, encryptionVersion: m.encryptionVersion || 0, ciphertext: m.ciphertext || null,
      forwarded: m.forwarded || false, forwardCount: m.forwardCount || 0, edited: false, deleted: false,
      reactions: m.reactions || [], createdAt: m.createdAt || now(), parentMessageId: m.parentMessageId || null,
      replyCount: 0, lastReplyAt: null, pinned: false, pinnedBy: null, pinnedAt: null, important: false };
    tbl("messages").push(row); save("messages");
    // bump reply count on parent
    if (m.parentMessageId) {
      const parent = tbl("messages").find(x => x.id === m.parentMessageId);
      if (parent) { parent.replyCount = (parent.replyCount || 0) + 1; parent.lastReplyAt = row.createdAt; save("messages"); }
    }
    return mapMsg(row);
  },
  async getById(id: string) { return mapMsg(tbl("messages").find(m => m.id === id)); },
  async list(convId: string, opts: any = {}) {
    const { limit = 50, before, after, parentMessageId } = opts;
    let rows = tbl("messages").filter(m => m.conversationId === convId && !m.deleted);
    if (parentMessageId !== undefined) rows = rows.filter(m => m.parentMessageId === parentMessageId);
    // replies stay in the main timeline (quoted card), matching the MySQL driver
    rows = rows.sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime());
    if (before) rows = rows.filter(m => new Date(m.createdAt) < new Date(before));
    if (after) rows = rows.filter(m => new Date(m.createdAt) > new Date(after));
    return rows.slice(-Number(limit)).map(mapMsg);
  },
  async listForConversation(convId: string, opts: any = {}) {
    return this.list(convId, opts);
  },
  async listPage(convId: string, opts: any = {}) {
    const { limit = 50, cursor } = opts;
    let rows = tbl("messages").filter(m => m.conversationId === convId && !m.deleted).sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
    if (cursor) rows = rows.filter(m => new Date(m.createdAt) < new Date(cursor));
    const page = rows.slice(0, Number(limit) + 1);
    const hasMore = page.length > Number(limit);
    return { messages: page.slice(0, Number(limit)).map(mapMsg), hasMore };
  },
  async listThreadReplies(parentId: string, opts: any = {}) {
    const { limit = 50 } = opts;
    return tbl("messages").filter(m => m.parentMessageId === parentId && !m.deleted).sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime()).slice(0, Number(limit)).map(mapMsg);
  },
  async update(id: string, patch: any) {
    const arr = tbl("messages"); const m = arr.find(x => x.id === id);
    if (m) { Object.assign(m, patch, { edited: patch.body !== undefined ? true : m.edited }); save("messages"); }
    return mapMsg(tbl("messages").find(x => x.id === id));
  },
  async softDelete(id: string, actorId?: string) {
    const arr = tbl("messages"); const m = arr.find(x => x.id === id);
    if (m) { m.deleted = true; m.deletedAt = now(); m.deletedBy = actorId || null; m.body = null; m.file = null; save("messages"); }
    return mapMsg(tbl("messages").find(x => x.id === id));
  },
  async setReaction(msgId: string, userId: string, emoji: string, add: boolean) {
    const arr = tbl("messages"); const m = arr.find(x => x.id === msgId);
    if (!m) return null;
    m.reactions = m.reactions || [];
    const idx = m.reactions.findIndex((r: any) => r.emoji === emoji && r.userId === userId);
    if (add && idx < 0) m.reactions.push({ emoji, userId });
    if (!add && idx >= 0) m.reactions.splice(idx, 1);
    save("messages"); return mapMsg(m);
  },
  async pin(msgId: string, actorId: string, pin: boolean) {
    const arr = tbl("messages"); const m = arr.find(x => x.id === msgId);
    if (m) { m.pinned = pin; m.pinnedBy = pin ? actorId : null; m.pinnedAt = pin ? now() : null; save("messages"); }
    return mapMsg(tbl("messages").find(x => x.id === msgId));
  },
  // The app calls these names; the JSON driver had close-but-different ones
  // (setReaction / softDelete / pin), so every call site 500'd. Implemented to
  // the MySQL semantics rather than aliased, because the return shapes differ.
  async thread(parentId: string) {
    const parent = mapMsg(tbl("messages").find(m => m.id === parentId));
    if (!parent) return null;
    const replies = tbl("messages")
      .filter(m => m.parentMessageId === parentId && !m.deleted)
      .sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime())
      .map(mapMsg);
    return { parent, replies };
  },
  // Returns the updated message, and flags whether this was an ADD — the socket
  // layer only notifies the author when a reaction goes on, not off.
  async toggleReaction(msgId: string, userId: string, emoji: string) {
    const m = tbl("messages").find(x => x.id === msgId);
    if (!m) return null;
    m.reactions = m.reactions || [];
    const i = m.reactions.findIndex((r: any) => r.userId === userId && r.emoji === emoji);
    const adding = i === -1;
    if (adding) m.reactions.push({ userId, emoji });
    else m.reactions.splice(i, 1);
    save("messages");
    const out: any = mapMsg(m);
    out._reactionAdded = adding;
    return out;
  },
  // Soft-delete: the row survives as a tombstone so the thread renders "This
  // message was deleted" in place instead of the message vanishing.
  async remove(id: string) {
    const m = tbl("messages").find(x => x.id === id);
    if (!m) return null;
    m.deleted = true;
    m.deletedAt = now();
    m.body = null;
    m.file = null;
    save("messages");
    return mapMsg(m);
  },
  // Per-viewer "delete for me" — hides a message from ONE person without
  // touching it for anyone else.
  async addDeletion(userId: string, messageId: string) {
    const arr = tbl("message_deletions");
    if (!arr.find(d => d.userId === userId && d.messageId === messageId)) {
      arr.push({ userId, messageId, createdAt: now() });
      save("message_deletions");
    }
  },
  async getDeletionIds(userId: string) {
    return tbl("message_deletions").filter(d => d.userId === userId).map(d => d.messageId);
  },
  async unpin(msgId: string) {
    const m = tbl("messages").find(x => x.id === msgId);
    if (m) { m.pinned = false; m.pinnedBy = null; m.pinnedAt = null; save("messages"); }
    return mapMsg(m);
  },
  async listPinned(convId: string) {
    return tbl("messages").filter(m => m.conversationId === convId && m.pinned && !m.deleted).sort((a, b) => new Date(b.pinnedAt).getTime() - new Date(a.pinnedAt).getTime()).map(mapMsg);
  },
  async setImportant(msgId: string, important: boolean) {
    const arr = tbl("messages"); const m = arr.find(x => x.id === msgId);
    if (m) { m.important = important; save("messages"); }
    return mapMsg(tbl("messages").find(x => x.id === msgId));
  },
  async search(convId: string, qry: string) {
    const q2 = (qry || "").toLowerCase();
    return tbl("messages").filter(m => m.conversationId === convId && !m.deleted && m.body?.toLowerCase().includes(q2)).sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()).slice(0, 30).map(mapMsg);
  },
  async searchAll(qry: string, userId: string, orgId?: string) {
    const q2 = (qry || "").toLowerCase();
    const myConvIds = new Set(tbl("conversation_members").filter(m => m.userId === userId && !m.deleted).map(m => m.conversationId));
    return tbl("messages").filter(m => myConvIds.has(m.conversationId) && !m.deleted && m.body?.toLowerCase().includes(q2)).sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()).slice(0, 30).map(mapMsg);
  },
  async getByIds(ids: string[]) {
    const s = new Set(ids); return tbl("messages").filter(m => s.has(m.id)).map(mapMsg);
  },
  async countUnread(convId: string, userId: string) {
    const mem = tbl("conversation_members").find(m => m.conversationId === convId && m.userId === userId && !m.deleted);
    return mem ? (mem.unread || 0) : 0;
  },
  async listImportant(userId: string) {
    const myConvIds = new Set(tbl("conversation_members").filter(m => m.userId === userId && !m.deleted).map(m => m.conversationId));
    return tbl("messages").filter(m => myConvIds.has(m.conversationId) && m.important && !m.deleted).sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()).map(mapMsg);
  },
};

// ─── Bookmarks ────────────────────────────────────────────────────────────────
const bookmarks = {
  async toggle(userId: string, messageId: string) {
    const arr = tbl("bookmarks");
    const ex = arr.find(b => b.userId === userId && b.messageId === messageId && !b.deleted);
    if (ex) { ex.deleted = true; ex.deletedAt = now(); save("bookmarks"); return false; }
    const soft = arr.find(b => b.userId === userId && b.messageId === messageId);
    if (soft) { soft.deleted = false; soft.deletedAt = null; } else { arr.push({ userId, messageId, deleted: false }); }
    save("bookmarks"); return true;
  },
  async list(userId: string) {
    return tbl("bookmarks").filter(b => b.userId === userId && !b.deleted).map(b => b.messageId);
  },
};

// ─── Meetings ────────────────────────────────────────────────────────────────
const mapMtg = (r: any) => r && ({
  id: r.id, title: r.title, startsAt: r.startsAt, durationMin: r.durationMin,
  createdBy: r.createdBy, conversationId: r.conversationId, status: r.status || "scheduled",
  hardEnded: !!r.hardEnded, lobbyEnabled: !!r.lobbyEnabled, locked: !!r.locked,
  recurrence: r.recurrence || "none", recurrenceRule: r.recurrenceRule || null,
  timezone: r.timezone || null, reminderLeadMin: r.reminderLeadMin == null ? null : Number(r.reminderLeadMin),
  description: r.description == null ? null : String(r.description),
  location: r.location == null ? null : String(r.location),
  organizationId: r.organizationId || null,
  publicLinkToken: r.publicLinkToken || null,
  // Per-meeting options (0116). Same defaults as the SQL columns, so a row
  // written before this feature reads back as "everything allowed, no lobby".
  lobbyPolicy: r.lobbyPolicy || "everyone",
  allowMic: r.allowMic == null ? true : !!r.allowMic,
  allowCamera: r.allowCamera == null ? true : !!r.allowCamera,
  allowChat: r.allowChat == null ? true : !!r.allowChat,
  allowReactions: r.allowReactions == null ? true : !!r.allowReactions,
  allowWhiteboard: r.allowWhiteboard == null ? true : !!r.allowWhiteboard,
  allowScreenShare: r.allowScreenShare == null ? true : !!r.allowScreenShare,
  hostAllowWhiteboard: r.hostAllowWhiteboard == null ? true : !!r.hostAllowWhiteboard,
  autoRecord: !!r.autoRecord,
});

const meetings = {
  async create(mt: any) {
    const id = mt.id || genId();
    const orgId = currentOrgId();
    const row = { id, title: mt.title, startsAt: mt.startsAt, durationMin: mt.durationMin || 30, createdBy: mt.createdBy || null,
      conversationId: mt.conversationId || null, status: "scheduled", hardEnded: false, lobbyEnabled: false, locked: false,
      recurrence: mt.recurrence || "none", recurrenceRule: mt.recurrenceRule || null, timezone: mt.timezone || null,
      reminderLeadMin: mt.reminderLeadMin == null ? null : Number(mt.reminderLeadMin), organizationId: orgId, deleted: false,
      description: mt.description && String(mt.description).trim() ? String(mt.description) : null,
      location: mt.location && String(mt.location).trim() ? String(mt.location) : null };
    tbl("meetings").push(row); save("meetings");
    // invitedByHost marks the HOST's invite list, which the "invited" lobby
    // policy keys on — a self-joiner's row (setAttendeeStatus) leaves it false.
    for (const u of mt.attendees || []) { tbl("meeting_attendees").push({ meetingId: id, userId: u, status: "invited", role: "participant", invitedByHost: true, optional: false, deleted: false }); }
    if ((mt.attendees || []).length) save("meeting_attendees");
    return mapMtg(row);
  },
  async listForUser(uid: string) {
    const orgId = currentOrgId();
    const attMids = new Set(tbl("meeting_attendees").filter(a => a.userId === uid && !a.deleted).map(a => a.meetingId));
    const rows = tbl("meetings").filter(m => !m.deleted && (m.createdBy === uid || attMids.has(m.id)) && (!orgId || !m.organizationId || m.organizationId === orgId)).sort((a, b) => new Date(a.startsAt).getTime() - new Date(b.startsAt).getTime());
    return rows.map(m => { const att = tbl("meeting_attendees").filter(a => a.meetingId === m.id && !a.deleted).map(a => ({ userId: a.userId, status: a.status, role: a.role || "participant" })); return { ...mapMtg(m), attendees: att }; });
  },
  async search(uid: string, qry: string, orgId?: string) {
    const q2 = (qry || "").toLowerCase();
    const attMids = new Set(tbl("meeting_attendees").filter(a => a.userId === uid && !a.deleted).map(a => a.meetingId));
    const rows = tbl("meetings").filter(m => !m.deleted && (m.createdBy === uid || attMids.has(m.id)) && m.title?.toLowerCase().includes(q2) && (!orgId || m.organizationId === orgId)).slice(0, 20);
    return rows.map(m => { const att = tbl("meeting_attendees").filter(a => a.meetingId === m.id && !a.deleted).map(a => ({ userId: a.userId, status: a.status, role: a.role || "participant" })); return { ...mapMtg(m), attendees: att }; });
  },
  async getById(mid: string) {
    const orgId = currentOrgId();
    const m = tbl("meetings").find(x => x.id === mid && !x.deleted && (!orgId || !x.organizationId || x.organizationId === orgId));
    if (!m) return null;
    const att = tbl("meeting_attendees").filter(a => a.meetingId === mid && !a.deleted).map(a => ({ userId: a.userId, status: a.status, role: a.role || "participant" }));
    return { ...mapMtg(m), attendees: att };
  },
  async setAttendeeStatus(mid: string, uid: string, status: string) {
    const arr = tbl("meeting_attendees"); const a = arr.find(x => x.meetingId === mid && x.userId === uid);
    // Same rule as the MySQL driver: status 'invited' is the HOST invite path,
    // and the flag only ever goes false -> true (monotonic).
    const byHost = status === "invited";
    if (a) { a.status = status; a.deleted = false; if (byHost) a.invitedByHost = true; }
    else { arr.push({ meetingId: mid, userId: uid, status, role: "participant", invitedByHost: byHost, deleted: false }); }
    save("meeting_attendees");
  },
  async isInvitedByHost(mid: string, uid: string) {
    const a = tbl("meeting_attendees").find(x => x.meetingId === mid && x.userId === uid && !x.deleted);
    return !!(a && a.invitedByHost);
  },
  async update(mid: string, patch: any) {
    const { attendees, ...rest } = patch || {};
    const arr = tbl("meetings"); const m = arr.find(x => x.id === mid);
    if (m) { Object.assign(m, rest); save("meetings"); }
    if (Array.isArray(attendees)) {
      const attArr = tbl("meeting_attendees"); attArr.forEach(a => { if (a.meetingId === mid) a.deleted = true; });
      for (const u of attendees) { const ex = attArr.find(a => a.meetingId === mid && a.userId === u); if (ex) { ex.deleted = false; ex.deletedAt = null; } else { attArr.push({ meetingId: mid, userId: u, status: "invited", role: "participant", deleted: false }); } }
      save("meeting_attendees");
    }
    return this.getById(mid);
  },
  async remove(mid: string, actorId?: string) {
    const arr = tbl("meetings"); const m = arr.find(x => x.id === mid);
    if (m) { m.deleted = true; m.deletedAt = now(); m.deletedBy = actorId || null; save("meetings"); }
    [["meeting_attendees","meetingId"],["meeting_presence","meetingId"],["meeting_recordings","meetingId"],["meeting_messages","meetingId"]].forEach(([t, col]) => { const a = tbl(t); a.forEach(r => { if (r[col] === mid) { r.deleted = true; r.deletedAt = now(); } }); save(t); });
    return { id: mid, deleted: true };
  },
  async removeAttendee(mid: string, uid: string) {
    const arr = tbl("meeting_attendees"); arr.forEach(a => { if (a.meetingId === mid && a.userId === uid) { a.deleted = true; a.deletedAt = now(); } }); save("meeting_attendees");
    return this.getById(mid);
  },
  async enterRoom(mid: string, uid: string) {
    const arr = tbl("meeting_presence"); const ex = arr.find(x => x.meetingId === mid && x.userId === uid);
    if (ex) { ex.lastSeen = now(); ex.deleted = false; ex.deletedAt = null; } else { arr.push({ meetingId: mid, userId: uid, joinedAt: now(), lastSeen: now(), deleted: false }); }
    save("meeting_presence");
    // Attendance log (0119): one row per join, guarded against reconnect churn.
    const att = tbl("meeting_attendance");
    if (!att.find(a => a.meetingId === mid && a.userId === uid && !a.leftAt)) {
      att.push({ id: genId(), meetingId: mid, userId: uid, joinedAt: now(), leftAt: null });
      save("meeting_attendance");
    }
  },
  async heartbeatRoom(mid: string, uid: string) {
    const arr = tbl("meeting_presence"); const p = arr.find(x => x.meetingId === mid && x.userId === uid);
    if (p) { p.lastSeen = now(); save("meeting_presence"); }
  },
  async leaveRoom(mid: string, uid: string) {
    const arr = tbl("meeting_presence"); arr.forEach(p => { if (p.meetingId === mid && p.userId === uid) { p.deleted = true; p.deletedAt = now(); } }); save("meeting_presence");
    const att = tbl("meeting_attendance");
    let touched = false;
    att.forEach(a => { if (a.meetingId === mid && a.userId === uid && !a.leftAt) { a.leftAt = now(); touched = true; } });
    if (touched) save("meeting_attendance");
  },
  async clearRoom(mid: string) {
    const arr = tbl("meeting_presence"); arr.forEach(p => { if (p.meetingId === mid && !p.deleted) { p.deleted = true; p.deletedAt = now(); } }); save("meeting_presence");
  },
  // REC-15: full attendance — every join row, including soft-deleted (left) ones.
  async attendance(mid: string) {
    return tbl("meeting_presence")
      .filter(p => p.meetingId === mid)
      .sort((a, b) => new Date(a.joinedAt).getTime() - new Date(b.joinedAt).getTime())
      .map(p => ({ userId: p.userId, joinedAt: p.joinedAt, leftAt: p.deletedAt || p.lastSeen }));
  },
  async roomParticipants(mid: string) {
    const cutoff = new Date(Date.now() - 90000).toISOString();
    return tbl("meeting_presence").filter(p => p.meetingId === mid && !p.deleted && p.lastSeen > cutoff).sort((a, b) => new Date(a.joinedAt).getTime() - new Date(b.joinedAt).getTime()).map(p => ({ userId: p.userId, joinedAt: p.joinedAt }));
  },
  async presenceCounts(meetingIds: string[]) {
    const cutoff = new Date(Date.now() - 90000).toISOString();
    const out: Record<string, number> = {};
    meetingIds.forEach(id => out[id] = 0);
    tbl("meeting_presence").filter(p => meetingIds.includes(p.meetingId) && !p.deleted && p.lastSeen > cutoff).forEach(p => { out[p.meetingId] = (out[p.meetingId] || 0) + 1; });
    return out;
  },
  async listEjected(mid: string) {
    return tbl("meeting_ejected").filter(e => e.meetingId === mid && !e.deleted).map(e => e.userId);
  },
  async eject(mid: string, uid: string, by: string) {
    const arr = tbl("meeting_ejected"); arr.push({ meetingId: mid, userId: uid, ejectedBy: by, ejectedAt: now(), deleted: false }); save("meeting_ejected");
  },
  async setStatus(mid: string, status: string) {
    const arr = tbl("meetings"); const m = arr.find(x => x.id === mid);
    if (m) { m.status = status; save("meetings"); }
    return mapMtg(tbl("meetings").find(x => x.id === mid));
  },
  async setHardEnded(mid: string) {
    const arr = tbl("meetings"); const m = arr.find(x => x.id === mid);
    if (m) { m.hardEnded = true; m.status = "completed"; save("meetings"); }
    return mapMtg(tbl("meetings").find(x => x.id === mid));
  },
  async clearHardEndedAndComplete(mid: string) {
    const arr = tbl("meetings"); const m = arr.find(x => x.id === mid);
    if (m) { m.hardEnded = false; m.status = "completed"; save("meetings"); }
    return mapMtg(tbl("meetings").find(x => x.id === mid));
  },
  async setLocked(mid: string, locked: boolean) {
    const arr = tbl("meetings"); const m = arr.find(x => x.id === mid);
    if (m) { m.locked = locked; save("meetings"); }
    return mapMtg(tbl("meetings").find(x => x.id === mid));
  },
  async attendanceReport(mid: string) {
    const rows = tbl("meeting_attendance").filter(a => a.meetingId === mid);
    const by: Record<string, any> = {};
    for (const a of rows) {
      const end = a.leftAt || new Date().toISOString();
      const b = (by[a.userId] ||= { userId: a.userId, firstJoined: a.joinedAt, lastLeft: end, sessions: 0, seconds: 0, stillPresent: false });
      b.sessions++;
      b.seconds += Math.max(0, Math.round((new Date(end).getTime() - new Date(a.joinedAt).getTime()) / 1000));
      if (a.joinedAt < b.firstJoined) b.firstJoined = a.joinedAt;
      if (end > b.lastLeft) b.lastLeft = end;
      if (!a.leftAt) b.stillPresent = true;
    }
    return Object.values(by).sort((x: any, y: any) => String(x.firstJoined).localeCompare(String(y.firstJoined)));
  },
  // Public (guest) join link (0132) — parity with the MySQL driver. Not
  // org-scoped on read: the anonymous guest has no tenant yet.
  async getByPublicToken(token: string) {
    const t = String(token || "");
    if (!t) return null;
    const m = tbl("meetings").find(x => !x.deleted && x.publicLinkToken === t);
    if (!m) return null;
    const att = tbl("meeting_attendees").filter(a => a.meetingId === m.id && !a.deleted).map(a => ({ userId: a.userId, status: a.status, role: a.role || "participant" }));
    return { ...mapMtg(m), attendees: att };
  },
  async setPublicLinkToken(mid: string, token: string | null) {
    const m = tbl("meetings").find(x => x.id === mid);
    if (m) { m.publicLinkToken = token || null; save("meetings"); }
    return this.getById(mid);
  },
  // Guest device binding (0135) — parity with the MySQL driver.
  async getGuestDevice(meetingId: string, deviceId: string) {
    const r = tbl("meeting_guest_devices").find(x => x.meetingId === meetingId && x.deviceId === deviceId);
    if (!r) return null;
    const u = tbl("users").find(x => x.id === r.userId);
    return { ...r, joinCount: Number(r.joinCount) || 1, userDeleted: !u || !!u.deleted };
  },
  async rebindGuestDevice({ meetingId, deviceId, userId }: { meetingId: string; deviceId: string; userId: string }) {
    const r = tbl("meeting_guest_devices").find(x => x.meetingId === meetingId && x.deviceId === deviceId);
    if (r) { r.userId = userId; r.joinCount = 1; r.createdAt = now(); r.lastSeenAt = now(); save("meeting_guest_devices"); }
    return this.getGuestDevice(meetingId, deviceId);
  },
  async bindGuestDevice({ meetingId, deviceId, userId }: { meetingId: string; deviceId: string; userId: string }) {
    const arr = tbl("meeting_guest_devices");
    const r = arr.find(x => x.meetingId === meetingId && x.deviceId === deviceId);
    if (r) { r.joinCount = (Number(r.joinCount) || 1) + 1; r.lastSeenAt = now(); }
    else arr.push({ meetingId, deviceId, userId, joinCount: 1, createdAt: now(), lastSeenAt: now() });
    save("meeting_guest_devices");
    return this.getGuestDevice(meetingId, deviceId);
  },
  async setLobbyEnabled(mid: string, enabled: boolean) {
    // Mirror both representations, exactly like the MySQL driver.
    const arr = tbl("meetings"); const m = arr.find(x => x.id === mid);
    if (m) { m.lobbyEnabled = enabled; m.lobbyPolicy = enabled ? "nobody" : "everyone"; save("meetings"); }
    return mapMtg(tbl("meetings").find(x => x.id === mid));
  },
  // ── Attendee roles, lobby and ejection (JSON parity) ──────────────────────
  // Every meeting feature built on these — co-host promotion, the lobby policy,
  // "remove participant" — was dead on this driver without them.
  async setAttendeeRole(mid: string, uid: string, role: string) {
    const a = tbl("meeting_attendees").find(x => x.meetingId === mid && x.userId === uid && !x.deleted);
    if (a) { a.role = role; save("meeting_attendees"); }
  },
  async setAttendeeOptional(mid: string, uid: string, optional: boolean) {
    const a = tbl("meeting_attendees").find(x => x.meetingId === mid && x.userId === uid && !x.deleted);
    if (a) { a.optional = !!optional; save("meeting_attendees"); }
  },
  // Free/busy from the meetings we already store (see the MySQL driver for the
  // overlap rule — half-open, so back-to-back meetings are not a conflict).
  async busyAmong(userIds: string[], from: string, to: string, excludeId?: string | null) {
    const ids = new Set(userIds || []);
    const out: any[] = [];
    const f = new Date(from).getTime();
    const t = new Date(to).getTime();
    for (const m of tbl("meetings")) {
      if (m.deleted || m.status === "cancelled") continue;
      if (excludeId && m.id === excludeId) continue;
      const s0 = new Date(m.startsAt).getTime();
      const e0 = s0 + (Number(m.durationMin) || 0) * 60000;
      if (!(s0 < t && e0 > f)) continue;
      for (const a of tbl("meeting_attendees")) {
        if (a.meetingId !== m.id || a.deleted || a.status === "declined") continue;
        if (!ids.has(a.userId)) continue;
        out.push({ userId: a.userId, meetingId: m.id, title: m.title, startsAt: m.startsAt, durationMin: Number(m.durationMin) || 0 });
      }
    }
    return out;
  },
  async getAttendeeRole(mid: string, uid: string) {
    const a = tbl("meeting_attendees").find(x => x.meetingId === mid && x.userId === uid && !x.deleted);
    return a ? a.role || "participant" : null;
  },
  async lobbyRequest(mid: string, uid: string) {
    const arr = tbl("meeting_lobby");
    const ex = arr.find(l => l.meetingId === mid && l.userId === uid);
    if (ex) { ex.status = "waiting"; ex.requestedAt = now(); ex.decidedAt = null; ex.decidedBy = null; }
    else arr.push({ meetingId: mid, userId: uid, status: "waiting", requestedAt: now(), decidedAt: null, decidedBy: null });
    save("meeting_lobby");
  },
  async lobbyAdmit(mid: string, uid: string, decidedBy: string) {
    const l = tbl("meeting_lobby").find(x => x.meetingId === mid && x.userId === uid);
    if (l) { l.status = "admitted"; l.decidedAt = now(); l.decidedBy = decidedBy; save("meeting_lobby"); }
  },
  async lobbyDeny(mid: string, uid: string, decidedBy: string) {
    const l = tbl("meeting_lobby").find(x => x.meetingId === mid && x.userId === uid);
    if (l) { l.status = "denied"; l.decidedAt = now(); l.decidedBy = decidedBy; save("meeting_lobby"); }
  },
  async lobbyAdmitAll(mid: string, decidedBy: string) {
    const arr = tbl("meeting_lobby");
    let n = 0;
    for (const l of arr)
      if (l.meetingId === mid && l.status === "waiting") {
        l.status = "admitted"; l.decidedAt = now(); l.decidedBy = decidedBy; n++;
      }
    if (n) save("meeting_lobby");
    return n;
  },
  async lobbyList(mid: string) {
    const users = tbl("users");
    return tbl("meeting_lobby")
      .filter(l => l.meetingId === mid)
      .sort((a, b) => String(a.requestedAt).localeCompare(String(b.requestedAt)))
      .map(l => {
        const u = users.find(x => x.id === l.userId);
        return { userId: l.userId, name: u ? u.name : null, email: u ? u.email : null, status: l.status, requestedAt: l.requestedAt };
      });
  },
  async lobbyStatus(mid: string, uid: string) {
    const l = tbl("meeting_lobby").find(x => x.meetingId === mid && x.userId === uid);
    return l ? l.status : null;
  },
  async meetingEject(mid: string, uid: string, ejectedBy: string) {
    const arr = tbl("meeting_ejected");
    const ex = arr.find(e => e.meetingId === mid && e.userId === uid);
    if (ex) { ex.ejectedAt = now(); ex.ejectedBy = ejectedBy; ex.deleted = false; ex.deletedAt = null; }
    else arr.push({ meetingId: mid, userId: uid, ejectedBy, ejectedAt: now(), deleted: false });
    save("meeting_ejected");
    // Drop their live presence too, or they still count as "already in" during
    // the few seconds the SFU takes to tear the session down.
    const pres = tbl("meeting_presence");
    let touched = false;
    for (const p of pres)
      if (p.meetingId === mid && p.userId === uid && !p.deleted) { p.deleted = true; p.deletedAt = now(); touched = true; }
    if (touched) save("meeting_presence");
  },
  async meetingEjectClear(mid: string, uid: string) {
    const e = tbl("meeting_ejected").find(x => x.meetingId === mid && x.userId === uid && !x.deleted);
    if (e) { e.deleted = true; e.deletedAt = now(); save("meeting_ejected"); }
  },
  async meetingEjectClearAll(mid: string) {
    const arr = tbl("meeting_ejected");
    let n = 0;
    for (const e of arr) if (e.meetingId === mid && !e.deleted) { e.deleted = true; e.deletedAt = now(); n++; }
    if (n) save("meeting_ejected");
    return n;
  },
  async meetingIsEjected(mid: string, uid: string) {
    return !!tbl("meeting_ejected").find(e => e.meetingId === mid && e.userId === uid && !e.deleted);
  },
  // Meeting reminders. The claim is what makes "fire exactly once" work across
  // instances in MySQL; here there is only one process, so recording the
  // occurrence is enough — but the RETURN CONTRACT must match (true = you won
  // the claim and should send).
  async withReminderLead(horizonDaysAhead = 366) {
    const from = Date.now() - 24 * 3600e3;
    const to = Date.now() + Math.max(1, Number(horizonDaysAhead) || 366) * 86400e3;
    return tbl("meetings")
      .filter(m => !m.deleted && m.status !== "cancelled" && !m.hardEnded &&
        m.reminderLeadMin != null && Number(m.reminderLeadMin) > 0)
      .filter(m => {
        const t = new Date(m.startsAt).getTime();
        return Number.isFinite(t) && t >= from && t <= to;
      })
      .map(m => ({
        ...mapMtg(m),
        attendees: tbl("meeting_attendees")
          .filter(a => a.meetingId === m.id && !a.deleted)
          .map(a => ({ userId: a.userId, status: a.status })),
      }));
  },
  async liveMeetings() {
    const cutoff = Date.now() - 90000;
    const live = new Set(
      tbl("meeting_presence")
        .filter(p => !p.deleted && new Date(p.lastSeen).getTime() > cutoff)
        .map(p => p.meetingId),
    );
    return tbl("meetings")
      .filter(m => live.has(m.id) && !m.deleted && m.status !== "cancelled" && !m.hardEnded)
      .map(mapMtg);
  },
  async claimEndWarning(mid: string, occurrenceStart: string, minutesBefore: number) {
    const arr = tbl("meeting_end_warnings_sent");
    if (arr.find(r => r.meetingId === mid && r.occurrenceStart === occurrenceStart && r.minutesBefore === minutesBefore))
      return false;
    arr.push({ meetingId: mid, occurrenceStart, minutesBefore, firedAt: now() });
    save("meeting_end_warnings_sent");
    return true;
  },
  async claimReminderOccurrence(mid: string, occurrenceKey: string) {
    const arr = tbl("meeting_reminders_sent");
    if (arr.find(r => r.meetingId === mid && r.occurrenceKey === occurrenceKey)) return false;
    arr.push({ meetingId: mid, occurrenceKey, sentAt: now() });
    save("meeting_reminders_sent");
    return true;
  },
  async setOptions(mid: string, patch: any = {}) {
    const m = tbl("meetings").find(x => x.id === mid);
    if (!m) return null;
    if (patch.lobbyPolicy !== undefined) {
      m.lobbyPolicy = String(patch.lobbyPolicy);
      m.lobbyEnabled = patch.lobbyPolicy !== "everyone";
    }
    for (const k of ["allowMic", "allowCamera", "allowChat", "allowReactions", "allowWhiteboard", "allowScreenShare", "hostAllowWhiteboard", "autoRecord"]) {
      if (patch[k] !== undefined) m[k] = !!patch[k];
    }
    save("meetings");
    return mapMtg(m);
  },
  async listUpcoming(withinMs?: number) {
    const from = new Date();
    const to = withinMs ? new Date(Date.now() + withinMs) : null;
    return tbl("meetings").filter(m => !m.deleted && new Date(m.startsAt) >= from && (!to || new Date(m.startsAt) <= to) && m.status === "scheduled" && m.reminderLeadMin != null).map(m => ({ ...mapMtg(m), attendees: tbl("meeting_attendees").filter(a => a.meetingId === m.id && !a.deleted).map(a => ({ userId: a.userId, status: a.status })) }));
  },
  async listRecurring() {
    return tbl("meetings").filter(m => !m.deleted && m.recurrence && m.recurrence !== "none").map(mapMtg);
  },
};

// ─── Invites ──────────────────────────────────────────────────────────────────
const mapInvite = (r: any) => r && ({ id: r.id, fromUserId: r.fromUserId, toUserId: r.toUserId, status: r.status, conversationId: r.conversationId || null, createdAt: r.createdAt, respondedAt: r.respondedAt || null, organizationId: r.organizationId || null });

const invites = {
  async create({ fromUserId, toUserId }: any) {
    const id = genId(); const orgId = currentOrgId();
    const row = { id, fromUserId, toUserId, status: "pending", conversationId: null, organizationId: orgId, deleted: false, createdAt: now(), respondedAt: null };
    tbl("invites").push(row); save("invites"); return mapInvite(row);
  },
  async getById(id: string) { return mapInvite(tbl("invites").find(x => x.id === id)); },
  async setStatus(id: string, status: string, conversationId?: string | null) {
    const arr = tbl("invites"); const inv = arr.find(x => x.id === id);
    if (inv) { inv.status = status; inv.respondedAt = now(); if (conversationId) inv.conversationId = conversationId; save("invites"); }
    return mapInvite(arr.find(x => x.id === id));
  },
  async listForUser(userId: string) {
    const orgId = currentOrgId();
    return tbl("invites").filter(i => (i.fromUserId === userId || i.toUserId === userId) && !i.deleted && (!orgId || !i.organizationId || i.organizationId === orgId)).sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()).map(mapInvite);
  },
  async findBetween(a: string, b: string) {
    const inv = tbl("invites").filter(i => ((i.fromUserId === a && i.toUserId === b) || (i.fromUserId === b && i.toUserId === a)) && !i.deleted).sort((x, y) => new Date(y.createdAt).getTime() - new Date(x.createdAt).getTime())[0];
    return inv ? mapInvite(inv) : null;
  },
  async isBlockedBy(sender: string, target: string) {
    return !!tbl("invites").find(i => i.fromUserId === sender && i.toUserId === target && i.status === "blocked" && !i.deleted);
  },
};

// ─── Folders ──────────────────────────────────────────────────────────────────
const folders = {
  async create({ userId, name, icon }: any) {
    const id = genId(); const orgId = currentOrgId();
    const row = { id, userId, name, icon: icon || "📁", organizationId: orgId, deleted: false, createdAt: now() };
    tbl("folders").push(row); save("folders"); return { id, userId, name, icon: row.icon };
  },
  async rename(fid: string, userId: string, name: string, icon: string) {
    const arr = tbl("folders"); const f = arr.find(x => x.id === fid && x.userId === userId && !x.deleted);
    if (f) { if (name != null) f.name = name; if (icon != null) f.icon = icon; save("folders"); }
    return f ? { id: f.id, userId: f.userId, name: f.name, icon: f.icon } : null;
  },
  async listForUser(userId: string) {
    const orgId = currentOrgId();
    return tbl("folders").filter(f => f.userId === userId && !f.deleted && (!orgId || !f.organizationId || f.organizationId === orgId)).sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime()).map(f => ({ id: f.id, userId: f.userId, name: f.name, icon: f.icon }));
  },
  async delete(fid: string, userId: string) {
    const arr = tbl("folders"); const f = arr.find(x => x.id === fid && x.userId === userId && !x.deleted);
    if (f) { f.deleted = true; f.deletedAt = now(); save("folders"); }
    const rems = tbl("reminders"); rems.forEach(r => { if (r.folderId === fid && r.userId === userId && !r.deleted) r.folderId = null; }); save("reminders");
  },
};

// ─── Reminders ────────────────────────────────────────────────────────────────
const mapReminder = (r: any) => r && ({
  id: r.id, userId: r.userId, text: r.text, dueAt: r.dueAt, folderId: r.folderId || null,
  done: !!r.done, createdAt: r.createdAt, recurrence: r.recurrence || "none",
  recurrenceRule: r.recurrenceRule || null, nextDueAt: r.nextDueAt || null,
  leadMin: r.leadMin == null ? null : Number(r.leadMin), organizationId: r.organizationId || null,
});

const reminders = {
  async create(r: any) {
    const id = genId(); const orgId = currentOrgId();
    const row = { id, userId: r.userId, text: r.text, dueAt: r.dueAt, folderId: r.folderId || null, done: false, createdAt: now(), recurrence: r.recurrence || "none", recurrenceRule: r.recurrenceRule || null, nextDueAt: r.nextDueAt || null, leadMin: r.leadMin == null ? null : Number(r.leadMin), organizationId: orgId, deleted: false };
    tbl("reminders").push(row); save("reminders"); return mapReminder(row);
  },
  async getById(id: string) { return mapReminder(tbl("reminders").find(r => r.id === id)); },
  async listForUser(userId: string, opts: any = {}) {
    const orgId = currentOrgId();
    let rows = tbl("reminders").filter(r => r.userId === userId && !r.deleted && (!orgId || !r.organizationId || r.organizationId === orgId));
    if (opts.folderId !== undefined) rows = rows.filter(r => r.folderId === opts.folderId);
    if (opts.done !== undefined) rows = rows.filter(r => !!r.done === opts.done);
    return rows.sort((a, b) => new Date(a.dueAt).getTime() - new Date(b.dueAt).getTime()).map(mapReminder);
  },
  async update(id: string, patch: any) {
    const arr = tbl("reminders"); const r = arr.find(x => x.id === id);
    if (r) { Object.assign(r, patch); save("reminders"); }
    return mapReminder(tbl("reminders").find(x => x.id === id));
  },
  async setDone(id: string, done: boolean) {
    const arr = tbl("reminders"); const r = arr.find(x => x.id === id);
    if (r) { r.done = done; save("reminders"); }
    return mapReminder(tbl("reminders").find(x => x.id === id));
  },
  async toggle(id: string, _userId?: string) {
    const arr = tbl("reminders"); const r = arr.find(x => x.id === id);
    if (r) { r.done = !r.done; save("reminders"); }
    return mapReminder(tbl("reminders").find(x => x.id === id));
  },
  async delete(id: string) {
    const arr = tbl("reminders"); const r = arr.find(x => x.id === id);
    if (r) { r.deleted = true; r.deletedAt = now(); save("reminders"); }
    return { id, deleted: true };
  },
  async listDue(asOf?: string) {
    const t = asOf ? new Date(asOf) : new Date();
    return tbl("reminders").filter(r => !r.deleted && !r.done && new Date(r.dueAt) <= t).map(mapReminder);
  },
  async claimDue(limit?: number) {
    const t = new Date().toISOString();
    const arr = tbl("reminders");
    const due = arr.filter(r => !r.deleted && !r.done && r.dueAt && r.dueAt <= t && !r.notifiedAt).slice(0, limit || 20);
    due.forEach(r => { r.notifiedAt = t; });
    if (due.length) save("reminders");
    return due.map(mapReminder);
  },
  async pruneOldOccurrences(cutoff: string) {
    const arr = tbl("reminders"); let count = 0;
    arr.forEach(r => { if (!r.deleted && r.done && r.recurrence !== "none" && r.dueAt && new Date(r.dueAt) < new Date(cutoff)) { r.deleted = true; r.deletedAt = now(); count++; } });
    if (count) save("reminders"); return count;
  },
};

// ─── Calls ───────────────────────────────────────────────────────────────────
const mapCall = (r: any) => r && ({ id: r.id, initiatorId: r.initiatorId, peerId: r.peerId || null, conversationId: r.conversationId || null, status: r.status, startedAt: r.startedAt || null, endedAt: r.endedAt || null, durationSec: r.durationSec || null, organizationId: r.organizationId || null });

const calls = {
  async create(c: any) {
    const id = c.id || genId(); const orgId = currentOrgId();
    const row = { id, initiatorId: c.initiatorId, peerId: c.peerId || null, conversationId: c.conversationId || null, status: c.status || "ringing", startedAt: c.startedAt || null, endedAt: null, durationSec: null, organizationId: orgId };
    tbl("calls").push(row); save("calls"); return mapCall(row);
  },
  async getById(id: string) { return mapCall(tbl("calls").find(c => c.id === id)); },
  async update(id: string, patch: any) {
    const arr = tbl("calls"); const c = arr.find(x => x.id === id);
    if (c) { Object.assign(c, patch); save("calls"); }
    return mapCall(tbl("calls").find(x => x.id === id));
  },
  async end(cid: string, { status = "ended", durationSec = 0 }: any = {}) {
    const arr = tbl("calls"); const c = arr.find(x => x.id === cid);
    if (c) { c.status = status; c.durationSec = durationSec; c.endedAt = now(); save("calls"); }
    return mapCall(c);
  },
  async listForUser(userId: string) {
    const orgId = currentOrgId();
    return tbl("calls").filter(c => (c.initiatorId === userId || c.peerId === userId) && (!orgId || !c.organizationId || c.organizationId === orgId)).sort((a, b) => new Date(b.startedAt || 0).getTime() - new Date(a.startedAt || 0).getTime()).slice(0, 50).map(mapCall);
  },
  async listActiveForUser(userId: string) {
    return tbl("calls").filter(c => (c.initiatorId === userId || c.peerId === userId) && ["ringing", "active", "connected"].includes(c.status)).map(mapCall);
  },
  async setStatus(cid: string, status: string, durationSec: number | null = null) {
    const c = tbl("calls").find(x => x.id === cid);
    if (c) { c.status = status; if (durationSec != null) c.durationSec = durationSec; save("calls"); }
    return mapCall(c);
  },
  async transitionIf(cid: string, { from, to, peerId = null, initiatorId = null, durationSec = null }: any) {
    const froms = Array.isArray(from) ? from : [from];
    const c = tbl("calls").find(x => x.id === cid);
    if (!c || !froms.includes(c.status)) return null;
    if (peerId && c.peerId !== peerId) return null;
    if (initiatorId && c.initiatorId !== initiatorId) return null;
    c.status = to; if (durationSec != null) c.durationSec = durationSec; save("calls");
    return mapCall(c);
  },
  async findStaleRinging(olderThanMs: number) {
    const cutoff = new Date(Date.now() - olderThanMs).toISOString();
    return tbl("calls").filter(c => c.status === "ringing" && c.startedAt && c.startedAt < cutoff).map(mapCall);
  },
};

// ─── Tasks ───────────────────────────────────────────────────────────────────
const mapTask = (r: any) => r && ({
  id: r.id, title: r.title, description: r.description || null, status: r.status || "todo",
  priority: r.priority || "medium", assigneeId: r.assigneeId || null, reporterId: r.reporterId || null,
  conversationId: r.conversationId || null, projectId: r.projectId || null,
  dueAt: r.dueAt || null, createdAt: r.createdAt, updatedAt: r.updatedAt || null,
  labels: r.labels || [], organizationId: r.organizationId || null,
  sortOrder: r.sortOrder || null, swimlane: r.swimlane || null,
  estimateMin: r.estimateMin || null, engScore: r.engScore || null,
});

const tasks = {
  async create(t: any) {
    const id = t.id || genId(); const orgId = currentOrgId();
    const row = { id, title: t.title, description: t.description || null, status: t.status || "todo", priority: t.priority || "medium", assigneeId: t.assigneeId || null, reporterId: t.reporterId || null, conversationId: t.conversationId || null, projectId: t.projectId || null, dueAt: t.dueAt || null, labels: t.labels || [], organizationId: orgId, deleted: false, createdAt: now(), updatedAt: now(), sortOrder: t.sortOrder || null, swimlane: t.swimlane || null, estimateMin: t.estimateMin || null, engScore: null };
    tbl("tasks").push(row); save("tasks");
    if (t.assigneeId) { tbl("task_assignees").push({ taskId: id, userId: t.assigneeId, assignedAt: now() }); save("task_assignees"); }
    return mapTask(row);
  },
  async getById(id: string) { return mapTask(tbl("tasks").find(t => t.id === id && !t.deleted)); },
  async update(id: string, patch: any) {
    const arr = tbl("tasks"); const t = arr.find(x => x.id === id);
    if (t) { Object.assign(t, patch, { updatedAt: now() }); save("tasks"); }
    return mapTask(tbl("tasks").find(x => x.id === id));
  },
  async delete(id: string, actorId?: string) {
    const arr = tbl("tasks"); const t = arr.find(x => x.id === id);
    if (t) { t.deleted = true; t.deletedAt = now(); t.deletedBy = actorId || null; save("tasks"); }
    return { id, deleted: true };
  },
  async listForConversation(convId: string, opts: any = {}) {
    const orgId = currentOrgId();
    let rows = tbl("tasks").filter(t => t.conversationId === convId && !t.deleted && (!orgId || !t.organizationId || t.organizationId === orgId));
    if (opts.status) rows = rows.filter(t => t.status === opts.status);
    return rows.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()).map(mapTask);
  },
  async listForUser(userId: string, opts: any = {}) {
    const orgId = currentOrgId();
    const assignedIds = new Set(tbl("task_assignees").filter(a => a.userId === userId).map(a => a.taskId));
    let rows = tbl("tasks").filter(t => !t.deleted && (t.assigneeId === userId || t.reporterId === userId || assignedIds.has(t.id)) && (!orgId || !t.organizationId || t.organizationId === orgId));
    if (opts.status) rows = rows.filter(t => t.status === opts.status);
    return rows.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()).map(mapTask);
  },
  async listForProject(projectId: string, opts: any = {}) {
    const orgId = currentOrgId();
    let rows = tbl("tasks").filter(t => t.projectId === projectId && !t.deleted && (!orgId || !t.organizationId || t.organizationId === orgId));
    if (opts.status) rows = rows.filter(t => t.status === opts.status);
    return rows.sort((a, b) => (a.sortOrder || 0) - (b.sortOrder || 0)).map(mapTask);
  },
  async listDue(asOf?: string) {
    const t = asOf ? new Date(asOf) : new Date();
    return tbl("tasks").filter(r => !r.deleted && r.dueAt && new Date(r.dueAt) <= t && r.status !== "done").map(mapTask);
  },
  async search(qry: string, userId: string, orgId?: string) {
    const q2 = (qry || "").toLowerCase();
    const assignedIds = new Set(tbl("task_assignees").filter(a => a.userId === userId).map(a => a.taskId));
    return tbl("tasks").filter(t => !t.deleted && (t.assigneeId === userId || assignedIds.has(t.id) || t.reporterId === userId) && (t.title?.toLowerCase().includes(q2) || t.description?.toLowerCase().includes(q2)) && (!orgId || !t.organizationId || t.organizationId === orgId)).slice(0, 20).map(mapTask);
  },
  async addAssignee(taskId: string, userId: string) {
    const arr = tbl("task_assignees"); const ex = arr.find(a => a.taskId === taskId && a.userId === userId);
    if (!ex) { arr.push({ taskId, userId, assignedAt: now() }); save("task_assignees"); }
  },
  async removeAssignee(taskId: string, userId: string) {
    const arr = tbl("task_assignees"); const idx = arr.findIndex(a => a.taskId === taskId && a.userId === userId);
    if (idx >= 0) { arr.splice(idx, 1); save("task_assignees"); }
  },
  async listAssignees(taskId: string) { return tbl("task_assignees").filter(a => a.taskId === taskId).map(a => a.userId); },
  async addWatcher(taskId: string, userId: string) {
    const arr = tbl("task_watchers"); if (!arr.find(w => w.taskId === taskId && w.userId === userId)) { arr.push({ taskId, userId }); save("task_watchers"); }
  },
  async removeWatcher(taskId: string, userId: string) {
    const arr = tbl("task_watchers"); const idx = arr.findIndex(w => w.taskId === taskId && w.userId === userId);
    if (idx >= 0) { arr.splice(idx, 1); save("task_watchers"); }
  },
  async listWatchers(taskId: string) { return tbl("task_watchers").filter(w => w.taskId === taskId).map(w => w.userId); },
  async addActivity(act: any) {
    const id = genId(); tbl("task_activity").push({ id, taskId: act.taskId, actorId: act.actorId, type: act.type, payload: act.payload || null, createdAt: now() }); save("task_activity"); return { id };
  },
  async listActivity(taskId: string) { return tbl("task_activity").filter(a => a.taskId === taskId).sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime()); },
  async setEngScore(taskId: string, score: number) {
    const arr = tbl("tasks"); const t = arr.find(x => x.id === taskId); if (t) { t.engScore = score; save("tasks"); }
  },
  async claimDueTasks(limit?: number) {
    const t = new Date().toISOString();
    const arr = tbl("tasks");
    const due = arr.filter(r => !r.deleted && r.status !== "done" && r.dueAt && r.dueAt <= t && !r.dueNotifiedAt).slice(0, limit || 20);
    due.forEach(r => { r.dueNotifiedAt = t; });
    if (due.length) save("tasks");
    return due.map(mapTask);
  },
};

// ─── Task Projects ────────────────────────────────────────────────────────────
const taskProjects = {
  async create(p: any) {
    const id = genId(); const orgId = currentOrgId();
    const row = { id, name: p.name, icon: p.icon || null, color: p.color || null, conversationId: p.conversationId || null, organizationId: orgId, deleted: false, createdAt: now() };
    tbl("task_projects").push(row); save("task_projects"); return row;
  },
  async getById(id: string) { return tbl("task_projects").find(p => p.id === id && !p.deleted) || null; },
  async list(opts: any = {}) {
    const orgId = currentOrgId();
    let rows = tbl("task_projects").filter(p => !p.deleted && (!orgId || !p.organizationId || p.organizationId === orgId));
    if (opts.conversationId) rows = rows.filter(p => p.conversationId === opts.conversationId);
    return rows;
  },
  async update(id: string, patch: any) {
    const arr = tbl("task_projects"); const p = arr.find(x => x.id === id);
    if (p) { Object.assign(p, patch); save("task_projects"); }
    return arr.find(x => x.id === id) || null;
  },
  async delete(id: string) {
    const arr = tbl("task_projects"); const p = arr.find(x => x.id === id);
    if (p) { p.deleted = true; p.deletedAt = now(); save("task_projects"); }
    return { id, deleted: true };
  },
  async listForUser(_ownerId?: string) {
    const orgId = currentOrgId();
    return tbl("task_projects").filter(p => !p.deleted && (!orgId || !p.organizationId || p.organizationId === orgId));
  },
};

// ─── Task Saved Views ─────────────────────────────────────────────────────────
const taskSavedViews = {
  async create(v: any) {
    const id = genId(); const orgId = currentOrgId();
    const row = { id, name: v.name, userId: v.userId, filters: v.filters || {}, organizationId: orgId, deleted: false, createdAt: now() };
    tbl("task_saved_views").push(row); save("task_saved_views"); return row;
  },
  async listForUser(userId: string) {
    const orgId = currentOrgId();
    return tbl("task_saved_views").filter(v => v.userId === userId && !v.deleted && (!orgId || !v.organizationId || v.organizationId === orgId));
  },
  async update(id: string, patch: any) {
    const arr = tbl("task_saved_views"); const v = arr.find(x => x.id === id);
    if (v) { Object.assign(v, patch); save("task_saved_views"); }
    return arr.find(x => x.id === id) || null;
  },
  async delete(id: string) {
    const arr = tbl("task_saved_views"); const v = arr.find(x => x.id === id);
    if (v) { v.deleted = true; v.deletedAt = now(); save("task_saved_views"); }
    return { id, deleted: true };
  },
};

// ─── Settings ─────────────────────────────────────────────────────────────────
const settings = {
  async get(userId: string) { return tbl("settings").find(s => s.userId === userId) || null; },
  async set(userId: string, patch: any) {
    const arr = tbl("settings"); const existing = arr.find(s => s.userId === userId);
    if (existing) { Object.assign(existing, patch); } else { arr.push({ userId, ...patch }); }
    save("settings"); return arr.find(s => s.userId === userId);
  },
};

// ─── Files ────────────────────────────────────────────────────────────────────
const mapFile = (r: any) => r && ({ id: r.id, conversationId: r.conversationId, uploaderId: r.uploaderId, name: r.name, mime: r.mime, size: Number(r.size) || 0, storageKey: r.storageKey || null, storageBackend: r.storageBackend || null, createdAt: r.createdAt, starred: !!r.starred, shareToken: r.shareToken || null, linkPermission: r.linkPermission || null, encryptionVersion: Number(r.encryptionVersion) || 0, ciphertextMeta: r.ciphertextMeta || null });

const files = {
  async create(f: any) {
    const id = f.id || genId(); const orgId = currentOrgId();
    const row = { id, conversationId: f.conversationId || null, uploaderId: f.uploaderId, name: f.name, mime: f.mime, size: f.size || 0, storageKey: f.storageKey || null, storageBackend: f.storageBackend || (f.storageKey ? "s3" : "db"), createdAt: now(), starred: false, shareToken: null, linkPermission: null, encryptionVersion: f.encryptionVersion || 0, ciphertextMeta: f.ciphertextMeta || null, organizationId: orgId, deleted: false };
    tbl("files").push(row); save("files"); return mapFile(row);
  },
  async getById(id: string) { return mapFile(tbl("files").find(f => f.id === id && !f.deleted)); },
  async getByToken(token: string) { return mapFile(tbl("files").find(f => f.shareToken === token && !f.deleted)); },
  async listForConversation(convId: string) {
    const orgId = currentOrgId();
    return tbl("files").filter(f => f.conversationId === convId && !f.deleted && (!orgId || !f.organizationId || f.organizationId === orgId)).sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()).map(mapFile);
  },
  async listForUser(uploaderId: string) {
    return tbl("files").filter(f => f.uploaderId === uploaderId && !f.deleted).sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()).map(mapFile);
  },
  async update(id: string, patch: any) {
    const arr = tbl("files"); const f = arr.find(x => x.id === id);
    if (f) { Object.assign(f, patch); save("files"); }
    return mapFile(tbl("files").find(x => x.id === id));
  },
  async delete(id: string, actorId?: string) {
    const arr = tbl("files"); const f = arr.find(x => x.id === id);
    if (f) { f.deleted = true; f.deletedAt = now(); f.deletedBy = actorId || null; save("files"); }
    return { id, deleted: true };
  },
  async search(qry: string, userId: string, opts: any = {}) {
    const q2 = (qry || "").toLowerCase();
    const myConvIds = new Set(tbl("conversation_members").filter(m => m.userId === userId && !m.deleted).map(m => m.conversationId));
    return tbl("files").filter(f => !f.deleted && myConvIds.has(f.conversationId) && f.name?.toLowerCase().includes(q2)).slice(0, 30).map(mapFile);
  },
  async listOrphans(olderThanMs: number) {
    const cutoff = new Date(Date.now() - olderThanMs).toISOString();
    return tbl("files").filter(f => !f.deleted && f.storageKey && !f.conversationId && f.createdAt < cutoff).map(mapFile);
  },
  // Cold-tier job helpers (0127) — mirror mysql.files.
  async listDiskTierCandidates(olderThanDays: number, batch = 200) {
    const cutoff = olderThanDays > 0 ? new Date(Date.now() - olderThanDays * 86400000).toISOString() : null;
    return tbl("files").filter(f => !f.deleted && f.storageBackend === "disk" && f.storageKey && (!cutoff || f.createdAt <= cutoff))
      .sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime()).slice(0, Math.max(1, Math.min(batch, 1000)))
      .map(f => ({ id: f.id, storageKey: f.storageKey, size: Number(f.size) || 0, createdAt: f.createdAt }));
  },
  async setStorageBackend(id: string, from: string, to: string) {
    const f = tbl("files").find(x => x.id === id && (x.storageBackend || (x.storageKey ? "s3" : "db")) === from);
    if (!f) return false;
    f.storageBackend = to; save("files"); return true;
  },
  async tierStats() {
    const out: Record<string, { count: number; bytes: number }> = {};
    for (const f of tbl("files")) { if (f.deleted) continue; const k = f.storageBackend || (f.storageKey ? "s3" : "db"); out[k] = out[k] || { count: 0, bytes: 0 }; out[k].count++; out[k].bytes += Number(f.size) || 0; }
    return out;
  },
};

// ─── File Shares ──────────────────────────────────────────────────────────────
const fileShares = {
  async create(s: any) {
    const id = genId(); const row = { id, subjectType: s.subjectType, subjectId: s.subjectId, token: s.token || genId(), permission: s.permission || "view", createdBy: s.createdBy, expiresAt: s.expiresAt || null, deleted: false, createdAt: now() };
    tbl("file_shares").push(row); save("file_shares"); return row;
  },
  async getByToken(token: string) { return tbl("file_shares").find(s => s.token === token && !s.deleted) || null; },
  async listForSubject(subjectType: string, subjectId: string) { return tbl("file_shares").filter(s => s.subjectType === subjectType && s.subjectId === subjectId && !s.deleted); },
  async delete(id: string) { const arr = tbl("file_shares"); const s = arr.find(x => x.id === id); if (s) { s.deleted = true; s.deletedAt = now(); save("file_shares"); } return { id, deleted: true }; },
};

// ─── Meeting Messages ─────────────────────────────────────────────────────────
const meetingMessages = {
  async create(m: any) {
    const id = genId(); const row = { id, meetingId: m.meetingId, senderId: m.senderId, body: m.body, type: m.type || "text", createdAt: now(), deleted: false };
    tbl("meeting_messages").push(row); save("meeting_messages"); return row;
  },
  async list(meetingId: string) { return tbl("meeting_messages").filter(m => m.meetingId === meetingId && !m.deleted).sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime()); },
  async delete(id: string) { const arr = tbl("meeting_messages"); const m = arr.find(x => x.id === id); if (m) { m.deleted = true; m.deletedAt = now(); save("meeting_messages"); } return { id, deleted: true }; },
};

// ─── Scheduled Messages ───────────────────────────────────────────────────────
const scheduledMessages = {
  async create(m: any) {
    const id = genId(); const row = { id, conversationId: m.conversationId, senderId: m.senderId, body: m.body, file: m.file || null, sendAt: m.sendAt, encryptionVersion: m.encryptionVersion || 0, ciphertext: m.ciphertext || null, deleted: false, createdAt: now() };
    tbl("scheduled_messages").push(row); save("scheduled_messages"); return row;
  },
  async getById(id: string) { return tbl("scheduled_messages").find(m => m.id === id && !m.deleted) || null; },
  async listDue(asOf?: string) {
    const t = (asOf ? new Date(asOf) : new Date()).toISOString();
    return tbl("scheduled_messages").filter(m => !m.deleted && m.sendAt <= t);
  },
  async claimDue(nowIso?: string, limit?: number) {
    const t = nowIso || new Date().toISOString();
    const arr = tbl("scheduled_messages");
    const due = arr.filter(m => !m.deleted && m.sendAt && m.sendAt <= t && !m.sentAt).slice(0, limit || 20);
    due.forEach(m => { m.sentAt = t; });
    if (due.length) save("scheduled_messages");
    return due.map(mapMsg);
  },
  async listForUser(userId: string) { return tbl("scheduled_messages").filter(m => m.senderId === userId && !m.deleted).sort((a, b) => new Date(a.sendAt).getTime() - new Date(b.sendAt).getTime()); },
  async delete(id: string) { const arr = tbl("scheduled_messages"); const m = arr.find(x => x.id === id); if (m) { m.deleted = true; m.deletedAt = now(); save("scheduled_messages"); } return { id, deleted: true }; },
  async update(id: string, patch: any) { const arr = tbl("scheduled_messages"); const m = arr.find(x => x.id === id); if (m) { Object.assign(m, patch); save("scheduled_messages"); } return arr.find(x => x.id === id) || null; },
};

// ─── Notifications ────────────────────────────────────────────────────────────
const notifications = {
  async create(n: any) {
    const id = genId(); const row = { id, userId: n.userId, type: n.type, actorId: n.actorId || null, entityType: n.entityType || null, entityId: n.entityId || null, body: n.body || null, read: false, createdAt: now(), organizationId: n.organizationId || null, deleted: false };
    tbl("notifications").push(row); save("notifications"); return row;
  },
  async listForUser(userId: string, opts: any = {}) {
    const orgId = currentOrgId();
    let rows = tbl("notifications").filter(n => n.userId === userId && !n.deleted && (!orgId || !n.organizationId || n.organizationId === orgId));
    if (opts.unreadOnly) rows = rows.filter(n => !n.read);
    return rows.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()).slice(0, opts.limit || 50);
  },
  async markRead(userId: string, ids?: string[]) {
    const arr = tbl("notifications");
    arr.forEach(n => { if (n.userId === userId && (!ids || ids.includes(n.id))) n.read = true; });
    save("notifications");
  },
  async delete(id: string) { const arr = tbl("notifications"); const n = arr.find(x => x.id === id); if (n) { n.deleted = true; save("notifications"); } },
  async countUnread(userId: string) { const orgId = currentOrgId(); return tbl("notifications").filter(n => n.userId === userId && !n.read && !n.deleted && (!orgId || !n.organizationId || n.organizationId === orgId)).length; },
};

// ─── Blocks ───────────────────────────────────────────────────────────────────
const blocks = {
  async create(blockerId: string, blockedId: string) {
    const arr = tbl("user_blocks"); const ex = arr.find(b => b.blockerId === blockerId && b.blockedId === blockedId && !b.deleted);
    if (!ex) { arr.push({ blockerId, blockedId, createdAt: now(), deleted: false }); save("user_blocks"); }
    return { blockerId, blockedId };
  },
  async remove(blockerId: string, blockedId: string) {
    const arr = tbl("user_blocks"); const b = arr.find(x => x.blockerId === blockerId && x.blockedId === blockedId && !x.deleted);
    if (b) { b.deleted = true; b.deletedAt = now(); save("user_blocks"); }
    return { blockerId, blockedId };
  },
  async isBlocked(a: string, b: string) { return !!tbl("user_blocks").find(x => !x.deleted && ((x.blockerId === a && x.blockedId === b) || (x.blockerId === b && x.blockedId === a))); },
  async listBlocked(userId: string) { return tbl("user_blocks").filter(b => b.blockerId === userId && !b.deleted).map(b => b.blockedId); },
  // The names the app actually calls. `create`/`remove`/`isBlocked` above are
  // the driver's older shape, kept so nothing that used them breaks.
  async block(blockerId: string, blockedId: string, reason?: string) {
    const arr = tbl("user_blocks");
    const ex = arr.find(b => b.blockerId === blockerId && b.blockedId === blockedId);
    if (ex) { ex.deleted = false; ex.deletedAt = null; ex.reason = reason || null; }
    else arr.push({ blockerId, blockedId, reason: reason || null, createdAt: now(), deleted: false });
    save("user_blocks");
    return { blockerId, blockedId };
  },
  async unblock(blockerId: string, blockedId: string) {
    const b = tbl("user_blocks").find(x => x.blockerId === blockerId && x.blockedId === blockedId && !x.deleted);
    if (b) { b.deleted = true; b.deletedAt = now(); save("user_blocks"); }
    return { blockerId, blockedId, removed: !!b };
  },
  // A block applies in BOTH directions: neither party can message the other.
  async isBlockedEitherWay(a: string, b: string) {
    return !!tbl("user_blocks").find(x => !x.deleted &&
      ((x.blockerId === a && x.blockedId === b) || (x.blockerId === b && x.blockedId === a)));
  },
  async report(reporterId: string, reportedId: string, reason?: string) {
    const id = genId();
    tbl("user_reports").push({ id, reporterId, reportedId, reason: (reason || "").slice(0, 512) || null, createdAt: now(), deleted: false });
    save("user_reports");
    return { id };
  },
  async listReports(reporterId: string) {
    return tbl("user_reports").filter(r => r.reporterId === reporterId && !r.deleted)
      .map(r => ({ id: r.id, userId: r.reportedId, reason: r.reason, createdAt: r.createdAt }));
  },
  async removeReport(reporterId: string, reportId: string) {
    const r = tbl("user_reports").find(x => x.id === reportId && x.reporterId === reporterId && !x.deleted);
    if (r) { r.deleted = true; r.deletedAt = now(); save("user_reports"); }
    return { id: reportId, removed: !!r };
  },
};

// ─── Sessions ─────────────────────────────────────────────────────────────────
const sessions = {
  async create(s: any) {
    const id = s.id || genId(); const row = { id, userId: s.userId, token: s.token, deviceId: s.deviceId || null, userAgent: s.userAgent || null, ip: s.ip || null, createdAt: now(), lastActiveAt: now(), expiresAt: s.expiresAt || null, revoked: false };
    tbl("sessions").push(row); save("sessions"); return row;
  },
  async getById(id: string) { return tbl("sessions").find(s => s.id === id && !s.revoked) || null; },
  async getByToken(token: string) { return tbl("sessions").find(s => s.token === token && !s.revoked) || null; },
  async listForUser(userId: string) { return tbl("sessions").filter(s => s.userId === userId && !s.revoked).sort((a, b) => new Date(b.lastActiveAt).getTime() - new Date(a.lastActiveAt).getTime()); },
  async touch(id: string) { const arr = tbl("sessions"); const s = arr.find(x => x.id === id); if (s) { s.lastActiveAt = now(); save("sessions"); } },
  async revoke(id: string) { const arr = tbl("sessions"); const s = arr.find(x => x.id === id); if (s) { s.revoked = true; s.revokedAt = now(); save("sessions"); } return { id, revoked: true }; },
  async revokeAll(userId: string, exceptId?: string) { const arr = tbl("sessions"); arr.forEach(s => { if (s.userId === userId && !s.revoked && s.id !== exceptId) { s.revoked = true; s.revokedAt = now(); } }); save("sessions"); },
  async getForAuth(id: string) {
    const s = tbl("sessions").find(x => x.id === id);
    return s ? { id: s.id, userId: s.userId, revoked: !!s.revoked, expiresAt: s.expiresAt, activeOrgId: s.activeOrgId || null } : null;
  },
  async listExpiredActive(limit = 500) {
    const t = new Date().toISOString();
    return tbl("sessions").filter(s => !s.revoked && s.expiresAt && s.expiresAt <= t).slice(0, limit).map(s => s.id);
  },
  async listIdleBeyondOrgPolicy(_limit = 500) {
    return [];
  },
  async revokeById(sessionId: string) {
    const arr = tbl("sessions"); const s = arr.find(x => x.id === sessionId);
    if (s) { s.revoked = true; s.revokedAt = now(); save("sessions"); }
    return { id: sessionId, revoked: true };
  },
  async sweepExpired() { const arr = tbl("sessions"); let count = 0; arr.forEach(s => { if (!s.revoked && s.expiresAt && new Date(s.expiresAt) < new Date()) { s.revoked = true; s.revokedAt = now(); count++; } }); if (count) save("sessions"); return count; },
};

// ─── Refresh Tokens ───────────────────────────────────────────────────────────
const refreshTokens = {
  async create(t: any) {
    const id = genId(); const row = { id, userId: t.userId, token: t.token, familyId: t.familyId || genId(), sessionId: t.sessionId || null, expiresAt: t.expiresAt, used: false, revoked: false, createdAt: now() };
    tbl("refresh_tokens").push(row); save("refresh_tokens"); return row;
  },
  async getByToken(token: string) { return tbl("refresh_tokens").find(t => t.token === token) || null; },
  async use(id: string) { const arr = tbl("refresh_tokens"); const t = arr.find(x => x.id === id); if (t) { t.used = true; t.usedAt = now(); save("refresh_tokens"); } },
  async revokeFamily(familyId: string) { const arr = tbl("refresh_tokens"); arr.forEach(t => { if (t.familyId === familyId) { t.revoked = true; } }); save("refresh_tokens"); },
  async revokeForUser(userId: string) { const arr = tbl("refresh_tokens"); arr.forEach(t => { if (t.userId === userId) t.revoked = true; }); save("refresh_tokens"); },
};

// ─── MFA ──────────────────────────────────────────────────────────────────────
const mfa = {
  async get(userId: string) { return tbl("mfa").find(m => m.userId === userId) || null; },
  async upsert(userId: string, data: any) {
    const arr = tbl("mfa"); const existing = arr.find(m => m.userId === userId);
    if (existing) { Object.assign(existing, data); } else { arr.push({ userId, ...data }); }
    save("mfa"); return arr.find(m => m.userId === userId);
  },
  async delete(userId: string) { const arr = tbl("mfa"); const idx = arr.findIndex(m => m.userId === userId); if (idx >= 0) { arr.splice(idx, 1); save("mfa"); } },
  async useBackupCode(userId: string, code: string) {
    const arr = tbl("mfa"); const m = arr.find(x => x.userId === userId);
    if (!m || !m.backupCodes) return false;
    const idx = m.backupCodes.indexOf(code); if (idx < 0) return false;
    m.backupCodes.splice(idx, 1); save("mfa"); return true;
  },
};

// ─── Stickers ─────────────────────────────────────────────────────────────────
const stickers = {
  async create(s: any) { const id = genId(); const row = { id, userId: s.userId, url: s.url, name: s.name || null, createdAt: now() }; tbl("stickers").push(row); save("stickers"); return row; },
  async list(userId: string) { return tbl("stickers").filter(s => s.userId === userId); },
  async delete(id: string, userId: string) { const arr = tbl("stickers"); const idx = arr.findIndex(s => s.id === id && s.userId === userId); if (idx >= 0) { arr.splice(idx, 1); save("stickers"); } return { id, deleted: true }; },
};

// ─── Call Feedback ────────────────────────────────────────────────────────────
const callFeedback = {
  async create(f: any) { const id = genId(); const row = { id, callId: f.callId, userId: f.userId, rating: f.rating, comment: f.comment || null, createdAt: now() }; tbl("call_feedback").push(row); save("call_feedback"); return row; },
  async getByCall(callId: string) { return tbl("call_feedback").filter(f => f.callId === callId); },
};

// ─── Telemetry ────────────────────────────────────────────────────────────────
const telemetry = {
  // §9.2 usage counters (aggregated per name+day; content-free).
  async bumpEvents(names: string[]) {
    const day = new Date().toISOString().slice(0, 10);
    const arr = tbl("telemetry_events");
    for (const name of names) {
      const ex = arr.find((r: any) => r.name === name && r.day === day);
      if (ex) ex.count = (ex.count || 0) + 1;
      else arr.push({ name, day, count: 1 });
    }
    save("telemetry_events");
  },
  async eventSummary(days = 7) {
    const cutoff = new Date(Date.now() - Math.max(1, Math.min(90, days)) * 86400000)
      .toISOString()
      .slice(0, 10);
    return tbl("telemetry_events")
      .filter((r: any) => r.day >= cutoff)
      .sort((a: any, b: any) => (a.day < b.day ? 1 : a.day > b.day ? -1 : a.name < b.name ? -1 : 1))
      .map((r: any) => ({ name: r.name, day: r.day, count: r.count || 0 }));
  },
  async record(event: any) { tbl("telemetry").push({ ...event, id: genId(), createdAt: now() }); save("telemetry"); },
  async recordClientError(err: any) { tbl("telemetry").push({ ...err, id: genId(), type: "client_error", createdAt: now() }); save("telemetry"); },
  async list(opts: any = {}) { return tbl("telemetry").slice(-(opts.limit || 100)); },
};

// ─── Recordings ───────────────────────────────────────────────────────────────
const mapRec = (r: any) => r && ({ id: r.id, meetingId: r.meetingId, startedBy: r.startedBy, startedAt: r.startedAt, endedAt: r.endedAt || null, status: r.status, storageKey: r.storageKey || null, playbackUrl: r.playbackUrl || null, egressId: r.egressId || null, durationSec: r.durationSec || null, sizeBytes: Number(r.sizeBytes) || 0, createdAt: r.createdAt });

const recordings = {
  async create(r: any) { const id = genId(); const row = { id, meetingId: r.meetingId, startedBy: r.startedBy, startedAt: now(), endedAt: null, status: r.status || "recording", storageKey: null, playbackUrl: null, egressId: r.egressId || null, durationSec: null, sizeBytes: 0, createdAt: now() }; tbl("recordings").push(row); save("recordings"); return mapRec(row); },
  async getById(id: string) { return mapRec(tbl("recordings").find(r => r.id === id)); },
  async update(id: string, patch: any) { const arr = tbl("recordings"); const r = arr.find(x => x.id === id); if (r) { Object.assign(r, patch); save("recordings"); } return mapRec(arr.find(x => x.id === id)); },
  async listForMeeting(meetingId: string) { return tbl("recordings").filter(r => r.meetingId === meetingId && !r.deleted).map(mapRec); },
  async purgeOlderThan(date: string) { const arr = tbl("recordings"); let count = 0; arr.forEach(r => { if (r.endedAt && new Date(r.endedAt) < new Date(date)) { r.deleted = true; count++; } }); if (count) save("recordings"); return count; },
};

// ─── Voicemails ───────────────────────────────────────────────────────────────
const mapVm = (r: any) => r && ({ id: r.id, callId: r.callId, fromUser: r.fromUser, toUser: r.toUser, fileId: r.fileId, durationSec: r.durationSec, listened: r.listened, createdAt: r.createdAt });

const voicemails = {
  async create(v: any) { const id = genId(); const row = { id, callId: v.callId, fromUser: v.fromUser, toUser: v.toUser, fileId: v.fileId, durationSec: v.durationSec || null, listened: false, createdAt: now() }; tbl("voicemails").push(row); save("voicemails"); return mapVm(row); },
  async getById(id: string) { return mapVm(tbl("voicemails").find(v => v.id === id)); },
  async listForUser(userId: string) { return tbl("voicemails").filter(v => v.toUser === userId).sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()).map(mapVm); },
  async setListened(id: string) { const arr = tbl("voicemails"); const v = arr.find(x => x.id === id); if (v) { v.listened = true; save("voicemails"); } return mapVm(v); },
};

// ─── Concerns (User Reports) ──────────────────────────────────────────────────
const concerns = {
  async create(c: any) { const id = genId(); const row = { id, reporterId: c.reporterId, reportedId: c.reportedId, reason: c.reason, detail: c.detail || null, status: "open", createdAt: now(), organizationId: c.organizationId || null }; tbl("user_reports").push(row); save("user_reports"); return row; },
  async list(opts: any = {}) { let rows = tbl("user_reports"); if (opts.status) rows = rows.filter(r => r.status === opts.status); return rows.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()); },
  async update(id: string, patch: any) { const arr = tbl("user_reports"); const r = arr.find(x => x.id === id); if (r) { Object.assign(r, patch); save("user_reports"); } return arr.find(x => x.id === id) || null; },
};

// ─── Error Logs ───────────────────────────────────────────────────────────────
const errorLogs = {
  async record(e: any) { tbl("error_logs").push({ id: genId(), ...e, createdAt: now() }); save("error_logs"); },
  async list(opts: any = {}) { let rows = tbl("error_logs"); if (opts.severity) rows = rows.filter(r => r.severity === opts.severity); return rows.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()).slice(0, opts.limit || 100); },
};

// ─── Audit ────────────────────────────────────────────────────────────────────
const audit = {
  async record(entry: any) { tbl("audit_log").push({ id: genId(), ...entry, createdAt: now() }); save("audit_log"); },
  async list(opts: any = {}) { return tbl("audit_log").sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()).slice(0, opts.limit || 100); },
};

// ─── Whiteboards ─────────────────────────────────────────────────────────────
const whiteboards = {
  async get(boardKey: string) { return tbl("whiteboards").find(w => w.boardKey === boardKey) || null; },
  async upsert(boardKey: string, json: string, updatedBy?: string) {
    const arr = tbl("whiteboards"); const existing = arr.find(w => w.boardKey === boardKey);
    if (existing) { existing.data = json; existing.updatedBy = updatedBy || null; existing.updatedAt = now(); }
    else { arr.push({ boardKey, data: json, updatedBy: updatedBy || null, createdAt: now(), updatedAt: now() }); }
    save("whiteboards"); return { boardKey };
  },
  async remove(boardKey: string) { const arr = tbl("whiteboards"); const idx = arr.findIndex(w => w.boardKey === boardKey); if (idx >= 0) { arr.splice(idx, 1); save("whiteboards"); } return { boardKey }; },
};

// ─── E2EE ────────────────────────────────────────────────────────────────────
const e2ee = {
  async getDevice(userId: string, deviceId: string) { return tbl("e2ee_devices").find(d => d.userId === userId && d.deviceId === deviceId && !d.revoked) || null; },
  async upsertDevice(d: any) {
    const arr = tbl("e2ee_devices"); const existing = arr.find(x => x.userId === d.userId && x.deviceId === d.deviceId);
    if (existing) { Object.assign(existing, d); } else { arr.push({ ...d, revoked: false, createdAt: now() }); }
    save("e2ee_devices"); return arr.find(x => x.userId === d.userId && x.deviceId === d.deviceId);
  },
  async listDevices(userId: string) { return tbl("e2ee_devices").filter(d => d.userId === userId && !d.revoked); },
  async revokeDevice(userId: string, deviceId: string) { const arr = tbl("e2ee_devices"); const d = arr.find(x => x.userId === userId && x.deviceId === deviceId); if (d) { d.revoked = true; d.revokedAt = now(); save("e2ee_devices"); } return { userId, deviceId, revoked: true }; },
  async revokeAllDevices(userId: string) { const arr = tbl("e2ee_devices"); arr.forEach(d => { if (d.userId === userId && !d.revoked) { d.revoked = true; d.revokedAt = now(); } }); save("e2ee_devices"); },
  async getEpoch(convId: string, epoch: number) { return tbl("e2ee_epochs").find(e => e.conversationId === convId && e.epoch === epoch) || null; },
  async upsertEpoch(data: any) {
    const arr = tbl("e2ee_epochs"); const existing = arr.find(e => e.conversationId === data.conversationId && e.epoch === data.epoch);
    if (existing) { Object.assign(existing, data); } else { arr.push({ ...data, createdAt: now() }); }
    save("e2ee_epochs"); return arr.find(e => e.conversationId === data.conversationId && e.epoch === data.epoch);
  },
  async listEpochs(convId: string) { return tbl("e2ee_epochs").filter(e => e.conversationId === convId).sort((a, b) => b.epoch - a.epoch); },
  async addEnvelope(env: any) { const id = genId(); const row = { id, ...env, delivered: false, createdAt: now() }; tbl("e2ee_envelopes").push(row); save("e2ee_envelopes"); return row; },
  async listEnvelopes(userId: string, deviceId: string) { return tbl("e2ee_envelopes").filter(e => e.recipientId === userId && e.deviceId === deviceId && !e.delivered); },
  async markEnvelopeDelivered(id: string) { const arr = tbl("e2ee_envelopes"); const e = arr.find(x => x.id === id); if (e) { e.delivered = true; e.deliveredAt = now(); save("e2ee_envelopes"); } },
};

// ─── Orgs ─────────────────────────────────────────────────────────────────────
const mapOrg = (r: any) => r && ({ id: r.id, name: r.name, slug: r.slug, logoUrl: r.logoUrl || null, status: r.status || "active", plan: r.plan || "free", createdAt: r.createdAt, settings: r.settings || {} });
const mapMember = (r: any) => r && ({ userId: r.userId, organizationId: r.organizationId, role: r.role, status: r.status, teamId: r.teamId || null, joinedAt: r.joinedAt || null, invitedBy: r.invitedBy || null });

const orgs = {
  async getById(id: string) { return mapOrg(tbl("orgs").find(o => o.id === id && !o.deleted)); },
  async getBySlug(slug: string) { return mapOrg(tbl("orgs").find(o => o.slug === slug && !o.deleted)); },
  async list() { return tbl("orgs").filter(o => !o.deleted && o.status === "active").map(mapOrg); },
  async create(data: any) {
    const id = data.id || genId(); const row = { id, name: data.name, slug: data.slug, logoUrl: data.logoUrl || null, status: "active", plan: data.plan || "free", settings: data.settings || {}, deleted: false, createdAt: now() };
    tbl("orgs").push(row); save("orgs"); return mapOrg(row);
  },
  async update(id: string, patch: any) { const arr = tbl("orgs"); const o = arr.find(x => x.id === id); if (o) { Object.assign(o, patch); save("orgs"); } return mapOrg(arr.find(x => x.id === id)); },
  async delete(id: string) { const arr = tbl("orgs"); const o = arr.find(x => x.id === id); if (o) { o.deleted = true; o.deletedAt = now(); save("orgs"); } return { id, deleted: true }; },
  async membership(userId: string, orgId: string) { return mapMember(tbl("org_members").find(m => m.userId === userId && m.organizationId === orgId && !m.deleted)); },
  async members(orgId: string) { return tbl("org_members").filter(m => m.organizationId === orgId && !m.deleted).map(mapMember); },
  async listMembers(orgId: string, opts: any = {}) {
    let rows = tbl("org_members").filter(m => m.organizationId === orgId && !m.deleted);
    if (opts.status) rows = rows.filter(m => m.status === opts.status);
    return rows.map(mapMember);
  },
  async addMember(orgId: string, userId: string, role = "member", invitedBy?: string) {
    const arr = tbl("org_members"); const ex = arr.find(m => m.organizationId === orgId && m.userId === userId);
    if (ex) { ex.deleted = false; ex.role = role; ex.status = "active"; } else { arr.push({ organizationId: orgId, userId, role, status: "active", teamId: null, joinedAt: now(), invitedBy: invitedBy || null, deleted: false }); }
    save("org_members"); return mapMember(arr.find(m => m.organizationId === orgId && m.userId === userId));
  },
  async updateMember(orgId: string, userId: string, patch: any) {
    const arr = tbl("org_members"); const m = arr.find(x => x.organizationId === orgId && x.userId === userId);
    if (m) { Object.assign(m, patch); save("org_members"); }
    return mapMember(arr.find(x => x.organizationId === orgId && x.userId === userId));
  },
  async removeMember(orgId: string, userId: string, actorId?: string) {
    const arr = tbl("org_members"); const m = arr.find(x => x.organizationId === orgId && x.userId === userId && !x.deleted);
    if (m) { m.deleted = true; m.deletedAt = now(); m.deletedBy = actorId || null; save("org_members"); }
    return { organizationId: orgId, userId, removed: true };
  },
  async inviteCode(orgId: string) { return tbl("orgs").find(o => o.id === orgId)?.inviteCode || null; },
  async listPendingInvites(orgId: string) { return tbl("org_members").filter(m => m.organizationId === orgId && m.status === "pending" && !m.deleted).map(mapMember); },
  async broadcast(id: string) { return tbl("org_broadcasts").find(b => b.id === id && !b.deleted) || null; },
  async listBroadcasts(orgId: string, opts: any = {}) { let rows = tbl("org_broadcasts").filter(b => b.organizationId === orgId && !b.deleted); if (opts.status) rows = rows.filter(b => b.status === opts.status); return rows.sort((a, b) => new Date(b.createdAt || 0).getTime() - new Date(a.createdAt || 0).getTime()); },
  async createBroadcast(data: any) { const id = genId(); const row = { id, ...data, status: data.status || "draft", deleted: false, createdAt: now() }; tbl("org_broadcasts").push(row); save("org_broadcasts"); return row; },
  async claimDueBroadcasts(limit = 20) {
    const arr = tbl("org_broadcasts"); const t = new Date().toISOString();
    const due = arr.filter(b => !b.deleted && b.status === "scheduled" && b.sendAt && b.sendAt <= t).slice(0, limit);
    due.forEach(b => { b.status = "sending"; }); if (due.length) save("org_broadcasts"); return due;
  },
  async setBroadcastStatus(id: string, status: string) { const arr = tbl("org_broadcasts"); const b = arr.find(x => x.id === id); if (b) { b.status = status; save("org_broadcasts"); } return arr.find(x => x.id === id) || null; },
  async deleteBroadcast(id: string, orgId: string) { const arr = tbl("org_broadcasts"); const b = arr.find(x => x.id === id && x.organizationId === orgId && !x.deleted && x.status !== "sending"); if (b) { b.deleted = true; save("org_broadcasts"); return { id, deleted: true }; } return { id, deleted: false }; },
  async updateBroadcast(id: string, orgId: string, patch: any = {}) { const arr = tbl("org_broadcasts"); const b = arr.find(x => x.id === id && x.organizationId === orgId && !x.deleted && x.status !== "sending"); if (b) { Object.assign(b, patch); save("org_broadcasts"); } return arr.find(x => x.id === id) || null; },
  async teams(orgId: string) { return tbl("teams").filter(t => t.organizationId === orgId && !t.deleted).map(t => ({ id: t.id, name: t.name, parentTeamId: t.parentTeamId || null, depth: Number(t.depth) || 0, memberCount: tbl("team_members").filter(m => m.teamId === t.id && !m.deleted).length })); },
  async teamInOrg(orgId: string, teamId: string) { return !!tbl("teams").find(t => t.id === teamId && t.organizationId === orgId && !t.deleted); },
  async createTeam(orgId: string, name: string, parentTeamId?: string | null) {
    const clean = String(name || "").trim(); if (!clean) return { error: "NAME_REQUIRED" };
    let depth = 0; let path = "/" + clean;
    if (parentTeamId) { const p = tbl("teams").find(t => t.id === parentTeamId && t.organizationId === orgId && !t.deleted); if (!p) return { error: "PARENT_NOT_FOUND" }; depth = (Number(p.depth) || 0) + 1; if (depth > 5) return { error: "TOO_DEEP" }; path = (p.path || "") + "/" + clean; }
    const dup = tbl("teams").find(t => t.organizationId === orgId && t.parentTeamId === (parentTeamId || null) && t.name === clean && !t.deleted);
    if (dup) return { error: "DUPLICATE" };
    const id = genId(); tbl("teams").push({ id, organizationId: orgId, parentTeamId: parentTeamId || null, name: clean, path, depth, deleted: false }); save("teams");
    return { team: { id, name: clean, parentTeamId: parentTeamId || null, depth, memberCount: 0 } };
  },
  async setMemberTeam(orgId: string, userId: string, teamId: string) {
    const arr = tbl("org_members"); const m = arr.find(x => x.organizationId === orgId && x.userId === userId && !x.deleted);
    if (m) { m.teamId = teamId || null; save("org_members"); }
    if (teamId) { const tmArr = tbl("team_members"); const ex = tmArr.find(x => x.teamId === teamId && x.userId === userId); if (ex) { ex.deleted = false; } else { tmArr.push({ teamId, userId, deleted: false }); } save("team_members"); }
    return this.membership(userId, orgId);
  },
  async setTeamMembership(orgId: string, userId: string, teamId: string, join: boolean) {
    if (!(await this.teamInOrg(orgId, teamId))) return this.membership(userId, orgId);
    const tmArr = tbl("team_members");
    if (join) { const ex = tmArr.find(x => x.teamId === teamId && x.userId === userId); if (ex) { ex.deleted = false; } else { tmArr.push({ teamId, userId, deleted: false }); } save("team_members"); const omArr = tbl("org_members"); const m = omArr.find(x => x.organizationId === orgId && x.userId === userId && !x.deleted); if (m) { m.teamId = teamId; save("org_members"); } }
    else { tmArr.forEach(x => { if (x.teamId === teamId && x.userId === userId && !x.deleted) { x.deleted = true; x.deletedAt = now(); } }); save("team_members"); const omArr = tbl("org_members"); const m = omArr.find(x => x.organizationId === orgId && x.userId === userId && !x.deleted); if (m && m.teamId === teamId) { m.teamId = null; save("org_members"); } }
    return this.membership(userId, orgId);
  },
  async memberTeamIds(orgId: string, userId: string) {
    const teamIds = new Set(tbl("teams").filter(t => t.organizationId === orgId && !t.deleted).map(t => t.id));
    return tbl("team_members").filter(m => m.userId === userId && !m.deleted && teamIds.has(m.teamId)).map(m => m.teamId);
  },
  async defaultOrg() {
    const slug = (process.env.SSO_DEFAULT_ORG_SLUG || "").trim();
    if (slug) return this.getBySlug(slug);
    const active = tbl("orgs").filter(o => !o.deleted && o.status === "active");
    return active.length === 1 ? mapOrg(active[0]) : null;
  },
  async orgsSolelyOwnedBy(userId: string) { return users.orgsSolelyOwnedBy(userId); },
};

// ─── Push Subscriptions ───────────────────────────────────────────────────────
const pushSubscriptions = {
  async upsert(userId: string, sub: { endpoint: string; p256dh: string; auth: string }, userAgent?: string) {
    const arr = tbl("push_subscriptions"); const existing = arr.find(s => s.endpoint === sub.endpoint && !s.deleted);
    if (existing) { existing.userId = userId; existing.p256dh = sub.p256dh; existing.auth = sub.auth; existing.userAgent = userAgent || null; existing.lastUsedAt = now(); save("push_subscriptions"); return existing.id; }
    const id = genId(); arr.push({ id, userId, endpoint: sub.endpoint, p256dh: sub.p256dh, auth: sub.auth, userAgent: userAgent || null, lastUsedAt: now(), deleted: false, createdAt: now() }); save("push_subscriptions"); return id;
  },
  async removeByEndpoint(endpoint: string) { const arr = tbl("push_subscriptions"); const s = arr.find(x => x.endpoint === endpoint && !x.deleted); if (s) { s.deleted = true; s.deletedAt = now(); save("push_subscriptions"); } },
  async removeForUser(userId: string) { const arr = tbl("push_subscriptions"); arr.forEach(s => { if (s.userId === userId && !s.deleted) { s.deleted = true; s.deletedAt = now(); } }); save("push_subscriptions"); },
  async listForUser(userId: string) { return tbl("push_subscriptions").filter(s => s.userId === userId && !s.deleted).sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()); },
  async listForUsers(userIds: string[]) { const s = new Set(userIds); return tbl("push_subscriptions").filter(x => s.has(x.userId) && !x.deleted); },
};

// ─── Mobile push devices (FCM / APNs) + click ledger (0124) ─────────────────
const mapPushDevice = (r: any) =>
  r && {
    id: r.id, userId: r.userId, platform: r.platform, token: r.token,
    voipToken: r.voipToken || null, deviceId: r.deviceId || null,
    appVersion: r.appVersion || null, sessionJti: r.sessionJti || null, userAgent: r.userAgent || null,
    createdAt: r.createdAt, lastSeenAt: r.lastSeenAt,
  };
const pushDevices = {
  async upsert(userId: string, dev: { platform: string; token: string; voipToken?: string | null; deviceId?: string | null; appVersion?: string | null; sessionJti?: string | null }, userAgent?: string) {
    const arr = tbl("push_devices"); const existing = arr.find(d => d.token === dev.token);
    if (existing) {
      existing.userId = userId; existing.platform = dev.platform;
      if (dev.voipToken !== undefined) existing.voipToken = dev.voipToken;
      if (dev.sessionJti !== undefined) existing.sessionJti = dev.sessionJti;
      existing.deviceId = dev.deviceId || null; existing.appVersion = dev.appVersion || null;
      existing.userAgent = userAgent || null; existing.lastSeenAt = now(); existing.deleted = false; existing.deletedAt = null;
      save("push_devices"); return existing.id;
    }
    const id = genId();
    arr.push({ id, userId, platform: dev.platform, token: dev.token, voipToken: dev.voipToken || null, deviceId: dev.deviceId || null, appVersion: dev.appVersion || null, sessionJti: dev.sessionJti || null, userAgent: userAgent || null, createdAt: now(), lastSeenAt: now(), deleted: false });
    save("push_devices"); return id;
  },
  async removeBySession(sessionJti: string) { if (!sessionJti) return 0; let n = 0; tbl("push_devices").forEach(d => { if (d.sessionJti === sessionJti && !d.deleted) { d.deleted = true; d.deletedAt = now(); n++; } }); if (n) save("push_devices"); return n; },
  async sweepStale(days = 60) { const cutoff = Date.now() - Math.max(1, Number(days) || 60) * 86400_000; let n = 0; tbl("push_devices").forEach(d => { if (!d.deleted && new Date(d.lastSeenAt).getTime() < cutoff) { d.deleted = true; d.deletedAt = now(); n++; } }); if (n) save("push_devices"); return n; },
  async removeByToken(token: string) { const d = tbl("push_devices").find(x => x.token === token && !x.deleted); if (d) { d.deleted = true; d.deletedAt = now(); save("push_devices"); } },
  async removeByVoipToken(voipToken: string) { let hit = false; tbl("push_devices").forEach(d => { if (d.voipToken === voipToken) { d.voipToken = null; hit = true; } }); if (hit) save("push_devices"); },
  async removeForUser(userId: string) { tbl("push_devices").forEach(d => { if (d.userId === userId && !d.deleted) { d.deleted = true; d.deletedAt = now(); } }); save("push_devices"); },
  async listForUser(userId: string) { return tbl("push_devices").filter(d => d.userId === userId && !d.deleted).sort((a, b) => new Date(b.lastSeenAt).getTime() - new Date(a.lastSeenAt).getTime()).map(mapPushDevice); },
  async listForUsers(userIds: string[]) { const s = new Set(userIds); return tbl("push_devices").filter(d => s.has(d.userId) && !d.deleted).map(mapPushDevice); },
};
const pushClickEvents = {
  async record(userId: string, ev: any) {
    const arr = tbl("push_click_events");
    if (arr.some(e => e.eventId === ev.eventId)) return false;
    arr.push({ id: genId(), eventId: ev.eventId, userId, platform: ev.platform || null, source: ev.source || null, appState: ev.appState || null, action: ev.action || null, notificationType: ev.notificationType || null, tag: ev.tag || null, conversationId: ev.conversationId || null, targetType: ev.targetType || null, targetId: ev.targetId || null, clickedAt: ev.clickedAt || null, createdAt: now() });
    save("push_click_events"); return true;
  },
  async listForUser(userId: string, limit = 50) { return tbl("push_click_events").filter(e => e.userId === userId).sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()).slice(0, Math.min(Math.max(Number(limit) || 50, 1), 500)); },
};

// ─── Factory ─────────────────────────────────────────────────────────────────
// ─── Chat webhooks (incoming + outgoing) ─────────────────────────────────────
// Same surface as the MySQL repo (drivers/mysql.ts) so webhookService is driver
// agnostic. Single-process by construction here, so the "atomic claim" is just a
// synchronous filter — there is no second replica to race with.
const mapWebhook = (r: any) =>
  r && {
    id: r.id, direction: r.direction, name: r.name,
    conversationId: r.conversationId, ownerId: r.ownerId,
    tokenHint: r.tokenHint || null, targetUrl: r.targetUrl || null,
    secret: r.secret || null,
    events: Array.isArray(r.events) ? r.events : String(r.events || "").split(",").filter(Boolean),
    enabled: !!r.enabled, lastStatus: r.lastStatus || null,
    lastDeliveryAt: r.lastDeliveryAt || null,
    failureCount: Number(r.failureCount || 0), createdAt: r.createdAt,
  };

const webhooks = {
  async create(w: any) {
    const row = {
      id: genId(), organizationId: currentOrgId() || null,
      direction: w.direction, name: w.name,
      conversationId: w.conversationId, ownerId: w.ownerId,
      tokenHash: w.tokenHash || null, tokenHint: w.tokenHint || null,
      targetUrl: w.targetUrl || null, secret: w.secret || null,
      events: w.events && w.events.length ? w.events : ["message.created"],
      enabled: true, lastStatus: null, lastDeliveryAt: null, failureCount: 0,
      createdAt: now(), deleted: false,
    };
    tbl("chat_webhooks").push(row); save("chat_webhooks");
    return mapWebhook(row);
  },
  async getById(id: string) {
    return mapWebhook(tbl("chat_webhooks").find(w => w.id === id && !w.deleted));
  },
  async getByTokenHash(tokenHash: string) {
    return mapWebhook(tbl("chat_webhooks").find(w => w.tokenHash === tokenHash && w.direction === "in" && !w.deleted));
  },
  async listForConversation(conversationId: string) {
    return tbl("chat_webhooks").filter(w => w.conversationId === conversationId && !w.deleted)
      .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt))).map(mapWebhook);
  },
  async listForOwner(ownerId: string) {
    return tbl("chat_webhooks").filter(w => w.ownerId === ownerId && !w.deleted)
      .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt))).map(mapWebhook);
  },
  async listOutgoingFor(conversationId: string, event: string) {
    return tbl("chat_webhooks")
      .filter(w => w.conversationId === conversationId && w.direction === "out" && w.enabled && !w.deleted)
      .filter(w => (w.events || []).includes(event)).map(mapWebhook);
  },
  async update(id: string, patch: any) {
    const w = tbl("chat_webhooks").find(x => x.id === id && !x.deleted);
    if (w) {
      if (patch.name !== undefined) w.name = patch.name;
      if (patch.enabled !== undefined) w.enabled = !!patch.enabled;
      if (patch.events !== undefined) w.events = patch.events;
      save("chat_webhooks");
    }
    return mapWebhook(w);
  },
  async rotate(id: string, cred: any) {
    const w = tbl("chat_webhooks").find(x => x.id === id && !x.deleted);
    if (w) {
      if (cred.tokenHash) { w.tokenHash = cred.tokenHash; w.tokenHint = cred.tokenHint || null; }
      if (cred.secret) w.secret = cred.secret;
      save("chat_webhooks");
    }
    return mapWebhook(w);
  },
  async remove(id: string) {
    const w = tbl("chat_webhooks").find(x => x.id === id && !x.deleted);
    if (w) { w.deleted = true; w.deletedAt = now(); save("chat_webhooks"); }
    return { id, removed: !!w };
  },
  async markHealth(id: string, status: string, failed: boolean) {
    const w = tbl("chat_webhooks").find(x => x.id === id);
    if (w) {
      w.lastStatus = String(status).slice(0, 32);
      w.lastDeliveryAt = now();
      w.failureCount = failed ? Number(w.failureCount || 0) + 1 : 0;
      save("chat_webhooks");
    }
  },
  async enqueue(webhookId: string, event: string, payload: string) {
    const id = genId();
    tbl("chat_webhook_deliveries").push({
      id, webhookId, event, payload, status: "pending", claimToken: null,
      attempts: 0, responseCode: null, error: null,
      nextAttemptAt: now(), createdAt: now(), deliveredAt: null,
    });
    save("chat_webhook_deliveries");
    return id;
  },
  async claimDue(limit = 25) {
    const t = now();
    const due = tbl("chat_webhook_deliveries")
      .filter(d => d.status === "pending" && String(d.nextAttemptAt) <= t)
      .sort((a, b) => String(a.nextAttemptAt).localeCompare(String(b.nextAttemptAt)))
      .slice(0, Math.max(1, Math.min(200, limit)));
    if (!due.length) return [];
    for (const d of due) d.status = "sending";
    save("chat_webhook_deliveries");
    const hooks = tbl("chat_webhooks");
    return due.map(d => {
      const w = hooks.find(h => h.id === d.webhookId);
      return {
        id: d.id, webhookId: d.webhookId, event: d.event, payload: d.payload,
        attempts: Number(d.attempts || 0),
        targetUrl: w ? w.targetUrl : null, secret: w ? w.secret : null,
        hookLive: !!(w && w.enabled && !w.deleted),
      };
    });
  },
  async markDelivered(id: string, responseCode: number) {
    const d = tbl("chat_webhook_deliveries").find(x => x.id === id);
    if (d) {
      d.status = "delivered"; d.attempts = Number(d.attempts || 0) + 1;
      d.responseCode = responseCode; d.error = null; d.claimToken = null;
      d.deliveredAt = now();
      save("chat_webhook_deliveries");
    }
  },
  async markFailed(id: string, responseCode: number | null, error: string, retryInSec: number | null) {
    const d = tbl("chat_webhook_deliveries").find(x => x.id === id);
    if (!d) return;
    d.attempts = Number(d.attempts || 0) + 1;
    d.responseCode = responseCode;
    d.error = String(error || "").slice(0, 512);
    d.claimToken = null;
    if (retryInSec == null) {
      d.status = "failed";
    } else {
      d.status = "pending";
      d.nextAttemptAt = new Date(Date.now() + Math.max(1, Math.round(retryInSec)) * 1000).toISOString();
    }
    save("chat_webhook_deliveries");
  },
  async listDeliveries(webhookId: string, limit = 25) {
    return tbl("chat_webhook_deliveries")
      .filter(d => d.webhookId === webhookId)
      .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)))
      .slice(0, Math.max(1, Math.min(100, limit)))
      .map(d => ({
        id: d.id, event: d.event, status: d.status, attempts: Number(d.attempts || 0),
        responseCode: d.responseCode == null ? null : Number(d.responseCode),
        error: d.error || null, createdAt: d.createdAt, deliveredAt: d.deliveredAt || null,
      }));
  },
  async requeueStale(olderThanSec = 300) {
    const cutoff = new Date(Date.now() - Math.max(30, olderThanSec) * 1000).toISOString();
    let n = 0;
    for (const d of tbl("chat_webhook_deliveries")) {
      if (d.status === "sending" && String(d.createdAt) < cutoff) {
        d.status = "pending"; d.claimToken = null; d.nextAttemptAt = now(); n++;
      }
    }
    if (n) save("chat_webhook_deliveries");
    return n;
  },
  async pruneDeliveries(retentionDays = 30) {
    const cutoff = new Date(Date.now() - Math.max(1, retentionDays) * 86400000).toISOString();
    const arr = tbl("chat_webhook_deliveries");
    const keep = arr.filter(d => String(d.createdAt) >= cutoff);
    const removed = arr.length - keep.length;
    if (removed) { store["chat_webhook_deliveries"] = keep; save("chat_webhook_deliveries"); }
    return removed;
  },
};

// ─── Meeting polls (0121) ────────────────────────────────────────────────────
// Same surface as the MySQL repo so the service is driver-agnostic.
const mapPoll = (r: any) =>
  r && {
    id: r.id, meetingId: r.meetingId, createdBy: r.createdBy,
    question: r.question, options: Array.isArray(r.options) ? r.options.map(String) : [],
    status: r.status || "open", anonymous: !!r.anonymous, multiChoice: !!r.multiChoice,
    createdAt: r.createdAt, closedAt: r.closedAt || null,
  };

const polls = {
  async create(p: any) {
    const row = {
      id: genId(), meetingId: p.meetingId, createdBy: p.createdBy,
      question: p.question, options: p.options.map(String),
      status: "open", anonymous: p.anonymous !== false, multiChoice: !!p.multiChoice,
      createdAt: now(), closedAt: null, deleted: false,
    };
    tbl("meeting_polls").push(row); save("meeting_polls");
    return mapPoll(row);
  },
  async getById(id: string) {
    return mapPoll(tbl("meeting_polls").find(p => p.id === id && !p.deleted));
  },
  async listForMeeting(meetingId: string) {
    return tbl("meeting_polls")
      .filter(p => p.meetingId === meetingId && !p.deleted)
      .sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)))
      .map(mapPoll);
  },
  async close(id: string) {
    const p = tbl("meeting_polls").find(x => x.id === id && !x.deleted);
    if (p && p.status !== "closed") { p.status = "closed"; p.closedAt = now(); save("meeting_polls"); }
    return mapPoll(p);
  },
  async remove(id: string) {
    const p = tbl("meeting_polls").find(x => x.id === id && !x.deleted);
    if (p) { p.deleted = true; p.deletedAt = now(); save("meeting_polls"); }
    return { id, removed: !!p };
  },
  async vote(pollId: string, userId: string, optionIndexes: number[]) {
    const arr = tbl("meeting_poll_votes");
    const kept = arr.filter(v => !(v.pollId === pollId && v.userId === userId));
    for (const idx of optionIndexes) kept.push({ pollId, userId, optionIndex: idx, createdAt: now() });
    store["meeting_poll_votes"] = kept; save("meeting_poll_votes");
    return { pollId, userId, optionIndexes };
  },
  async tally(pollId: string) {
    const rows = tbl("meeting_poll_votes").filter(v => v.pollId === pollId);
    const counts: Record<number, number> = {};
    const voters = new Set<string>();
    for (const v of rows) {
      counts[v.optionIndex] = (counts[v.optionIndex] || 0) + 1;
      voters.add(v.userId);
    }
    return { counts, voterCount: voters.size };
  },
  async myVote(pollId: string, userId: string) {
    return tbl("meeting_poll_votes")
      .filter(v => v.pollId === pollId && v.userId === userId)
      .map(v => Number(v.optionIndex))
      .sort((a, b) => a - b);
  },
  async voters(pollId: string) {
    return tbl("meeting_poll_votes")
      .filter(v => v.pollId === pollId)
      .map(v => ({ userId: v.userId, optionIndex: Number(v.optionIndex) }));
  },
};

// The JSON driver implements a SUBSET of the MySQL driver's surface (see
// backend/app/test/driver-parity.test.ts for the current gap). Without this
// guard, calling something it lacks produces `TypeError: db.tasks.logActivity
// is not a function` — surfacing to the developer as an opaque 500 with no clue
// that the driver, not their code, is the problem.
//
// Wrapping each repo makes that failure ANSWER the question instead: it names
// the method, says the JSON driver doesn't implement it, and points at the fix.
// Deliberately a thrown error rather than a silent no-op: a stub that quietly
// returned undefined would corrupt data and be far harder to diagnose than a
// loud stop.
// Introspection hook: because the proxy answers EVERY property with a function,
// nothing can tell an implemented method from a guarded one by inspection alone.
// The parity test asks for this to get the real list.
export const IMPLEMENTED = Symbol.for("colab.json.implemented");

function guard<T extends object>(repo: string, impl: T): T {
  return new Proxy(impl, {
    get(target, prop: any) {
      if (prop === IMPLEMENTED)
        return Object.keys(target).filter((k) => typeof (target as any)[k] === "function");
      if (prop in target) return (target as any)[prop];
      if (typeof prop !== "string" || prop.startsWith("_") || prop === "then") return undefined;
      return () => {
        throw Object.assign(
          new Error(
            `The local JSON database driver doesn't implement db.${repo}.${prop}(). ` +
              `Run with DATABASE_DRIVER=mysql (npm run dev) for the full feature set.`,
          ),
          {
            status: 501,
            code: "JSON_DRIVER_UNSUPPORTED",
            // `expose` opts this message past the error middleware, which
            // genericizes 5xx bodies to "Something went wrong" so internals
            // never leak. This one is a DEVELOPER-facing setup message with no
            // user data in it, and it is useless if it can't be read.
            expose: true,
          },
        );
      };
    },
  });
}

export function createJsonDb(_config: any) {
  const repos: Record<string, any> = {
    users, conversations, messages, bookmarks, meetings, folders, reminders,
    calls, tasks, taskProjects, taskSavedViews, invites, settings, files,
    fileShares, meetingMessages, scheduledMessages, notifications, blocks,
    sessions, refreshTokens, mfa, stickers, callFeedback, telemetry, orgs,
    whiteboards, recordings, voicemails, concerns, errorLogs, audit,
    pushSubscriptions, pushDevices, pushClickEvents, e2ee, webhooks, polls,
    connectors: createJsonConnectorsRepo({ tbl, save, genId, now }),
  };
  const guarded = Object.fromEntries(
    Object.entries(repos).map(([name, impl]) => [name, guard(name, impl)]),
  );
  return {
    driver: "json" as const,
    ...guarded,
    async withTransaction<T>(fn: (txQuery?: any) => Promise<T>): Promise<T> {
      return fn();
    },
    pool: { end: async () => {}, query: async () => [[]] },
  };
}
