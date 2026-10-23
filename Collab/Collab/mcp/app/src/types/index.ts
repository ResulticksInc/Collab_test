// Shared MCP type surface. Kept dependency-free so every module (tools,
// resources, prompts, transports) imports from one place.

// A minimal JSON-Schema subset understood by validation/schema.ts.
export type JsonSchema = {
  type?: "object" | "string" | "number" | "integer" | "boolean" | "array";
  description?: string;
  properties?: Record<string, JsonSchema>;
  required?: string[];
  additionalProperties?: boolean;
  enum?: unknown[];
  items?: JsonSchema;
  minLength?: number;
  maxLength?: number;
  minimum?: number;
  maximum?: number;
  default?: unknown;
  format?: string;
};

// Resolved identity + transport context for a single MCP request. `userId`/
// `tenantId` are populated from the verified (or decoded) JWT and are used for
// audit logging and scoping — never trusted in place of the backend's own
// authorization, which re-checks every call.
export type McpContext = {
  token: string;
  userId?: string;
  tenantId?: string;
  name?: string;
  deviceId?: string;
  requestId?: string | number;
  clientInfo?: { name?: string; version?: string };
};

// Tool annotations advertised to clients (MCP `annotations`) so an assistant can
// reason about side effects before calling.
export type ToolAnnotations = {
  readOnlyHint?: boolean;
  destructiveHint?: boolean;
  idempotentHint?: boolean;
};

export type McpTool = {
  name: string;
  title?: string;
  description: string;
  category: string;
  inputSchema: JsonSchema;
  annotations?: ToolAnnotations;
  run: (
    input: Record<string, unknown>,
    context: McpContext,
  ) => Promise<unknown>;
};

export type McpResource = {
  uri: string;
  name: string;
  description: string;
  mimeType?: string;
  // True for URI templates (RFC 6570-ish {param} placeholders).
  isTemplate?: boolean;
  read: (
    params: Record<string, unknown>,
    context: McpContext,
  ) => Promise<unknown>;
};

export type McpPromptArgument = {
  name: string;
  description: string;
  required?: boolean;
};

export type McpPrompt = {
  name: string;
  description: string;
  arguments?: McpPromptArgument[];
  // Builds the prompt messages from arguments. Prompts orchestrate TOOLS by
  // instructing the assistant which tools to call — they never duplicate backend
  // logic themselves.
  build: (args: Record<string, unknown>) => { role: string; text: string }[];
};

export type BackendGateway = {
  get: (path: string, context: McpContext) => Promise<unknown>;
  post: (
    path: string,
    body: Record<string, unknown>,
    context: McpContext,
  ) => Promise<unknown>;
  patch: (
    path: string,
    body: Record<string, unknown>,
    context: McpContext,
  ) => Promise<unknown>;
  delete: (path: string, context: McpContext) => Promise<unknown>;
  // Raw binary upload (file bytes go in the body, metadata in the query string).
  postRaw: (
    path: string,
    bytes: Uint8Array,
    contentType: string,
    context: McpContext,
  ) => Promise<unknown>;
};
