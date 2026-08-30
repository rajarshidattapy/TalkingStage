import { GoogleGenAI } from "@google/genai";
import v7 from "@/config/v7.json";
import {
  checkRateLimit,
  hasMismatchedOrigin,
  rateLimitResponse,
} from "@/lib/request-guards";

export const runtime = "nodejs";
export const maxDuration = 30;

const MAX_SOURCE_CHARS = 12_000;

function cleanTag(value: unknown) {
  return typeof value === "string"
    ? value
        .normalize("NFKC")
        .replace(/\p{C}/gu, " ")
        .replace(/[^\p{L}\p{N} -]/gu, "")
        .replace(/\s+/g, " ")
        .trim()
        .slice(0, 40)
    : "";
}

export async function POST(request: Request) {
  if (hasMismatchedOrigin(request)) {
    return Response.json({ error: "Cross-origin requests are not allowed." }, { status: 403 });
  }

  const rateLimit = checkRateLimit(
    request,
    "tags",
    v7.security.setup_requests_per_window,
    v7.security.rate_limit_window_ms,
  );
  if (!rateLimit.allowed) return rateLimitResponse(rateLimit);

  const apiKey = process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY;
  if (!apiKey) {
    return Response.json(
      { error: "Tag extraction needs GEMINI_API_KEY in the server environment." },
      { status: 503 },
    );
  }

  let body: { vibe?: unknown; notes?: unknown };
  try {
    body = (await request.json()) as { vibe?: unknown; notes?: unknown };
  } catch {
    return Response.json({ error: "Setup content is required." }, { status: 400 });
  }

  const vibe = String(body.vibe ?? "").slice(0, 400);
  const notes = String(body.notes ?? "").slice(0, MAX_SOURCE_CHARS);
  if (!vibe.trim() && !notes.trim()) {
    return Response.json({ error: "Setup content is required." }, { status: 400 });
  }

  try {
    const ai = new GoogleGenAI({ apiKey });
    const interaction = await ai.interactions.create(
      {
        model: v7.research.tag_model,
        input: `Read the presentation setup below and return the topics it is about.

Return between 3 and ${v7.research.max_tags} tags. Each tag must be a concrete, searchable noun phrase of one to three words — the kind of thing you would type into a stock photo site or look up in an encyclopedia. Prefer subjects over adjectives, and never return the words "presentation", "slides", or the requested tone itself.

Return only a JSON array of strings, nothing else.

<tone>${vibe}</tone>
<notes>${notes}</notes>`,
        store: false,
      },
      {
        timeout: v7.research.tag_timeout_ms,
        maxRetries: 0,
        fetchOptions: { signal: request.signal },
      },
    );

    const text = String(interaction.output_text || "");
    const match = text.match(/\[[\s\S]*\]/);
    const parsed: unknown = match ? JSON.parse(match[0]) : [];
    const tags = [
      ...new Set(
        (Array.isArray(parsed) ? parsed : []).map(cleanTag).filter((tag) => tag.length >= 2),
      ),
    ].slice(0, v7.research.max_tags);

    if (!tags.length) {
      return Response.json({ error: "No usable topics were found." }, { status: 502 });
    }
    return Response.json({ tags }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    if (request.signal.aborted) return new Response(null, { status: 499 });
    const message = error instanceof Error ? error.message : "Tags could not be generated.";
    return Response.json({ error: message }, { status: 502 });
  }
}
