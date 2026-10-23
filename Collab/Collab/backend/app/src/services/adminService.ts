// ─────────────────────────────────────────────────────────────────────────────
// Collab Admin Portal — Business Logic & Database Service Layer
//
// Provides high-performance, server-paginated data retrieval and administrative
// operations across organizations, members, meetings, and audit logs.
// ─────────────────────────────────────────────────────────────────────────────
import { db } from "../platform";
import * as broadcastService from "./orgBroadcastService";

export interface PaginationParams {
  limit?: number;
  offset?: number;
  query?: string;
}

// ── Database query helpers ───────────────────────────────────────────────────
async function query(sql: string, params: any[] = []): Promise<any[]> {
  try {
    if (db.driver === "mysql" && db.pool?.query) {
      const [rows] = await db.pool.query(sql, params);
      return (rows as any[]) || [];
    }
    return [];
  } catch (err) {
    console.error("[adminService] Query error:", err, { sql, params });
    throw err;
  }
}

async function queryOne(sql: string, params: any[] = []): Promise<any> {
  const rows = await query(sql, params);
  return rows[0] || null;
}

export const adminService = {
  // ── 1. Dashboard metrics ───────────────────────────────────────────────────
  async getDashboardMetrics() {
    if (db.driver === "mysql") {
      const now = new Date();
      const startOfDay = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 0, 0, 0));
      const endOfDay = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 23, 59, 59));

      const [
        orgStats,
        memberStats,
        onlineStats,
        meetingStats,
        recentOrgs,
        recentMeetings,
      ] = await Promise.all([
        // Total and active organizations
        queryOne(`
          SELECT 
            COUNT(*) as totalOrgs,
            SUM(CASE WHEN status = 'active' THEN 1 ELSE 0 END) as activeOrgs
          FROM organizations 
          WHERE deleted = 0
        `),
        // Total active organization memberships
        queryOne(`
          SELECT COUNT(*) as totalMembers
          FROM organization_members om
          JOIN users u ON u.id = om.user_id
          WHERE om.deleted = 0 AND om.status = 'active' AND u.deleted = 0
        `),
        // Users currently online / active
        queryOne(`
          SELECT COUNT(*) as onlineUsers
          FROM users
          WHERE deleted = 0 AND presence IN ('on', 'busy', 'dnd', 'away')
        `),
        // Meeting statistics across all organizations
        queryOne(`
          SELECT
            COUNT(*) as totalMeetings,
            SUM(CASE WHEN starts_at >= ? AND starts_at <= ? THEN 1 ELSE 0 END) as todayMeetings,
            SUM(CASE WHEN starts_at > ? AND status != 'ended' AND status != 'cancelled' THEN 1 ELSE 0 END) as upcomingMeetings,
            SUM(CASE WHEN status = 'ended' OR (starts_at < ? AND status != 'cancelled') THEN 1 ELSE 0 END) as completedMeetings
          FROM meetings
          WHERE deleted = 0
        `, [startOfDay, endOfDay, now, now]),
        // 5 most recent organizations
        query(`
          SELECT o.id, o.name, o.slug, o.status, o.created_at,
            (SELECT COUNT(*) FROM organization_members om WHERE om.organization_id = o.id AND om.deleted = 0 AND om.status = 'active') as member_count
          FROM organizations o
          WHERE o.deleted = 0
          ORDER BY o.created_at DESC
          LIMIT 5
        `),
        // 5 most recent or upcoming meetings
        query(`
          SELECT m.id, m.title, m.starts_at, m.duration_min, m.status, m.organization_id,
            o.name as organization_name, u.name as organizer_name,
            (SELECT COUNT(*) FROM meeting_attendees ma WHERE ma.meeting_id = m.id AND ma.deleted = 0) as attendees_count
          FROM meetings m
          LEFT JOIN organizations o ON o.id = m.organization_id
          LEFT JOIN users u ON u.id = m.created_by
          WHERE m.deleted = 0
          ORDER BY m.starts_at DESC
          LIMIT 5
        `),
      ]);

      return {
        totalOrganizations: Number(orgStats?.totalOrgs) || 0,
        activeOrganizations: Number(orgStats?.activeOrgs) || 0,
        totalMembers: Number(memberStats?.totalMembers) || 0,
        onlineUsers: Number(onlineStats?.onlineUsers) || 0,
        totalMeetings: Number(meetingStats?.totalMeetings) || 0,
        todayMeetings: Number(meetingStats?.todayMeetings) || 0,
        upcomingMeetings: Number(meetingStats?.upcomingMeetings) || 0,
        completedMeetings: Number(meetingStats?.completedMeetings) || 0,
        recentOrganizations: (recentOrgs || []).map((o) => ({
          id: o.id,
          name: o.name,
          slug: o.slug,
          status: o.status,
          createdAt: o.created_at,
          memberCount: Number(o.member_count) || 0,
        })),
        recentMeetings: (recentMeetings || []).map((m) => ({
          id: m.id,
          title: m.title,
          startsAt: m.starts_at,
          durationMin: m.duration_min,
          status: m.status,
          organizationId: m.organization_id,
          organizationName: m.organization_name || "Independent",
          organizerName: m.organizer_name || "Unknown",
          attendeesCount: Number(m.attendees_count) || 0,
        })),
      };
    }

    // JSON driver fallback
    const allUsers = await db.users.list();
    const online = allUsers.filter((u: any) => u.presence && u.presence !== "off").length;
    return {
      totalOrganizations: 1,
      activeOrganizations: 1,
      totalMembers: allUsers.length,
      onlineUsers: online,
      totalMeetings: 0,
      todayMeetings: 0,
      upcomingMeetings: 0,
      completedMeetings: 0,
      recentOrganizations: [],
      recentMeetings: [],
    };
  },

  // ── 2. Organizations Management ───────────────────────────────────────────
  async listOrganizations({
    query: searchQ = "",
    status,
    limit = 20,
    offset = 0,
  }: PaginationParams & { status?: string }) {
    const lim = Math.min(Math.max(Number(limit) || 20, 1), 100);
    const off = Math.max(Number(offset) || 0, 0);

    const conditions = ["o.deleted = 0"];
    const params: any[] = [];

    if (status && status !== "all") {
      conditions.push("o.status = ?");
      params.push(status);
    }

    if (searchQ.trim()) {
      conditions.push("(o.name LIKE ? OR o.slug LIKE ? OR o.id = ?)");
      const term = `%${searchQ.trim()}%`;
      params.push(term, term, searchQ.trim());
    }

    const whereClause = conditions.join(" AND ");

    const countRow = await queryOne(
      `SELECT COUNT(*) as total FROM organizations o WHERE ${whereClause}`,
      params,
    );
    const total = Number(countRow?.total) || 0;

    const orgRows = await query(
      `SELECT 
        o.id, o.name, o.slug, o.kind, o.status, o.owner_id, o.created_by, o.created_at,
        u.name as owner_name, u.email as owner_email,
        (SELECT COUNT(*) FROM organization_members om WHERE om.organization_id = o.id AND om.deleted = 0 AND om.status = 'active') as total_members,
        (SELECT COUNT(*) FROM meetings m WHERE m.organization_id = o.id AND m.deleted = 0) as total_meetings,
        (SELECT COUNT(DISTINCT om.user_id) 
           FROM organization_members om 
           JOIN users mu ON mu.id = om.user_id 
          WHERE om.organization_id = o.id 
            AND om.deleted = 0 
            AND om.status = 'active' 
            AND mu.deleted = 0 
            AND mu.presence IN ('on', 'busy', 'dnd', 'away')) as online_members
      FROM organizations o
      LEFT JOIN users u ON u.id = o.owner_id
      WHERE ${whereClause}
      ORDER BY o.created_at DESC
      LIMIT ? OFFSET ?`,
      [...params, lim, off],
    );

    const organizations = orgRows.map((r) => ({
      id: r.id,
      name: r.name,
      slug: r.slug,
      kind: r.kind || "team",
      status: r.status || "active",
      ownerId: r.owner_id || null,
      ownerName: r.owner_name || null,
      ownerEmail: r.owner_email || null,
      createdAt: r.created_at,
      totalMembers: Number(r.total_members) || 0,
      totalMeetings: Number(r.total_meetings) || 0,
      onlineMembers: Number(r.online_members) || 0,
    }));

    return {
      organizations,
      total,
      limit: lim,
      offset: off,
    };
  },

  async getOrganizationDetails(orgId: string) {
    const org = await queryOne(
      `SELECT o.*, u.name as owner_name, u.email as owner_email, u.avatar_url as owner_avatar
       FROM organizations o
       LEFT JOIN users u ON u.id = o.owner_id
       WHERE o.id = ? AND o.deleted = 0`,
      [orgId],
    );

    if (!org) return null;

    const now = new Date();
    const startOfDay = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 0, 0, 0));
    const endOfDay = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 23, 59, 59));

    const [stats, members, meetings, activity] = await Promise.all([
      // Meeting stats for this org
      queryOne(
        `SELECT
          COUNT(*) as totalMeetings,
          SUM(CASE WHEN starts_at >= ? AND starts_at <= ? THEN 1 ELSE 0 END) as todayMeetings,
          SUM(CASE WHEN starts_at > ? AND status != 'ended' AND status != 'cancelled' THEN 1 ELSE 0 END) as upcomingMeetings,
          SUM(CASE WHEN status = 'ended' OR (starts_at < ? AND status != 'cancelled') THEN 1 ELSE 0 END) as completedMeetings,
          SUM(CASE WHEN recurrence != 'none' THEN 1 ELSE 0 END) as recurringMeetings
        FROM meetings
        WHERE organization_id = ? AND deleted = 0`,
        [startOfDay, endOfDay, now, now, orgId],
      ),
      // Members of this org
      query(
        `SELECT 
          om.id as membership_id, om.role, om.status as member_status, om.created_at as joined_at,
          u.id as user_id, u.name, u.email, u.avatar_url, u.initials, u.color, u.presence, u.last_seen,
          t.name as team_name
        FROM organization_members om
        JOIN users u ON u.id = om.user_id
        LEFT JOIN teams t ON t.id = om.team_id
        WHERE om.organization_id = ? AND om.deleted = 0
        ORDER BY FIELD(om.role, 'owner', 'ceo', 'cto', 'admin', 'manager', 'member', 'guest'), u.name ASC`,
        [orgId],
      ),
      // Meetings for this org
      query(
        `SELECT 
          m.id, m.title, m.starts_at, m.duration_min, m.status, m.recurrence, m.created_at,
          u.name as organizer_name, u.email as organizer_email,
          (SELECT COUNT(*) FROM meeting_attendees ma WHERE ma.meeting_id = m.id AND ma.deleted = 0) as attendees_count
        FROM meetings m
        LEFT JOIN users u ON u.id = m.created_by
        WHERE m.organization_id = ? AND m.deleted = 0
        ORDER BY m.starts_at DESC
        LIMIT 50`,
        [orgId],
      ),
      // Org audit activity
      query(
        `SELECT a.id, a.action, a.actor_id, a.target, a.meta_json, a.created_at, u.name as actor_name, u.email as actor_email
         FROM audit_log a
         LEFT JOIN users u ON u.id = a.actor_id
         WHERE a.organization_id = ?
         ORDER BY a.created_at DESC
         LIMIT 25`,
        [orgId],
      ),
    ]);

    const activeMembers = members.filter((m) => m.member_status === "active");
    const onlineCount = activeMembers.filter((m) => m.presence && m.presence !== "off").length;

    return {
      organization: {
        id: org.id,
        name: org.name,
        slug: org.slug,
        kind: org.kind,
        status: org.status,
        createdAt: org.created_at,
        ownerId: org.owner_id,
        ownerName: org.owner_name,
        ownerEmail: org.owner_email,
        ownerAvatar: org.owner_avatar,
      },
      stats: {
        totalMembers: activeMembers.length,
        onlineMembers: onlineCount,
        totalMeetings: Number(stats?.totalMeetings) || 0,
        todayMeetings: Number(stats?.todayMeetings) || 0,
        upcomingMeetings: Number(stats?.upcomingMeetings) || 0,
        completedMeetings: Number(stats?.completedMeetings) || 0,
        recurringMeetings: Number(stats?.recurringMeetings) || 0,
      },
      members: members.map((m) => ({
        membershipId: m.membership_id,
        userId: m.user_id,
        name: m.name,
        email: m.email,
        avatarUrl: m.avatar_url,
        initials: m.initials,
        color: m.color,
        role: m.role,
        status: m.member_status,
        presence: m.presence || "off",
        lastSeen: m.last_seen,
        joinedAt: m.joined_at,
        teamName: m.team_name || null,
      })),
      meetings: meetings.map((m) => ({
        id: m.id,
        title: m.title,
        startsAt: m.starts_at,
        durationMin: m.duration_min,
        status: m.status,
        recurrence: m.recurrence,
        organizerName: m.organizer_name || "Unknown",
        organizerEmail: m.organizer_email || null,
        attendeesCount: Number(m.attendees_count) || 0,
        createdAt: m.created_at,
      })),
      activity: activity.map((a) => ({
        id: a.id,
        action: a.action,
        actorId: a.actor_id,
        actorName: a.actor_name || "Admin",
        actorEmail: a.actor_email || null,
        target: a.target,
        meta: typeof a.meta_json === "string" ? JSON.parse(a.meta_json || "{}") : a.meta_json || {},
        createdAt: a.created_at,
      })),
    };
  },

  // ── 3. Members Management ─────────────────────────────────────────────────
  async listMembers({
    query: searchQ = "",
    organizationId,
    presence,
    limit = 20,
    offset = 0,
  }: PaginationParams & { organizationId?: string; presence?: string; status?: string }) {
    const lim = Math.min(Math.max(Number(limit) || 20, 1), 100);
    const off = Math.max(Number(offset) || 0, 0);

    const conditions = ["u.deleted = 0"];
    const params: any[] = [];

    if (organizationId && organizationId !== "all") {
      conditions.push(
        "EXISTS (SELECT 1 FROM organization_members om WHERE om.user_id = u.id AND om.organization_id = ? AND om.deleted = 0)",
      );
      params.push(organizationId);
    }

    if (presence && presence !== "all") {
      if (presence === "online") {
        conditions.push("u.presence IN ('on', 'busy', 'dnd', 'away')");
      } else if (presence === "offline") {
        conditions.push("(u.presence = 'off' OR u.presence IS NULL)");
      } else {
        conditions.push("u.presence = ?");
        params.push(presence);
      }
    }

    if (searchQ.trim()) {
      conditions.push("(u.name LIKE ? OR u.email LIKE ? OR u.id = ?)");
      const term = `%${searchQ.trim()}%`;
      params.push(term, term, searchQ.trim());
    }

    const whereClause = conditions.join(" AND ");

    const countRow = await queryOne(
      `SELECT COUNT(*) as total FROM users u WHERE ${whereClause}`,
      params,
    );
    const total = Number(countRow?.total) || 0;

    const userRows = await query(
      `SELECT 
        u.id, u.name, u.email, u.avatar_url, u.initials, u.color, u.role as global_role,
        u.presence, u.last_seen, u.created_at,
        (SELECT COUNT(*) FROM meeting_attendees ma WHERE ma.user_id = u.id AND ma.deleted = 0) as meetings_count
      FROM users u
      WHERE ${whereClause}
      ORDER BY u.name ASC
      LIMIT ? OFFSET ?`,
      [...params, lim, off],
    );

    // Fetch organization memberships for these users
    const userIds = userRows.map((u) => u.id);
    let membershipsByUser: Record<string, any[]> = {};

    if (userIds.length > 0) {
      const placeholders = userIds.map(() => "?").join(",");
      const memberRows = await query(
        `SELECT om.user_id, om.organization_id, om.role, om.status, om.created_at as joined_at, o.name as org_name
         FROM organization_members om
         JOIN organizations o ON o.id = om.organization_id AND o.deleted = 0
         WHERE om.user_id IN (${placeholders}) AND om.deleted = 0`,
        userIds,
      );

      for (const m of memberRows) {
        if (!membershipsByUser[m.user_id]) membershipsByUser[m.user_id] = [];
        membershipsByUser[m.user_id].push({
          orgId: m.organization_id,
          orgName: m.org_name,
          role: m.role,
          status: m.status,
          joinedAt: m.joined_at,
        });
      }
    }

    const members = userRows.map((u) => ({
      userId: u.id,
      name: u.name,
      email: u.email,
      avatarUrl: u.avatar_url,
      initials: u.initials,
      color: u.color,
      presence: u.presence || "off",
      lastSeen: u.last_seen,
      createdAt: u.created_at,
      meetingsCount: Number(u.meetings_count) || 0,
      organizations: membershipsByUser[u.id] || [],
    }));

    return {
      members,
      total,
      limit: lim,
      offset: off,
    };
  },

  // ── 4. Online Users ───────────────────────────────────────────────────────
  async getOnlineUsers({
    query: searchQ = "",
    limit = 50,
    offset = 0,
  }: PaginationParams) {
    const lim = Math.min(Math.max(Number(limit) || 50, 1), 100);
    const off = Math.max(Number(offset) || 0, 0);

    const conditions = ["u.deleted = 0", "u.presence IN ('on', 'busy', 'dnd', 'away')"];
    const params: any[] = [];

    if (searchQ.trim()) {
      conditions.push("(u.name LIKE ? OR u.email LIKE ?)");
      const term = `%${searchQ.trim()}%`;
      params.push(term, term);
    }

    const whereClause = conditions.join(" AND ");

    const countRow = await queryOne(
      `SELECT COUNT(*) as total FROM users u WHERE ${whereClause}`,
      params,
    );
    const total = Number(countRow?.total) || 0;

    const userRows = await query(
      `SELECT 
        u.id, u.name, u.email, u.avatar_url, u.initials, u.color, u.presence, u.last_seen, u.created_at,
        mp.meeting_id as active_meeting_id, m.title as active_meeting_title
      FROM users u
      LEFT JOIN meeting_presence mp ON mp.user_id = u.id AND mp.last_seen >= DATE_SUB(NOW(), INTERVAL 2 MINUTE)
      LEFT JOIN meetings m ON m.id = mp.meeting_id AND m.deleted = 0
      WHERE ${whereClause}
      ORDER BY u.last_seen DESC, u.name ASC
      LIMIT ? OFFSET ?`,
      [...params, lim, off],
    );

    const userIds = userRows.map((u) => u.id);
    let membershipsByUser: Record<string, string[]> = {};

    if (userIds.length > 0) {
      const placeholders = userIds.map(() => "?").join(",");
      const memberRows = await query(
        `SELECT om.user_id, o.name as org_name
         FROM organization_members om
         JOIN organizations o ON o.id = om.organization_id AND o.deleted = 0
         WHERE om.user_id IN (${placeholders}) AND om.deleted = 0 AND om.status = 'active'`,
        userIds,
      );

      for (const m of memberRows) {
        if (!membershipsByUser[m.user_id]) membershipsByUser[m.user_id] = [];
        membershipsByUser[m.user_id].push(m.org_name);
      }
    }

    const users = userRows.map((u) => ({
      userId: u.id,
      name: u.name,
      email: u.email,
      avatarUrl: u.avatar_url,
      initials: u.initials,
      color: u.color,
      presence: u.presence,
      lastSeen: u.last_seen,
      createdAt: u.created_at,
      organizations: membershipsByUser[u.id] || [],
      currentMeeting: u.active_meeting_id
        ? {
            id: u.active_meeting_id,
            title: u.active_meeting_title || "Meeting",
          }
        : null,
    }));

    return {
      users,
      total,
      limit: lim,
      offset: off,
    };
  },

  // ── 5. Meetings Management ────────────────────────────────────────────────
  async listMeetings({
    query: searchQ = "",
    organizationId,
    status,
    dateFrom,
    dateTo,
    organizerId,
    upcomingOnly,
    completedOnly,
    limit = 20,
    offset = 0,
  }: PaginationParams & {
    organizationId?: string;
    status?: string;
    dateFrom?: string;
    dateTo?: string;
    organizerId?: string;
    upcomingOnly?: boolean;
    completedOnly?: boolean;
  }) {
    const lim = Math.min(Math.max(Number(limit) || 20, 1), 100);
    const off = Math.max(Number(offset) || 0, 0);

    const conditions = ["m.deleted = 0"];
    const params: any[] = [];

    if (organizationId && organizationId !== "all") {
      conditions.push("m.organization_id = ?");
      params.push(organizationId);
    }

    if (status && status !== "all") {
      conditions.push("m.status = ?");
      params.push(status);
    }

    if (organizerId) {
      conditions.push("m.created_by = ?");
      params.push(organizerId);
    }

    if (dateFrom) {
      conditions.push("m.starts_at >= ?");
      params.push(new Date(dateFrom));
    }

    if (dateTo) {
      conditions.push("m.starts_at <= ?");
      params.push(new Date(dateTo));
    }

    const now = new Date();
    if (upcomingOnly) {
      conditions.push("m.starts_at > ? AND m.status != 'ended' AND m.status != 'cancelled'");
      params.push(now);
    } else if (completedOnly) {
      conditions.push("(m.status = 'ended' OR (m.starts_at < ? AND m.status != 'cancelled'))");
      params.push(now);
    }

    if (searchQ.trim()) {
      conditions.push("(m.title LIKE ? OR m.id = ?)");
      const term = `%${searchQ.trim()}%`;
      params.push(term, searchQ.trim());
    }

    const whereClause = conditions.join(" AND ");

    const countRow = await queryOne(
      `SELECT COUNT(*) as total FROM meetings m WHERE ${whereClause}`,
      params,
    );
    const total = Number(countRow?.total) || 0;

    const meetingRows = await query(
      `SELECT 
        m.id, m.title, m.starts_at, m.duration_min, m.status, m.recurrence, m.recurrence_rule,
        m.timezone, m.organization_id, m.created_by, m.created_at,
        o.name as organization_name,
        u.name as organizer_name, u.email as organizer_email,
        (SELECT COUNT(*) FROM meeting_attendees ma WHERE ma.meeting_id = m.id AND ma.deleted = 0) as attendees_count
      FROM meetings m
      LEFT JOIN organizations o ON o.id = m.organization_id
      LEFT JOIN users u ON u.id = m.created_by
      WHERE ${whereClause}
      ORDER BY m.starts_at DESC
      LIMIT ? OFFSET ?`,
      [...params, lim, off],
    );

    const meetings = meetingRows.map((m) => ({
      id: m.id,
      title: m.title,
      startsAt: m.starts_at,
      durationMin: m.duration_min,
      status: m.status,
      recurrence: m.recurrence,
      recurrenceRule: m.recurrence_rule,
      timezone: m.timezone || "UTC",
      organizationId: m.organization_id,
      organizationName: m.organization_name || "Independent",
      createdBy: m.created_by,
      organizerName: m.organizer_name || "Unknown",
      organizerEmail: m.organizer_email || null,
      attendeesCount: Number(m.attendees_count) || 0,
      createdAt: m.created_at,
    }));

    return {
      meetings,
      total,
      limit: lim,
      offset: off,
    };
  },

  async getMeetingDetails(meetingId: string) {
    const meeting = await queryOne(
      `SELECT m.*, o.name as organization_name, o.slug as organization_slug,
              u.name as organizer_name, u.email as organizer_email, u.avatar_url as organizer_avatar
       FROM meetings m
       LEFT JOIN organizations o ON o.id = m.organization_id
       LEFT JOIN users u ON u.id = m.created_by
       WHERE m.id = ? AND m.deleted = 0`,
      [meetingId],
    );

    if (!meeting) return null;

    const attendees = await query(
      `SELECT 
        ma.user_id, ma.status as attendance_status, ma.role as attendee_role,
        u.name, u.email, u.avatar_url, u.initials, u.color, u.presence,
        (u.id = ?) as is_organizer
      FROM meeting_attendees ma
      JOIN users u ON u.id = ma.user_id
      WHERE ma.meeting_id = ? AND ma.deleted = 0
      ORDER BY (u.id = ?) DESC, u.name ASC`,
      [meeting.created_by, meetingId, meeting.created_by],
    );

    return {
      meeting: {
        id: meeting.id,
        title: meeting.title,
        description: meeting.description || null,
        startsAt: meeting.starts_at,
        durationMin: meeting.duration_min,
        status: meeting.status,
        recurrence: meeting.recurrence,
        recurrenceRule: meeting.recurrence_rule,
        timezone: meeting.timezone || "UTC",
        organizationId: meeting.organization_id,
        organizationName: meeting.organization_name || "Independent",
        organizationSlug: meeting.organization_slug || null,
        createdBy: meeting.created_by,
        organizerName: meeting.organizer_name || "Unknown",
        organizerEmail: meeting.organizer_email || null,
        organizerAvatar: meeting.organizer_avatar || null,
        createdAt: meeting.created_at,
      },
      attendees: attendees.map((a) => ({
        userId: a.user_id,
        name: a.name,
        email: a.email,
        avatarUrl: a.avatar_url,
        initials: a.initials,
        color: a.color,
        presence: a.presence || "off",
        status: a.attendance_status,
        role: a.attendee_role || "participant",
        isOrganizer: !!a.is_organizer,
      })),
    };
  },

  // ── 6. Meeting Participant Management ─────────────────────────────────────
  async addMeetingMembers(
    meetingId: string,
    userIds: string[],
    actor: { email: string },
  ) {
    const meeting = await queryOne(
      `SELECT id, title, organization_id FROM meetings WHERE id = ? AND deleted = 0`,
      [meetingId],
    );
    if (!meeting) {
      return { error: "MEETING_NOT_FOUND", message: "Meeting not found." };
    }

    const orgId = meeting.organization_id;
    if (!userIds || userIds.length === 0) {
      return { error: "NO_USERS", message: "No user IDs provided." };
    }

    // Security check: Validate that all userIds are active members of the meeting's organization
    if (orgId) {
      const placeholders = userIds.map(() => "?").join(",");
      const validMembers = await query(
        `SELECT user_id FROM organization_members 
         WHERE organization_id = ? AND user_id IN (${placeholders}) AND deleted = 0 AND status = 'active'`,
        [orgId, ...userIds],
      );
      const validSet = new Set(validMembers.map((v) => v.user_id));
      const invalidUsers = userIds.filter((uid) => !validSet.has(uid));
      if (invalidUsers.length > 0) {
        return {
          error: "INVALID_ORG_MEMBER",
          message: `Cannot add users from outside the meeting's organization. ${invalidUsers.length} user(s) were invalid.`,
        };
      }
    }

    // Add attendees (upsert to reactivate if previously removed)
    for (const uid of userIds) {
      await query(
        `INSERT INTO meeting_attendees (meeting_id, user_id, status, role)
         VALUES (?, ?, 'invited', 'participant')
         ON DUPLICATE KEY UPDATE deleted = 0, deleted_at = NULL, status = 'invited'`,
        [meetingId, uid],
      );
    }

    // Record audit log
    await this.recordAudit({
      actor: actor.email,
      action: "meeting.member_added",
      target: `meeting:${meetingId}`,
      meta: { meetingId, addedUserCount: userIds.length, userIds, title: meeting.title },
      organizationId: orgId || null,
    });

    return { ok: true, details: await this.getMeetingDetails(meetingId) };
  },

  async removeMeetingMember(
    meetingId: string,
    userId: string,
    actor: { email: string },
  ) {
    const meeting = await queryOne(
      `SELECT id, title, created_by, organization_id FROM meetings WHERE id = ? AND deleted = 0`,
      [meetingId],
    );
    if (!meeting) {
      return { error: "MEETING_NOT_FOUND", message: "Meeting not found." };
    }

    if (meeting.created_by === userId) {
      return { error: "CANNOT_REMOVE_ORGANIZER", message: "Cannot remove the meeting organizer." };
    }

    await query(
      `UPDATE meeting_attendees SET deleted = 1, deleted_at = NOW() WHERE meeting_id = ? AND user_id = ?`,
      [meetingId, userId],
    );

    // Record audit log
    await this.recordAudit({
      actor: actor.email,
      action: "meeting.member_removed",
      target: `meeting:${meetingId}`,
      meta: { meetingId, removedUserId: userId, title: meeting.title },
      organizationId: meeting.organization_id || null,
    });

    return { ok: true, details: await this.getMeetingDetails(meetingId) };
  },

  // ── 7. Analytics ──────────────────────────────────────────────────────────
  async getAnalytics(orgId?: string) {
    const orgFilterClause = orgId && orgId !== "all" ? "AND organization_id = ?" : "";
    const orgParams = orgId && orgId !== "all" ? [orgId] : [];

    const now = new Date();
    const startOfDay = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 0, 0, 0));
    const endOfDay = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 23, 59, 59));

    const [summary, dailyDistribution, orgBreakdown, statusDistribution] = await Promise.all([
      // Summary stats
      queryOne(
        `SELECT
          COUNT(*) as totalMeetings,
          SUM(CASE WHEN starts_at >= ? AND starts_at <= ? THEN 1 ELSE 0 END) as todayMeetings,
          SUM(CASE WHEN starts_at > ? AND status != 'ended' AND status != 'cancelled' THEN 1 ELSE 0 END) as upcomingMeetings,
          SUM(CASE WHEN status = 'ended' OR (starts_at < ? AND status != 'cancelled') THEN 1 ELSE 0 END) as completedMeetings,
          SUM(CASE WHEN recurrence != 'none' THEN 1 ELSE 0 END) as recurringMeetings
        FROM meetings
        WHERE deleted = 0 ${orgFilterClause}`,
        [startOfDay, endOfDay, now, now, ...orgParams],
      ),
      // Daily distribution for the past 14 days + next 7 days
      query(
        `SELECT 
          DATE(starts_at) as meeting_date,
          COUNT(*) as meeting_count
        FROM meetings
        WHERE deleted = 0 
          AND starts_at >= DATE_SUB(NOW(), INTERVAL 14 DAY)
          AND starts_at <= DATE_ADD(NOW(), INTERVAL 7 DAY)
          ${orgFilterClause}
        GROUP BY DATE(starts_at)
        ORDER BY meeting_date ASC`,
        orgParams,
      ),
      // Meeting counts per organization
      query(
        `SELECT 
          o.id as org_id, o.name as org_name,
          COUNT(m.id) as total_meetings,
          SUM(CASE WHEN m.starts_at >= ? AND m.starts_at <= ? THEN 1 ELSE 0 END) as today_meetings,
          SUM(CASE WHEN m.starts_at > ? AND m.status != 'ended' AND m.status != 'cancelled' THEN 1 ELSE 0 END) as upcoming_meetings,
          SUM(CASE WHEN m.status = 'ended' OR (m.starts_at < ? AND m.status != 'cancelled') THEN 1 ELSE 0 END) as completed_meetings,
          SUM(CASE WHEN m.recurrence != 'none' THEN 1 ELSE 0 END) as recurring_meetings
        FROM organizations o
        LEFT JOIN meetings m ON m.organization_id = o.id AND m.deleted = 0
        WHERE o.deleted = 0
        GROUP BY o.id, o.name
        ORDER BY total_meetings DESC
        LIMIT 20`,
        [startOfDay, endOfDay, now, now],
      ),
      // Status breakdown
      query(
        `SELECT status, COUNT(*) as count
         FROM meetings
         WHERE deleted = 0 ${orgFilterClause}
         GROUP BY status`,
        orgParams,
      ),
    ]);

    return {
      summary: {
        totalMeetings: Number(summary?.totalMeetings) || 0,
        todayMeetings: Number(summary?.todayMeetings) || 0,
        upcomingMeetings: Number(summary?.upcomingMeetings) || 0,
        completedMeetings: Number(summary?.completedMeetings) || 0,
        recurringMeetings: Number(summary?.recurringMeetings) || 0,
      },
      dailyDistribution: (dailyDistribution || []).map((d) => ({
        date: d.meeting_date,
        count: Number(d.meeting_count) || 0,
      })),
      organizationBreakdown: (orgBreakdown || []).map((o) => ({
        orgId: o.org_id,
        orgName: o.org_name,
        totalMeetings: Number(o.total_meetings) || 0,
        todayMeetings: Number(o.today_meetings) || 0,
        upcomingMeetings: Number(o.upcoming_meetings) || 0,
        completedMeetings: Number(o.completed_meetings) || 0,
        recurringMeetings: Number(o.recurring_meetings) || 0,
      })),
      statusDistribution: (statusDistribution || []).map((s) => ({
        status: s.status,
        count: Number(s.count) || 0,
      })),
    };
  },

  // ── 8. Audit Logging ──────────────────────────────────────────────────────
  async recordAudit({
    actor,
    action,
    target,
    meta = {},
    organizationId = null,
  }: {
    actor: string;
    action: string;
    target?: string;
    meta?: any;
    organizationId?: string | null;
  }) {
    try {
      const metaJson = JSON.stringify(meta || {});
      await query(
        `INSERT INTO audit_log (actor_id, action, target, meta_json, organization_id)
         VALUES (?, ?, ?, ?, ?)`,
        [actor, action, target || null, metaJson, organizationId || null],
      );
    } catch (e) {
      console.warn("[adminService] Failed to record audit log:", e);
    }
  },

  // ── Server logs (Insights & Governance → Server Logs) ─────────────────────
  // Every platform failure the backend recorded (error_logs: backend / process /
  // socket / frontend-reported, de-duplicated by fingerprint with an occurrence
  // count). Same source the engineering ops portal reads, exposed to the admin
  // session so operators on a host without ops access still see what failed.
  async listServerLogs({
    query: searchQ = "",
    level,
    source,
    status,
    range,
    limit = 50,
    offset = 0,
  }: PaginationParams & { level?: string; source?: string; status?: string; range?: string }) {
    const lim = Math.min(Math.max(Number(limit) || 50, 1), 200);
    const off = Math.max(Number(offset) || 0, 0);
    const conditions: string[] = [];
    const params: any[] = [];
    const rangeSql: Record<string, string> = {
      today: "e.last_seen_at >= CURDATE()",
      "24h": "e.last_seen_at >= NOW() - INTERVAL 1 DAY",
      "7d": "e.last_seen_at >= NOW() - INTERVAL 7 DAY",
      "30d": "e.last_seen_at >= NOW() - INTERVAL 30 DAY",
    };
    if (range && rangeSql[range]) conditions.push(rangeSql[range]);
    if (level && level !== "all") { conditions.push("e.severity = ?"); params.push(String(level)); }
    if (source && source !== "all") { conditions.push("e.source = ?"); params.push(String(source)); }
    if (status && status !== "all") { conditions.push("e.status = ?"); params.push(String(status)); }
    if (searchQ.trim()) {
      conditions.push("(e.message LIKE ? OR e.request_path LIKE ? OR e.code LIKE ? OR u.email LIKE ?)");
      const term = `%${searchQ.trim()}%`;
      params.push(term, term, term, term);
    }
    const whereClause = conditions.length ? "WHERE " + conditions.join(" AND ") : "";
    const from = "FROM error_logs e LEFT JOIN users u ON u.id = e.user_id";

    const [countRow, sevRows, srcRows, rows] = await Promise.all([
      queryOne(`SELECT COUNT(*) AS total, COALESCE(SUM(e.occurrences),0) AS occurrences ${from} ${whereClause}`, params),
      query(`SELECT e.severity AS k, COUNT(*) AS n ${from} ${whereClause} GROUP BY e.severity`, params),
      query(`SELECT e.source AS k, COUNT(*) AS n ${from} ${whereClause} GROUP BY e.source`, params),
      query(
        `SELECT e.id, e.created_at, e.last_seen_at, e.occurrences, e.env, e.source, e.severity, e.code,
                e.message, e.stack, e.context, e.request_path, e.user_id, e.organization_id,
                e.status, e.resolution, e.dependency, e.resolved_by, e.resolved_at,
                u.name AS user_name, u.email AS user_email
           ${from} ${whereClause}
          ORDER BY e.last_seen_at DESC
          LIMIT ? OFFSET ?`,
        [...params, lim, off],
      ),
    ]);

    // Who owns the fix — the ops portal's attribution rules, so both views agree.
    const INFRA_RE = /econnrefused|etimedout|timed out|timeout|connection|pool|deadlock|too many connections|redis|socket hang up|econnreset|lock wait|enospc|enomem|out of memory|epipe|eai_again|enotfound/i;
    const EXTERNAL_RE = /nosuchkey|specified key|s3|bucket|object storage|giphy|jwks|sso|idp|upstream|bad gateway|502|503|504|livekit|egress/i;
    const domainOf = (r: any): string => {
      const msg = String(r.message || "");
      if (String(r.severity) === "warn") return "client";
      if (r.dependency === "infra" || INFRA_RE.test(msg)) return "infrastructure";
      if (r.dependency === "external" || EXTERNAL_RE.test(msg)) return "external";
      if (r.source === "frontend") return "client";
      return "application";
    };
    const parseJson = (v: any) => {
      if (v == null) return null;
      if (typeof v === "object") return v;
      try { return JSON.parse(String(v)); } catch { return null; }
    };
    const tally = (list: any[]) => Object.fromEntries(list.map((r) => [String(r.k || "unknown"), Number(r.n) || 0]));

    return {
      total: Number(countRow?.total) || 0,
      occurrences: Number(countRow?.occurrences) || 0,
      bySeverity: tally(sevRows),
      bySource: tally(srcRows),
      logs: rows.map((r) => ({
        id: String(r.id),
        firstSeen: r.created_at,
        lastSeen: r.last_seen_at,
        occurrences: Number(r.occurrences) || 1,
        env: r.env,
        source: r.source || "backend",
        level: r.severity || "error",
        code: r.code || null,
        message: String(r.message || ""),
        stack: r.stack ? String(r.stack).slice(0, 4000) : null,
        context: parseJson(r.context),
        requestPath: r.request_path || null,
        user: r.user_id ? { id: r.user_id, name: r.user_name || null, email: r.user_email || null } : null,
        organizationId: r.organization_id || null,
        domain: domainOf(r),
        dependency: r.dependency || null,
        status: r.status || "open",
        resolution: r.resolution || null,
        resolvedBy: r.resolved_by || null,
        resolvedAt: r.resolved_at || null,
      })),
    };
  },

  async listAuditLogs({
    query: searchQ = "",
    action,
    limit = 50,
    offset = 0,
  }: PaginationParams & { action?: string }) {
    const lim = Math.min(Math.max(Number(limit) || 50, 1), 100);
    const off = Math.max(Number(offset) || 0, 0);

    const conditions: string[] = [];
    const params: any[] = [];

    if (action && action !== "all") {
      conditions.push("a.action LIKE ?");
      params.push(`%${action}%`);
    }

    if (searchQ.trim()) {
      conditions.push("(a.action LIKE ? OR a.target LIKE ? OR a.actor_id LIKE ?)");
      const term = `%${searchQ.trim()}%`;
      params.push(term, term, term);
    }

    const whereClause = conditions.length ? "WHERE " + conditions.join(" AND ") : "";

    const countRow = await queryOne(
      `SELECT COUNT(*) as total FROM audit_log a ${whereClause}`,
      params,
    );
    const total = Number(countRow?.total) || 0;

    const logRows = await query(
      `SELECT 
        a.id, a.actor_id, a.action, a.target, a.meta_json, a.organization_id, a.created_at,
        o.name as organization_name,
        u.name as actor_name, u.email as actor_email
      FROM audit_log a
      LEFT JOIN organizations o ON o.id = a.organization_id
      LEFT JOIN users u ON u.id = a.actor_id
      ${whereClause}
      ORDER BY a.created_at DESC
      LIMIT ? OFFSET ?`,
      [...params, lim, off],
    );

    const logs = logRows.map((r) => ({
      id: r.id,
      actor: r.actor_email || r.actor_name || r.actor_id || "System",
      action: r.action,
      target: r.target,
      meta: typeof r.meta_json === "string" ? JSON.parse(r.meta_json || "{}") : r.meta_json || {},
      organizationId: r.organization_id,
      organizationName: r.organization_name || null,
      createdAt: r.created_at,
    }));

    return {
      logs,
      total,
      limit: lim,
      offset: off,
    };
  },

  // ── 8. Organization Broadcasts ──────────────────────────────────────────────
  async listBroadcasts(params: PaginationParams & { organizationId?: string; status?: string }) {
    const lim = Math.min(Math.max(Number(params.limit) || 20, 1), 100);
    const off = Math.max(Number(params.offset) || 0, 0);
    const searchQ = String(params.query || "");
    const { organizationId, status } = params;

    const conditions: string[] = ["b.deleted = 0"];
    const sqlParams: any[] = [];

    if (organizationId && organizationId !== "all") {
      conditions.push("b.organization_id = ?");
      sqlParams.push(organizationId);
    }

    if (status && status !== "all") {
      conditions.push("b.status = ?");
      sqlParams.push(status);
    }

    if (searchQ.trim()) {
      conditions.push("(b.title LIKE ? OR b.body LIKE ? OR o.name LIKE ?)");
      const term = `%${searchQ.trim()}%`;
      sqlParams.push(term, term, term);
    }

    const whereClause = conditions.length ? "WHERE " + conditions.join(" AND ") : "";

    const countRow = await queryOne(
      `SELECT COUNT(*) as total FROM org_broadcasts b
       LEFT JOIN organizations o ON o.id = b.organization_id
       ${whereClause}`,
      sqlParams,
    );
    const total = Number(countRow?.total) || 0;

    const rows = await query(
      `SELECT 
        b.id, b.organization_id, b.author_id, b.title, b.body, b.send_at, b.status, b.file_id, b.created_at, b.updated_at,
        o.name as organization_name,
        u.name as author_name, u.email as author_email
      FROM org_broadcasts b
      LEFT JOIN organizations o ON o.id = b.organization_id
      LEFT JOIN users u ON u.id = b.author_id
      ${whereClause}
      ORDER BY COALESCE(b.send_at, b.created_at) DESC
      LIMIT ? OFFSET ?`,
      [...sqlParams, lim, off],
    );

    const broadcasts = rows.map((r) => ({
      id: r.id,
      organizationId: r.organization_id,
      organizationName: r.organization_name || "Unknown Organization",
      authorId: r.author_id,
      authorName: r.author_name || r.author_email || "Admin Console",
      title: r.title,
      body: r.body,
      sendAt: r.send_at,
      status: r.status,
      fileId: r.file_id,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
    }));

    return {
      broadcasts,
      total,
      limit: lim,
      offset: off,
    };
  },

  async createBroadcast(
    data: {
      organizationId: string;
      title: string;
      body?: string;
      sendAt?: string | null;
      excludedUserIds?: string[];
    },
    adminContext: { email: string },
  ) {
    const orgId = String(data.organizationId || "").trim();
    const title = String(data.title || "").trim();
    const body = data.body ? String(data.body).trim() : "";
    const sendAt = data.sendAt ? new Date(data.sendAt).toISOString() : null;
    const excludedUserIds = Array.isArray(data.excludedUserIds) ? data.excludedUserIds : [];

    if (!orgId) {
      return { error: true, message: "Target organization is required." };
    }
    if (!title) {
      return { error: true, message: "Broadcast title is required." };
    }

    const org = await db.orgs.getById(orgId);
    if (!org) {
      return { error: true, message: "Organization not found." };
    }

    // Create the broadcast row in database
    const created = await db.orgs.createBroadcast(orgId, null, title, body || null, {
      sendAt,
      excludedUserIds,
    });

    if (!created) {
      return { error: true, message: "Failed to create broadcast." };
    }

    // Deliver immediately if not scheduled
    let deliveredCount = 0;
    if (!sendAt) {
      try {
        const { notifications } = await broadcastService.deliver({
          ...created,
          authorName: "Admin Console",
          excludedUserIds,
        });
        deliveredCount = notifications.length;
      } catch (err: any) {
        console.error("[adminService] Failed to deliver broadcast:", err);
      }
    }

    // Audit log entry
    await this.recordAudit({
      actor: adminContext.email,
      action: sendAt ? "admin.broadcast_scheduled" : "admin.broadcast_sent",
      target: created.id,
      organizationId: orgId,
      meta: {
        title,
        sendAt,
        deliveredCount,
        excludedCount: excludedUserIds.length,
        excludedUserIds,
      },
    });

    return {
      error: false,
      details: {
        ...created,
        organizationName: org.name,
        deliveredCount,
      },
    };
  },

  async deleteBroadcast(broadcastId: string, adminContext: { email: string }) {
    const b = await db.orgs.broadcast(broadcastId);
    if (!b) {
      return { error: true, message: "Broadcast not found." };
    }

    const res = await db.orgs.deleteBroadcast(broadcastId, b.organizationId);
    if (!res?.deleted) {
      return { error: true, message: "Broadcast could not be deleted or is currently in flight." };
    }

    await this.recordAudit({
      actor: adminContext.email,
      action: "admin.broadcast_deleted",
      target: broadcastId,
      organizationId: b.organizationId,
      meta: { title: b.title, status: b.status },
    });

    return { error: false, details: { id: broadcastId, deleted: true } };
  },
};
