import assert from "node:assert/strict";
import test from "node:test";
import {
  freshClient,
  geminiImage,
  jsonRequest,
  jsonResponse,
  loadRoute,
  readConfig,
  withEnv,
  withFetch,
} from "./helpers/services.mjs";

const { POST } = await loadRoute("imagery");
const config = await readConfig();

const ENDPOINT = "http://localhost:3000/api/imagery";
const KEY = { GEMINI_API_KEY: "test-gemini-key", GOOGLE_API_KEY: undefined };
const PIXELS = Buffer.from("pretend-jpeg-bytes").toString("base64");

const HERO = {
  sceneId: "scene-7",
  kind: "hero",
  eyebrow: "Opening",
  title: "Energy that pays for itself",
  subtitle: "Rooftop solar reached grid parity in every state last year.",
  accent: "ember",
};

function dataUrl(mimeType, byteLength) {
  return `data:${mimeType};base64,${Buffer.alloc(byteLength, 7).toString("base64")}`;
}

function callImagery(body, options) {
  return POST(jsonRequest(ENDPOINT, body, options));
}

/** The prompt is the first text part whether or not references were attached. */
function promptOf(call) {
  const sent = JSON.parse(call.body);
  return typeof sent.input === "string" ? sent.input : sent.input[0].text;
}

test("returns the generated image as raw bytes tagged with its scene and model", async () => {
  const { result, calls } = await withEnv(KEY, () =>
    withFetch(
      () => geminiImage(PIXELS),
      () => callImagery(HERO),
    ),
  );

  assert.equal(result.status, 200);
  assert.equal(result.headers.get("Content-Type"), "image/jpeg");
  assert.equal(result.headers.get("X-GurudornaAI-Scene"), "scene-7");
  assert.equal(result.headers.get("X-GurudornaAI-Image-Model"), config.imagery.model);
  // Slide imagery is presenter content; it must not sit in any cache.
  assert.match(result.headers.get("Cache-Control"), /no-store/);
  assert.equal(
    Buffer.from(await result.arrayBuffer()).toString("base64"),
    PIXELS,
    "the response body is the decoded image, not a JSON envelope",
  );

  const sent = JSON.parse(calls[0].body);
  assert.equal(sent.model, config.imagery.model);
  assert.equal(sent.store, false);
  assert.deepEqual(sent.response_format, {
    type: "image",
    mime_type: config.imagery.mime_type,
    aspect_ratio: config.imagery.aspect_ratio,
    image_size: config.imagery.image_size,
  });
});

test("the prompt carries the scene content and forbids rendering a slide", async () => {
  const { calls } = await withEnv(KEY, () =>
    withFetch(
      () => geminiImage(PIXELS),
      () =>
        callImagery({
          ...HERO,
          kind: "cards",
          cards: [
            { title: "Install cost", body: "Down 71% since 2010." },
            { title: "Payback", body: "Under six years in most markets." },
          ],
        }),
    ),
  );

  const prompt = promptOf(calls[0]);
  assert.match(prompt, /Energy that pays for itself/);
  assert.match(prompt, /Install cost: Down 71% since 2010/);
  assert.match(prompt, /Payback: Under six years/);
  assert.match(prompt, /electric orange-red/, "the ember accent is described, not passed as a token");
  assert.match(prompt, /wide establishing image/, "cards get their own composition direction");
  assert.match(prompt, /Do not render a slide/);
  assert.match(prompt, /No new words, letters, numbers/);
});

test("each scene kind gets its own composition direction", async () => {
  const directions = {
    hero: /unmistakable visual subject near the center/,
    cards: /wide establishing image/,
    metric: /visual metaphor for the metric/,
    quote: /atmospheric, emotionally resonant/,
  };

  for (const [kind, expected] of Object.entries(directions)) {
    const { calls } = await withEnv(KEY, () =>
      withFetch(
        () => geminiImage(PIXELS),
        () => callImagery({ ...HERO, kind }),
      ),
    );
    assert.match(promptOf(calls[0]), expected, `${kind} direction`);
  }
});

