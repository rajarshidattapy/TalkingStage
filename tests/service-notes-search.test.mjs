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

const { POST } = await loadRoute("notes/search");
const config = await readConfig();

const ENDPOINT = "http://localhost:3000/api/notes/search";
const RESPONSES_URL = "https://api.openai.com/v1/responses";
const KEY = { OPENAI_API_KEY: "test-openai-key" };

const BULLETS = "- Rooftop solar crossed 18 GW in 2026.\n- MNRE extended the programme to 31.03.2026.";

/** A Responses reply that used the web_search tool, with url_citation annotations. */
function searchReply(text = BULLETS, annotations = [], { toolCall = true } = {}) {
  return jsonResponse({
    id: "resp_test",
    status: "completed",
    output: [
      ...(toolCall ? [{ type: "web_search_call", status: "completed" }] : []),
      { type: "message", content: [{ type: "output_text", text, annotations }] },
    ],
  });
}

function citation(url, title = "A source") {
  return { type: "url_citation", url, title, start_index: 0, end_index: 10 };
}

function callSearch(body, options) {
  return POST(jsonRequest(ENDPOINT, body, options));
}

test("searches the web and returns briefing bullets with their sources", async () => {
  const { result, calls } = await withEnv(KEY, () =>
    withFetch(
      () =>
        searchReply(BULLETS, [
          citation("https://mnre.gov.in/programme?utm_source=openai", "MNRE programme"),
          citation("https://pib.gov.in/release?PRID=123&utm_source=openai", "Press release"),
        ]),
      () => callSearch({ query: "India rooftop solar net metering 2026" }),
    ),
  );

  assert.equal(result.status, 200);
  assert.equal(result.headers.get("Cache-Control"), "no-store");

  const payload = await result.json();
  assert.equal(payload.query, "India rooftop solar net metering 2026");
  assert.equal(payload.markdown, BULLETS);
  assert.deepEqual(payload.citations, [
    { title: "MNRE programme", url: "https://mnre.gov.in/programme" },
    { title: "Press release", url: "https://pib.gov.in/release?PRID=123" },
  ]);

  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, RESPONSES_URL);
  assert.equal(calls[0].headers.get("authorization"), "Bearer test-openai-key");

  const sent = JSON.parse(calls[0].body);
  assert.equal(sent.model, config.notes.search_model);
  assert.equal(sent.store, false);
  assert.deepEqual(sent.tools, [{ type: "web_search" }]);
  assert.equal(sent.tool_choice, "required", "the model must actually search, not answer from memory");
  // The presenter's words are data, not instructions.
  assert.match(sent.input, /^<topic>India rooftop solar net metering 2026<\/topic>$/);
  assert.match(sent.instructions, /briefing notes for a live presenter/);
  assert.match(sent.instructions, /Never name a source without linking it/);
});

