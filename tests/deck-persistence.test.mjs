import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const root = new URL("../", import.meta.url);

test("a resumed presentation continues the deck instead of opening a new one", async () => {
  const [page, route, configText] = await Promise.all([
    readFile(new URL("app/page.tsx", root), "utf8"),
    readFile(new URL("app/api/realtime/route.ts", root), "utf8"),
    readFile(new URL("config/v7.json", root), "utf8"),
  ]);
  const config = JSON.parse(configText);

  assert.ok(config.presentation.resume_scene_limit > 0);

  // Stopping must stay a pause: nothing in the stop/start path may clear the
  // deck, the staged scene, or the numbering that the resumed session builds on.
  const stopLive = page.slice(page.indexOf("const stopLive = useCallback"), page.indexOf("const startLive"));
  assert.doesNotMatch(stopLive, /setDeckScenes|setScene\(|setHistory|nextSceneSequenceRef/);
  const startLive = page.slice(page.indexOf("const startLive = useCallback"), page.indexOf('fetch("/api/realtime"'));
  assert.doesNotMatch(startLive, /setDeckScenes\(\[\]\)|setScene\(INITIAL_SCENE\)|nextSceneSequenceRef\.current = 0/);

  // startLive is a useCallback that must not re-create on every staged scene,
  // so the deck reaches it through a ref, the way vibe and notes already do.
  assert.match(page, /const deckScenesRef = useRef<Scene\[\]>\(\[\]\);/);
  assert.match(page, /deckScenesRef\.current = deckScenes;/);

  // Headlines only. Card bodies and imagery would bloat every reconnect
  // without telling the director anything more about what is already covered.
  const realtimeFetchAt = page.indexOf('fetch("/api/realtime"');
  const body = page.slice(realtimeFetchAt, page.indexOf("if (!response.ok)", realtimeFetchAt));
  assert.match(body, /resume: deckScenesRef\.current\.map\(/);
  assert.match(body, /sequence: staged\.sequence/);
  assert.match(body, /kind: staged\.kind/);
  assert.match(body, /title: staged\.title/);
  assert.doesNotMatch(body, /cards:|backgroundImage:|assetIds:/);

  // The server has to lift its own welcome-cover rule, or the outline just
  // becomes context for a presentation the director still restarts.
  assert.match(route, /function resumeInstructions/);
  assert.match(route, /\$\{DIRECTOR_INSTRUCTIONS\}\$\{setup\}\$\{resume\}/);
  assert.match(route, /Ignore the welcome-cover rule above/);
  assert.match(route, /v7\.presentation\.resume_scene_limit/);
  assert.match(route, /cleanSetupText\(scene\.title, MAX_RESUME_TITLE_CHARS\)/);
});
