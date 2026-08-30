/**
 * Anakin is a URL scraper, not a search engine — every call needs a concrete
 * URL. Topic discovery is therefore done by building URLs for sources that are
 * addressable by topic (stock photo search pages, Wikipedia articles) rather
 * than by scraping a search engine.
 */
const ANAKIN_BASE = process.env.ANAKIN_BASE_URL || "https://api.anakin.io";
const SYNC_PATH = "/v1/url-scraper/scrape";
const ASYNC_PATH = "/v1/url-scraper";

export type ScrapeFormat = "markdown" | "images" | "links" | "html" | "summary";

export type ScrapeResult = {
  images: string[];
  markdown: string;
};

type AnakinResponse = {
  status?: string;
  id?: string;
  jobId?: string;
  images?: unknown;
  markdown?: unknown;
  data?: { images?: unknown; markdown?: unknown };
  generatedJson?: { images?: unknown };
};

function readResult(payload: AnakinResponse): ScrapeResult {
  const source = payload.data ?? payload;
  const images = [
    ...(Array.isArray(source.images) ? source.images : []),
    ...(Array.isArray(payload.generatedJson?.images) ? payload.generatedJson.images : []),
  ]
    .filter((url): url is string => typeof url === "string" && /^https?:\/\//.test(url))
    .slice(0, 24);
  const markdown = typeof source.markdown === "string" ? source.markdown : "";
  return { images: [...new Set(images)], markdown };
}

async function pollJob(jobId: string, apiKey: string, signal: AbortSignal, timeoutMs: number) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 2000));
    if (signal.aborted) throw new Error("Scrape aborted.");
    const response = await fetch(`${ANAKIN_BASE}${ASYNC_PATH}/${encodeURIComponent(jobId)}`, {
      headers: { "X-API-Key": apiKey },
      signal,
    });
    if (!response.ok) continue;
    const payload = (await response.json()) as AnakinResponse;
    if (payload.status === "completed") return readResult(payload);
    if (payload.status === "failed") throw new Error("Anakin reported a failed scrape job.");
  }
  throw new Error("Anakin scrape timed out.");
}

/**
 * Uses the inline endpoint and falls through to polling when Anakin answers
 * with a job id instead of a finished result.
 */
export async function scrape(
  url: string,
  formats: ScrapeFormat[],
  options: { apiKey: string; useBrowser?: boolean; signal: AbortSignal; timeoutMs: number },
): Promise<ScrapeResult> {
  const response = await fetch(`${ANAKIN_BASE}${SYNC_PATH}`, {
    method: "POST",
    headers: {
      "X-API-Key": options.apiKey,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      url,
      formats,
      useBrowser: options.useBrowser ?? false,
      country: "us",
    }),
    signal: options.signal,
  });

  if (!response.ok) throw new Error(`Anakin returned ${response.status} for ${url}`);
  const payload = (await response.json()) as AnakinResponse;

  const jobId = payload.status !== "completed" ? payload.id || payload.jobId : undefined;
  if (jobId) return pollJob(jobId, options.apiKey, options.signal, options.timeoutMs);
  return readResult(payload);
}

/** Stock photo search pages are addressable by topic and free to reuse. */
export function imageSearchUrls(tag: string) {
  const query = encodeURIComponent(tag.trim().toLowerCase());
  return [
    `https://unsplash.com/s/photos/${query}`,
    `https://www.pexels.com/search/${query}/`,
  ];
}

/** Wikipedia is the text analogue: topic-addressable, stable, clearly licensed. */
export function articleUrl(tag: string) {
  const slug = tag.trim().replace(/\s+/g, "_");
  return `https://en.wikipedia.org/wiki/${encodeURIComponent(slug)}`;
}
