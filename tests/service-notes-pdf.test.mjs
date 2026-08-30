import assert from "node:assert/strict";
import test from "node:test";
import { zipSync, strToU8 } from "fflate";
import { PDFDocument } from "pdf-lib";
import {
  freshClient,
  jsonResponse,
  loadRoute,
  rawRequest,
  readConfig,
  withEnv,
  withFetch,
} from "./helpers/services.mjs";

const { POST } = await loadRoute("notes/pdf");
const config = await readConfig();

const ENDPOINT = "http://localhost:3000/api/notes/pdf";
const KEY = { SARVAM_API_KEY: "test-sarvam-key" };
const DIGITISE_URL = "https://api.sarvam.ai/doc-ai/v1/job/digitise";
const OUTPUT_URL = "https://sarvam-output.test/job.zip";

// The route polls on a real timer, so tests shorten the interval rather than
// waiting the configured five seconds per poll.
config.notes.poll_interval_ms = 5;

async function pdfWithPages(count) {
  const document = await PDFDocument.create();
  for (let index = 0; index < count; index += 1) {
    document.addPage([612, 792]).drawText(`Page ${index + 1}`, { x: 50, y: 700, size: 24 });
  }
  return Buffer.from(await document.save());
}

function markdownZip(pages) {
  return zipSync(
    Object.fromEntries(Object.entries(pages).map(([name, text]) => [name, strToU8(text)])),
  );
}

function callNotes(pdf, { language, fileName = "notes.pdf", ...options } = {}) {
  const form = new FormData();
  if (pdf !== undefined) form.append("file", new Blob([pdf], { type: "application/pdf" }), fileName);
  if (language) form.append("language", language);
  return POST(rawRequest(ENDPOINT, form, options));
}

/** Submit -> poll -> download, the happy path of a digitise job. */
function digitiseStub({ zip, statuses = [{ status: "completed", output_url: OUTPUT_URL }] } = {}) {
  const remaining = new Map();
  return (call) => {
    if (call.url === DIGITISE_URL) return jsonResponse({ job_id: `job-${remaining.size + 1}` });
    if (call.url.endsWith("/status")) {
      const queue = remaining.get(call.url) ?? [...statuses];
      const next = queue.length > 1 ? queue.shift() : queue[0];
      remaining.set(call.url, queue);
      return jsonResponse(next);
    }
    return new Response(zip, { status: 200 });
  };
}

test("converts a short PDF in one job and returns the concatenated Markdown", async () => {
  const pdf = await pdfWithPages(3);
  const zip = markdownZip({
    "page_1.md": "# Notes\n\nFirst page.",
    "page_2.md": "Second page.",
    "page_3.md": "Third page.",
  });

  const { result, calls } = await withEnv(KEY, () =>
    withFetch(digitiseStub({ zip }), () => callNotes(pdf)),
  );

  assert.equal(result.status, 200);
  assert.equal(result.headers.get("Cache-Control"), "no-store");
  assert.deepEqual(await result.json(), {
    markdown: "# Notes\n\nFirst page.\n\nSecond page.\n\nThird page.",
    pages: 3,
  });

  const submissions = calls.filter((call) => call.url === DIGITISE_URL);
  assert.equal(submissions.length, 1, "ten pages or fewer go as a single job");
  assert.equal(submissions[0].headers.get("api-subscription-key"), "test-sarvam-key");
  assert.equal(calls.at(-1).url, OUTPUT_URL);
});

test("pages are ordered numerically and non-Markdown members are ignored", async () => {
  const pdf = await pdfWithPages(1);
  const zip = markdownZip({
    "page_10.md": "Tenth.",
    "page_2.md": "Second.",
    "page_1.md": "First.",
    "metadata.json": '{"pages":10}',
    "thumbnail.png": "not markdown",
    "page_3.md": "   ",
  });

  const { result } = await withEnv(KEY, () =>
    withFetch(digitiseStub({ zip }), () => callNotes(pdf)),
  );

  // "page_10" must sort after "page_2", and the blank page drops out entirely.
  assert.equal((await result.json()).markdown, "First.\n\nSecond.\n\nTenth.");
});

