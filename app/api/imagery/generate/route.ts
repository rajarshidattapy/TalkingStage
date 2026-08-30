import { GoogleGenAI } from "@google/genai";
import v7 from "@/config/v7.json";
import {
  checkRateLimit,
  hasMismatchedOrigin,
  rateLimitResponse,
} from "@/lib/request-guards";

export const runtime = "nodejs";
export const maxDuration = 120;

/**
 * Setup-time image generation, distinct from the per-scene imagery route: the
 * presenter is filling their asset library before speaking, so the subjects come
 * from the briefing notes rather than from a scene that does not exist yet.
 */
function promptInstructions(count: number) {
  return `Read the presentation notes below and write ${count} image prompts for photographs that would illustrate this talk.

Each prompt must:
- Describe one concrete, specific visual subject drawn from the notes — a place, an object, a process, a person at work, a material.
- Be a single sentence of 12 to 30 words, written as a photography brief.
- Cover a different idea from the notes than the other prompts. Do not restate one subject ${count} ways.
- Contain no text, words, letters, numbers, charts, logos, watermarks, or user interfaces.
- Avoid naming real living people or branded products.

Return only a JSON array of ${count} strings, nothing else.`;
}

function cleanText(value: unknown, limit: number) {
  return typeof value === "string"
    ? value.normalize("NFKC").replace(/\p{C}/gu, " ").replace(/\s+/g, " ").trim().slice(0, limit)
    : "";
}

export async function POST(request: Request) {
  if (hasMismatchedOrigin(request)) {
    return Response.json({ error: "Cross-origin requests are not allowed." }, { status: 403 });
  }

  const rateLimit = checkRateLimit(
    request,
    "imagery-generate",
    v7.security.generate_requests_per_window,
    v7.security.rate_limit_window_ms,
  );
  if (!rateLimit.allowed) return rateLimitResponse(rateLimit);

  const apiKey = process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY;
  if (!apiKey) {
    return Response.json(
      { error: "Image generation needs GEMINI_API_KEY in the server environment." },
      { status: 503 },
    );
  }

  let body: { notes?: unknown; prompt?: unknown };
  try {
    body = (await request.json()) as { notes?: unknown; prompt?: unknown };
  } catch {
    return Response.json({ error: "Initial notes are required." }, { status: 400 });
  }

  // Subjects come from the notes only — not the vibe, not the researched tags.
  const notes = cleanText(body.notes, v7.setup.max_notes_chars);
  const steer = cleanText(body.prompt, v7.imagery.max_steer_chars);
  if (notes.length < 40) {
    return Response.json(
      { error: "Add some initial notes first — the images are generated from them." },
      { status: 400 },
    );
  }

  const count = v7.imagery.generated_batch_size;
  const ai = new GoogleGenAI({ apiKey });

  let prompts: string[];
  try {
    const interaction = await ai.interactions.create(
      {
        model: v7.imagery.prompt_model,
        input: `${promptInstructions(count)}

<notes>${notes}</notes>${steer ? `\n\n<art_direction>${steer}</art_direction>` : ""}`,
        store: false,
      },
      {
        timeout: v7.imagery.prompt_timeout_ms,
        maxRetries: 0,
        fetchOptions: { signal: request.signal },
      },
    );

    const text = String(interaction.output_text || "");
    const match = text.match(/\[[\s\S]*\]/);
    const parsed: unknown = match ? JSON.parse(match[0]) : [];
    prompts = (Array.isArray(parsed) ? parsed : [])
      .map((entry) => cleanText(entry, 400))
      .filter((entry) => entry.length >= 12)
      .slice(0, count);
  } catch (error) {
    if (request.signal.aborted) return new Response(null, { status: 499 });
    const message = error instanceof Error ? error.message : "Image prompts could not be written.";
    return Response.json({ error: message }, { status: 502 });
  }

  if (!prompts.length) {
    return Response.json(
      { error: "No image ideas could be drawn from these notes." },
      { status: 502 },
    );
  }

  // One slow or refused image must not lose the rest of the batch.
  const settled = await Promise.allSettled(
    prompts.map(async (prompt) => {
      const interaction = await ai.interactions.create(
        {
          model: v7.imagery.model,
          input: `${prompt}

Photographic, editorial quality, natural light, no text or lettering anywhere in the frame.`,
          store: false,
          response_format: {
            type: "image",
            mime_type: v7.imagery.mime_type,
            aspect_ratio: v7.imagery.aspect_ratio,
            image_size: v7.imagery.image_size,
          },
        },
        {
          timeout: v7.imagery.timeout_ms,
          maxRetries: 0,
          fetchOptions: { signal: request.signal },
        },
      );

      const generated = interaction.output_image;
      if (!generated?.data) throw new Error("Gemini returned no image for this prompt.");
      const mimeType = generated.mime_type || v7.imagery.mime_type;
      return { prompt, mimeType, dataUrl: `data:${mimeType};base64,${generated.data}` };
    }),
  );

  if (request.signal.aborted) return new Response(null, { status: 499 });

  const images = settled.flatMap((result) => (result.status === "fulfilled" ? [result.value] : []));
  if (!images.length) {
    const reason = settled.find((result) => result.status === "rejected");
    const message =
      reason?.status === "rejected" && reason.reason instanceof Error
        ? reason.reason.message
        : "No images could be generated.";
    return Response.json({ error: message }, { status: 502 });
  }

  return Response.json(
    { images, requested: prompts.length },
    { headers: { "Cache-Control": "no-store" } },
  );
}