test("reference assets switch the model and ride along as image parts", async () => {
  const { result, calls } = await withEnv(KEY, () =>
    withFetch(
      () => geminiImage(PIXELS),
      () =>
        callImagery({
          ...HERO,
          referenceAssets: [
            {
              id: "asset-mood",
              name: "Studio moodboard",
              kind: "illustration",
              dataUrl: dataUrl("image/webp", 2048),
            },
          ],
        }),
    ),
  );

  assert.equal(result.status, 200);
  assert.equal(result.headers.get("X-GurudornaAI-Image-Model"), config.imagery.reference_model);

  const sent = JSON.parse(calls[0].body);
  assert.equal(Array.isArray(sent.input), true, "references make the input multipart");
  assert.equal(sent.input[0].type, "text");
  assert.equal(sent.input[1].type, "image");
  assert.equal(sent.input[1].mime_type, "image/webp");
  assert.match(sent.input[0].text, /Reference 1 is Studio moodboard \(illustration\)/);
  assert.match(sent.input[0].text, /Do not invent, rewrite, or distort logos/);
});

test("only well-formed, in-budget references are attached", async () => {
  const keeper = { id: "good-1", name: "Keeper", kind: "photo", dataUrl: dataUrl("image/jpeg", 512) };
  // Validation runs inside the first `max_reference_assets` entries, so each
  // case keeps the batch small enough that the cap is not what does the work.
  const rejected = {
    "a non-object entry": "not-an-object",
    "a missing data URL": { id: "no-data", name: "Missing data URL" },
    "an unsupported image type": { id: "gif", name: "Wrong type", dataUrl: dataUrl("image/gif", 512) },
    "a plain URL instead of inline bytes": {
      id: "remote",
      name: "Remote",
      dataUrl: "https://example.com/photo.png",
    },
    "an unnamed asset": { id: "nameless", name: "", dataUrl: dataUrl("image/png", 512) },
    "an asset with no id": { id: "", name: "Anonymous", dataUrl: dataUrl("image/png", 512) },
    "an oversized asset": {
      id: "huge",
      name: "Too big",
      dataUrl: dataUrl("image/png", config.imagery.max_reference_bytes + 5_000),
    },
  };

  for (const [label, bad] of Object.entries(rejected)) {
    const { calls } = await withEnv(KEY, () =>
      withFetch(
        () => geminiImage(PIXELS),
        () => callImagery({ ...HERO, referenceAssets: [bad, keeper] }),
      ),
    );

    const sent = JSON.parse(calls[0].body);
    assert.equal(
      sent.input.filter((part) => part.type === "image").length,
      1,
      `${label} should be dropped while the valid reference survives`,
    );
    assert.match(sent.input[0].text, /Reference 1 is Keeper/);
  }
});

test("a reference batch that is entirely invalid falls back to a plain prompt", async () => {
  const { result, calls } = await withEnv(KEY, () =>
    withFetch(
      () => geminiImage(PIXELS),
      () =>
        callImagery({
          ...HERO,
          referenceAssets: [{ id: "gif", name: "Wrong type", dataUrl: dataUrl("image/gif", 512) }],
        }),
    ),
  );

  assert.equal(result.status, 200);
  const sent = JSON.parse(calls[0].body);
  assert.equal(typeof sent.input, "string", "no references means no multipart input");
  assert.equal(sent.model, config.imagery.model, "and the non-reference model is used");
  assert.match(sent.input, /Avoid identifiable public figures/);
});

test("never attaches more references than the configured maximum", async () => {
  const many = Array.from({ length: 8 }, (_, index) => ({
    id: `asset-${index}`,
    name: `Reference ${index}`,
    kind: "photo",
    dataUrl: dataUrl("image/png", 256),
  }));

  const { calls } = await withEnv(KEY, () =>
    withFetch(
      () => geminiImage(PIXELS),
      () => callImagery({ ...HERO, referenceAssets: many }),
    ),
  );

  const sent = JSON.parse(calls[0].body);
  assert.equal(
    sent.input.filter((part) => part.type === "image").length,
    config.imagery.max_reference_assets,
  );
});

