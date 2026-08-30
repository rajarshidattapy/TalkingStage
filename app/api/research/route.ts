import v7 from "@/config/v7.json";
import { articleUrl, imageSearchUrls, scrape } from "@/lib/anakin";
import {
  checkRateLimit,
  hasMismatchedOrigin,
  rateLimitResponse,
} from "@/lib/request-guards";

export const runtime = "nodejs";
export const maxDuration = 120;

// Scraped hosts are ours to choose, but the image URLs inside a page are not.
// Only fetch bytes from the CDNs the chosen sources actually serve from.
const ALLOWED_IMAGE_HOSTS = [
  "images.unsplash.com",
  "plus.unsplash.com",
  "images.pexels.com",
];

function isAllowedImage(url: string) {
  try {
    const parsed = new URL(url);
    return parsed.protocol === "https:" && ALLOWED_IMAGE_HOSTS.includes(parsed.hostname);
  } catch {
    return false;
  }
}

/**
 * Inlined as data URLs so scraped imagery behaves exactly like an upload:
 * no CORS, no next/image remote patterns, and html-to-image can still
 * rasterize it for the PDF/PPTX export without tainting the canvas.
 */
async function inlineImage(url: string, signal: AbortSignal) {
  const response = await fetch(url, { signal, redirect: "follow" });
  if (!response.ok) throw new Error(`Image fetch failed (${response.status}).`);
  const type = (response.headers.get("content-type") || "").split(";")[0].trim();
  if (!["image/jpeg", "image/png", "image/webp"].includes(type)) {
    throw new Error("Unsupported image type.");
  }
  const bytes = Buffer.from(await response.arrayBuffer());
  if (!bytes.length || bytes.length > v7.research.max_image_bytes) {
    throw new Error("Image is outside the size limit.");
  }
  return { dataUrl: `data:${type};base64,${bytes.toString("base64")}`, mimeType: type };
}

function cleanTag(value: unknown) {
  return typeof value === "string"
    ? value.normalize("NFKC").replace(/\p{C}/gu, " ").replace(/\s+/g, " ").trim().slice(0, 40)
    : "";
}

/** Strip wiki chrome so the director gets prose, not navigation. */
function condense(markdown: string, limit: number) {
  return markdown
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/!\[[^\]]*\]\([^)]*\)/g, " ")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/^\s*(?:\||\[edit\]|#+\s*(?:References|External links|See also|Further reading|Notes)\b)[\s\S]*$/gim, " ")
    .replace(/\[\d+\]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, limit);
}

export async function POST(request: Request) {
  if (hasMismatchedOrigin(request)) {
    return Response.json({ error: "Cross-origin requests are not allowed." }, { status: 403 });
  }

  const rateLimit = checkRateLimit(
    request,
    "research",
    v7.security.research_requests_per_window,
    v7.security.rate_limit_window_ms,
  );
  if (!rateLimit.allowed) return rateLimitResponse(rateLimit);

  const apiKey = process.env.ANAKIN_API_KEY;
  if (!apiKey) {
    return Response.json(
      { error: "Web research needs ANAKIN_API_KEY in the server environment." },
      { status: 503 },
    );
  }

  let body: { tags?: unknown };
  try {
    body = (await request.json()) as { tags?: unknown };
  } catch {
    return Response.json({ error: "Tags are required." }, { status: 400 });
  }

  const tags = [
    ...new Set((Array.isArray(body.tags) ? body.tags : []).map(cleanTag).filter(Boolean)),
  ].slice(0, v7.research.max_tags);
  if (!tags.length) return Response.json({ error: "Tags are required." }, { status: 400 });

  const options = {
    apiKey,
    signal: request.signal,
    timeoutMs: v7.research.scrape_timeout_ms,
  };

  // Every scrape is independent; one failing tag must not lose the others.
  const settled = await Promise.allSettled(
    tags.flatMap((tag) => [
      (async () => {
        const results = await Promise.allSettled(
          imageSearchUrls(tag)
            .slice(0, v7.research.image_sources_per_tag)
            .map((url) => scrape(url, ["images"], { ...options, useBrowser: true })),
        );
        const images = results
          .flatMap((result) => (result.status === "fulfilled" ? result.value.images : []))
          .filter(isAllowedImage)
          .slice(0, v7.research.images_per_tag);
        return { kind: "images" as const, tag, images };
      })(),
      (async () => {
        const { markdown } = await scrape(articleUrl(tag), ["markdown"], options);
        return {
          kind: "content" as const,
          tag,
          text: condense(markdown, v7.research.chars_per_tag),
        };
      })(),
    ]),
  );

  const candidates: Array<{ tag: string; url: string }> = [];
  const content: Array<{ tag: string; text: string; source: string }> = [];

  for (const result of settled) {
    if (result.status !== "fulfilled") continue;
    if (result.value.kind === "images") {
      candidates.push(...result.value.images.map((url) => ({ tag: result.value.tag, url })));
    } else if (result.value.text.length >= 120) {
      content.push({
        tag: result.value.tag,
        text: result.value.text,
        source: articleUrl(result.value.tag),
      });
    }
  }

  // Round-robin by tag so one prolific topic cannot fill the whole library.
  const byTag = new Map<string, Array<{ tag: string; url: string }>>();
  for (const candidate of candidates) {
    byTag.set(candidate.tag, [...(byTag.get(candidate.tag) || []), candidate]);
  }
  const ordered: Array<{ tag: string; url: string }> = [];
  for (let round = 0; ordered.length < v7.research.max_images; round += 1) {
    const slice = [...byTag.values()].map((list) => list[round]).filter(Boolean);
    if (!slice.length) break;
    ordered.push(...slice);
  }

  const inlined = await Promise.allSettled(
    ordered.slice(0, v7.research.max_images).map(async (candidate) => ({
      tag: candidate.tag,
      sourceUrl: candidate.url,
      ...(await inlineImage(candidate.url, request.signal)),
    })),
  );
  const images = inlined.flatMap((result) => (result.status === "fulfilled" ? [result.value] : []));

  if (!images.length && !content.length) {
    return Response.json(
      { error: "Anakin returned nothing usable for these topics." },
      { status: 502 },
    );
  }

  return Response.json({ tags, images, content }, { headers: { "Cache-Control": "no-store" } });
}
