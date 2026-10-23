import { config } from "../config";
import type { JsonSchema } from "../types";

// Shared builders so every tool declares a consistent, strict schema.

export function objectSchema(
  properties: Record<string, JsonSchema>,
  required: string[] = [],
): JsonSchema {
  return { type: "object", properties, required, additionalProperties: false };
}

// Common field shapes.
export const f = {
  id: (description: string): JsonSchema => ({
    type: "string",
    description,
    maxLength: 64,
  }),
  text: (description: string, maxLength = 8000): JsonSchema => ({
    type: "string",
    description,
    maxLength,
  }),
  shortText: (description: string): JsonSchema => ({
    type: "string",
    description,
    maxLength: 500,
  }),
  isoDate: (description: string): JsonSchema => ({
    type: "string",
    description: description + " (ISO 8601, e.g. 2026-07-01T15:00:00Z)",
    maxLength: 40,
  }),
  limit: (): JsonSchema => ({
    type: "integer",
    description: `Max results (1–${config.maxPageSize}, default ${config.defaultPageSize}).`,
    minimum: 1,
    maximum: config.maxPageSize,
    default: config.defaultPageSize,
  }),
  cursor: (): JsonSchema => ({
    type: "string",
    description:
      "Keyset cursor: the id of the OLDEST item already seen; returns the page just older.",
    maxLength: 64,
  }),
  stringArray: (description: string): JsonSchema => ({
    type: "array",
    description,
    items: { type: "string", maxLength: 64 },
  }),
};

// Clamp a requested limit into [1, maxPageSize] with a sane default — no tool
// can ever request an unbounded dataset.
export function clampLimit(v: unknown): number {
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) return config.defaultPageSize;
  return Math.min(Math.trunc(n), config.maxPageSize);
}

// Safe path-segment encoder for ids interpolated into URLs.
export function seg(v: unknown): string {
  return encodeURIComponent(String(v ?? ""));
}

// Cap an array result to a limit (defense against a backend returning a large
// list to a read tool). Returns { items, count, truncated }.
export function page<T>(
  items: T[],
  limit: number,
): { items: T[]; count: number; truncated: boolean } {
  const arr = Array.isArray(items) ? items : [];
  const sliced = arr.slice(0, limit);
  return {
    items: sliced,
    count: sliced.length,
    truncated: arr.length > sliced.length,
  };
}
