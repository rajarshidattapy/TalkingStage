import assert from "node:assert/strict";
import test from "node:test";
import {
  freshClient,
  geminiImage,
  geminiText,
  jsonRequest,
  jsonResponse,
  loadRoute,
  readConfig,
  withEnv,
  withFetch,
} from "./helpers/services.mjs";

const { POST } = await loadRoute("imagery/generate");
const config = await readConfig();

const ENDPOINT = "http://localhost:3000/api/imagery/generate";
const KEY = { GEMINI_API_KEY: "test-gemini-key", GOOGLE_API_KEY: undefined };
const PIXELS = Buffer.from("pretend-jpeg-bytes").toString("base64");
const COUNT = config.imagery.generated_batch_size;

const NOTES = `We are a rooftop solar installer working across Karnataka and Tamil Nadu.
Founded 2019. 4,200 residential rooftops installed. Average payback now 5.8 years.
The bottleneck is the discom inspection queue, not the hardware.`;

const PROMPTS = [
  "A close-up photograph of an installer securing a mounting bracket onto a sunlit clay tile roof",
  "An aerial photograph of a South Indian neighbourhood with rooftop solar arrays across the street",
  "A technician inspecting a home battery unit mounted beside an electrical meter box outdoors",
  "A stack of utility paperwork and site maps resting on a clipboard beside a ladder",
  "A wide photograph of a crew carrying solar panels across a flat rooftop at midday",
];

/** First call writes the prompts; every later call renders one image. */
function generationStub({ prompts = PROMPTS, image = () => geminiImage(PIXELS) } = {}) {
  return (call, index) =>
    index === 1
      ? geminiText(typeof prompts === "string" ? prompts : JSON.stringify(prompts))
      : image(call, index);
}

function callGenerate(body, options) {
  return POST(jsonRequest(ENDPOINT, body, options));
}

test("writes prompts from the notes, then returns a batch of images", async () => {
  const { result, calls } = await withEnv(KEY, () =>
    withFetch(generationStub(), () => callGenerate({ notes: NOTES })),
  );

  assert.equal(result.status, 200);
  assert.equal(result.headers.get("Cache-Control"), "no-store");

  const payload = await result.json();
  assert.equal(payload.requested, COUNT);
  assert.equal(payload.images.length, COUNT);
  for (const [index, image] of payload.images.entries()) {
    assert.equal(image.prompt, PROMPTS[index], "each image reports the prompt that made it");
    assert.equal(image.mimeType, "image/jpeg");
    assert.equal(image.dataUrl, `data:image/jpeg;base64,${PIXELS}`);
  }

  // One prompt-writing call, then one call per image.
  assert.equal(calls.length, 1 + COUNT);
});

test("the prompt request sees the notes and nothing else", async () => {
  const { calls } = await withEnv(KEY, () =>
    withFetch(generationStub(), () =>
      callGenerate({ notes: NOTES, vibe: "hopeful", tags: ["solar"] }),
    ),
  );

  const sent = JSON.parse(calls[0].body);
  assert.equal(sent.model, config.imagery.prompt_model);
  assert.equal(sent.store, false);
  assert.match(sent.input, /<notes>/);
  assert.match(sent.input, /rooftop solar installer/);
  assert.match(sent.input, new RegExp(`write ${COUNT} image prompts`));
  assert.match(sent.input, /Cover a different idea from the notes/);
  assert.match(sent.input, /no text, words, letters, numbers, charts, logos/);
  // Only the notes drive the subjects.
  assert.doesNotMatch(sent.input, /hopeful/);
  assert.doesNotMatch(sent.input, /art_direction/);
});

test("optional art direction rides along as a separate field", async () => {
  const { calls } = await withEnv(KEY, () =>
    withFetch(generationStub(), () =>
      callGenerate({ notes: NOTES, prompt: "  warm documentary   photography  " }),
    ),
  );

  const sent = JSON.parse(calls[0].body);
  assert.match(sent.input, /<art_direction>warm documentary photography<\/art_direction>/);
});

test("each image is rendered by the fast image model at the configured format", async () => {
  const { calls } = await withEnv(KEY, () =>
    withFetch(generationStub(), () => callGenerate({ notes: NOTES })),
  );

  for (const call of calls.slice(1)) {
    const sent = JSON.parse(call.body);
    assert.equal(sent.model, config.imagery.model);
    assert.equal(sent.store, false);
    assert.deepEqual(sent.response_format, {
      type: "image",
      mime_type: config.imagery.mime_type,
      aspect_ratio: config.imagery.aspect_ratio,
      image_size: config.imagery.image_size,
    });
    assert.match(sent.input, /no text or lettering anywhere in the frame/);
  }

  const rendered = calls.slice(1).map((call) => JSON.parse(call.body).input.split("\n")[0]);
  assert.deepEqual(rendered, PROMPTS, "one render per written prompt, in order");
});

