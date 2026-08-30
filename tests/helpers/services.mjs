/**
 * Shared plumbing for the per-service tests.
 *
 * Route handlers are plain `(Request) => Response` functions, so they can be
 * called directly — no dev server, no network. What they do need is Next's
 * module resolution (the `@/…` alias, extensionless relative imports, JSON
 * without an import attribute), which `module-hooks.mjs` supplies, and a
 * stand-in for whatever upstream API they call.
 */
import { register } from "node:module";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

register("./module-hooks.mjs", import.meta.url);

const root = new URL("../../", import.meta.url);

export const ORIGIN = "http://localhost:3000";

export function loadRoute(name) {
  return import(new URL(`app/api/${name}/route.ts`, root));
}

export function loadLib(name) {
  return import(new URL(`lib/${name}.ts`, root));
}

export function readConfig() {
  return import(new URL("config/v7.json", root), { with: { type: "json" } }).then(
    (module) => module.default,
  );
}

/** Every test gets its own client IP so the shared rate limiter cannot leak across cases. */
let clientCounter = 0;
export function freshClient() {
  clientCounter += 1;
  return `203.0.113.${clientCounter}`;
}

export function jsonRequest(url, body, { headers = {}, method = "POST", client = freshClient() } = {}) {
  return new Request(url, {
    method,
    headers: {
      "content-type": "application/json",
      origin: new URL(url).origin,
      "x-forwarded-for": client,
      ...headers,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

export function rawRequest(url, body, { headers = {}, method = "POST", client = freshClient() } = {}) {
  return new Request(url, {
    method,
    headers: { origin: new URL(url).origin, "x-forwarded-for": client, ...headers },
    body,
  });
}

/**
 * Replaces `globalThis.fetch` for the duration of `run`. The Gemini SDK, the
 * Sarvam REST calls, and Anakin all go through it, so one seam covers every
 * outbound call a route can make. Returns the recorded calls alongside the
 * handler's result.
 */
export async function withFetch(handler, run) {
  const original = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (input, init = {}) => {
    const isRequest = typeof Request !== "undefined" && input instanceof Request;
    const url = typeof input === "string" ? input : input.url;
    // Callers pass either (url, init) or a single Request; normalize both so a
    // test can always read `call.body` and `call.headers`.
    const request = {
      url,
      method: init.method || (isRequest ? input.method : "GET"),
      headers: new Headers(init.headers || (isRequest ? input.headers : undefined)),
      body: init.body ?? (isRequest ? await input.clone().text() : undefined),
      init,
      input,
    };
    calls.push(request);
    const response = await handler(request, calls.length);
    if (!response) throw new Error(`No stub response for ${url}`);
    return response;
  };
  try {
    return { result: await run(calls), calls };
  } finally {
    globalThis.fetch = original;
  }
}

export function jsonResponse(payload, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/** Shape a Gemini interactions response the way `@google/genai` expects to normalize it. */
export function geminiText(text) {
  return jsonResponse({
    id: "interaction_test",
    steps: [{ type: "model_output", content: [{ type: "text", text }] }],
  });
}

export function geminiImage(base64, mimeType = "image/jpeg") {
  return jsonResponse({
    id: "interaction_test",
    steps: [
      { type: "model_output", content: [{ type: "image", data: base64, mime_type: mimeType }] },
    ],
  });
}

/** Swaps env vars for one test and restores whatever was there before. */
export async function withEnv(values, run) {
  const previous = new Map(Object.keys(values).map((key) => [key, process.env[key]]));
  for (const [key, value] of Object.entries(values)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  try {
    return await run();
  } finally {
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

export function scratchDir(prefix) {
  return mkdtempSync(path.join(tmpdir(), `${prefix}-`));
}

/**
 * The Sarvam fallback talks to a raw WebSocket, so a test needs to stand in for
 * the socket itself. `script(socket)` receives a fake socket whose `sent` array
 * records every frame the route pushed, and drives it with `emit`.
 */
export async function withWebSocket(script, run) {
  const original = globalThis.WebSocket;
  const sockets = [];

  class FakeWebSocket {
    constructor(url, protocols) {
      this.url = url;
      this.protocols = protocols;
      this.sent = [];
      this.closed = false;
      this.listeners = new Map();
      sockets.push(this);
      // Give the route a turn to attach its listeners before anything fires.
      queueMicrotask(() => script(this));
    }

    addEventListener(type, handler) {
      this.listeners.set(type, [...(this.listeners.get(type) || []), handler]);
    }

    send(data) {
      this.sent.push(JSON.parse(data));
    }

    close() {
      this.closed = true;
    }

    emit(type, event = {}) {
      for (const handler of this.listeners.get(type) || []) handler(event);
    }

    /** Convenience for the common case: a JSON message frame from Sarvam. */
    reply(payload) {
      this.emit("message", { data: JSON.stringify(payload) });
    }
  }

  globalThis.WebSocket = FakeWebSocket;
  try {
    return { result: await run(sockets), sockets };
  } finally {
    globalThis.WebSocket = original;
  }
}
