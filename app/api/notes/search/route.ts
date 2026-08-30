import v7 from "@/config/v7.json";
import {
  checkRateLimit,
  hasMismatchedOrigin,
  rateLimitResponse,
} from "@/lib/request-guards";

export const runtime = "nodejs";
export const maxDuration = 90;

const OPENAI_RESPONSES_URL = "https://api.openai.com/v1/responses";

/**
 * Anakin scrapes a URL you already know; this answers a question you do not
 * have a URL for. The result is pasted into the presenter's briefing notes, so
 * it has to read like notes — facts, figures, and names the director can lean
 * on mid-sentence — not like an article.
 */
const SEARCH_INSTRUCTIONS = `You research a topic on the web and write briefing notes for a live presenter.

Write compact Markdown the presenter can scan while speaking:
- Short bullets, each a single concrete fact, figure, date, or name.
- Lead with the numbers and proper nouns. Spell names and organisations exactly as the sources do.
- Prefer recent, specific, checkable detail over general background.
- No introduction, no conclusion, no filler, and never address the reader.
- End every bullet with the page it came from as a Markdown link, like ([MNRE](https://mnre.gov.in/page)). Never name a source without linking it.

Return between 4 and 10 bullets. If the sources disagree, say so in one bullet.`;

type Annotation = { type?: string; url?: unknown; title?: unknown };
type ResponseContent = { type?: string; text?: string; refusal?: string; annotations?: Annotation[] };
type ResponseItem = { type?: string; content?: ResponseContent[] };
type OpenAIResponse = {
  status?: string;
  output?: ResponseItem[];
  error?: { message?: string };
};

function cleanQuery(value: unknown) {
  return typeof value === "string"
    ? value
        .normalize("NFKC")
        .replace(/\p{C}/gu, " ")
        .replace(/\s+/g, " ")
        .trim()
        .slice(0, v7.notes.max_query_chars)
    : "";
}

/** Citations arrive with an `utm_source=openai` tag; the notes should not carry it. */
function cleanCitationUrl(value: unknown) {
  if (typeof value !== "string") return "";
  try {
    const parsed = new URL(value);
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return "";
    parsed.searchParams.delete("utm_source");
    return parsed.toString();
  } catch {
    return "";
  }
}

/**
 * The model is asked to cite inline because that is what produces the
 * `url_citation` annotations the source list is built from. The links
 * themselves are noise in notes a presenter reads while speaking, so they come
 * back out here — the sources survive as a tidy list beside the findings.
 */
function stripInlineCitations(text: string) {
  return text
    // A whole trailing citation group: " ([mnre.gov.in](https://…))".
    .replace(/\s*\(\s*\[[^\]]*\]\([^)]*\)(?:\s*,\s*\[[^\]]*\]\([^)]*\))*\s*\)/g, "")
    // Any link left over keeps its visible words and loses the URL.
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    // Backstop for a bare URL the model pasted without link syntax.
    .replace(/([?&])utm_source=openai(&?)/g, (_match, separator: string, next: string) =>
      next ? separator : "",
    )
    .replace(/[ \t]+$/gm, "")
    .trim();
}

const MARKDOWN_LINK = /\[([^\]]*)\]\((https?:\/\/[^)\s]+)\)/g;

/**
 * Sources come from two places, because neither is reliable alone: the API
 * attaches `url_citation` annotations only for some requests, and the model
 * writes the link into the text only when asked. Read both and merge.
 */
function readCitations(part: ResponseContent | undefined) {
  const seen = new Map<string, { title: string; url: string }>();

  const add = (rawUrl: unknown, rawTitle: unknown) => {
    const url = cleanCitationUrl(rawUrl);
    if (!url) return;
    const title = typeof rawTitle === "string" ? rawTitle.trim().slice(0, 120) : "";
    const host = new URL(url).hostname;
    const existing = seen.get(url);
    if (existing) {
      // A later, real title beats an earlier hostname placeholder.
      if (title && existing.title === host) existing.title = title;
      return;
    }
    seen.set(url, { title: title || host, url });
  };

  for (const annotation of part?.annotations || []) {
    if (annotation.type === "url_citation") add(annotation.url, annotation.title);
  }
  for (const link of (part?.text || "").matchAll(MARKDOWN_LINK)) add(link[2], link[1]);

  return [...seen.values()].slice(0, v7.notes.max_citations);
}

export async function POST(request: Request) {
  if (hasMismatchedOrigin(request)) {
    return Response.json({ error: "Cross-origin requests are not allowed." }, { status: 403 });
  }

  const rateLimit = checkRateLimit(
    request,
    "notes-search",
    v7.security.setup_requests_per_window,
    v7.security.rate_limit_window_ms,
  );
  if (!rateLimit.allowed) return rateLimitResponse(rateLimit);

  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    return Response.json(
      { error: "Web search needs OPENAI_API_KEY in the server environment." },
      { status: 503 },
    );
  }

  let body: { query?: unknown };
  try {
    body = (await request.json()) as { query?: unknown };
  } catch {
    return Response.json({ error: "A search question is required." }, { status: 400 });
  }

  const query = cleanQuery(body.query);
  if (query.length < 3) {
    return Response.json({ error: "A search question is required." }, { status: 400 });
  }

  const timeout = AbortSignal.timeout(v7.notes.search_timeout_ms);
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
        model: v7.notes.search_model,
        store: false,
        instructions: SEARCH_INSTRUCTIONS,
        // The query is the presenter's own words; it is data, not instruction.
        input: `<topic>${query}</topic>`,
        tools: [{ type: "web_search" }],
        tool_choice: "required",
      }),
    });

    const payload = (await upstream.json()) as OpenAIResponse;
    if (!upstream.ok) {
      throw new Error(payload.error?.message || `OpenAI returned ${upstream.status}.`);
    }

    const message = payload.output?.find((item) => item.type === "message");
    const refusal = message?.content?.find((part) => part.type === "refusal")?.refusal;
    if (refusal) throw new Error(refusal);

    const part = message?.content?.find((item) => item.type === "output_text");
    const markdown = stripInlineCitations(part?.text || "").slice(0, v7.notes.max_search_chars);
    if (!markdown) {
      return Response.json({ error: "That search returned nothing usable." }, { status: 502 });
    }

    return Response.json(
      { query, markdown, citations: readCitations(part) },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    if (request.signal.aborted) return new Response(null, { status: 499 });
    if (timeout.aborted) {
      return Response.json({ error: "That search took too long." }, { status: 504 });
    }
    const message = error instanceof Error ? error.message : "The web search failed.";
    return Response.json({ error: message }, { status: 502 });
  }
}
