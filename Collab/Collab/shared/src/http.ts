// Standard API response envelope — every endpoint returns this shape.
const ok = (data, meta?) => ({ ok: true, data, ...(meta ? { meta } : {}) });
const fail = (code, message, details?) => ({
  ok: false,
  error: { code, message, ...(details ? { details } : {}) },
});
export { ok, fail };
