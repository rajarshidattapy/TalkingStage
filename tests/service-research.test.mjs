import assert from "node:assert/strict";
import test from "node:test";
import {
  freshClient,
  jsonRequest,
  jsonResponse,
  loadLib,
  loadRoute,
  readConfig,
  withEnv,
  withFetch,
} from "./helpers/services.mjs";

// lib/anakin reads its base URL once, at module load.
process.env.ANAKIN_BASE_URL = "https://anakin.test";

const { articleUrl, imageSearchUrls, scrape } = await loadLib("anakin");
const { POST } = await loadRoute("research");
const config = await readConfig();

const ENDPOINT = "http://localhost:3000/api/research";
const KEY = { ANAKIN_API_KEY: "test-anakin-key" };
const SCRAPE_URL = "https://anakin.test/v1/url-scraper/scrape";

const JPEG = Buffer.from("pretend-jpeg-bytes");

/** Image fetches now carry a rendition width, so compare without the query. */
function withoutQuery(url) {
  const parsed = new URL(url);
  return `${parsed.origin}${parsed.pathname}`;
}

function imageResponse(bytes = JPEG, type = "image/jpeg") {
  return new Response(bytes, { status: 200, headers: { "content-type": type } });
}

/** Enough prose to clear the route's 120-character usefulness floor. */
function article(topic) {
  return `# ${topic}\n\n${topic} is a well documented subject with a long history, a broad literature, and many practical applications across several industries worldwide.\n\n## References\n\n[1] Someone. [Source](https://example.com/paper)`;
}

function unsplashUrl(name) {
  return `https://images.unsplash.com/photo-${name}`;
}

function callResearch(body, options) {
  return POST(jsonRequest(ENDPOINT, body, options));
}

/**
 * Routes every Anakin scrape and image fetch a research call makes. `images`
 * is what the Unsplash page yields per tag; `pexels` is the second source, left
 * empty by default so each test controls exactly how many candidates exist.
 */
function researchStub({ images = {}, pexels = {}, markdown = {}, imageBytes = () => imageResponse() } = {}) {
  return (call) => {
    if (call.url === SCRAPE_URL) {
      const { url } = JSON.parse(call.body);
      if (url.startsWith("https://en.wikipedia.org/")) {
        const key = decodeURIComponent(url.split("/wiki/")[1]).replace(/_/g, " ");
        return jsonResponse({ status: "completed", markdown: markdown[key] ?? "" });
      }
      const source = url.includes("pexels.com") ? pexels : images;
      const tag = decodeURIComponent(url.match(/\/(?:s\/photos|search)\/([^/?]+)/)[1]);
      return jsonResponse({ status: "completed", images: source[tag] ?? [] });
    }
    return imageBytes(call);
  };
}

test("topic URLs are built for sources that are addressable by topic", () => {
  assert.deepEqual(imageSearchUrls("  Solar Power  "), [
    "https://unsplash.com/s/photos/solar%20power",
    "https://www.pexels.com/search/solar%20power/",
  ]);
  assert.equal(articleUrl("  solar   power "), "https://en.wikipedia.org/wiki/solar_power");
  // Slashes and other URL syntax in a tag must not escape the wiki path.
  assert.equal(articleUrl("a/b?c"), "https://en.wikipedia.org/wiki/a%2Fb%3Fc");
});

test("scrape returns inline results and keeps only absolute http image URLs", async () => {
  const { result, calls } = await withFetch(
    () =>
      jsonResponse({
        status: "completed",
        markdown: "Some prose.",
        images: ["https://cdn.test/a.jpg", "/relative.jpg", 42, "https://cdn.test/a.jpg"],
        generatedJson: { images: ["http://cdn.test/b.jpg"] },
      }),
    () =>
      scrape("https://example.com", ["images", "markdown"], {
        apiKey: "test-anakin-key",
        signal: new AbortController().signal,
        timeoutMs: 1_000,
      }),
  );

  assert.deepEqual(result.images, ["https://cdn.test/a.jpg", "http://cdn.test/b.jpg"]);
  assert.equal(result.markdown, "Some prose.");

  assert.equal(calls[0].url, SCRAPE_URL);
  assert.equal(calls[0].headers.get("x-api-key"), "test-anakin-key");
  const sent = JSON.parse(calls[0].body);
  assert.equal(sent.url, "https://example.com");
  assert.deepEqual(sent.formats, ["images", "markdown"]);
  assert.equal(sent.useBrowser, false, "browser rendering is opt-in per call");
});

