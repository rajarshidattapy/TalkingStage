import assert from "node:assert/strict";
import test from "node:test";
import {
  freshClient,
  jsonRequest,
  jsonResponse,
  loadRoute,
  readConfig,
  withEnv,
  withFetch,
} from "./helpers/services.mjs";

const { POST } = await loadRoute("tags");
const config = await readConfig();

const ENDPOINT = "http://localhost:3000/api/tags";
const RESPONSES_URL = "https://api.openai.com/v1/responses";
const KEY = { OPENAI_API_KEY: "test-openai-key" };

/** An OpenAI Responses reply carrying one structured-output message. */
function openaiTags(tags, { reasoning = false } = {}) {
  const text = typeof tags === "string" ? tags : JSON.stringify({ tags });
  return jsonResponse({
    id: "resp_test",
    status: "completed",
    output: [
      // gpt-5.x models may emit a reasoning item ahead of the message.
      ...(reasoning ? [{ type: "reasoning", summary: [] }] : []),
      { type: "message", content: [{ type: "output_text", text }] },
    ],
  });
}

function callTags(body, options) {
  return POST(jsonRequest(ENDPOINT, body, options));
}

test("extracts tags from the setup content and sends both fields to OpenAI", async () => {
  const { result, calls } = await withEnv(KEY, () =>
    withFetch(
      () => openaiTags(["solar power", "grid storage", "climate policy"]),
      () => callTags({ vibe: "hopeful and concrete", notes: "Notes about renewables." }),
    ),
  );

  assert.equal(result.status, 200);
  assert.equal(result.headers.get("Cache-Control"), "no-store");
  assert.deepEqual((await result.json()).tags, ["solar power", "grid storage", "climate policy"]);

  assert.equal(calls.length, 1, "one upstream call per request");
  assert.equal(calls[0].url, RESPONSES_URL);
  assert.equal(calls[0].headers.get("authorization"), "Bearer test-openai-key");

  const sent = JSON.parse(calls[0].body);
  assert.equal(sent.model, config.research.tag_model);
  assert.equal(sent.store, false, "setup content is never retained upstream");
  assert.match(sent.input, /<tone>hopeful and concrete<\/tone>/);
  assert.match(sent.input, /<notes>Notes about renewables\.<\/notes>/);
  assert.match(sent.instructions, /one to three words/);
});

test("the response is pinned to a strict tag-array schema", async () => {
  const { calls } = await withEnv(KEY, () =>
    withFetch(
      () => openaiTags(["one topic", "two topic", "three topic"]),
      () => callTags({ notes: "Grid notes." }),
    ),
  );

  const { format } = JSON.parse(calls[0].body).text;
  assert.equal(format.type, "json_schema");
  assert.equal(format.strict, true);
  assert.equal(format.schema.additionalProperties, false);
  assert.deepEqual(format.schema.required, ["tags"]);
  assert.equal(format.schema.properties.tags.type, "array");
  assert.equal(format.schema.properties.tags.minItems, 3);
  assert.equal(
    format.schema.properties.tags.maxItems,
    config.research.max_tags,
    "the cap is enforced upstream, not only after the fact",
  );
});

test("the message is found even behind a reasoning item", async () => {
  const { result } = await withEnv(KEY, () =>
    withFetch(
      () => openaiTags(["solar power", "grid storage", "climate policy"], { reasoning: true }),
      () => callTags({ notes: "Grid notes." }),
    ),
  );

  assert.equal(result.status, 200);
  assert.deepEqual((await result.json()).tags, ["solar power", "grid storage", "climate policy"]);
});

test("tags are cleaned, deduplicated, and dropped when unusable", async () => {
  const { result } = await withEnv(KEY, () =>
    withFetch(
      () => openaiTags(["  wind  turbines ", "a", 17, null, "battery/storage!", "wind turbines"]),
      () => callTags({ notes: "Grid notes." }),
    ),
  );

  assert.equal(result.status, 200);
  // Whitespace collapses, punctuation is stripped, non-strings and 1-char tags
  // are dropped, and the repeat of an already-seen tag is deduplicated.
  assert.deepEqual((await result.json()).tags, ["wind turbines", "batterystorage"]);
});

test("never returns more tags than the configured maximum", async () => {
  const many = Array.from({ length: 20 }, (_, index) => `topic number ${index}`);
  const { result } = await withEnv(KEY, () =>
    withFetch(
      () => openaiTags(many),
      () => callTags({ notes: "Lots of topics." }),
    ),
  );

  assert.equal((await result.json()).tags.length, config.research.max_tags);
});

