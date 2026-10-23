import { test } from "node:test";
import assert from "node:assert/strict";
import { apiClientKey, bearerSubject } from "../src/middleware/rateLimit";

// The global API throttle must bucket per signed-in USER, not per source IP:
// behind the corporate load balancer every user shares one address, and a
// per-IP bucket throttled the whole company together (E2EE recovery calls
// included, which the client then read as "no backup / no key").

function reqWith(headers: Record<string, string>, ip = "10.0.0.9"): any {
  return { headers, socket: { remoteAddress: ip } };
}
function jwtWithSub(sub: any): string {
  const b64 = (o: any) => Buffer.from(JSON.stringify(o)).toString("base64url");
  return b64({ alg: "HS256", typ: "JWT" }) + "." + b64({ sub }) + ".sig";
}

test("a bearer JWT buckets by its subject, not by IP", () => {
  const a = reqWith({ authorization: "Bearer " + jwtWithSub("u_alice") });
  const b = reqWith({ authorization: "Bearer " + jwtWithSub("u_bob") });
  assert.equal(bearerSubject(a), "u_alice");
  assert.equal(apiClientKey(a), "u:u_alice");
  assert.equal(apiClientKey(b), "u:u_bob");
  assert.notEqual(apiClientKey(a), apiClientKey(b), "two users behind one LB get two buckets");
});

test("no or malformed bearer token falls back to the IP bucket", () => {
  assert.equal(apiClientKey(reqWith({})), "ip:10.0.0.9");
  assert.equal(apiClientKey(reqWith({ authorization: "Bearer not.a.jwt.at.all" })), "ip:10.0.0.9");
  assert.equal(apiClientKey(reqWith({ authorization: "Bearer " + jwtWithSub(42) })), "ip:10.0.0.9");
  assert.equal(bearerSubject(reqWith({ authorization: "Basic abc" })), null);
});
