import v7 from "@/config/v7.json";
import {
  checkRateLimit,
  hasMismatchedOrigin,
  rateLimitResponse,
} from "@/lib/request-guards";

export const runtime = "nodejs";
export const maxDuration = 30;

const OPENAI_RESPONSES_URL = "https://api.openai.com/v1/responses";
const MAX_SOURCE_CHARS = 12_000;

// The tags become Anakin scrape URLs (a stock photo search page, a Wikipedia
// article), so brevity is a hard requirement, not a style note. Asking for the
// shape in `instructions` and pinning the array in a strict schema keeps the
// model from returning sentence-length "topics" that no source can answer.
const TAG_INSTRUCTIONS = `You read a presentation setup and return the topics it is about.

Each tag must be a concrete, searchable noun phrase of one to three words — the kind of thing you would type into a stock photo site or look up in an encyclopedia. Prefer subjects over adjectives, and never return the words "presentation", "slides", or the requested tone itself.

The tone is context for what the talk is like. The notes are what it is about.`;

type ResponseContent = { type?: string; text?: string; refusal?: string };
type ResponseItem = { type?: string; content?: ResponseContent[] };
type OpenAIResponse = {
  status?: string;
  output?: ResponseItem[];
  error?: { message?: string };
  incomplete_details?: { reason?: string };
};

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

/** The first assistant message, skipping any reasoning items ahead of it. */
function readOutputText(payload: OpenAIResponse) {
  const message = payload.output?.find((item) => item.type === "message");
  const refusal = message?.content?.find((part) => part.type === "refusal")?.refusal;
  if (refusal) throw new Error(refusal);
  return message?.content?.find((part) => part.type === "output_text")?.text || "";
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

  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    return Response.json(
      { error: "Tag extraction needs OPENAI_API_KEY in the server environment." },
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

  // The caller's abort and our own deadline both have to cancel the upstream call.
  const timeout = AbortSignal.timeout(v7.research.tag_timeout_ms);
  const signal = AbortSignal.any([request.signal, timeout]);

  try {
    const upstream = await fetch(OPENAI_RESPONSES_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      signal,
      body: JSON.stringify({
        model: v7.research.tag_model,
        store: false,
        instructions: TAG_INSTRUCTIONS,
        input: `<tone>${vibe}</tone>\n<notes>${notes}</notes>`,
        text: {
          format: {
            type: "json_schema",
            name: "topic_tags",
            strict: true,
            schema: {
              type: "object",
              additionalProperties: false,
              properties: {
                tags: {
                  type: "array",
                  minItems: 3,
                  maxItems: v7.research.max_tags,
                  items: { type: "string" },
                },
              },
              required: ["tags"],
            },
          },
        },
      }),
    });

    const payload = (await upstream.json()) as OpenAIResponse;
    if (!upstream.ok) {
      // OpenAI returns a readable reason; pass it through instead of a status code.
      throw new Error(payload.error?.message || `OpenAI returned ${upstream.status}.`);
    }

    const text = readOutputText(payload);
    const parsed: unknown = text ? (JSON.parse(text) as { tags?: unknown }).tags : [];
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
    if (timeout.aborted) {
      return Response.json({ error: "Topic extraction timed out." }, { status: 504 });
    }
    const message = error instanceof Error ? error.message : "Tags could not be generated.";
    return Response.json({ error: message }, { status: 502 });
  }
}
