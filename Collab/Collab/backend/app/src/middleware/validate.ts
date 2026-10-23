// ── Request body validator ─────────────────────────────────────────────────
// Zero-dependency schema guard: validates req.body against a plain-JS schema
// and returns 400 with field-level errors before the request reaches a service.
// Keeps the validation language minimal — required, type checks, length bounds,
// enumeration. Sufficient for the audit findings without adding ajv/zod.
//
// Usage:
//   router.post("/meetings", validate({ title: { required: true, maxLength: 200 } }), handler)

type FieldSpec = {
  required?: boolean;
  maxLength?: number;
  minLength?: number;
  isEmail?: boolean;
  isNumber?: boolean;
  isBoolean?: boolean;
  isOneOf?: readonly any[];
};
type Schema = Record<string, FieldSpec>;

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function validate(schema: Schema) {
  return function validationMiddleware(req: any, res: any, next: any) {
    if ((req.headers["content-type"] || "").includes("multipart/form-data")) {
      return next();
    }
    const body = req.body || {};
    const errors: Record<string, string> = {};

    for (const [field, spec] of Object.entries(schema)) {
      const val = body[field];
      const absent = val === undefined || val === null || val === "";

      if (spec.required && absent) {
        errors[field] = `${field} is required`;
        continue;
      }
      if (absent) continue; // optional field not provided — skip remaining checks

      if (spec.isNumber && typeof val !== "number" && isNaN(Number(val)))
        errors[field] = `${field} must be a number`;
      else if (spec.isBoolean && typeof val !== "boolean" && val !== "true" && val !== "false")
        errors[field] = `${field} must be a boolean`;
      else if (spec.isEmail && !EMAIL_RE.test(String(val)))
        errors[field] = `${field} must be a valid email address`;
      else if (spec.isOneOf && !spec.isOneOf.includes(val))
        errors[field] = `${field} must be one of: ${spec.isOneOf.join(", ")}`;
      else if (spec.maxLength && String(val).length > spec.maxLength)
        errors[field] = `${field} must be at most ${spec.maxLength} characters`;
      else if (spec.minLength && String(val).length < spec.minLength)
        errors[field] = `${field} must be at least ${spec.minLength} characters`;
    }

    if (Object.keys(errors).length)
      return res.status(400).json({ ok: false, error: "Validation failed", fields: errors });

    next();
  };
}