test("caps how much setup content is forwarded", async () => {
  const { calls } = await withEnv(KEY, () =>
    withFetch(
      () => openaiTags(["one topic", "two topic", "three topic"]),
      () => callTags({ vibe: "v".repeat(1000), notes: "n".repeat(20_000) }),
    ),
  );

  const sent = JSON.parse(calls[0].body);
  assert.equal(sent.input.match(/<tone>(v*)<\/tone>/)[1].length, 400);
  assert.equal(sent.input.match(/<notes>(n*)<\/notes>/)[1].length, 12_000);
});

test("reports 502 when the model answers without a usable topic list", async () => {
  const replies = {
    "an empty array": openaiTags([]),
    "unusable entries": openaiTags(["a", 1]),
    "no message item": jsonResponse({ id: "resp_test", status: "completed", output: [] }),
  };

  for (const [label, reply] of Object.entries(replies)) {
    const { result } = await withEnv(KEY, () =>
      withFetch(
        () => reply,
        () => callTags({ notes: "Something." }),
      ),
    );
    assert.equal(result.status, 502, label);
    assert.match((await result.json()).error, /No usable topics/, label);
  }
});

test("a refusal is surfaced as its stated reason", async () => {
  const { result } = await withEnv(KEY, () =>
    withFetch(
      () =>
        jsonResponse({
          id: "resp_test",
          status: "completed",
          output: [{ type: "message", content: [{ type: "refusal", refusal: "I can't help with that." }] }],
        }),
      () => callTags({ notes: "Something." }),
    ),
  );

  assert.equal(result.status, 502);
  assert.match((await result.json()).error, /I can't help with that/);
});

test("an upstream error reports OpenAI's own message, not an opaque status", async () => {
  const { result } = await withEnv(KEY, () =>
    withFetch(
      () => jsonResponse({ error: { message: "Rate limit reached for gpt-5.4-nano." } }, 429),
      () => callTags({ notes: "Something." }),
    ),
  );

  assert.equal(result.status, 502);
  assert.match((await result.json()).error, /Rate limit reached for gpt-5\.4-nano/);
});

test("an error body with no message still yields a usable reason", async () => {
  const { result } = await withEnv(KEY, () =>
    withFetch(
      () => jsonResponse([{ error: {} }], 400),
      () => callTags({ notes: "Something." }),
    ),
  );

  assert.equal(result.status, 502);
  assert.match((await result.json()).error, /OpenAI returned 400/);
});

test("requires setup content before spending an upstream call", async () => {
  const { result, calls } = await withEnv(KEY, () =>
    withFetch(
      () => {
        throw new Error("OpenAI must not be called for empty setup content.");
      },
      async () => [
        await callTags({ vibe: "   ", notes: "" }),
        await callTags({}),
        await POST(
          new Request(ENDPOINT, {
            method: "POST",
            headers: { "content-type": "application/json", "x-forwarded-for": freshClient() },
            body: "not json at all",
          }),
        ),
      ],
    ),
  );

  for (const response of result) {
    assert.equal(response.status, 400);
    assert.match((await response.json()).error, /Setup content is required/);
  }
  assert.equal(calls.length, 0);
});

test("without an OpenAI key the service reports 503, not a crash", async () => {
  const response = await withEnv({ OPENAI_API_KEY: undefined }, () =>
    callTags({ notes: "Something." }),
  );

  assert.equal(response.status, 503);
  assert.match((await response.json()).error, /OPENAI_API_KEY/);
});

test("a caller that goes away ends as 499 rather than an error payload", async () => {
  const controller = new AbortController();
  const request = new Request(ENDPOINT, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      origin: "http://localhost:3000",
      "x-forwarded-for": freshClient(),
    },
    body: JSON.stringify({ notes: "Something." }),
    signal: controller.signal,
  });

  const { result } = await withEnv(KEY, () =>
    withFetch(
      () => {
        controller.abort();
        throw Object.assign(new Error("The operation was aborted."), { name: "AbortError" });
      },
      () => POST(request),
    ),
  );

  assert.equal(result.status, 499);
  assert.equal(await result.text(), "");
});

test("blocks cross-origin callers and throttles a flood", async () => {
  const crossOrigin = await withEnv(KEY, () =>
    callTags({ notes: "Something." }, { headers: { origin: "http://evil.example" } }),
  );
  assert.equal(crossOrigin.status, 403);

  const client = freshClient();
  const limit = config.security.setup_requests_per_window;
  const { result } = await withEnv(KEY, () =>
    withFetch(
      () => openaiTags(["one topic", "two topic", "three topic"]),
      async () => {
        for (let attempt = 0; attempt < limit; attempt += 1) {
          await callTags({ notes: "Something." }, { client });
        }
        return callTags({ notes: "Something." }, { client });
      },
    ),
  );

  assert.equal(result.status, 429);
  assert.ok(Number(result.headers.get("Retry-After")) > 0);
});