test("inline citations leave the bullets but survive as the source list", async () => {
  // The model is told to cite inline because that is what creates the
  // annotations. Notes a presenter scans mid-sentence should not be full of URLs.
  const cited =
    "- MNRE extended the scheme to 31.03.2026. ([mnre.gov.in](https://mnre.gov.in/x?utm_source=openai))\n" +
    "- Two sources agree. ([pib](https://pib.gov.in/y?PRID=9&utm_source=openai), [peda](https://peda.gov.in/z?utm_source=openai))\n" +
    "- See the [state regulator order](https://jserc.org/re?utm_source=openai) for detail.";

  const { result } = await withEnv(KEY, () =>
    withFetch(
      () =>
        searchReply(cited, [
          citation("https://mnre.gov.in/x?utm_source=openai", "MNRE"),
          citation("https://pib.gov.in/y?PRID=9&utm_source=openai", "PIB"),
        ]),
      () => callSearch({ query: "rooftop solar policy" }),
    ),
  );

  const payload = await result.json();
  assert.equal(
    payload.markdown,
    "- MNRE extended the scheme to 31.03.2026.\n" +
      "- Two sources agree.\n" +
      "- See the state regulator order for detail.",
    "citation groups are removed; a sentence-level link keeps its words",
  );
  assert.doesNotMatch(payload.markdown, /https?:\/\//, "no URLs are left in the bullets");
  // Annotated sources come first, then any link found only in the body.
  assert.deepEqual(payload.citations, [
    { title: "MNRE", url: "https://mnre.gov.in/x" },
    { title: "PIB", url: "https://pib.gov.in/y?PRID=9" },
    { title: "peda", url: "https://peda.gov.in/z" },
    { title: "state regulator order", url: "https://jserc.org/re" },
  ]);
});

test("a bare tracking parameter is stripped even without link syntax", async () => {
  const { result } = await withEnv(KEY, () =>
    withFetch(
      () =>
        searchReply(
          "- Source: https://mnre.gov.in/x?utm_source=openai\n- Other: https://pib.gov.in/y?PRID=9&utm_source=openai",
        ),
      () => callSearch({ query: "rooftop solar policy" }),
    ),
  );

  const { markdown } = await result.json();
  assert.doesNotMatch(markdown, /utm_source/);
  // Stripping must not leave a dangling separator behind.
  assert.match(markdown, /https:\/\/mnre\.gov\.in\/x$/m);
  assert.match(markdown, /https:\/\/pib\.gov\.in\/y\?PRID=9$/m);
});

test("citations are deduplicated, titled, and capped", async () => {
  const many = Array.from({ length: 20 }, (_, index) =>
    citation(`https://example.com/source-${index}`, `Source ${index}`),
  );
  const { result } = await withEnv(KEY, () =>
    withFetch(
      () =>
        searchReply(BULLETS, [
          citation("https://example.com/same", "First title"),
          citation("https://example.com/same", "Duplicate"),
          // A citation with no title falls back to its hostname.
          citation("https://untitled.example/page", "   "),
          ...many,
        ]),
      () => callSearch({ query: "rooftop solar" }),
    ),
  );

  const { citations } = await result.json();
  assert.equal(citations.length, config.notes.max_citations);
  assert.equal(citations[0].url, "https://example.com/same");
  assert.equal(citations[0].title, "First title", "the first title for a URL wins");
  assert.equal(citations[1].title, "untitled.example", "an untitled source is labelled by host");
  assert.equal(new Set(citations.map((entry) => entry.url)).size, citations.length);
});

test("non-citation and unusable annotations are ignored", async () => {
  const { result } = await withEnv(KEY, () =>
    withFetch(
      () =>
        searchReply(BULLETS, [
          { type: "file_citation", file_id: "file-1" },
          citation("javascript:alert(1)", "Hostile"),
          citation("not a url", "Malformed"),
          citation(42, "Not a string"),
          citation("https://good.example/page", "Good"),
        ]),
      () => callSearch({ query: "rooftop solar" }),
    ),
  );

  assert.deepEqual((await result.json()).citations, [
    { title: "Good", url: "https://good.example/page" },
  ]);
});

test("a search with no citations still returns its findings", async () => {
  const { result } = await withEnv(KEY, () =>
    withFetch(
      () => searchReply(BULLETS, []),
      () => callSearch({ query: "rooftop solar" }),
    ),
  );

  const payload = await result.json();
  assert.equal(payload.markdown, BULLETS);
  assert.deepEqual(payload.citations, []);
});

test("the query is normalized and bounded before it is sent", async () => {
  const { result, calls } = await withEnv(KEY, () =>
    withFetch(
      () => searchReply(),
      () => callSearch({ query: `  rooftop\t\tsolar   ${"x".repeat(400)}  ` }),
    ),
  );

  const sent = JSON.parse(calls[0].body);
  const topic = sent.input.match(/<topic>([\s\S]*)<\/topic>/)[1];
  assert.equal(topic.length, config.notes.max_query_chars);
  assert.match(topic, /^rooftop solar x+$/, "whitespace runs collapse to single spaces");
  assert.equal((await result.json()).query, topic, "the caller is told what was actually searched");
});

test("findings are clipped to the notes budget", async () => {
  const { result } = await withEnv(KEY, () =>
    withFetch(
      () => searchReply(`- ${"long finding ".repeat(1000)}`),
      () => callSearch({ query: "rooftop solar" }),
    ),
  );

  assert.equal((await result.json()).markdown.length, config.notes.max_search_chars);
});

test("an empty or too-short question never reaches the API", async () => {
  const { result, calls } = await withEnv(KEY, () =>
    withFetch(
      () => {
        throw new Error("OpenAI must not be called without a real question.");
      },
      async () => [
        await callSearch({}),
        await callSearch({ query: "   " }),
        await callSearch({ query: "ab" }),
        await callSearch({ query: 42 }),
        await POST(
          new Request(ENDPOINT, {
            method: "POST",
            headers: { "content-type": "application/json", "x-forwarded-for": freshClient() },
            body: "{ not json",
          }),
        ),
      ],
    ),
  );

  for (const response of result) {
    assert.equal(response.status, 400);
    assert.match((await response.json()).error, /search question is required/);
  }
  assert.equal(calls.length, 0);
});

test("an empty result, a refusal, and an upstream error each fail clearly", async () => {
  const cases = {
    "an empty answer": [searchReply("   "), 502, /nothing usable/],
    "no message item": [
      jsonResponse({ id: "resp_test", status: "completed", output: [{ type: "web_search_call" }] }),
      502,
      /nothing usable/,
    ],
    "a refusal": [
      jsonResponse({
        id: "resp_test",
        status: "completed",
        output: [{ type: "message", content: [{ type: "refusal", refusal: "I can't search for that." }] }],
      }),
      502,
      /I can't search for that/,
    ],
    "an upstream error": [
      jsonResponse({ error: { message: "Web search is not enabled for this project." } }, 403),
      502,
      /Web search is not enabled/,
    ],
    "an error with no message": [jsonResponse({}, 500), 502, /OpenAI returned 500/],
  };

  for (const [label, [reply, status, expected]] of Object.entries(cases)) {
    const { result } = await withEnv(KEY, () =>
      withFetch(
        () => reply,
        () => callSearch({ query: "rooftop solar" }),
      ),
    );
    assert.equal(result.status, status, label);
    assert.match((await result.json()).error, expected, label);
  }
});

test("without an OpenAI key the service reports 503", async () => {
  const response = await withEnv({ OPENAI_API_KEY: undefined }, () =>
    callSearch({ query: "rooftop solar" }),
  );

  assert.equal(response.status, 503);
  assert.match((await response.json()).error, /OPENAI_API_KEY/);
});

test("a caller that goes away ends as 499", async () => {
  const controller = new AbortController();
  const request = new Request(ENDPOINT, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      origin: "http://localhost:3000",
      "x-forwarded-for": freshClient(),
    },
    body: JSON.stringify({ query: "rooftop solar" }),
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
    callSearch({ query: "rooftop solar" }, { headers: { origin: "http://evil.example" } }),
  );
  assert.equal(crossOrigin.status, 403);
  assert.match((await crossOrigin.json()).error, /Cross-origin/);

  const client = freshClient();
  const limit = config.security.setup_requests_per_window;
  const { result } = await withEnv(KEY, () =>
    withFetch(
      () => searchReply(),
      async () => {
        for (let attempt = 0; attempt < limit; attempt += 1) {
          await callSearch({ query: "rooftop solar" }, { client });
        }
        return callSearch({ query: "rooftop solar" }, { client });
      },
    ),
  );

  assert.equal(result.status, 429);
  assert.equal(result.headers.get("X-RateLimit-Limit"), String(limit));
});