test("scrape reads Anakin's image objects, not just bare URLs", async () => {
  // The live scraper returns `{ alt, src, width, height }` per image; treating
  // that as a string silently threw away every result.
  const { result } = await withFetch(
    () =>
      jsonResponse({
        status: "completed",
        images: [
          { alt: "A worker installing solar panels", src: "https://plus.unsplash.com/premium_photo-1.jpg", width: "6720", height: "4480" },
          { alt: "solar panels on green field", src: "https://images.unsplash.com/photo-2.jpg", width: "3000", height: "4088" },
          // Dimensions arrive as strings; unknown dimensions are not "small".
          { alt: "no dimensions", src: "https://images.unsplash.com/photo-3.jpg" },
          { alt: "bare string form still works", url: "https://images.unsplash.com/photo-4.jpg" },
          "https://images.unsplash.com/photo-5.jpg",
        ],
      }),
    () =>
      scrape("https://unsplash.com/s/photos/solar", ["images"], {
        apiKey: "k",
        signal: new AbortController().signal,
        timeoutMs: 1_000,
      }),
  );

  assert.deepEqual(result.images, [
    "https://plus.unsplash.com/premium_photo-1.jpg",
    "https://images.unsplash.com/photo-2.jpg",
    "https://images.unsplash.com/photo-3.jpg",
    "https://images.unsplash.com/photo-4.jpg",
    "https://images.unsplash.com/photo-5.jpg",
  ]);
});

test("page chrome is filtered out by its dimensions", async () => {
  const { result } = await withFetch(
    () =>
      jsonResponse({
        status: "completed",
        images: [
          // Contributor avatars are 32x32 and would crowd out real photography.
          { alt: "Go to Getty Images's profile", src: "https://images.unsplash.com/profile-1.jpg", width: "32", height: "32" },
          { alt: "tracking pixel", src: "https://images.unsplash.com/pixel.gif", width: "1", height: "1" },
          { alt: "wide banner, short", src: "https://images.unsplash.com/banner.jpg", width: "1200", height: "60" },
          { alt: "real photo", src: "https://images.unsplash.com/photo-real.jpg", width: "3000", height: "2000" },
          { alt: "malformed entry", src: 42, width: "3000", height: "2000" },
          { alt: "no source at all", width: "3000", height: "2000" },
          null,
        ],
      }),
    () =>
      scrape("https://unsplash.com/s/photos/solar", ["images"], {
        apiKey: "k",
        signal: new AbortController().signal,
        timeoutMs: 1_000,
      }),
  );

  assert.deepEqual(result.images, ["https://images.unsplash.com/photo-real.jpg"]);
});

test("scrape reads a nested data envelope and caps the image list", async () => {
  const many = Array.from({ length: 40 }, (_, index) => `https://cdn.test/${index}.jpg`);
  const { result } = await withFetch(
    () => jsonResponse({ status: "completed", data: { images: many, markdown: "Prose." } }),
    () =>
      scrape("https://example.com", ["images"], {
        apiKey: "k",
        signal: new AbortController().signal,
        timeoutMs: 1_000,
      }),
  );

  assert.equal(result.images.length, 24);
  assert.equal(result.markdown, "Prose.");
});

test("scrape falls through to polling when Anakin answers with a job id", async () => {
  const { result, calls } = await withFetch(
    (call, index) =>
      index === 1
        ? jsonResponse({ status: "pending", id: "job/42" })
        : jsonResponse({ status: "completed", images: ["https://cdn.test/late.jpg"] }),
    () =>
      scrape("https://example.com", ["images"], {
        apiKey: "k",
        signal: new AbortController().signal,
        timeoutMs: 10_000,
      }),
  );

  assert.deepEqual(result.images, ["https://cdn.test/late.jpg"]);
  assert.equal(calls.length, 2);
  assert.equal(calls[1].url, "https://anakin.test/v1/url-scraper/job%2F42", "the job id is URL-encoded");
  assert.equal(calls[1].headers.get("x-api-key"), "k");
});

