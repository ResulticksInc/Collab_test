// Centralized HTTP error factory for backend services.
// Unified replace for duplicate local helpers (httpError, deny, badRequest, err).

export function httpErr(status: number, message: string, code?: string): Error {
  const e: any = new Error(message);
  e.status = status;
  if (code) e.code = code;
  return e;
}
