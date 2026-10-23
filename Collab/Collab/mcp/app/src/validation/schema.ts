import { config } from "../config";
import { ValidationError } from "../errors";
import type { JsonSchema } from "../types";

// Dependency-free JSON-Schema validator + sanitizer for tool inputs. Supports
// the subset our tools declare (see types.JsonSchema). Goals:
//   • Reject unknown keys (additionalProperties:false) — no smuggled params.
//   • Enforce types, required, enum, numeric/length bounds.
//   • Coerce obvious mismatches (numeric strings → numbers) for ergonomic AI use.
//   • Sanitize strings: strip control chars, trim, cap length (anti-abuse).
//   • Apply declared defaults.
// Returns the cleaned value or throws ValidationError with every issue listed.

// Strip ASCII control chars except tab/newline/CR (0x09/0x0A/0x0D). Built from
// escaped unicode so no raw control bytes live in this source file.
const CONTROL_CHARS = new RegExp(
  "[\\u0000-\\u0008\\u000B\\u000C\\u000E-\\u001F\\u007F]",
  "g",
);

function sanitizeString(
  s: string,
  schema: JsonSchema,
  path: string,
  issues: string[],
): string {
  let out = s.replace(CONTROL_CHARS, "").trim();
  const cap = schema.maxLength ?? config.maxStringLen;
  if (out.length > cap) {
    issues.push(`${path}: exceeds max length ${cap}`);
    out = out.slice(0, cap);
  }
  if (schema.minLength != null && out.length < schema.minLength)
    issues.push(`${path}: shorter than min length ${schema.minLength}`);
  if (schema.enum && !schema.enum.includes(out))
    issues.push(`${path}: must be one of ${schema.enum.join(", ")}`);
  return out;
}

function validateValue(
  value: unknown,
  schema: JsonSchema,
  path: string,
  issues: string[],
): unknown {
  // Apply default for undefined.
  if (value === undefined) {
    if (schema.default !== undefined) value = schema.default;
    else return undefined;
  }
  if (value === null) return null;

  switch (schema.type) {
    case "string": {
      if (typeof value !== "string") {
        // Coerce scalars to string for ergonomic tool calls.
        if (typeof value === "number" || typeof value === "boolean")
          value = String(value);
        else {
          issues.push(`${path}: expected string`);
          return undefined;
        }
      }
      return sanitizeString(value as string, schema, path, issues);
    }
    case "number":
    case "integer": {
      let n = value as any;
      if (
        typeof n === "string" &&
        n.trim() !== "" &&
        Number.isFinite(Number(n))
      )
        n = Number(n);
      if (typeof n !== "number" || !Number.isFinite(n)) {
        issues.push(`${path}: expected ${schema.type}`);
        return undefined;
      }
      if (schema.type === "integer" && !Number.isInteger(n)) n = Math.trunc(n);
      if (schema.minimum != null && n < schema.minimum)
        issues.push(`${path}: below minimum ${schema.minimum}`);
      if (schema.maximum != null && n > schema.maximum)
        issues.push(`${path}: above maximum ${schema.maximum}`);
      if (schema.enum && !schema.enum.includes(n))
        issues.push(`${path}: must be one of ${schema.enum.join(", ")}`);
      return n;
    }
    case "boolean": {
      if (typeof value === "boolean") return value;
      if (value === "true") return true;
      if (value === "false") return false;
      issues.push(`${path}: expected boolean`);
      return undefined;
    }
    case "array": {
      if (!Array.isArray(value)) {
        issues.push(`${path}: expected array`);
        return undefined;
      }
      if (value.length > 1000) {
        issues.push(`${path}: array too large (max 1000)`);
        value = value.slice(0, 1000);
      }
      return (value as unknown[]).map((v, i) =>
        schema.items
          ? validateValue(v, schema.items, `${path}[${i}]`, issues)
          : v,
      );
    }
    case "object": {
      if (typeof value !== "object" || Array.isArray(value)) {
        issues.push(`${path}: expected object`);
        return undefined;
      }
      const input = value as Record<string, unknown>;
      const out: Record<string, unknown> = {};
      const props = schema.properties || {};
      // Reject unknown keys when additionalProperties is false (default-deny).
      if (schema.additionalProperties === false) {
        for (const key of Object.keys(input))
          if (!(key in props)) issues.push(`${path}.${key}: unknown property`);
      } else {
        for (const key of Object.keys(input))
          if (!(key in props)) out[key] = input[key];
      }
      for (const [key, sub] of Object.entries(props)) {
        const cleaned = validateValue(
          input[key],
          sub,
          `${path}.${key}`,
          issues,
        );
        if (cleaned !== undefined) out[key] = cleaned;
      }
      for (const req of schema.required || [])
        if (out[req] === undefined || out[req] === null || out[req] === "")
          issues.push(`${path}.${req}: required`);
      return out;
    }
    default:
      return value;
  }
}

export function validateInput(
  schema: JsonSchema,
  input: Record<string, unknown>,
): Record<string, unknown> {
  const issues: string[] = [];
  const cleaned = validateValue(input || {}, schema, "input", issues) as Record<
    string,
    unknown
  >;
  if (issues.length) throw new ValidationError(issues);
  return cleaned || {};
}
