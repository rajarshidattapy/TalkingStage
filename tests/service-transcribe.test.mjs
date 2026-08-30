import assert from "node:assert/strict";
import test from "node:test";
import {
  freshClient,
  loadLib,
  loadRoute,
  rawRequest,
  readConfig,
  withEnv,
  withWebSocket,
} from "./helpers/services.mjs";

const { POST } = await loadRoute("transcribe");
const { floatToPcm16, mergePcm16 } = await loadLib("pcm");
const config = await readConfig();

const ENDPOINT = "http://localhost:3000/api/transcribe";
const KEY = { SARVAM_API_KEY: "test-sarvam-key" };
const MAX_BYTES = config.transcription.max_utterance_seconds * config.transcription.sample_rate * 2;

/** A plausible spoken turn: `seconds` of 16 kHz mono linear16. */
function utterance(seconds = 1) {
  return Buffer.alloc(Math.round(seconds * config.transcription.sample_rate * 2), 1);
}

function callTranscribe(body, options) {
  return POST(rawRequest(ENDPOINT, body, { headers: { "content-type": "application/octet-stream" }, ...options }));
}

test("floatToPcm16 clamps to the full linear16 range without wrapping", () => {
  const pcm = floatToPcm16(new Float32Array([0, 1, -1, 2, -2, 0.5, -0.5]));

  assert.equal(pcm[0], 0);
  assert.equal(pcm[1], 32767, "full positive scale must not wrap to negative");
  assert.equal(pcm[2], -32768, "full negative scale uses the extra step");
  assert.equal(pcm[3], 32767, "out-of-range input is clamped, not wrapped");
  assert.equal(pcm[4], -32768);
  assert.equal(pcm[5], 16384);
  assert.equal(pcm[6], -16384);
  assert.equal(pcm.length, 7);
  assert.equal(pcm.BYTES_PER_ELEMENT, 2, "Sarvam is billed on 2 bytes per mono sample");
  assert.equal(floatToPcm16(new Float32Array(0)).length, 0);
});

test("mergePcm16 concatenates worklet chunks in order", () => {
  const merged = mergePcm16([new Int16Array([1, 2]), new Int16Array([3]), new Int16Array([4, 5])]);

  assert.deepEqual([...merged], [1, 2, 3, 4, 5]);
  assert.equal(merged.byteLength, 10);
  assert.equal(mergePcm16([]).length, 0);
  assert.equal(mergePcm16([new Int16Array(0), new Int16Array([9])]).length, 1);
});

test("streams the whole utterance to Sarvam and returns the final transcript", async () => {
  const audio = utterance(2);
  const { result, sockets } = await withEnv(KEY, () =>
    withWebSocket(
      (socket) => {
        socket.emit("open");
        socket.reply({ event: "transcript.partial", text: "the future" });
        socket.reply({ event: "transcript.final", text: "  The future is already here.  ", language: "en-IN" });
      },
      () => callTranscribe(audio),
    ),
  );

  assert.equal(result.status, 200);
  assert.equal(result.headers.get("Cache-Control"), "no-store");
  assert.deepEqual(await result.json(), {
    text: "The future is already here.",
    language: "en-IN",
  });

  const [socket] = sockets;
  assert.equal(socket.closed, true, "the socket is closed once the turn resolves");
  assert.deepEqual(socket.protocols, ["api-subscription-key.test-sarvam-key"], "the key rides the subprotocol, not a query param");

  const url = new URL(socket.url);
  assert.equal(url.protocol, "wss:");
  assert.equal(url.host, "api.sarvam.ai");
  assert.equal(url.pathname, "/speech-to-text-realtime/ws");
  assert.equal(url.searchParams.get("model"), config.transcription.fallback_model);
  assert.equal(url.searchParams.get("language_code"), config.transcription.language_code);
  assert.equal(url.searchParams.get("encoding"), "linear16");
  assert.equal(url.searchParams.get("sample_rate"), String(config.transcription.sample_rate));
  assert.equal(url.searchParams.get("stream_type"), "simulated");
  // OpenAI's VAD already decided the turn boundary; Sarvam must not re-cut it.
  assert.equal(url.searchParams.get("endpointing"), "manual");
  assert.equal(url.searchParams.get("api-subscription-key"), null, "the key never appears in the URL");
});

test("audio is framed into ~1s chunks between speech_start and flush", async () => {
  const audio = utterance(3); // 96,000 bytes -> three 32,000-byte frames.
  const { sockets } = await withEnv(KEY, () =>
    withWebSocket(
      (socket) => {
        socket.emit("open");
        socket.reply({ event: "transcript.final", text: "Three seconds of speech.", language: "en-IN" });
      },
      () => callTranscribe(audio),
    ),
  );

  const frames = sockets[0].sent;
  assert.equal(frames[0].event, "speech_start");
  assert.equal(frames.at(-2).event, "speech_end");
  assert.equal(frames.at(-1).event, "flush");

  const chunks = frames.filter((frame) => frame.event === "audio_input");
  assert.equal(chunks.length, 3, "one frame per ~1s of 16 kHz mono linear16");

  const rebuilt = Buffer.concat(chunks.map((chunk) => Buffer.from(chunk.audio, "base64")));
  assert.equal(rebuilt.length, audio.length, "no audio is lost or duplicated in framing");
  assert.ok(rebuilt.equals(audio));
});

