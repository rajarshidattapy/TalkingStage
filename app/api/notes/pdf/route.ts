import { unzipSync, strFromU8 } from "fflate";
import { PDFDocument } from "pdf-lib";
import v7 from "@/config/v7.json";
import {
  checkRateLimit,
  hasMismatchedOrigin,
  rateLimitResponse,
} from "@/lib/request-guards";

export const runtime = "nodejs";
export const maxDuration = 300;

const SARVAM_BASE = "https://api.sarvam.ai";
const PAGES_PER_JOB = 10; // Hard API limit per digitise job.

type DigitiseJob = { job_id?: string; jobId?: string; id?: string };
type JobStatus = { status?: string; output_url?: string; outputUrl?: string; error?: string };

function jobId(job: DigitiseJob) {
  return job.job_id || job.jobId || job.id || "";
}

async function submitChunk(pdf: Uint8Array, language: string, apiKey: string, signal: AbortSignal) {
  const form = new FormData();
  form.append("file", new Blob([pdf as BlobPart], { type: "application/pdf" }), "notes.pdf");
  form.append("output_format", "md");
  form.append("language_code", language);

  const response = await fetch(`${SARVAM_BASE}/doc-ai/v1/job/digitise`, {
    method: "POST",
    headers: { "api-subscription-key": apiKey },
    body: form,
    signal,
  });
  if (!response.ok) {
    throw new Error(`Sarvam rejected the document (${response.status}).`);
  }
  const id = jobId((await response.json()) as DigitiseJob);
  if (!id) throw new Error("Sarvam did not return a job id.");
  return id;
}

async function awaitJob(id: string, apiKey: string, signal: AbortSignal) {
  const deadline = Date.now() + v7.notes.job_timeout_ms;
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, v7.notes.poll_interval_ms));
    if (signal.aborted) throw new Error("Conversion aborted.");

    const response = await fetch(
      `${SARVAM_BASE}/doc-ai/v1/job/${encodeURIComponent(id)}/status`,
      { headers: { "api-subscription-key": apiKey }, signal },
    );
    if (!response.ok) continue;
    const status = (await response.json()) as JobStatus;
    const state = String(status.status || "").toLowerCase();
    if (state === "completed" || state === "succeeded") {
      const url = status.output_url || status.outputUrl;
      if (!url) throw new Error("Sarvam completed the job without an output URL.");
      return url;
    }
    if (state === "failed" || state === "rejected") {
      throw new Error(status.error || `Sarvam could not process the document (${state}).`);
    }
  }
  throw new Error("Sarvam document conversion timed out.");
}

/** The digitise output is a ZIP of per-page Markdown; concatenate in order. */
async function readMarkdownZip(url: string, signal: AbortSignal) {
  const response = await fetch(url, { signal });
  if (!response.ok) throw new Error("The converted document could not be downloaded.");
  const files = unzipSync(new Uint8Array(await response.arrayBuffer()));
  return Object.keys(files)
    .filter((name) => name.toLowerCase().endsWith(".md"))
    .sort((left, right) => left.localeCompare(right, "en", { numeric: true }))
    .map((name) => strFromU8(files[name]).trim())
    .filter(Boolean)
    .join("\n\n");
}

export async function POST(request: Request) {
  if (hasMismatchedOrigin(request)) {
    return Response.json({ error: "Cross-origin requests are not allowed." }, { status: 403 });
  }

  const rateLimit = checkRateLimit(
    request,
    "notes-pdf",
    v7.security.setup_requests_per_window,
    v7.security.rate_limit_window_ms,
  );
  if (!rateLimit.allowed) return rateLimitResponse(rateLimit);

  const apiKey = process.env.SARVAM_API_KEY;
  if (!apiKey) {
    return Response.json(
      { error: "PDF conversion needs SARVAM_API_KEY in the server environment." },
      { status: 503 },
    );
  }

  const form = await request.formData();
  const file = form.get("file");
  const language = String(form.get("language") || v7.notes.default_language);
  if (!(file instanceof Blob) || !file.size) {
    return Response.json({ error: "A PDF file is required." }, { status: 400 });
  }
  if (file.size > v7.notes.max_pdf_bytes) {
    return Response.json({ error: "That PDF is too large." }, { status: 400 });
  }

  try {
    const bytes = new Uint8Array(await file.arrayBuffer());
    const document = await PDFDocument.load(bytes, { ignoreEncryption: true });
    const pageCount = document.getPageCount();
    if (pageCount > v7.notes.max_pages) {
      return Response.json(
        { error: `That PDF has ${pageCount} pages; the limit is ${v7.notes.max_pages}.` },
        { status: 400 },
      );
    }

    // <= 10 pages goes as one job; longer documents are split to fit the limit.
    const chunks: Uint8Array[] = [];
    if (pageCount <= PAGES_PER_JOB) {
      chunks.push(bytes);
    } else {
      for (let start = 0; start < pageCount; start += PAGES_PER_JOB) {
        const chunk = await PDFDocument.create();
        const indices = Array.from(
          { length: Math.min(PAGES_PER_JOB, pageCount - start) },
          (_, offset) => start + offset,
        );
        const pages = await chunk.copyPages(document, indices);
        pages.forEach((page) => chunk.addPage(page));
        chunks.push(await chunk.save());
      }
    }

    const markdown: string[] = [];
    for (const chunk of chunks) {
      const id = await submitChunk(chunk, language, apiKey, request.signal);
      markdown.push(await readMarkdownZip(await awaitJob(id, apiKey, request.signal), request.signal));
    }

    const text = markdown.filter(Boolean).join("\n\n").trim();
    if (!text) {
      return Response.json({ error: "No text was found in that PDF." }, { status: 502 });
    }
    return Response.json(
      { markdown: text, pages: pageCount },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    if (request.signal.aborted) return new Response(null, { status: 499 });
    const message = error instanceof Error ? error.message : "The PDF could not be converted.";
    return Response.json({ error: message }, { status: 502 });
  }
}