test("scrape reports a rejected request, a failed job, and an exhausted deadline", async () => {
  const signal = new AbortController().signal;

  await assert.rejects(
    () =>
      withFetch(
        () => new Response("nope", { status: 503 }),
        () => scrape("https://example.com", ["images"], { apiKey: "k", signal, timeoutMs: 1_000 }),
      ),
    /Anakin returned 503 for https:\/\/example\.com/,
  );

  await assert.rejects(
    () =>
      withFetch(
        (call, index) =>
          index === 1
            ? jsonResponse({ status: "pending", id: "job-1" })
            : jsonResponse({ status: "failed" }),
        () => scrape("https://example.com", ["images"], { apiKey: "k", signal, timeoutMs: 10_000 }),
      ),
    /failed scrape job/,
  );

  await assert.rejects(
    () =>
      withFetch(
        () => jsonResponse({ status: "pending", id: "job-1" }),
        // A deadline already in the past means the poll loop never runs.
        () => scrape("https://example.com", ["images"], { apiKey: "k", signal, timeoutMs: 0 }),
      ),
    /timed out/,
  );
});

test("returns inlined imagery and condensed article text per tag", async () => {
  const { result, calls } = await withEnv(KEY, () =>
    withFetch(
      researchStub({
        images: { "solar power": [unsplashUrl("a"), unsplashUrl("b")] },
        markdown: { "solar power": article("Solar power") },
      }),
      () => callResearch({ tags: ["solar power"] }),
    ),
  );

  assert.equal(result.status, 200);
  assert.equal(result.headers.get("Cache-Control"), "no-store");

  const payload = await result.json();
  assert.deepEqual(payload.tags, ["solar power"]);
  assert.equal(payload.images.length, 2);
  assert.equal(payload.images[0].tag, "solar power");
  assert.equal(payload.images[0].mimeType, "image/jpeg");
  assert.equal(
    payload.images[0].dataUrl,
    `data:image/jpeg;base64,${JPEG.toString("base64")}`,
    "images are inlined so export can rasterize them without tainting the canvas",
  );
  assert.equal(payload.images[0].sourceUrl, unsplashUrl("a"));

  assert.equal(payload.content.length, 1);
  assert.equal(payload.content[0].source, "https://en.wikipedia.org/wiki/solar_power");
  assert.match(payload.content[0].text, /Solar power is a well documented subject/);
  // Wiki chrome is stripped: no reference markers, no link syntax, no trailing sections.
  assert.doesNotMatch(payload.content[0].text, /\[1\]|\]\(|## References/);
  assert.ok(payload.content[0].text.length <= config.research.chars_per_tag);

  const scraped = calls.filter((call) => call.url === SCRAPE_URL).map((call) => JSON.parse(call.body));
  assert.equal(scraped.length, config.research.image_sources_per_tag + 1);
  assert.equal(
    scraped.filter((call) => call.useBrowser).length,
    config.research.image_sources_per_tag,
    "only the stock-photo pages need browser rendering",
  );
});

test("image bytes are fetched only from the CDNs the chosen sources serve from", async () => {
  const { result, calls } = await withEnv(KEY, () =>
    withFetch(
      researchStub({
        images: {
          "solar power": [
            "http://images.unsplash.com/insecure.jpg",
            "https://evil.example/tracker.jpg",
            "https://images.unsplash.com.evil.example/lookalike.jpg",
            "not a url",
            "https://images.pexels.com/allowed.jpg",
          ],
        },
        markdown: { "solar power": article("Solar power") },
      }),
      () => callResearch({ tags: ["solar power"] }),
    ),
  );

  const payload = await result.json();
  assert.deepEqual(
    payload.images.map((image) => image.sourceUrl),
    ["https://images.pexels.com/allowed.jpg"],
  );
  assert.deepEqual(
    calls.filter((call) => call.url !== SCRAPE_URL).map((call) => withoutQuery(call.url)),
    ["https://images.pexels.com/allowed.jpg"],
    "no request is made to a host outside the allowlist",
  );
});

test("a deck-sized rendition is requested, not the full-size original", async () => {
  const original = "https://images.unsplash.com/photo-1.jpg?fm=jpg&q=60&w=3000&fit=crop";
  const { result, calls } = await withEnv(KEY, () =>
    withFetch(
      researchStub({
        images: { "solar power": [original] },
        markdown: { "solar power": article("Solar power") },
      }),
      () => callResearch({ tags: ["solar power"] }),
    ),
  );

  const fetched = calls.filter((call) => call.url !== SCRAPE_URL).map((call) => new URL(call.url));
  assert.equal(fetched.length, 1);
  assert.equal(
    fetched[0].searchParams.get("w"),
    String(config.delivery.export_width_px),
    "the oversized width is replaced with the width the deck renders at",
  );
  assert.equal(fetched[0].searchParams.get("q"), "60", "other rendition parameters are left alone");

  // Provenance still points at what the search page actually linked.
  assert.equal((await result.json()).images[0].sourceUrl, original);
});

test("an image that is the wrong type, empty, oversized, or missing is skipped", async () => {
  const bytesFor = {
    "https://images.unsplash.com/photo-svg": new Response("<svg/>", {
      status: 200,
      headers: { "content-type": "image/svg+xml" },
    }),
    "https://images.unsplash.com/photo-empty": imageResponse(Buffer.alloc(0)),
    "https://images.unsplash.com/photo-huge": imageResponse(
      Buffer.alloc(config.research.max_image_bytes + 1, 1),
    ),
    "https://images.unsplash.com/photo-404": new Response("gone", { status: 404 }),
    "https://images.unsplash.com/photo-ok": imageResponse(JPEG, "image/png"),
  };

  const { result } = await withEnv(KEY, () =>
    withFetch(
      researchStub({
        images: { "solar power": Object.keys(bytesFor) },
        markdown: { "solar power": article("Solar power") },
        imageBytes: (call) => bytesFor[withoutQuery(call.url)],
      }),
      () => callResearch({ tags: ["solar power"] }),
    ),
  );

  const payload = await result.json();
  assert.deepEqual(
    payload.images.map((image) => image.sourceUrl),
    ["https://images.unsplash.com/photo-ok"],
  );
  assert.equal(payload.images[0].mimeType, "image/png");
});

test("one failing tag does not lose the others", async () => {
  const { result } = await withEnv(KEY, () =>
    withFetch(
      (call) => {
        if (call.url === SCRAPE_URL) {
          const { url } = JSON.parse(call.body);
          if (url.includes("broken")) return new Response("boom", { status: 500 });
          if (url.startsWith("https://en.wikipedia.org/")) {
            return jsonResponse({ status: "completed", markdown: article("Wind power") });
          }
          return jsonResponse({ status: "completed", images: [unsplashUrl("wind")] });
        }
        return imageResponse();
      },
      () => callResearch({ tags: ["broken topic", "wind power"] }),
    ),
  );

  assert.equal(result.status, 200);
  const payload = await result.json();
  assert.deepEqual(payload.tags, ["broken topic", "wind power"]);
  assert.deepEqual([...new Set(payload.content.map((entry) => entry.tag))], ["wind power"]);
  assert.deepEqual([...new Set(payload.images.map((image) => image.tag))], ["wind power"]);
});

test("thin article text is dropped rather than passed on as background", async () => {
  const { result } = await withEnv(KEY, () =>
    withFetch(
      researchStub({
        images: { "solar power": [unsplashUrl("a")] },
        markdown: { "solar power": "Too short to be useful." },
      }),
      () => callResearch({ tags: ["solar power"] }),
    ),
  );

  const payload = await result.json();
  assert.deepEqual(payload.content, []);
  assert.equal(payload.images.length, 1, "the imagery for that tag still comes through");
});

test("the image library is filled round-robin and capped", async () => {
  const tags = ["alpha", "beta", "gamma"];
  const { result } = await withEnv(KEY, () =>
    withFetch(
      researchStub({
        images: Object.fromEntries(
          tags.map((tag) => [tag, Array.from({ length: 6 }, (_, index) => unsplashUrl(`${tag}-${index}`))]),
        ),
        markdown: Object.fromEntries(tags.map((tag) => [tag, article(tag)])),
      }),
      () => callResearch({ tags }),
    ),
  );

  const payload = await result.json();
  assert.equal(payload.images.length, config.research.max_images);
  // Round-robin: no single prolific topic gets to fill the whole library.
  const perTag = tags.map((tag) => payload.images.filter((image) => image.tag === tag).length);
  assert.ok(Math.max(...perTag) - Math.min(...perTag) <= 1, `uneven split: ${perTag}`);
});

test("tags are cleaned, deduplicated, and capped before any scraping", async () => {
  const { calls } = await withEnv(KEY, () =>
    withFetch(
      researchStub({ markdown: { "solar power": article("Solar power") } }),
      () =>
        callResearch({
          tags: ["  solar   power ", "solar power", 42, null, "", "x".repeat(80), ...Array.from({ length: 10 }, (_, i) => `topic ${i}`)],
        }),
    ),
  );

  const scrapedTopics = new Set(
    calls
      .filter((call) => call.url === SCRAPE_URL)
      .map((call) => JSON.parse(call.body).url)
      .filter((url) => url.startsWith("https://en.wikipedia.org/"))
      .map((url) => decodeURIComponent(url.split("/wiki/")[1]).replace(/_/g, " ")),
  );

  assert.equal(scrapedTopics.size, config.research.max_tags);
  assert.ok(scrapedTopics.has("solar power"));
  assert.ok([...scrapedTopics].every((tag) => tag.length <= 40), "each tag is clipped to 40 characters");
});

test("a request with no usable tags is rejected before any scraping", async () => {
  const { result, calls } = await withEnv(KEY, () =>
    withFetch(
      () => {
        throw new Error("Anakin must not be called without tags.");
      },
      async () => [
        await callResearch({}),
        await callResearch({ tags: [] }),
        await callResearch({ tags: [1, null, "  "] }),
        await callResearch({ tags: "solar power" }),
        await POST(
          new Request(ENDPOINT, {
            method: "POST",
            headers: { "content-type": "application/json", "x-forwarded-for": freshClient() },
            body: "{",
          }),
        ),
      ],
    ),
  );

  for (const response of result) {
    assert.equal(response.status, 400);
    assert.match((await response.json()).error, /Tags are required/);
  }
  assert.equal(calls.length, 0);
});

test("a research run that finds nothing usable is a 502", async () => {
  const { result } = await withEnv(KEY, () =>
    withFetch(
      researchStub({ images: {}, markdown: {} }),
      () => callResearch({ tags: ["obscure topic"] }),
    ),
  );

  assert.equal(result.status, 502);
  assert.match((await result.json()).error, /nothing usable/);
});

test("without an Anakin key the service reports 503", async () => {
  const response = await withEnv({ ANAKIN_API_KEY: undefined }, () =>
    callResearch({ tags: ["solar power"] }),
  );

  assert.equal(response.status, 503);
  assert.match((await response.json()).error, /ANAKIN_API_KEY/);
});

test("blocks cross-origin callers and throttles a flood", async () => {
  const crossOrigin = await withEnv(KEY, () =>
    callResearch({ tags: ["solar power"] }, { headers: { origin: "http://evil.example" } }),
  );
  assert.equal(crossOrigin.status, 403);

  const client = freshClient();
  const limit = config.security.research_requests_per_window;
  const { result } = await withEnv(KEY, () =>
    withFetch(
      researchStub({
        images: { "solar power": [unsplashUrl("a")] },
        markdown: { "solar power": article("Solar power") },
      }),
      async () => {
        for (let attempt = 0; attempt < limit; attempt += 1) {
          await callResearch({ tags: ["solar power"] }, { client });
        }
        return callResearch({ tags: ["solar power"] }, { client });
      },
    ),
  );

  assert.equal(result.status, 429);
  assert.equal(result.headers.get("X-RateLimit-Limit"), String(limit));
});
