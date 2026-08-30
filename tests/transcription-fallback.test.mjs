import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const root = new URL("../", import.meta.url);

// lib/pcm.ts is plain TS with no imports, so strip the types and run it for real.
async function loadPcm() {
  const source = await readFile(new URL("lib/pcm.ts", root), "utf8");
  const javascript = source
    .replace(/export function (\w+)\(([^)]*)\)\s*:\s*\w+(<[^>]*>)?/g, "export function $1($2)")
    .replace(/(\w+):\s*(Float32Array|Int16Array\[\]|Int16Array)/g, "$1");
  return import(`data:text/javascript,${encodeURIComponent(javascript)}`);
}

test("float samples convert to clamped little-endian linear16", async () => {
  const { floatToPcm16, mergePcm16 } = await loadPcm();

  const pcm = floatToPcm16(new Float32Array([0, 1, -1, 2, -2, 0.5]));
  assert.equal(pcm[0], 0);
  assert.equal(pcm[1], 32767, "full positive scale must not wrap");
  assert.equal(pcm[2], -32768, "full negative scale uses the extra step");
  assert.equal(pcm[3], 32767, "out-of-range input is clamped, not wrapped");
  assert.equal(pcm[4], -32768);
  assert.equal(pcm[5], 16384);

  const merged = mergePcm16([new Int16Array([1, 2]), new Int16Array([3])]);
  assert.deepEqual([...merged], [1, 2, 3]);
  assert.equal(mergePcm16([]).length, 0);
  // The byte length Sarvam is billed on: 2 bytes per mono sample.
  assert.equal(merged.byteLength, 6);
});

test("Sarvam is wired as the fallback behind OpenAI transcription", async () => {
  const [configText, routeSource, pageSource, envExample] = await Promise.all([
    readFile(new URL("config/v7.json", root), "utf8"),
    readFile(new URL("app/api/transcribe/route.ts", root), "utf8"),
    readFile(new URL("app/page.tsx", root), "utf8"),
    readFile(new URL(".env.example", root), "utf8"),
  ]);
  const config = JSON.parse(configText);

  assert.equal(config.transcription.primary, "openai_realtime");
  assert.equal(config.transcription.fallback_provider, "sarvam");
  assert.equal(config.transcription.fallback_model, "saaras:v3-realtime");
  assert.equal(config.transcription.language_code, "auto");
  assert.equal(config.transcription.sample_rate, 16000);
  // OpenAI stays primary: the fallback only fires after a grace period.
  assert.ok(config.transcription.fallback_delay_ms > 0);
  assert.ok(config.security.transcribe_requests_per_window > 0);
  assert.match(envExample, /SARVAM_API_KEY=/);

  // The key never reaches the browser.
  assert.match(routeSource, /process\.env\.SARVAM_API_KEY/);
  assert.doesNotMatch(pageSource, /SARVAM_API_KEY|api-subscription-key/);
  assert.match(routeSource, /speech-to-text-realtime\/ws/);
  assert.match(routeSource, /api-subscription-key\.\$\{apiKey\}/);
  assert.match(routeSource, /endpointing: "manual"/);
  assert.match(routeSource, /hasMismatchedOrigin/);
  assert.match(routeSource, /checkRateLimit/);

  assert.match(pageSource, /\/api\/transcribe/);
  assert.match(pageSource, /runTranscriptionFallback/);
  assert.match(pageSource, /resolvedTranscriptTurnRef\.current >= turn/);
  assert.match(pageSource, /fallbackUnavailableRef\.current = true/);
  assert.match(pageSource, /audioWorklet\.addModule/);
  assert.match(pageSource, /createMediaStreamDestination/);
  assert.match(pageSource, /stopPcmCapture\(\)/);
});