test("the requested language and output format reach Sarvam", async () => {
  const pdf = await pdfWithPages(1);
  const { calls } = await withEnv(KEY, () =>
    withFetch(digitiseStub({ zip: markdownZip({ "page_1.md": "Notes." }) }), () =>
      callNotes(pdf, { language: "hi-IN" }),
    ),
  );

  const body = calls[0].body;
  assert.ok(body instanceof FormData, "the PDF is forwarded as multipart, not re-encoded");
  assert.equal(body.get("language_code"), "hi-IN");
  assert.equal(body.get("output_format"), "md");
  assert.ok(body.get("file") instanceof Blob);
});

test("no language means the configured default", async () => {
  const pdf = await pdfWithPages(1);
  const { calls } = await withEnv(KEY, () =>
    withFetch(digitiseStub({ zip: markdownZip({ "page_1.md": "Notes." }) }), () => callNotes(pdf)),
  );

  assert.equal(calls[0].body.get("language_code"), config.notes.default_language);
});

test("a long PDF is split into ten-page jobs and reassembled in order", async () => {
  const pdf = await pdfWithPages(23);
  const chunkText = ["First chunk.", "Second chunk.", "Third chunk."];
  let submitted = 0;

  const { result, calls } = await withEnv(KEY, () =>
    withFetch(
      (call) => {
        if (call.url === DIGITISE_URL) {
          submitted += 1;
          return jsonResponse({ job_id: `job-${submitted}` });
        }
        if (call.url.endsWith("/status")) {
          const id = call.url.match(/job-(\d+)/)[1];
          return jsonResponse({ status: "completed", output_url: `${OUTPUT_URL}?job=${id}` });
        }
        const id = Number(new URL(call.url).searchParams.get("job"));
        return new Response(markdownZip({ "page_1.md": chunkText[id - 1] }), { status: 200 });
      },
      () => callNotes(pdf),
    ),
  );

  const payload = await result.json();
  assert.equal(payload.pages, 23, "the page count is the original document's");
  assert.equal(payload.markdown, chunkText.join("\n\n"));

  const submissions = calls.filter((call) => call.url === DIGITISE_URL);
  assert.equal(submissions.length, 3, "23 pages need three jobs at the 10-page API limit");

  // Each chunk really is a separate, smaller PDF, not the whole document resent.
  for (const submission of submissions) {
    const chunk = await submission.body.get("file").arrayBuffer();
    const loaded = await PDFDocument.load(new Uint8Array(chunk));
    assert.ok(loaded.getPageCount() <= 10);
    assert.ok(chunk.byteLength < pdf.length);
  }
});

test("polling continues through in-progress states until the job completes", async () => {
  const pdf = await pdfWithPages(1);
  const { result, calls } = await withEnv(KEY, () =>
    withFetch(
      digitiseStub({
        zip: markdownZip({ "page_1.md": "Eventually done." }),
        statuses: [
          { status: "Queued" },
          { status: "PROCESSING" },
          { status: "Succeeded", outputUrl: OUTPUT_URL },
        ],
      }),
      () => callNotes(pdf),
    ),
  );

  assert.equal(result.status, 200);
  assert.equal((await result.json()).markdown, "Eventually done.");
  assert.equal(calls.filter((call) => call.url.endsWith("/status")).length, 3);
});

test("a transient status error is retried rather than failing the job", async () => {
  const pdf = await pdfWithPages(1);
  let polls = 0;

  const { result } = await withEnv(KEY, () =>
    withFetch(
      (call) => {
        if (call.url === DIGITISE_URL) return jsonResponse({ jobId: "job-1" });
        if (call.url.endsWith("/status")) {
          polls += 1;
          return polls === 1
            ? new Response("bad gateway", { status: 502 })
            : jsonResponse({ status: "completed", output_url: OUTPUT_URL });
        }
        return new Response(markdownZip({ "page_1.md": "Recovered." }), { status: 200 });
      },
      () => callNotes(pdf),
    ),
  );

  assert.equal(result.status, 200);
  assert.equal((await result.json()).markdown, "Recovered.");
});