test("prompts are cleaned, bounded, and capped at the batch size", async () => {
  const messy = [
    "  A   photograph of\ta sunlit  clay tile roof with new panels  ",
    "too short",
    42,
    null,
    "x".repeat(900),
    ...Array.from({ length: 10 }, (_, index) => `A photograph of subject number ${index} outdoors`),
  ];

  const { result, calls } = await withEnv(KEY, () =>
    withFetch(generationStub({ prompts: messy }), () => callGenerate({ notes: NOTES })),
  );

  const payload = await result.json();
  assert.equal(payload.images.length, COUNT, "never more than one batch");
  assert.equal(
    payload.images[0].prompt,
    "A photograph of a sunlit clay tile roof with new panels",
    "whitespace collapses",
  );
  assert.ok(
    payload.images.every((image) => image.prompt.length <= 400),
    "each prompt is bounded",
  );
  assert.ok(
    payload.images.every((image) => image.prompt !== "too short"),
    "unusably short prompts are dropped",
  );
  assert.equal(calls.length, 1 + COUNT);
});

test("prose around the JSON array is tolerated", async () => {
  const { result } = await withEnv(KEY, () =>
    withFetch(
      generationStub({ prompts: `Sure! Here you go:\n${JSON.stringify(PROMPTS)}\nHope that helps.` }),
      () => callGenerate({ notes: NOTES }),
    ),
  );

  assert.equal((await result.json()).images.length, COUNT);
});

test("one failed image does not lose the rest of the batch", async () => {
  const { result } = await withEnv(KEY, () =>
    withFetch(
      generationStub({
        image: (_call, index) =>
          index === 3
            ? jsonResponse({ id: "interaction_test", steps: [] })
            : geminiImage(PIXELS),
      }),
      () => callGenerate({ notes: NOTES }),
    ),
  );

  assert.equal(result.status, 200);
  const payload = await result.json();
  assert.equal(payload.requested, COUNT);
  assert.equal(payload.images.length, COUNT - 1, "the batch is returned minus the failure");
  assert.equal(
    payload.images.some((image) => image.prompt === PROMPTS[1]),
    false,
    "the failed prompt is the one missing",
  );
});

test("a batch where every image fails reports why", async () => {
  const { result } = await withEnv(KEY, () =>
    withFetch(
      generationStub({ image: () => jsonResponse({ error: { message: "Safety block." } }, 400) }),
      () => callGenerate({ notes: NOTES }),
    ),
  );

  assert.equal(result.status, 502);
  assert.ok((await result.json()).error);
});

test("notes too thin to draw from are rejected before any upstream call", async () => {
  const { result, calls } = await withEnv(KEY, () =>
    withFetch(
      () => {
        throw new Error("Gemini must not be called without usable notes.");
      },
      async () => [
        await callGenerate({}),
        await callGenerate({ notes: "   " }),
        await callGenerate({ notes: "Solar is good." }),
        await callGenerate({ notes: 42 }),
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
    assert.match((await response.json()).error, /notes/i);
  }
  assert.equal(calls.length, 0);
});

test("notes are clipped to the setup budget", async () => {
  const { calls } = await withEnv(KEY, () =>
    withFetch(generationStub(), () => callGenerate({ notes: `${NOTES} ${"n".repeat(30_000)}` })),
  );

  const notes = JSON.parse(calls[0].body).input.match(/<notes>([\s\S]*?)<\/notes>/)[1];
  assert.equal(notes.length, config.setup.max_notes_chars);
});

test("unusable prompt output is reported without rendering anything", async () => {
  for (const reply of ["I cannot help with that.", "[]", '["short", 1]']) {
    const { result, calls } = await withEnv(KEY, () =>
      withFetch(generationStub({ prompts: reply }), () => callGenerate({ notes: NOTES })),
    );
    assert.equal(result.status, 502, reply);
    assert.match((await result.json()).error, /No image ideas/, reply);
    assert.equal(calls.length, 1, "no image is rendered without a prompt");
  }
});

test("a failure while writing prompts is reported as 502", async () => {
  const { result } = await withEnv(KEY, () =>
    withFetch(
      () => jsonResponse({ error: { message: "quota exhausted" } }, 429),
      () => callGenerate({ notes: NOTES }),
    ),
  );

  assert.equal(result.status, 502);
  assert.ok((await result.json()).error);
});

test("without a Gemini key the service reports 503", async () => {
  const response = await withEnv({ GEMINI_API_KEY: undefined, GOOGLE_API_KEY: undefined }, () =>
    callGenerate({ notes: NOTES }),
  );

  assert.equal(response.status, 503);
  assert.match((await response.json()).error, /GEMINI_API_KEY/);
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
    body: JSON.stringify({ notes: NOTES }),
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
    callGenerate({ notes: NOTES }, { headers: { origin: "http://evil.example" } }),
  );
  assert.equal(crossOrigin.status, 403);
  assert.match((await crossOrigin.json()).error, /Cross-origin/);

  const client = freshClient();
  const limit = config.security.generate_requests_per_window;
  // A generation fans out to six upstream calls, so it has its own tighter budget.
  assert.ok(limit < config.security.setup_requests_per_window);

  const { result } = await withEnv(KEY, () =>
    withFetch(generationStub(), async () => {
      for (let attempt = 0; attempt < limit; attempt += 1) {
        await callGenerate({ notes: NOTES }, { client });
      }
      return callGenerate({ notes: NOTES }, { client });
    }),
  );

  assert.equal(result.status, 429);
  assert.equal(result.headers.get("X-RateLimit-Limit"), String(limit));
});
