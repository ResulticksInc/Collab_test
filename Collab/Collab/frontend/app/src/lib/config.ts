const config = {
  // Default to SAME-ORIGIN ("" / relative) so the browser always talks to the
  // exact host:port it loaded the app from. The Next server reverse-proxies
  // /api and /socket.io to the backend (see next.config.js rewrites). This is
  // what makes CoLab work on ANY server / region / port and from ANY device
  // (LAN, tunnel, public IP) with no per-host rebuild: there is no baked
  // "localhost:4000" to be unreachable from another machine, and no cross-origin
  // request, so CORS never gates the app. Set NEXT_PUBLIC_API_BASE_URL only when
  // the API is genuinely on a different origin with no proxy in front.
  apiBaseUrl: process.env.NEXT_PUBLIC_API_BASE_URL || "",
  socketUrl: process.env.NEXT_PUBLIC_SOCKET_URL || "",
  vapidPublicKey: process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY || "",
  appName: process.env.NEXT_PUBLIC_APP_NAME || "Collab",
  appVersion: process.env.NEXT_PUBLIC_APP_VERSION || "v1.0.1",
  workspaceName: process.env.NEXT_PUBLIC_WORKSPACE_NAME || "Collab",
  // SSO (OpenID Connect) sign-in. Shown by default; set NEXT_PUBLIC_SSO_ENABLED="0"
  // to hide the button. The backend still gates the real flow — an unconfigured
  // server bounces the user back with a friendly ?sso_error notice.
  ssoEnabled: process.env.NEXT_PUBLIC_SSO_ENABLED !== "0",
  // Product feature flags. Hidden surfaces keep their components, routes, APIs
  // and data intact — reactivation is just flipping the env var to "1".
  features: {
    agents: process.env.NEXT_PUBLIC_FEATURE_AGENTS === "1",
    aiSummary: process.env.NEXT_PUBLIC_FEATURE_AI_SUMMARY === "1",
    globalSearch: process.env.NEXT_PUBLIC_FEATURE_GLOBAL_SEARCH === "1",
    // Self-service sign-up is SHOWN by default: a new user registers, becomes a
    // platform user with no org, and lands on the create/join onboarding. Set
    // NEXT_PUBLIC_FEATURE_SIGNUP="0" to hide it (admin/SSO-provisioned deployments).
    signup: process.env.NEXT_PUBLIC_FEATURE_SIGNUP !== "0",
  },
};
export default config;
