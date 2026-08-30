import assert from "node:assert/strict";
import test from "node:test";
import {
  freshClient,
  geminiText,
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
const KEY = { GEMINI_API_KEY: "test-gemini-key", GOOGLE_API_KEY: undefined };

function callTags(body, options) {
  return POST(jsonRequest(ENDPOINT, body, options));
}

test("extracts tags from the setup content and sends both fields to Gemini", async () => {
  const { result, calls } = await withEnv(KEY, () =>
    withFetch(
      () => geminiText('Here you go: ["solar power", "grid storage", "climate policy"]'),
      () => callTags({ vibe: "hopeful and concrete", notes: "Notes about renewables." }),
    ),
  );

  assert.equal(result.status, 200);
  assert.equal(result.headers.get("Cache-Control"), "no-store");
  assert.deepEqual((await result.json()).tags, ["solar power", "grid storage", "climate policy"]);

  assert.equal(calls.length, 1, "one upstream interaction per request");
  const sent = JSON.parse(calls[0].body);
  assert.equal(sent.model, config.research.tag_model);
  assert.equal(sent.store, false, "setup content is never retained upstream");
  assert.match(sent.input, /<tone>hopeful and concrete<\/tone>/);
  assert.match(sent.input, /<notes>Notes about renewables\.<\/notes>/);
  assert.match(sent.input, new RegExp(`between 3 and ${config.research.max_tags} tags`));
});

test("tolerates prose around the JSON array and drops unusable entries", async () => {
  const { result } = await withEnv(KEY, () =>
    withFetch(
      () =>
        geminiText(
          'Sure!\n["  wind  turbines ", "a", 17, null, "battery/storage!", "wind turbines"]\nHope that helps.',
        ),
      () => callTags({ notes: "Grid notes." }),
    ),
  );

  assert.equal(result.status, 200);
  const { tags } = await result.json();
  // Whitespace collapses, punctuation is stripped, non-strings and 1-char tags
  // are dropped, and the repeat of an already-seen tag is deduplicated.
  assert.deepEqual(tags, ["wind turbines", "batterystorage"]);
});

test("never returns more tags than the configured maximum", async () => {
  const many = Array.from({ length: 20 }, (_, index) => `topic number ${index}`);
  const { result } = await withEnv(KEY, () =>
    withFetch(
      () => geminiText(JSON.stringify(many)),
      () => callTags({ notes: "Lots of topics." }),
    ),
  );

  const { tags } = await result.json();
  assert.equal(tags.length, config.research.max_tags);
});

test("caps how much setup content is forwarded", async () => {
  const { calls } = await withEnv(KEY, () =>
    withFetch(
      () => geminiText('["one topic","two topic","three topic"]'),
      () => callTags({ vibe: "v".repeat(1000), notes: "n".repeat(20_000) }),
    ),
  );

  const sent = JSON.parse(calls[0].body);
  assert.equal(sent.input.match(/<tone>(v*)<\/tone>/)[1].length, 400);
  assert.equal(sent.input.match(/<notes>(n*)<\/notes>/)[1].length, 12_000);
});

test("reports 502 when Gemini answers without a usable topic list", async () => {
  for (const reply of ["I cannot help with that.", "[]", '["a", 1]']) {
    const { result } = await withEnv(KEY, () =>
      withFetch(
        () => geminiText(reply),
        () => callTags({ notes: "Something." }),
      ),
    );
    assert.equal(result.status, 502, `"${reply}" should not become tags`);
    assert.match((await result.json()).error, /No usable topics/);
  }
});

test("surfaces an upstream failure as 502 rather than throwing", async () => {
  const { result } = await withEnv(KEY, () =>
    withFetch(
      () => jsonResponse({ error: { message: "quota exhausted" } }, 429),
      () => callTags({ notes: "Something." }),
    ),
  );

  assert.equal(result.status, 502);
  assert.ok((await result.json()).error);
});

test("requires setup content before spending an upstream call", async () => {
  const { result, calls } = await withEnv(KEY, () =>
    withFetch(
      () => {
        throw new Error("Gemini must not be called for empty setup content.");
      },
      async () => {
        const empty = await callTags({ vibe: "   ", notes: "" });
        const absent = await callTags({});
        const malformed = await POST(
          new Request(ENDPOINT, {
            method: "POST",
            headers: { "content-type": "application/json", "x-forwarded-for": freshClient() },
            body: "not json at all",
          }),
        );
        return [empty, absent, malformed];
      },
    ),
  );

  for (const response of result) {
    assert.equal(response.status, 400);
    assert.match((await response.json()).error, /Setup content is required/);
  }
  assert.equal(calls.length, 0);
});

test("without a Gemini key the service reports 503, not a crash", async () => {
  const response = await withEnv({ GEMINI_API_KEY: undefined, GOOGLE_API_KEY: undefined }, () =>
    callTags({ notes: "Something." }),
  );

  assert.equal(response.status, 503);
  assert.match((await response.json()).error, /GEMINI_API_KEY/);
});

test("GOOGLE_API_KEY works as the alternate credential", async () => {
  const { result } = await withEnv(
    { GEMINI_API_KEY: undefined, GOOGLE_API_KEY: "alternate-key" },
    () =>
      withFetch(
        () => geminiText('["one topic","two topic","three topic"]'),
        () => callTags({ notes: "Something." }),
      ),
  );

  assert.equal(result.status, 200);
});

test("blocks cross-origin callers and throttles a flood", async () => {
  const crossOrigin = await withEnv(KEY, () =>
    callTags({ notes: "Something." }, { headers: { origin: "http://evil.example" } }),
  );
  assert.equal(crossOrigin.status, 403);

  const client = freshClient();
  const limit = config.security.setup_requests_per_window;
  const blocked = await withEnv(KEY, () =>
    withFetch(
      () => geminiText('["one topic","two topic","three topic"]'),
      async () => {
        for (let attempt = 0; attempt < limit; attempt += 1) {
          await callTags({ notes: "Something." }, { client });
        }
        return callTags({ notes: "Something." }, { client });
      },
    ),
  );

  assert.equal(blocked.result.status, 429);
  assert.equal(blocked.result.headers.get("Retry-After") > "0", true);
});
