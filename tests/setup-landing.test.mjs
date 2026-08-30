import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

const root = new URL("../", import.meta.url);

// Node 22 strips TypeScript types on import, so these exercise the real modules.
const { imageSearchUrls, articleUrl } = await import(new URL("lib/anakin.ts", root).href);

test("vibes persist to sqlite, dedupe, and bump on reuse", async () => {
  const directory = mkdtempSync(path.join(tmpdir(), "gurudornaai-vibes-"));
  process.env.GURUDORNAAI_DATA_DIR = directory;
  const { saveVibe, recentVibes, normalizeVibe, closeVibeDb } = await import(
    new URL("lib/vibes.ts", root).href
  );
  try {
    assert.equal(normalizeVibe("  bold   and  punchy "), "bold and punchy");
    assert.equal(normalizeVibe(42), "", "non-strings are rejected, not coerced");

    saveVibe("bold and punchy");
    saveVibe("calm and factual");
    const bumped = saveVibe("bold and punchy");

    assert.equal(bumped.usedCount, 2, "re-entering a vibe bumps rather than duplicates");
    const all = recentVibes();
    assert.equal(all.length, 2, "no duplicate row was created");
    assert.deepEqual(all.map((vibe) => vibe.text).sort(), [
      "bold and punchy",
      "calm and factual",
    ]);
    assert.equal(saveVibe("   "), null, "an empty vibe is not stored");
  } finally {
    closeVibeDb();
    delete process.env.GURUDORNAAI_DATA_DIR;
    rmSync(directory, { recursive: true, force: true });
  }
});

test("anakin helpers build topic-addressable URLs, never a search engine", () => {
  const urls = imageSearchUrls("Clean Energy");
  assert.equal(urls.length, 2);
  assert.ok(urls.every((url) => url.startsWith("https://")));
  assert.ok(urls.some((url) => url.includes("unsplash.com/s/photos/clean%20energy")));
  assert.ok(urls.some((url) => url.includes("pexels.com/search/clean%20energy")));
  assert.ok(
    !urls.some((url) => /google|bing|duckduckgo/i.test(url)),
    "image sourcing must not scrape a search engine",
  );

  assert.equal(articleUrl("clean energy"), "https://en.wikipedia.org/wiki/clean_energy");
  assert.equal(articleUrl(" Solar Power "), "https://en.wikipedia.org/wiki/Solar_Power");
});

test("setup wiring, guards, and budgets are in place", async () => {
  const [configText, pageSource, realtimeSource, researchSource, envExample] = await Promise.all([
    readFile(new URL("config/v7.json", root), "utf8"),
    readFile(new URL("app/page.tsx", root), "utf8"),
    readFile(new URL("app/api/realtime/route.ts", root), "utf8"),
    readFile(new URL("app/api/research/route.ts", root), "utf8"),
    readFile(new URL(".env.example", root), "utf8"),
  ]);
  const config = JSON.parse(configText);

  assert.equal(config.setup.enabled, true);
  assert.ok(
    config.setup.notes_budget_chars < config.setup.max_notes_chars,
    "the director gets a truncated slice, not the whole notes field",
  );
  assert.equal(config.research.provider, "anakin");
  assert.ok(config.research.max_images > 0);
  assert.match(envExample, /ANAKIN_API_KEY=/);

  // The SDP moved into a JSON body so notes can ride along.
  assert.match(realtimeSource, /offer\.sdp === "string"/);
  assert.match(realtimeSource, /setupInstructions/);
  assert.match(realtimeSource, /briefing_notes/);
  assert.match(realtimeSource, /never as instructions/);
  assert.match(pageSource, /sdp: offer\.sdp/);

  // Scraped image bytes must be inlined, or html-to-image taints the export canvas.
  assert.match(researchSource, /ALLOWED_IMAGE_HOSTS/);
  assert.match(researchSource, /inlineImage/);
  assert.match(researchSource, /base64/);
  assert.match(researchSource, /hasMismatchedOrigin/);
  assert.match(researchSource, /checkRateLimit/);

  assert.match(pageSource, /hasCompletedSetup/);
  assert.match(pageSource, /\/api\/notes\/pdf/);
  assert.match(pageSource, /\/api\/research/);
  assert.match(pageSource, /\/api\/vibes/);
  assert.doesNotMatch(pageSource, /ANAKIN_API_KEY|SARVAM_API_KEY/, "keys stay server-side");
});