test("originals placed on the slide are described as off-limits to the generator", async () => {
  const { calls } = await withEnv(KEY, () =>
    withFetch(
      () => geminiImage(PIXELS),
      () => callImagery({ ...HERO, exactAssetKinds: ["person", "logo"] }),
    ),
  );

  const prompt = promptOf(calls[0]);
  assert.match(prompt, /Original person, logo assets are overlaid separately/);
  assert.match(prompt, /restrained complementary environment/);
  assert.match(prompt, /Do not depict, imitate, redraw, or duplicate/);
});

test("an incomplete scene is rejected before any upstream call", async () => {
  const incomplete = [
    { ...HERO, sceneId: "" },
    { ...HERO, title: "" },
    { ...HERO, kind: "timeline" },
    { ...HERO, kind: "" },
  ];

  const { calls } = await withEnv(KEY, () =>
    withFetch(
      () => {
        throw new Error("Gemini must not be called for an incomplete scene.");
      },
      async () => {
        for (const body of incomplete) {
          const response = await callImagery(body);
          assert.equal(response.status, 400);
          assert.match((await response.json()).error, /scene is incomplete/);
        }
      },
    ),
  );

  assert.equal(calls.length, 0);
});

test("malformed JSON, a missing key, and an empty generation all fail cleanly", async () => {
  const malformed = await withEnv(KEY, () =>
    POST(
      new Request(ENDPOINT, {
        method: "POST",
        headers: { "content-type": "application/json", "x-forwarded-for": freshClient() },
        body: "{{{",
      }),
    ),
  );
  assert.equal(malformed.status, 400);

  const keyless = await withEnv({ GEMINI_API_KEY: undefined, GOOGLE_API_KEY: undefined }, () =>
    callImagery(HERO),
  );
  assert.equal(keyless.status, 503);
  assert.match((await keyless.json()).error, /GEMINI_API_KEY/);

  const { result: imageless } = await withEnv(KEY, () =>
    withFetch(
      () => jsonResponse({ id: "interaction_test", steps: [] }),
      () => callImagery(HERO),
    ),
  );
  assert.equal(imageless.status, 502);
  assert.match((await imageless.json()).error, /did not return an image/);

  const { result: upstreamError } = await withEnv(KEY, () =>
    withFetch(
      () => jsonResponse({ error: { message: "safety block" } }, 400),
      () => callImagery(HERO),
    ),
  );
  assert.equal(upstreamError.status, 502);
});

test("an aborted scene ends as 499 instead of an error payload", async () => {
  const controller = new AbortController();
  const request = new Request(ENDPOINT, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      origin: "http://localhost:3000",
      "x-forwarded-for": freshClient(),
    },
    body: JSON.stringify(HERO),
    signal: controller.signal,
  });

  const { result } = await withEnv(KEY, () =>
    withFetch(
      () => {
        // The client navigated away mid-generation, exactly as the page does
        // when the speaker moves on to the next scene.
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
    callImagery(HERO, { headers: { origin: "https://evil.example" } }),
  );
  assert.equal(crossOrigin.status, 403);
  assert.match((await crossOrigin.json()).error, /Cross-origin/);

  const client = freshClient();
  const limit = config.security.imagery_requests_per_window;
  const { result } = await withEnv(KEY, () =>
    withFetch(
      () => geminiImage(PIXELS),
      async () => {
        for (let attempt = 0; attempt < limit; attempt += 1) {
          await callImagery(HERO, { client });
        }
        return callImagery(HERO, { client });
      },
    ),
  );

  assert.equal(result.status, 429);
  assert.equal(result.headers.get("X-RateLimit-Limit"), String(limit));
});
