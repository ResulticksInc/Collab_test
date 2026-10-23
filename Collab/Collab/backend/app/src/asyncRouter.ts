import express from "express";

type Handler = (req: any, res: any, next: any) => any;

// Wrap a handler so both synchronous throws and rejected promises are forwarded
// to Express's error-handling middleware instead of becoming unhandled
// rejections (which leave the HTTP request hanging forever).
const wrap =
  (fn: Handler): Handler =>
  (req, res, next) => {
    try {
      const out = fn(req, res, next);
      if (out && typeof out.then === "function") out.catch(next);
    } catch (e) {
      next(e);
    }
  };

// Drop-in replacement for express.Router() whose verb methods auto-wrap async
// handlers. A throwing handler now returns a JSON error response the client can
// surface, rather than hanging the request.
export function asyncRouter() {
  const r: any = express.Router();
  for (const m of ["get", "post", "put", "patch", "delete"]) {
    const orig = r[m].bind(r);
    r[m] = (path: string, ...handlers: Handler[]) =>
      orig(path, ...handlers.map((h) => (h && h.length >= 4 ? h : wrap(h))));
  }
  return r;
}
