import assert from "node:assert/strict";
import test from "node:test";
import { loadLib } from "./helpers/services.mjs";

const { checkRateLimit, hasMismatchedOrigin, rateLimitResponse } = await loadLib("request-guards");

function request(headers = {}, url = "http://localhost:3000/api/vibes") {
  return new Request(url, { headers });
}

test("origin guard only rejects a real cross-origin caller", () => {
  // Same-origin fetch, curl, and server-to-server calls send no Origin at all.
  assert.equal(hasMismatchedOrigin(request()), false);
  assert.equal(hasMismatchedOrigin(request({ origin: "http://localhost:3000" })), false);
  // A port is part of the host, so a different port is a different origin.
  assert.equal(hasMismatchedOrigin(request({ origin: "http://localhost:3001" })), true);
  assert.equal(hasMismatchedOrigin(request({ origin: "http://evil.example" })), true);
  // Protocol counts too: https://localhost:3000 is not http://localhost:3000.
  assert.equal(hasMismatchedOrigin(request({ origin: "https://localhost:3000" })), true);
  // An unparseable Origin is treated as hostile rather than ignored.
  assert.equal(hasMismatchedOrigin(request({ origin: "not a url" })), true);
  assert.equal(hasMismatchedOrigin(request({ origin: "null" })), true);
});

test("rate limiter counts per client address and per scope", () => {
  const alice = request({ "x-forwarded-for": "198.51.100.1" });
  const bob = request({ "x-forwarded-for": "198.51.100.2" });

  const first = checkRateLimit(alice, "guard-scope-a", 2, 60_000);
  assert.equal(first.allowed, true);
  assert.equal(first.limit, 2);
  assert.equal(first.remaining, 1);

  const second = checkRateLimit(alice, "guard-scope-a", 2, 60_000);
  assert.equal(second.allowed, true);
  assert.equal(second.remaining, 0);

  const third = checkRateLimit(alice, "guard-scope-a", 2, 60_000);
  assert.equal(third.allowed, false, "the request past the limit is rejected");
  assert.equal(third.remaining, 0, "remaining never goes negative");
  assert.ok(third.retryAfterSeconds >= 1);

  // A second client is unaffected by the first client's exhausted budget.
  assert.equal(checkRateLimit(bob, "guard-scope-a", 2, 60_000).allowed, true);
  // So is the same client on a different route scope.
  assert.equal(checkRateLimit(alice, "guard-scope-b", 2, 60_000).allowed, true);
});

test("client address prefers the first x-forwarded-for hop, then x-real-ip", () => {
  const proxied = request({ "x-forwarded-for": " 198.51.100.9 , 10.0.0.1", "x-real-ip": "10.0.0.2" });
  const direct = request({ "x-real-ip": "198.51.100.9" });

  // Both requests must land on the same bucket for the second call to be the
  // second hit — which is only true if the leading forwarded hop wins and is trimmed.
  assert.equal(checkRateLimit(proxied, "guard-scope-c", 1, 60_000).allowed, true);
  assert.equal(checkRateLimit(direct, "guard-scope-c", 1, 60_000).allowed, false);
});

test("unidentifiable clients share one bucket instead of bypassing the limit", () => {
  assert.equal(checkRateLimit(request(), "guard-scope-d", 1, 60_000).allowed, true);
  assert.equal(checkRateLimit(request(), "guard-scope-d", 1, 60_000).allowed, false);
});

test("the window reopens once it has elapsed", async () => {
  const client = request({ "x-forwarded-for": "198.51.100.20" });
  assert.equal(checkRateLimit(client, "guard-scope-e", 1, 20).allowed, true);
  assert.equal(checkRateLimit(client, "guard-scope-e", 1, 20).allowed, false);

  await new Promise((resolve) => setTimeout(resolve, 40));
  const reopened = checkRateLimit(client, "guard-scope-e", 1, 20);
  assert.equal(reopened.allowed, true, "a fresh window restarts the count");
  assert.equal(reopened.remaining, 0);
});

test("the throttled response carries the standard retry headers", async () => {
  const response = rateLimitResponse({
    allowed: false,
    limit: 8,
    remaining: 0,
    retryAfterSeconds: 42,
  });

  assert.equal(response.status, 429);
  assert.equal(response.headers.get("Retry-After"), "42");
  assert.equal(response.headers.get("X-RateLimit-Limit"), "8");
  assert.equal(response.headers.get("X-RateLimit-Remaining"), "0");
  assert.match((await response.json()).error, /Too many requests/);
});
