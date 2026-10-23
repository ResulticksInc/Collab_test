// ─────────────────────────────────────────────────────────────────────────────
// Collab Admin Portal — Frontend API Client Wrapper
//
// Communicates with /api/admin/* endpoints using the dedicated clb_admin_token.
// ─────────────────────────────────────────────────────────────────────────────
import config from "./config";

const BASE = config.apiBaseUrl;
const ADMIN_TOKEN_KEY = "clb_admin_token";

export function getAdminToken(): string | null {
  if (typeof window === "undefined") return null;
  try {
    return localStorage.getItem(ADMIN_TOKEN_KEY);
  } catch {
    return null;
  }
}

export function saveAdminToken(token: string) {
  if (typeof window === "undefined") return;
  try {
    localStorage.setItem(ADMIN_TOKEN_KEY, token);
  } catch {}
}

export function clearAdminToken() {
  if (typeof window === "undefined") return;
  try {
    localStorage.removeItem(ADMIN_TOKEN_KEY);
  } catch {}
}

async function request<T = any>(
  path: string,
  options: RequestInit = {},
): Promise<{ ok: boolean; data?: T; error?: string; status: number }> {
  const token = getAdminToken();
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    ...(options.headers as Record<string, string>),
  };

  if (token) {
    headers["Authorization"] = `Bearer ${token}`;
  }

  try {
    const res = await fetch(`${BASE}/api/admin${path}`, {
      ...options,
      headers,
    });

    const json = await res.json().catch(() => null);

    if (res.status === 401 && !path.includes("/auth/login") && !path.includes("/auth/status")) {
      clearAdminToken();
      if (typeof window !== "undefined") {
        window.dispatchEvent(new CustomEvent("colab:admin_unauthorized"));
      }
    }

    if (!res.ok || json?.ok === false) {
      const errMsg =
        typeof json?.error === "string"
          ? json.error
          : json?.error?.message ||
            json?.message ||
            (typeof json?.error === "object" ? JSON.stringify(json.error) : null) ||
            `Request failed with status ${res.status}`;
      return {
        ok: false,
        error: errMsg,
        status: res.status,
      };
    }

    return {
      ok: true,
      data: json?.data !== undefined ? json.data : json,
      status: res.status,
    };
  } catch (err: any) {
    return {
      ok: false,
      error: err?.message || "Network error. Please check your connection.",
      status: 0,
    };
  }
}

