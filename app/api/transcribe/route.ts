import v7 from "@/config/v7.json";
import {
  checkRateLimit,
  hasMismatchedOrigin,
  rateLimitResponse,
} from "@/lib/request-guards";

export const runtime = "nodejs";
export const maxDuration = 30;

const SARVAM_REALTIME_URL = "wss://api.sarvam.ai/speech-to-text-realtime/ws";
// One WebSocket text frame per ~1s of 16 kHz mono linear16 audio.
const AUDIO_CHUNK_BYTES = 32_000;
const MIN_UTTERANCE_BYTES = 3_200; // ~100 ms; anything shorter is noise.

type SarvamMessage = {
  event?: string;
  text?: string;
  language?: string;
  code?: string;
  message?: string;
  is_fatal?: boolean;
};

/**
 * The official `sarvamai` npm SDK has no helper for `saaras:v3-realtime` yet,
 * so this opens the documented raw WebSocket. Node 22 ships a global
 * WebSocket, which keeps the key server-side without a new dependency.
 */
function transcribeWithSarvam(audio: Buffer, apiKey: string) {
  const params = new URLSearchParams({
    model: v7.transcription.fallback_model,
    language_code: v7.transcription.language_code,
    // We already hold the whole utterance, so partials would be wasted work.
    stream_type: "simulated",
    // OpenAI's VAD decided the turn boundaries; do not let Sarvam re-cut them.
    endpointing: "manual",
    encoding: "linear16",
    sample_rate: String(v7.transcription.sample_rate),
  });

  return new Promise<{ text: string; language: string }>((resolve, reject) => {
    const socket = new WebSocket(`${SARVAM_REALTIME_URL}?${params}`, [
      `api-subscription-key.${apiKey}`,
    ]);
    let settled = false;

    const finish = (error: Error | null, value?: { text: string; language: string }) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        socket.close();
      } catch {
        // The socket may already be closing.
      }
      if (error) reject(error);
      else resolve(value!);
    };

    const timer = setTimeout(
      () => finish(new Error("Sarvam did not return a transcript in time.")),
      v7.transcription.timeout_ms,
    );

    socket.addEventListener("open", () => {
      socket.send(JSON.stringify({ event: "speech_start" }));
      for (let offset = 0; offset < audio.length; offset += AUDIO_CHUNK_BYTES) {
        socket.send(
          JSON.stringify({
            event: "audio_input",
            audio: audio.subarray(offset, offset + AUDIO_CHUNK_BYTES).toString("base64"),
          }),
        );
      }
      socket.send(JSON.stringify({ event: "speech_end" }));
      socket.send(JSON.stringify({ event: "flush" }));
    });

    socket.addEventListener("message", (event) => {
      let message: SarvamMessage;
      try {
        message = JSON.parse(String(event.data)) as SarvamMessage;
      } catch {
        return;
      }
      if (message.event === "transcript.final") {
        finish(null, {
          text: String(message.text || "").trim(),
          language: String(message.language || v7.transcription.language_code),
        });
      }
      if (message.event === "error" && message.is_fatal) {
        finish(new Error(String(message.message || "Sarvam reported a fatal error.")));
      }
    });

    socket.addEventListener("error", () =>
      finish(new Error("The Sarvam transcription socket failed.")),
    );
    socket.addEventListener("close", () =>
      finish(new Error("Sarvam closed before returning a final transcript.")),
    );
  });
}

export async function POST(request: Request) {
  if (hasMismatchedOrigin(request)) {
    return Response.json(
      { error: "Cross-origin transcription requests are not allowed." },
      { status: 403 },
    );
  }

  const rateLimit = checkRateLimit(
    request,
    "sarvam-transcription",
    v7.security.transcribe_requests_per_window,
    v7.security.rate_limit_window_ms,
  );
  if (!rateLimit.allowed) return rateLimitResponse(rateLimit);

  const apiKey = process.env.SARVAM_API_KEY;
  if (!apiKey) {
    return Response.json(
      { error: "Fallback transcription needs SARVAM_API_KEY in the server environment." },
      { status: 503 },
    );
  }

  const maxBytes =
    v7.transcription.max_utterance_seconds * v7.transcription.sample_rate * 2;
  const audio = Buffer.from(await request.arrayBuffer());
  if (audio.length < MIN_UTTERANCE_BYTES || audio.length > maxBytes) {
    return Response.json({ error: "A single spoken turn is required." }, { status: 400 });
  }

  try {
    const result = await transcribeWithSarvam(audio, apiKey);
    if (!result.text) {
      return Response.json({ error: "Sarvam returned an empty transcript." }, { status: 502 });
    }
    return Response.json(result, {
      headers: { "Cache-Control": "no-store" },
    });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Sarvam transcription failed.";
    return Response.json({ error: message }, { status: 502 });
  }
}
