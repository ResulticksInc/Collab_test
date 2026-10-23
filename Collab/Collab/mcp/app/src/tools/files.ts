import type { BackendGateway, McpTool } from "../types";
import { api, qs } from "../server/gateway";
import { GatewayError } from "../errors";
import { objectSchema, f, clampLimit, seg, page } from "./helpers";

// File tools — orchestrate fileService via /files. Uploads send raw bytes
// (base64 in, decoded to a Buffer) with metadata in the query string, matching
// the backend's express.raw upload route. Downloads return a presigned URL when
// the file is object-store-backed, else metadata + guidance (we never tunnel
// large binaries through the model context).
export function fileTools(gw: BackendGateway): McpTool[] {
  return [
    {
      name: "list_files",
      title: "List files",
      category: "files",
      description:
        "List files the user can access (uploaded or shared with them).",
      annotations: { readOnlyHint: true },
      inputSchema: objectSchema({ limit: f.limit() }),
      run: async (i, c) => {
        const data = (await gw.get(api("/files"), c)) as any[];
        return page(data, clampLimit(i.limit));
      },
    },
    {
      name: "search_files",
      title: "Search files",
      category: "files",
      description: "Search accessible files by name.",
      annotations: { readOnlyHint: true },
      inputSchema: objectSchema(
        { query: f.text("Filename text", 200), limit: f.limit() },
        ["query"],
      ),
      run: async (i, c) => {
        const r = (await gw.get(api("/search") + qs({ q: i.query }), c)) as any;
        return page((r && r.files) || [], clampLimit(i.limit));
      },
    },
    {
      name: "file_metadata",
      title: "File metadata",
      category: "files",
      description: "Get a file's metadata + sharing details by id.",
      annotations: { readOnlyHint: true },
      inputSchema: objectSchema({ fileId: f.id("File id") }, ["fileId"]),
      run: (i, c) => gw.get(api(`/files/${seg(i.fileId)}/details`), c),
    },
    {
      name: "download_file",
      title: "Get file download link",
      category: "files",
      description:
        "Get a time-limited presigned download URL for a file (object-store-backed files). If the file is not object-store-backed, returns its metadata and the authenticated download path instead.",
      annotations: { readOnlyHint: true },
      inputSchema: objectSchema({ fileId: f.id("File id") }, ["fileId"]),
      run: async (i, c) => {
        try {
          const presigned = await gw.get(
            api(`/files/${seg(i.fileId)}/presigned`),
            c,
          );
          return { kind: "presigned", ...(presigned as any) };
        } catch (e) {
          if (e instanceof GatewayError && e.status === 404) {
            // Not S3-backed — return metadata + the authenticated binary path.
            const meta = await gw.get(
              api(`/files/${seg(i.fileId)}/details`),
              c,
            );
            return {
              kind: "direct",
              file: meta,
              downloadPath: api(`/files/${seg(i.fileId)}/download`),
              note: "This file streams from the app's authenticated download endpoint; fetch it with the user's bearer token.",
            };
          }
          throw e;
        }
      },
    },
    {
      name: "upload_file",
      title: "Upload file",
      category: "files",
      description:
        "Upload a new file from base64-encoded content. Optionally attach it to a conversation. Returns the created file record.",
      annotations: { readOnlyHint: false, destructiveHint: false },
      inputSchema: objectSchema(
        {
          name: f.shortText("File name (with extension)"),
          mime: f.shortText("MIME type (e.g. text/plain, image/png)"),
          contentBase64: {
            type: "string",
            description: "File bytes, base64-encoded.",
            maxLength: 14_000_000,
          },
          conversationId: f.id("Optional conversation to attach the file to"),
        },
        ["name", "contentBase64"],
      ),
      run: (i, c) => {
        let bytes: Buffer;
        try {
          bytes = Buffer.from(String(i.contentBase64), "base64");
        } catch {
          throw new GatewayError(
            "INVALID_INPUT",
            "contentBase64 is not valid base64.",
            400,
          );
        }
        if (!bytes.length)
          throw new GatewayError(
            "INVALID_INPUT",
            "Decoded file is empty.",
            400,
          );
        const mime = (i.mime as string) || "application/octet-stream";
        const path =
          api("/files") +
          qs({ name: i.name, mime, conversationId: i.conversationId });
        return gw.postRaw(path, bytes, mime, c);
      },
    },
  ];
}