export const adminApi = {
  // Auth
  async getStatus() {
    return request<{ configured: boolean; defaultEmail: string; env: string }>("/auth/status");
  },

  async login(credentials: { email?: string; username?: string; password?: string }) {
    const res = await request<{ token: string; admin: { email: string; role: string } }>(
      "/auth/login",
      {
        method: "POST",
        body: JSON.stringify(credentials),
      },
    );
    if (res.ok && res.data?.token) {
      saveAdminToken(res.data.token);
    }
    return res;
  },

  async getMe() {
    return request<{ admin: { email: string; role: string } }>("/auth/me");
  },

  async logout() {
    try {
      await request("/auth/logout", { method: "POST" });
    } finally {
      clearAdminToken();
    }
  },

  // Dashboard
  async getDashboard() {
    return request<any>("/dashboard");
  },

  // Organizations
  async getOrganizations(params: { q?: string; status?: string; limit?: number; offset?: number } = {}) {
    const qp = new URLSearchParams();
    if (params.q) qp.set("q", params.q);
    if (params.status && params.status !== "all") qp.set("status", params.status);
    if (params.limit) qp.set("limit", String(params.limit));
    if (params.offset) qp.set("offset", String(params.offset));
    return request<any>(`/organizations?${qp.toString()}`);
  },

  async getOrganization(id: string) {
    return request<any>(`/organizations/${id}`);
  },

  async getOrganizationMembers(id: string) {
    return request<any>(`/organizations/${id}/members`);
  },

  // Members
  async getMembers(params: { q?: string; organizationId?: string; presence?: string; limit?: number; offset?: number } = {}) {
    const qp = new URLSearchParams();
    if (params.q) qp.set("q", params.q);
    if (params.organizationId && params.organizationId !== "all") qp.set("organizationId", params.organizationId);
    if (params.presence && params.presence !== "all") qp.set("presence", params.presence);
    if (params.limit) qp.set("limit", String(params.limit));
    if (params.offset) qp.set("offset", String(params.offset));
    return request<any>(`/members?${qp.toString()}`);
  },

  // Online Users
  async getOnlineUsers(params: { q?: string; limit?: number; offset?: number } = {}) {
    const qp = new URLSearchParams();
    if (params.q) qp.set("q", params.q);
    if (params.limit) qp.set("limit", String(params.limit));
    if (params.offset) qp.set("offset", String(params.offset));
    return request<any>(`/online-users?${qp.toString()}`);
  },

  // Meetings
  async getMeetings(params: {
    q?: string;
    organizationId?: string;
    status?: string;
    dateFrom?: string;
    dateTo?: string;
    upcomingOnly?: boolean;
    completedOnly?: boolean;
    limit?: number;
    offset?: number;
  } = {}) {
    const qp = new URLSearchParams();
    if (params.q) qp.set("q", params.q);
    if (params.organizationId && params.organizationId !== "all") qp.set("organizationId", params.organizationId);
    if (params.status && params.status !== "all") qp.set("status", params.status);
    if (params.dateFrom) qp.set("dateFrom", params.dateFrom);
    if (params.dateTo) qp.set("dateTo", params.dateTo);
    if (params.upcomingOnly) qp.set("upcomingOnly", "true");
    if (params.completedOnly) qp.set("completedOnly", "true");
    if (params.limit) qp.set("limit", String(params.limit));
    if (params.offset) qp.set("offset", String(params.offset));
    return request<any>(`/meetings?${qp.toString()}`);
  },

  async getMeeting(id: string) {
    return request<any>(`/meetings/${id}`);
  },

  async addMeetingMembers(meetingId: string, userIds: string[]) {
    return request<any>(`/meetings/${meetingId}/members`, {
      method: "POST",
      body: JSON.stringify({ userIds }),
    });
  },

  async removeMeetingMember(meetingId: string, memberId: string) {
    return request<any>(`/meetings/${meetingId}/members/${memberId}`, {
      method: "DELETE",
    });
  },

  // Live meeting controls (admin counterpart of the host's in-call controls)
  async getLiveMeeting(meetingId: string) {
    return request<any>(`/meetings/${meetingId}/live`);
  },
  async liveMuteAll(meetingId: string) {
    return request<any>(`/meetings/${meetingId}/live/mute-all`, { method: "POST" });
  },
  async liveMute(meetingId: string, userId: string) {
    return request<any>(`/meetings/${meetingId}/live/participants/${userId}/mute`, { method: "POST" });
  },
  async liveStopScreenShare(meetingId: string, userId: string) {
    return request<any>(`/meetings/${meetingId}/live/participants/${userId}/stop-screen-share`, { method: "POST" });
  },
  async liveCameraOff(meetingId: string, userId: string) {
    return request<any>(`/meetings/${meetingId}/live/participants/${userId}/camera-off`, { method: "POST" });
  },
  async liveCamerasOff(meetingId: string) {
    return request<any>(`/meetings/${meetingId}/live/cameras-off`, { method: "POST" });
  },
  async liveSetUserWhiteboard(meetingId: string, userId: string, enabled: boolean) {
    return request<any>(`/meetings/${meetingId}/live/participants/${userId}/whiteboard`, {
      method: "PATCH",
      body: JSON.stringify({ enabled }),
    });
  },
  async liveRemove(meetingId: string, userId: string) {
    return request<any>(`/meetings/${meetingId}/live/participants/${userId}`, { method: "DELETE" });
  },
  async liveReadmit(meetingId: string, userId: string) {
    return request<any>(`/meetings/${meetingId}/live/participants/${userId}/readmit`, { method: "POST" });
  },
  async liveSetWhiteboard(meetingId: string, enabled: boolean) {
    return request<any>(`/meetings/${meetingId}/live/whiteboard`, {
      method: "PATCH",
      body: JSON.stringify({ enabled }),
    });
  },

  // Analytics
  async getAnalytics(organizationId?: string) {
    const qp = new URLSearchParams();
    if (organizationId && organizationId !== "all") qp.set("organizationId", organizationId);
    return request<any>(`/analytics?${qp.toString()}`);
  },

  // Audit Logs
  async getAuditLogs(params: { q?: string; action?: string; limit?: number; offset?: number } = {}) {
    const qp = new URLSearchParams();
    if (params.q) qp.set("q", params.q);
    if (params.action && params.action !== "all") qp.set("action", params.action);
    if (params.limit) qp.set("limit", String(params.limit));
    if (params.offset) qp.set("offset", String(params.offset));
    return request<any>(`/audit-logs?${qp.toString()}`);
  },

  // Live push-channel state (public readiness probe; no admin token needed).
  // Shows on Server Logs so a host whose FCM / APNs / VAPID leg is down is
  // visible at a glance, next to the failures it caused.
  async getPushStatus() {
    try {
      const res = await fetch(`${BASE}/api/health/ready`, { cache: "no-store" });
      const json: any = await res.json().catch(() => null);
      const push = json && json.checks && json.checks.push;
      return push ? { ok: true as const, data: push } : { ok: false as const, error: "no push status" };
    } catch (e: any) {
      return { ok: false as const, error: e?.message || "unreachable" };
    }
  },

  // Server logs (platform failures)
  async getServerLogs(
    params: { q?: string; level?: string; source?: string; status?: string; range?: string; limit?: number; offset?: number } = {},
  ) {
    const qp = new URLSearchParams();
    if (params.q) qp.set("q", params.q);
    for (const k of ["level", "source", "status", "range"] as const) {
      const v = params[k];
      if (v && v !== "all") qp.set(k, v);
    }
    if (params.limit) qp.set("limit", String(params.limit));
    if (params.offset) qp.set("offset", String(params.offset));
    return request<any>(`/server-logs?${qp.toString()}`);
  },

  // Broadcasts
  async getBroadcasts(params: { q?: string; organizationId?: string; status?: string; limit?: number; offset?: number } = {}) {
    const qp = new URLSearchParams();
    if (params.q) qp.set("q", params.q);
    if (params.organizationId && params.organizationId !== "all") qp.set("organizationId", params.organizationId);
    if (params.status && params.status !== "all") qp.set("status", params.status);
    if (params.limit) qp.set("limit", String(params.limit));
    if (params.offset) qp.set("offset", String(params.offset));
    return request<any>(`/broadcasts?${qp.toString()}`);
  },

  async createBroadcast(data: {
    organizationId: string;
    title: string;
    body?: string;
    sendAt?: string | null;
    excludedUserIds?: string[];
  }) {
    return request<any>(`/broadcasts`, {
      method: "POST",
      body: JSON.stringify(data),
    });
  },

  async deleteBroadcast(id: string) {
    return request<any>(`/broadcasts/${id}`, {
      method: "DELETE",
    });
  },
};