test("upstream failures each surface as a 502 with the reason", async () => {
  const pdf = await pdfWithPages(1);
  const failures = {
    "a rejected submission": [
      () => new Response("unsupported", { status: 415 }),
      /rejected the document \(415\)/,
    ],
    "a submission with no job id": [() => jsonResponse({}), /did not return a job id/],
    "a failed job": [
      (call) =>
        call.url === DIGITISE_URL
          ? jsonResponse({ job_id: "job-1" })
          : jsonResponse({ status: "failed", error: "Scanned pages were unreadable." }),
      /Scanned pages were unreadable/,
    ],
    "a completed job with no output": [
      (call) =>
        call.url === DIGITISE_URL
          ? jsonResponse({ job_id: "job-1" })
          : jsonResponse({ status: "completed" }),
      /without an output URL/,
    ],
    "an undownloadable output": [
      (call) => {
        if (call.url === DIGITISE_URL) return jsonResponse({ job_id: "job-1" });
        if (call.url.endsWith("/status")) {
          return jsonResponse({ status: "completed", output_url: OUTPUT_URL });
        }
        return new Response("gone", { status: 404 });
      },
      /could not be downloaded/,
    ],
  };

  for (const [label, [handler, expected]] of Object.entries(failures)) {
    const { result } = await withEnv(KEY, () => withFetch(handler, () => callNotes(pdf)));
    assert.equal(result.status, 502, label);
    assert.match((await result.json()).error, expected, label);
  }
});

test("a PDF that yields no text is reported rather than returned as empty notes", async () => {
  const pdf = await pdfWithPages(1);
  const { result } = await withEnv(KEY, () =>
    withFetch(digitiseStub({ zip: markdownZip({ "page_1.md": "   \n  " }) }), () => callNotes(pdf)),
  );

  assert.equal(result.status, 502);
  assert.match((await result.json()).error, /No text was found/);
});

test("a missing file, an empty file, and an over-length document are rejected", async () => {
  const { result, calls } = await withEnv(KEY, () =>
    withFetch(
      () => {
        throw new Error("Sarvam must not be called for an unusable upload.");
      },
      async () => [
        [await callNotes(undefined), /PDF file is required/],
        [await callNotes(Buffer.alloc(0)), /PDF file is required/],
        [await callNotes(await pdfWithPages(config.notes.max_pages + 1)), /the limit is 60/],
      ],
    ),
  );

  for (const [response, expected] of result) {
    assert.equal(response.status, 400);
    assert.match((await response.json()).error, expected);
  }
  assert.equal(calls.length, 0);
});

test("a file that is not a readable PDF fails as 502, not a crash", async () => {
  const { result } = await withEnv(KEY, () =>
    withFetch(
      () => {
        throw new Error("Sarvam must not be called for an unreadable file.");
      },
      () => callNotes(Buffer.from("this is not a pdf at all")),
    ),
  );

  assert.equal(result.status, 502);
  assert.ok((await result.json()).error);
});

test("without a Sarvam key the service reports 503", async () => {
  const response = await withEnv({ SARVAM_API_KEY: undefined }, () =>
    callNotes(Buffer.from("anything")),
  );

  assert.equal(response.status, 503);
  assert.match((await response.json()).error, /SARVAM_API_KEY/);
});

test("blocks cross-origin callers and throttles a flood", async () => {
  const pdf = await pdfWithPages(1);
  const crossOrigin = await withEnv(KEY, () =>
    callNotes(pdf, { headers: { origin: "http://evil.example" } }),
  );
  assert.equal(crossOrigin.status, 403);
  assert.match((await crossOrigin.json()).error, /Cross-origin/);

  const client = freshClient();
  const limit = config.security.setup_requests_per_window;
  const { result } = await withEnv(KEY, () =>
    withFetch(digitiseStub({ zip: markdownZip({ "page_1.md": "Notes." }) }), async () => {
      for (let attempt = 0; attempt < limit; attempt += 1) {
        await callNotes(pdf, { client });
      }
      return callNotes(pdf, { client });
    }),
  );

  assert.equal(result.status, 429);
  assert.equal(result.headers.get("X-RateLimit-Limit"), String(limit));
});
