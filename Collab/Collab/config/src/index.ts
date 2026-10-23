// Centralized, frozen configuration. Import this anywhere; read env nowhere else.
import { str, num, bool, list } from "./env";
import * as features from "./features";
import * as constants from "./constants";

const livekitWsUrl = str("LIVEKIT_WS_URL", "ws://localhost:7534");

const config = {
  env: str("NODE_ENV", "development"),
  // Running application version — surfaced by the ops portal and stamped on each
  // deployment/boot record so errors can be correlated to "which release".
  version: str("APP_VERSION", "1.0.1"),
  // Git commit the running image was built from (baked at image-build time via a
  // build ARG → GIT_COMMIT env). Empty when running from source. Lets the ops
  // portal show exactly which code is live.
  gitCommit: str("GIT_COMMIT", ""),
  features,
  constants,
  backend: {
    host: str("BACKEND_HOST", "0.0.0.0"),
    port: num("BACKEND_PORT", 4000),
    corsOrigins: list("CORS_ORIGINS", ["http://localhost:3000"]),
    // Absolute, externally-reachable base URL for this API. Used to render
    // copy-pasteable URLs that must work from OUTSIDE the app (today: the chat
    // webhook ingest URL). Empty falls back to a relative path.
    publicUrl: str("PUBLIC_API_URL", ""),
    // Number of trusted reverse proxies in front of the backend (the nginx edge
    // = 1). The rate limiter reads the client IP as the Nth entry from the RIGHT
    // of X-Forwarded-For; the client-controlled LEFT of that header is
    // unverifiable, so trusting the first entry let a caller spoof their IP and
    // sidestep per-IP limits. 0 = trust no proxy (use the raw TCP peer).
    trustProxyHops: num("TRUST_PROXY_HOPS", 1),
    // Console-log EVERY API request + payload + response (redacted, truncated) —
    // backend/app/src/middleware/apiDebugLog.ts. Dev/integration debugging only
    // (mobile app against a dev backend); never enable in production.
    apiDebugLog: bool("API_DEBUG_LOG", false),
  },
  auth: {
    jwtSecret: str("AUTH_JWT_SECRET", "dev-only-change-me"),
    tokenTtl: str("AUTH_TOKEN_TTL", "7d"),
    // Public self-service sign-up. ON by default: the enterprise onboarding treats a
    // newly-registered person as a platform user with NO org (they then create an org
    // or request to join one — they are NOT auto-added to any tenant). Set
    // AUTH_SIGNUP_ENABLED=false to lock a deployment down to admin/SSO provisioning only.
    signupEnabled: bool("AUTH_SIGNUP_ENABLED", true),
  },
  // External Data API (/api/external/v1). Lets OTHER platforms read CoLab's
  // MySQL data (users, conversations, messages, meetings, tasks, files, and an
  // allow-listed generic table reader) with an API key instead of a person's
  // session. Keys are minted per organization (org admins) or platform-wide
  // (admin portal) and stored hashed. See docs/EXTERNAL_DATA_API.html.
  externalApi: {
    // Master switch. false → every /api/external route 404s and no key works.
    enabled: bool("EXTERNAL_API_ENABLED", true),
    // Optional STATIC platform keys (comma-separated raw keys) for deployments
    // that have no admin portal / org admin to mint one. Full read access across
    // all organizations; treat like a root password. Prefer minted keys.
    staticKeys: list("EXTERNAL_API_KEYS", []),
    // Per-key request ceiling per minute (on top of the global API throttle).
    rateMax: num("EXTERNAL_API_RATE_MAX", 300),
    // Page size defaults / cap for every list endpoint (`limit` query param).
    pageSize: num("EXTERNAL_API_PAGE_SIZE", 100),
    maxPageSize: num("EXTERNAL_API_MAX_PAGE_SIZE", 500),
  },
  // Collab Admin Portal (/admin). Gated by ADMIN_EMAIL and ADMIN_PASSWORD,
  // decoupled from regular app user sessions.
  admin: {
    email: str("ADMIN_EMAIL", "admin@collab.local"),
    password: str("ADMIN_PASSWORD", "admin1234"),
    sessionTtl: str("ADMIN_SESSION_TTL", "12h"),
  },
  // Engineering Operations Portal (/dev). Gated by its OWN credential, decoupled
  // from the app session, so the public — and ordinary Collab users — can't reach
  // infra internals. Set OPS_PORTAL_PASSWORD to enable; when empty the portal API
  // is refused everywhere (secure default).
  ops: {
    portalUser: str("OPS_PORTAL_USER", "admin"),
    portalPassword: str("OPS_PORTAL_PASSWORD", ""),
    // Session length for a portal login (the ops token TTL).
    sessionTtl: str("OPS_SESSION_TTL", "12h"),
  },
  // Chat media enrichment — all COST-FREE.
  //  • GIF/sticker SEARCH: proxied through the backend to GIPHY so the API key
  //    never reaches the browser. (Tenor was sunset by Google on 2026-06-30 and
  //    no longer accepts new clients, so GIPHY is the maintained provider.) Get a
  //    free key at developers.giphy.com and set GIPHY_API_KEY — note GIPHY's free
  //    tier is rate-limited, so verify production capacity before relying on it at
  //    scale. A tenant admin can also paste a key in the admin console (stored per
  //    org, no redeploy). With NO key the picker still works: a keyless built-in
  //    sticker pack + the create-your-own studio (search is simply off).
  media: {
    // GIF search provider + key. provider is future-proofing (only "giphy" is
    // implemented today); the env key is the deployment-wide default that an org
    // key overrides.
    gifProvider: str("GIF_PROVIDER", "giphy"), // "giphy" (only maintained option)
    giphyKey: str("GIPHY_API_KEY", ""),
  },
  // Single Sign-On (OpenID Connect, Authorization Code + PKCE). All teams share ONE
  // IdP; you only register this app and set clientId + redirectUri (+ secret). Token
  // and JWKS endpoints are auto-derived (or auto-discovered from the issuer's
  // /.well-known/openid-configuration) when left blank. See docs/SSO.md and
  // backend/app/src/services/ssoService.ts. Disabled unless SSO_ENABLED is truthy.
  sso: {
    enabled: bool("SSO_ENABLED", false),
    // IdP BASE URL (the public AgenXchange host, e.g. https://stgoa.re.cx/). Every
    // endpoint left blank below is derived from it: <base>/authorize, <base>/token,
    // <base>/jwks, <base>/logout — so a host change is ONE line. The explicit
    // SSO_*_URL values still win when set. Trailing slash is tolerated.
    baseUrl: str("SSO_BASE_URL", "").replace(/\/+$/, ""),
    // IdP login host — the browser is sent to `${idpUrl}/login?return_to=<authorize>`.
    idpUrl: str("SSO_IDP_URL", ""), // e.g. https://stgoa.re.cx  (= http://10.200.1.58:7505)
    authorizeUrl: str("SSO_AUTHORIZE_URL", ""), // e.g. https://stgoa.re.cx/authorize
    // Optional explicit endpoints. Left blank → discovered from the issuer, else
    // derived from the authorize URL's origin (…/token, …/.well-known/jwks.json).
    tokenUrl: str("SSO_TOKEN_URL", ""),
    jwksUrl: str("SSO_JWKS_URL", ""),
    userinfoUrl: str("SSO_USERINFO_URL", ""),
    issuer: str("SSO_ISSUER", ""), // expected id_token `iss` (also the discovery base)
    // Per-app registration values.
    clientId: str("SSO_CLIENT_ID", ""),
    // Additional client ids whose id_tokens this backend ACCEPTS (`aud` check) —
    // e.g. the mobile app's own IdP registration when it runs the OIDC exchange
    // natively and posts the id_token to /api/auth/sso/token. Comma-separated.
    // Blank = only SSO_CLIENT_ID.
    extraClientIds: list("SSO_EXTRA_CLIENT_IDS", []),
    clientSecret: str("SSO_CLIENT_SECRET", ""), // server-side only; PKCE still required
    redirectUri: str("SSO_REDIRECT_URI", ""), // must EXACTLY match IdP registration
    scope: str("SSO_SCOPE", "openid profile email"),
    // Secret used to HMAC-sign the OAuth `state` (carries the PKCE verifier + nonce
    // across the redirect with a short TTL). Reads SSO_STATE_SECRET, then
    // AUTH_SSO_SECRET (the name the reference project uses), then the app JWT secret.
    stateSecret: str(
      "SSO_STATE_SECRET",
      str("AUTH_SSO_SECRET", str("AUTH_JWT_SECRET", "dev-only-change-me")),
    ),
    // Fail CLOSED by default: if the id_token signature CANNOT be verified (JWKS
    // unreachable/misconfigured) the callback rejects. Flip to true ONLY for a dev
    // IdP that exposes no JWKS — then the id_token is decoded WITHOUT signature
    // verification (never do this in production).
    insecureSkipVerify: bool("SSO_INSECURE_SKIP_VERIFY", false),
    // OIDC end-session (logout) endpoint. Left blank → SSO_BASE_URL + /logout, else
    // discovery's `end_session_endpoint` PATH mapped onto the reachable authorize
    // origin, else `${authorizeOrigin}/logout`. Used ONLY by GET /api/auth/sso/logout
    // after an app sign-out (never before a sign-in).
    logoutUrl: str("SSO_LOGOUT_URL", ""),
    // ENCRYPTED PII CLAIMS. The AgenXchange IdP does not put the user's PII (email,
    // department, employee_id, picture) in the id_token in the clear — it ships them
    // as a JWE in the `claims_jwe` claim, encrypted to THIS app's RSA public key
    // (keys/agenxchange_public.pem, handed to the IdP). The matching private key
    // (keys/collab_private.pem — scripts/gen-sso-keys.sh) decrypts it here: either
    // the PEM inline (raw or base64, for Azure/secret stores) or a path to the file.
    // Unset = a `claims_jwe` id_token is REJECTED (fail closed) — never silently
    // signed in from unverified plaintext claims.
    jwePrivateKey: str("SSO_JWE_PRIVATE_KEY", ""),
    jwePrivateKeyFile: str("SSO_JWE_PRIVATE_KEY_FILE", ""),
    // FERNET-ENCRYPTED PROFILE COPIES (guide v3 "*_enc"). Alongside (or instead of)
    // plaintext, the IdP can send email_enc / name_enc / picture_enc /
    // department_enc / employee_id_enc as Fernet tokens keyed by a shared secret
    // the SSO team hands out (key = base64url(SHA256(secret))). Server-side only.
    // Unset = *_enc fields are ignored (claims_jwe / plaintext still work).
    profileEncSecret: str("SSO_PROFILE_ENC_SECRET", ""),
  },
  meetings: {
    // MCHAT-21 (§11 Q4): what an UNINVITED link-joiner sees of the meeting
    // chat's history. "joinpoint" (default — the PRD's stated requirement)
    // stamps their membership with a history cutoff so they see messages from
    // their join forward; "full" grants the whole thread. A policy question
    // pending legal — this makes the answer a config flip, not a code change.
    // Invited members always see full history either way.
    linkJoinerHistory: str("MEETING_LINK_JOINER_HISTORY", "joinpoint"),
  },
  livekit: {
    // Self-hosted LiveKit SFU. The browser connects to wsUrl; the backend mints
    // per-user room tokens (JWT signed with the API secret) gated by membership.
    // LiveKit built-in TURN is enabled (livekit.yaml turn.enabled: true) and
    // provides relay candidates automatically via JoinResponse.ice_servers.
    // coturn at infrastructure/coturn can serve as an additional TURN relay;
    // if used, set TURN_SECRET + TURN_URLS below.
    wsUrl: livekitWsUrl,
    serverUrl: str("LIVEKIT_SERVER_URL", livekitWsUrl),
    apiKey: str("LIVEKIT_API_KEY", "devkey"),
    apiSecret: str(
      "LIVEKIT_API_SECRET",
      "devsecret_change_me_to_a_long_random_value_min32",
    ),
    tokenTtlSec: num("LIVEKIT_TOKEN_TTL_SEC", 3600),
    // Meeting recording via LiveKit Egress. OFF by default — requires the
    // separate `livekit/egress` worker container (docker-compose `egress`
    // service) sharing Redis with the SFU. Set EGRESS_ENABLED=yes only after
    // that worker is deployed, or recording start returns an honest 503.
    egressEnabled: bool("EGRESS_ENABLED", false),
    // Optional: external TURN relay (coturn) credentials.
    // The backend can mint ephemeral TURN credentials using HMAC-SHA1.
    // turnSecret: str("TURN_SECRET", ""),
    // turnUrls: list("TURN_URLS", []),
  },
  calls: {
    // Mobile push K2: the phone's native ring lasts 45 s and must OUT-RING the
    // server, so the server's missed-call timeout is capped at 40 s (a higher
    // value is clamped + logged in realtime/socket.ts). Tell mobile before
    // changing it.
    missedTimeoutMs: num("CALL_MISSED_MS", 35000),
    // K2.2: the server's `call_missed` notification is the ONLY missed-call
    // signal a phone gets once mobile drops its plugin-side one. It goes through
    // pushNotif → quiet hours / notifyLevel:none like every other notification
    // (matches web). Set true if product wants missed calls to bypass those
    // gates on the closed-app push path (rings already do).
    missedBypassQuietHours: bool("CALL_MISSED_BYPASS_QUIET_HOURS", false),
    // Faster-connect (mobile handoff, Oct 2026). A socket from a KILLED app
    // process is only noticed at the socket.io ping timeout; its "disconnect"
    // used to hang up whatever call the user had meanwhile answered on the new
    // process. Before ending a connected call on a socket drop, wait this long
    // and re-check that the user really has no live socket and is not in the
    // call's SFU room. 0 disables the grace (tests).
    disconnectGraceMs: num("CALL_DISCONNECT_GRACE_MS", 10000),
  },
  realtime: {
    // socket.io keepalive. Defaults (25 s / 20 s) take up to 45 s to notice a
    // killed phone process; 5 s / 10 s notices it in ~15 s so presence and the
    // call cleanup above act on reality sooner. Bytes per ping are negligible.
    pingIntervalMs: num("SOCKET_PING_INTERVAL_MS", 5000),
    pingTimeoutMs: num("SOCKET_PING_TIMEOUT_MS", 10000),
    // Handshake revocation checks (blocklist + session row) are cached per
    // token for this long so a reconnect storm / killed-state restart does not
    // pay two DB round trips per connect. Only POSITIVE verdicts are cached and
    // a revoke on this node evicts the entry, so force-logout stays immediate.
    authCacheMs: num("SOCKET_AUTH_CACHE_MS", 15000),
  },
  // External TURN relay (self-hosted coturn) for call/meeting media. When set,
  // the backend advertises these ICE servers to the browser in the call-token
  // response, so clients that can't reach the SFU's node_ip directly (off-LAN,
  // home, mobile, global) relay media through turns://<domain> over TLS instead
  // of a raw IP. Empty TURN_URLS → no external TURN (internal/LAN-only calls).
  turn: {
    urls: list("TURN_URLS", []), // e.g. turns:turncollab.resulticks.com:443,turn:turncollab.resulticks.com:3478
    username: str("TURN_USERNAME", ""),
    password: str("TURN_PASSWORD", ""),
  },
  database: {
    // MySQL is the single source of truth. Resolution order:
    //   1) DB_PROFILE=<name> + DATABASE_URL_<NAME>  → flip the whole DB by editing
    //      ONE line in .env (e.g. DB_PROFILE=local vs DB_PROFILE=live).
    //   2) Legacy fallback: DEMO_DATABASE_URL (if demoMode) else DATABASE_URL.
    // Demo mode still wins if features.demoMode is on (so DEMO_MODE=yes keeps
    // pointing at the demo DB regardless of DB_PROFILE).
    url: (() => {
      if (features.demoMode)
        return str("DEMO_DATABASE_URL", "mysql://colab:colab@localhost:3306/colab_demo");
      const profile = str("DB_PROFILE", "");
      if (profile) {
        const key = "DATABASE_URL_" + profile.toUpperCase();
        const fromProfile = process.env[key];
        if (fromProfile && fromProfile !== "") return fromProfile;
      }
      return str("DATABASE_URL", "mysql://colab:colab@localhost:3306/colab");
    })(),
  },
  // "One API" — OPTIONAL structured-JSON DB-access helper.
  //
  // IMPORTANT — current state (verified): ONE_API_ENABLED is INERT at runtime.
  // The SQL executor (database/src/drivers/mysql.ts q()) ALWAYS uses the direct
  // mysql2 pool; nothing imports oneApiClient.fetchData / oneApiClient.mutate.
  // The gateway's structured payload (table/columns/joins/conditions) cannot
  // express CoLab's FULLTEXT search, window functions, ON DUPLICATE KEY upserts,
  // or FOR UPDATE transactions, so One API CANNOT transparently replace the
  // driver. This switch only gates the unused oneApiClient helper for future
  // explicit call sites. Do NOT believe the older claim that this routes runtime
  // SQL through the gateway — that was rolled back. See docs/ONE_API.md.
  oneApi: {
    enabled: bool("ONE_API_ENABLED", false),
    url: str("ONE_API_URL", ""), // e.g. http://10.101.1.4:7988/fetch-data
    dbType: str("ONE_API_DB_TYPE", "mysql"),
    database: str("ONE_API_DATABASE", ""),
    apiKey: str("ONE_API_KEY", ""), // sent as Bearer if set
    // Safety: on a gateway error, fall back to a direct DB query so the app stays
    // up (keeps the "emergency" promise). Set false to make the gateway mandatory.
    fallback: bool("ONE_API_FALLBACK", true),
    timeoutMs: num("ONE_API_TIMEOUT_MS", 15000),
  },
  storage: {
    // MinIO runs on 9003 everywhere (one consistent port; 9000/9001 left free for a
    // co-located project). Host-run backends reach it via http://localhost:9003;
    // Dockerized backends override with S3_ENDPOINT=http://minio:9003.
    endpoint: str("S3_ENDPOINT", "http://localhost:9003"),
    publicEndpoint: str("S3_PUBLIC_ENDPOINT", "http://localhost:9003"),
    bucket: str("S3_BUCKET", "colab-files"),
    accessKeyId: str("S3_ACCESS_KEY_ID", "colabminio"),
    secretAccessKey: str("S3_SECRET_ACCESS_KEY", "colabminio123"),
    // How long to wait for MinIO to ACCEPT a connection, and how many attempts
    // the SDK makes, before an upload is declared failed. The SDK's defaults are
    // no connect timeout × 3 attempts: when MinIO is down (or its host silently
    // drops SYNs) every upload sat on a frozen progress bar for minutes before
    // the 503 came back — which is what "file sharing doesn't work" looked like.
    connectTimeoutMs: num("S3_CONNECT_TIMEOUT_MS", 5000),
    // Socket IDLE timeout per request: how long to wait for MinIO to send the
    // next byte once connected. Bounds a MinIO that accepts the TCP connection
    // but never answers (hung drive / scanner deadlock): without it every
    // download sat until nginx's 60s proxy timeout, and the browser's 4 media
    // slots stayed pinned on dead requests. Large transfers keep flowing — the
    // timer only fires when NOTHING arrives for this long.
    requestTimeoutMs: num("S3_REQUEST_TIMEOUT_MS", 30000),
    maxAttempts: num("S3_MAX_ATTEMPTS", 2),
    // Streamed uploads at or under this size are buffered first so that, when
    // object storage is unreachable, they can land in the database instead of
    // failing — chat attachments keep working through a MinIO outage. Above it
    // the file streams straight to storage and an outage is an honest 503 (a
    // multi-GB LONGBLOB would blow MySQL's max_allowed_packet). 0 disables.
    blobFallbackMaxBytes: num("FILE_BLOB_FALLBACK_MAX_BYTES", 8 * 1024 * 1024),
    // Tier order for POST /api/files (docs/FILE_UPLOAD_STORAGE_CHAIN.md).
    // "disk,s3,db" (default) = local file-storage volume first, MinIO second,
    // MySQL LONGBLOB third (small uploads only — the db tier is never used above
    // blobFallbackMaxBytes). "s3,db" restores the pre-0127 behaviour exactly and
    // is the rollback switch. Unknown tier names fail at boot.
    order: str("FILE_STORAGE_ORDER", "disk,s3,db"),
    // Root of the local file-storage tier. Inside the container this is a named
    // volume (files_data:/app/data/files); a host-run backend defaults to
    // ./data/files relative to the process cwd.
    localDir: str("FILE_STORAGE_DIR", "./data/files"),
    // The disk tier REFUSES an upload (and the chain moves on to MinIO) unless at
    // least this much space would remain free after the upload lands. Keeps the
    // volume from filling to the brim, which would also starve MySQL/logs when
    // they share the host disk. 512 MB default.
    localMinFreeBytes: num("FILE_STORAGE_MIN_FREE_BYTES", 512 * 1024 * 1024),
  },
  files: {
    // Recycle-bin GC/retention: how long a soft-deleted file's S3 blob + row are
    // KEPT before the GC sweeper permanently reclaims them. 0 (or negative)
    // DISABLES GC entirely (files stay soft-deleted forever — restorable, but
    // storage grows unbounded). Default 30 days. The sweeper only ever touches
    // deleted=1 rows past this window — never a live file. See index.ts boot loop.
    gcRetentionDays: num("FILES_GC_RETENTION_DAYS", 30),
    // Per-sweep batch cap (bounded work per GC run). Repo-clamped to <=1000.
    gcBatch: num("FILES_GC_BATCH", 100),
    // Virus-scan HOOK opt-in. OFF by default. Even when ON, scanning is a no-op
    // until a real scanner backend (ClamAV/clamd, AV gateway) is provisioned —
    // it requires infrastructure not present in this environment. See
    // services/virusScanService.ts. Flip on only after wiring a scanner.
    virusScanEnabled: bool("FILES_VIRUS_SCAN_ENABLED", false),
    // Cold-tier job (docs/FILE_UPLOAD_STORAGE_CHAIN.md §11.3): moves disk-tier
    // files to MinIO once they are older than tierColdAfterDays, or — regardless
    // of age, oldest first — while the files volume is fuller than
    // tierPressurePct. Keeps the disk a bounded hot set of recent uploads and lets
    // MinIO absorb unbounded growth. false keeps disk as the permanent store.
    tierEnabled: bool("FILE_TIER_ENABLED", true),
    tierColdAfterDays: num("FILE_TIER_COLD_AFTER_DAYS", 30),
    tierPressurePct: num("FILE_TIER_PRESSURE_PCT", 80),
    // Pressure mode never moves a file younger than this: a just-shared
    // attachment is what everyone is opening right now and must stay on the
    // fast local tier. 0 = move even brand-new files (the pre-8 Oct 2026 rule).
    tierPressureMinAgeDays: num("FILE_TIER_PRESSURE_MIN_AGE_DAYS", 1),
    tierBatch: num("FILE_TIER_BATCH", 200),
    // Minutes between cold-tier runs (default hourly).
    tierIntervalMinutes: num("FILE_TIER_INTERVAL_MINUTES", 60),
  },
  redis: {
    url: str("REDIS_URL", ""),
    // Multi-instance safety valve. Set REDIS_REQUIRED=true on any deployment that
    // runs ≥2 backend replicas: the backend then REFUSES to boot without a
    // REDIS_URL instead of silently degrading to the per-process in-memory adapter
    // (which drops cross-instance message/call/presence fan-out). Defaults to TRUE in production
    // (set REDIS_REQUIRED=false to opt out on a single instance); dev leaves it false and keeps the zero-config in-memory path.
    required: bool("REDIS_REQUIRED", str("NODE_ENV", "development") === "production"),
  },
  mfa: {
    // Multi-factor auth (TOTP) master switch. OFF by default: the enrollment
    // endpoints report "disabled" and login step-up is a no-op, so the whole
    // feature is DORMANT until a deployment sets MFA_ENABLED=true. Even then MFA
    // is opt-in per user until an org policy enforces it (a later phase). The
    // TOTP seed is sealed with a key derived from AUTH_JWT_SECRET, so no extra
    // secret is required to turn it on.
    enabled: bool("MFA_ENABLED", false),
  },
  e2ee: {
    // Global E2EE kill switch. Set E2EE_ENABLED=false to disable all encryption
    // while preserving the full E2EE codebase for future reactivation.
    // When false: messages are stored as plaintext, no encryption paths are taken.
    enabled: bool("E2EE_ENABLED", false),
    // Device-bound JWT STRICT mode (GAP-3). When ON, an authenticated request
    // whose token has a deviceId pointing at a REVOKED device — or whose token
    // has NO deviceId at all once E2EE is enabled — is rejected. Default OFF
    // (fail-OPEN) for the ecosystem migration window so existing tokens without
    // deviceId aren't locked out. Flip to true only AFTER the token-rotation
    // window has elapsed (typically 7-14 days at AUTH_TOKEN_TTL).
    deviceBoundStrict: bool("E2EE_DEVICE_BOUND_JWT_STRICT", false),
    // AUTOMATIC history recovery on any authenticated device. When ON, the
    // server mints one sealed ACCOUNT KEY per user (e2ee_account_key) and serves
    // it to that user's authenticated sessions; the client wraps the recovery
    // secret under it (wrap kind 'account') so a new device, an SSO login, a
    // restored session or a reinstall restores its full history with no
    // password, passphrase or recovery-key prompt. TRADE-OFF: the operator (DB +
    // escrow secret) can then open a user's history BACKUP — live messages stay
    // end-to-end encrypted. Set to false to return to the strictly server-blind
    // model (restores then need a typed credential again).
    autoRecovery: bool("E2EE_AUTO_RECOVERY", true),
    // Secret the account keys are sealed under (HKDF → AES-256-GCM). Keep it
    // out of the DB. Falls back to AUTH_JWT_SECRET when unset so the feature
    // needs no extra provisioning; a dedicated secret is recommended so a leaked
    // JWT secret does not also unseal backups.
    escrowSecret: str("E2EE_ESCROW_SECRET", ""),
  },
  // Chat webhooks (incoming + outgoing). See docs/CHAT_WEBHOOKS.md.
  webhooks: {
    // Master switch. When false the management API reports "disabled", the
    // ingest endpoint 404s, and no outbound delivery is ever attempted — the
    // whole feature is dormant without removing any code.
    enabled: bool("WEBHOOKS_ENABLED", true),
    // Per-conversation cap, so one integration-happy member cannot turn a busy
    // group into an outbound fan-out amplifier.
    maxPerConversation: num("WEBHOOKS_MAX_PER_CONVERSATION", 10),
    // Per-delivery HTTP timeout, and how many times a delivery is retried
    // (exponential backoff) before it is marked permanently failed.
    timeoutMs: num("WEBHOOKS_TIMEOUT_MS", 8000),
    maxAttempts: num("WEBHOOKS_MAX_ATTEMPTS", 5),
    // Ingest budget: messages accepted per incoming webhook per minute.
    ingestPerMinute: num("WEBHOOKS_INGEST_PER_MINUTE", 60),
    // How long the delivery log is kept (it embeds message text, so it is
    // pruned like any other message-derived artifact).
    deliveryRetentionDays: num("WEBHOOKS_DELIVERY_RETENTION_DAYS", 30),
    // SSRF POSTURE. Outgoing targets are DNS-resolved and private/loopback/
    // link-local addresses are refused, exactly like link unfurling. An on-prem
    // deployment whose integration targets genuinely live on the internal
    // network must opt in explicitly — this is never on by default, because a
    // chat webhook is a user-supplied URL the server fetches.
    allowPrivateTargets: bool("WEBHOOKS_ALLOW_PRIVATE_TARGETS", false),
  },
  // UNIFIED CONNECTOR ENGINE — Teams / Slack / Google Chat / WhatsApp bridging
  // + Google / Outlook calendar sync. See docs/CONNECTOR_ENGINE.md.
  connectors: {
    // Master switch. When false the management API reports "disabled", the
    // inbound endpoints 404, and the drain worker never runs — dormant, not removed.
    enabled: bool("CONNECTORS_ENABLED", true),
    // Secret the stored platform credentials are SEALED under (HKDF →
    // AES-256-GCM). Falls back to AUTH_JWT_SECRET so the feature needs no extra
    // provisioning; a dedicated value is recommended so a leaked JWT secret does
    // not also unseal every Slack/Graph/WhatsApp token.
    secret: str("CONNECTORS_SECRET", str("AUTH_JWT_SECRET", "dev-only-change-me")),
    // Per platform-call HTTP timeout, and how many attempts a job gets
    // (exponential backoff) before it is marked permanently failed.
    timeoutMs: num("CONNECTORS_TIMEOUT_MS", 10000),
    maxAttempts: num("CONNECTORS_MAX_ATTEMPTS", 6),
    // Drain cadence for the job queue (an enqueue also nudges it directly).
    drainSeconds: num("CONNECTORS_DRAIN_SECONDS", 15),
    // How long finished jobs are kept (payloads embed message text).
    jobRetentionDays: num("CONNECTORS_JOB_RETENTION_DAYS", 14),
    // Inbound idempotency window: a platform event id seen within this many
    // seconds is dropped as a duplicate redelivery.
    dedupeTtlSec: num("CONNECTORS_DEDUPE_TTL_SEC", 24 * 3600),
    // Inbound budget per account per minute (courtesy cap under the per-IP
    // limiter on the public endpoint).
    inboundPerMinute: num("CONNECTORS_INBOUND_PER_MINUTE", 300),
    // Per-conversation cap on channel mappings.
    maxMappingsPerConversation: num("CONNECTORS_MAX_MAPPINGS_PER_CONVERSATION", 10),
    // Calendar delta pull cadence (minutes) for accounts with pull enabled.
    calendarPullMinutes: num("CONNECTORS_CALENDAR_PULL_MINUTES", 10),
    // Inbound signature verification. Fail CLOSED by default: an inbound event
    // whose signature cannot be verified is rejected. Only a local dev run
    // against unsigned fixtures should ever relax this.
    insecureSkipVerify: bool("CONNECTORS_INSECURE_SKIP_VERIFY", false),
    // Microsoft Graph / WhatsApp Graph API versions.
    graphApiVersion: str("CONNECTORS_MS_GRAPH_VERSION", "v1.0"),
    whatsappApiVersion: str("CONNECTORS_WHATSAPP_API_VERSION", "v21.0"),
  },
  vapid: {
    publicKey: str("VAPID_PUBLIC_KEY", ""),
    privateKey: str("VAPID_PRIVATE_KEY", ""),
    subject: str("VAPID_SUBJECT", "mailto:admin@colab.app"),
  },
  // Mobile push — Firebase Cloud Messaging (HTTP v1). The Flutter app
  // (Collab_mobile) registers its FCM token at POST /api/push/devices; every
  // webPush.sendToUser(s) is mirrored to those devices as an FCM message.
  // Auth is a Firebase SERVICE ACCOUNT (Firebase console → Project settings →
  // Service accounts → Generate new private key): either the JSON inline
  // (FCM_SERVICE_ACCOUNT_JSON, base64 or raw) or a path to the file. Unset =
  // mobile push stays off; nothing else changes.
  fcm: {
    serviceAccountJson: str("FCM_SERVICE_ACCOUNT_JSON", ""),
    serviceAccountFile: str("FCM_SERVICE_ACCOUNT_FILE", ""),
    // Normally read from the service account; override only for odd setups.
    projectId: str("FCM_PROJECT_ID", ""),
    // Seconds an FCM message is kept for an offline device, per class.
    messageTtlSec: num("FCM_MESSAGE_TTL_SEC", 24 * 3600),
    callTtlSec: num("FCM_CALL_TTL_SEC", 45),
    // Mobile handoff K7: attach the recipient's E2EE envelope(s) to a message
    // push so the PHONE (which holds the keys) can show the real text from
    // the shade. The server never has plaintext for an encrypted message, so
    // this is the ONLY way a killed-state E2EE push reads as anything but
    // "Sent a message". ON by default; set false to keep even ciphertext off
    // FCM/APNs (the phone then shows the generic body). Plain-text
    // conversations always push their (140-char) preview regardless.
    e2eeCiphertext: bool("PUSH_E2EE_CIPHERTEXT", true),
    // Product decision (22 Sep 2026): notification bodies for E2EE messages
    // are PLAIN TEXT. The server has no plaintext for an encrypted message, so
    // the SENDING client hands it a short `pushPreview` (≤140 chars, tags
    // stripped) alongside the envelope. The server uses it ONLY as the push
    // body — never persisted, never echoed in message:new, never in the debug
    // ledger. Set false to fall back to the generic body (+ ciphertext above).
    e2eePlaintextPreview: bool("PUSH_E2EE_PLAINTEXT_PREVIEW", true),
  },
  // iOS incoming calls MUST arrive as an APNs VoIP push (PushKit → CallKit) —
  // a plain alert cannot ring a terminated app. Sent straight to APNs over
  // HTTP/2 with a token-based (.p8) auth key; no extra dependency. Requires an
  // APNs auth key with the "Apple Push Notifications service" capability.
  // Unset = iOS calls fall back to a normal FCM alert (no CallKit ring).
  apns: {
    keyId: str("APNS_KEY_ID", ""),
    teamId: str("APNS_TEAM_ID", ""),
    // The .p8 contents (base64 or raw PEM) or a path to the file.
    keyP8: str("APNS_KEY_P8", ""),
    keyFile: str("APNS_KEY_FILE", ""),
    // The app's bundle id; VoIP topic is `<bundleId>.voip`.
    bundleId: str("APNS_BUNDLE_ID", "com.resulticks.collab"),
    // "sandbox" for development builds (Xcode-run / TestFlight-internal with a
    // development profile), "production" for App Store / ad-hoc distribution.
    environment: str("APNS_ENVIRONMENT", str("NODE_ENV", "development") === "production" ? "production" : "sandbox"),
  },
  ai: {
    // OpenAI-compatible chat-completions endpoint (e.g. an Ollama gateway).
    // Powers in-product AI such as conversation summaries. When LLM_BASE_URL is
    // unset, AI features report "not configured" and make no outbound calls.
    baseUrl: str("LLM_BASE_URL", ""),
    apiKey: str("LLM_API_KEY", ""),
    model: str("LLM_MODEL", ""),
    enabled: str("LLM_BASE_URL", "") !== "",
    timeoutMs: num("LLM_TIMEOUT_MS", 30000),
  },
};

export default Object.freeze(config);