test("a trailing partial chunk is still sent", async () => {
  const audio = utterance(1.5); // 48,000 bytes -> 32,000 + 16,000.
  const { sockets } = await withEnv(KEY, () =>
    withWebSocket(
      (socket) => {
        socket.emit("open");
        socket.reply({ event: "transcript.final", text: "Partial frame.", language: "en-IN" });
      },
      () => callTranscribe(audio),
    ),
  );

  const chunks = sockets[0].sent.filter((frame) => frame.event === "audio_input");
  assert.equal(chunks.length, 2);
  assert.equal(Buffer.from(chunks[1].audio, "base64").length, 16_000);
});

test("a language-less final transcript falls back to the configured language code", async () => {
  const { result } = await withEnv(KEY, () =>
    withWebSocket(
      (socket) => {
        socket.emit("open");
        socket.reply({ event: "transcript.final", text: "No language field." });
      },
      () => callTranscribe(utterance()),
    ),
  );

  assert.equal((await result.json()).language, config.transcription.language_code);
});

test("an empty final transcript is a 502, not a silent empty turn", async () => {
  const { result } = await withEnv(KEY, () =>
    withWebSocket(
      (socket) => {
        socket.emit("open");
        socket.reply({ event: "transcript.final", text: "   " });
      },
      () => callTranscribe(utterance()),
    ),
  );

  assert.equal(result.status, 502);
  assert.match((await result.json()).error, /empty transcript/);
});

test("unparseable frames are skipped instead of killing the turn", async () => {
  const { result } = await withEnv(KEY, () =>
    withWebSocket(
      (socket) => {
        socket.emit("open");
        socket.emit("message", { data: "<not json>" });
        socket.reply({ event: "transcript.final", text: "Survived the noise.", language: "en-IN" });
      },
      () => callTranscribe(utterance()),
    ),
  );

  assert.equal(result.status, 200);
  assert.equal((await result.json()).text, "Survived the noise.");
});

test("a non-fatal Sarvam error does not abandon the turn", async () => {
  const { result } = await withEnv(KEY, () =>
    withWebSocket(
      (socket) => {
        socket.emit("open");
        socket.reply({ event: "error", code: "warn", message: "Low volume.", is_fatal: false });
        socket.reply({ event: "transcript.final", text: "Still transcribed.", language: "en-IN" });
      },
      () => callTranscribe(utterance()),
    ),
  );

  assert.equal(result.status, 200);
  assert.equal((await result.json()).text, "Still transcribed.");
});

test("socket failures each surface as a 502 with a specific reason", async () => {
  const failures = {
    "a fatal Sarvam error": [
      (socket) => {
        socket.emit("open");
        socket.reply({ event: "error", message: "Unsupported sample rate.", is_fatal: true });
      },
      /Unsupported sample rate/,
    ],
    "a transport error": [(socket) => socket.emit("error"), /socket failed/],
    "a close before any final transcript": [
      (socket) => {
        socket.emit("open");
        socket.emit("close");
      },
      /closed before returning a final transcript/,
    ],
  };

  for (const [label, [script, expected]] of Object.entries(failures)) {
    const { result } = await withEnv(KEY, () => withWebSocket(script, () => callTranscribe(utterance())));
    assert.equal(result.status, 502, label);
    assert.match((await result.json()).error, expected, label);
  }
});

test("only the first outcome wins, so a late close cannot overwrite a transcript", async () => {
  const { result } = await withEnv(KEY, () =>
    withWebSocket(
      (socket) => {
        socket.emit("open");
        socket.reply({ event: "transcript.final", text: "First and final.", language: "en-IN" });
        // Sarvam always closes afterwards; that must not turn a success into an error.
        socket.emit("close");
        socket.emit("error");
      },
      () => callTranscribe(utterance()),
    ),
  );

  assert.equal(result.status, 200);
  assert.equal((await result.json()).text, "First and final.");
});

test("audio outside a plausible spoken turn never opens a socket", async () => {
  const tooShort = Buffer.alloc(3_199, 1); // Under ~100 ms: noise, not speech.
  const tooLong = Buffer.alloc(MAX_BYTES + 2, 1);

  const { result, sockets } = await withEnv(KEY, () =>
    withWebSocket(
      () => {
        throw new Error("Sarvam must not be reached for an implausible utterance.");
      },
      async () => [
        await callTranscribe(tooShort),
        await callTranscribe(tooLong),
        await callTranscribe(Buffer.alloc(0)),
      ],
    ),
  );

  for (const response of result) {
    assert.equal(response.status, 400);
    assert.match((await response.json()).error, /single spoken turn is required/);
  }
  assert.equal(sockets.length, 0);
});

test("without a Sarvam key the fallback reports 503 rather than pretending to work", async () => {
  const response = await withEnv({ SARVAM_API_KEY: undefined }, () => callTranscribe(utterance()));

  assert.equal(response.status, 503);
  assert.match((await response.json()).error, /SARVAM_API_KEY/);
});

test("blocks cross-origin callers and throttles a flood", async () => {
  const crossOrigin = await withEnv(KEY, () =>
    callTranscribe(utterance(), { headers: { origin: "http://evil.example" } }),
  );
  assert.equal(crossOrigin.status, 403);
  assert.match((await crossOrigin.json()).error, /Cross-origin/);

  const client = freshClient();
  const limit = config.security.transcribe_requests_per_window;
  const { result } = await withEnv(KEY, () =>
    withWebSocket(
      (socket) => {
        socket.emit("open");
        socket.reply({ event: "transcript.final", text: "Turn.", language: "en-IN" });
      },
      async () => {
        for (let attempt = 0; attempt < limit; attempt += 1) {
          await callTranscribe(utterance(), { client });
        }
        return callTranscribe(utterance(), { client });
      },
    ),
  );

  assert.equal(result.status, 429);
  assert.equal(result.headers.get("X-RateLimit-Limit"), String(limit));
});
