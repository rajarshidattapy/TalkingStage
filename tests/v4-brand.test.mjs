import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { missing, readOptionalBytes, readOptionalText } from "./helpers/repo-files.mjs";

const root = new URL("../", import.meta.url);

test("V4 locks the TalkingStage identity across app and exports", async (t) => {
  const [v3Text, v4Text, brandText, pageSource, routeSource, layoutSource, packageText, favicon, baseline, socialCard] =
    await Promise.all([
      readFile(new URL("config/v3.json", root), "utf8"),
      readFile(new URL("config/v4.json", root), "utf8"),
      readFile(new URL("config/brand.json", root), "utf8"),
      readFile(new URL("app/page.tsx", root), "utf8"),
      readFile(new URL("app/api/realtime/route.ts", root), "utf8"),
      readFile(new URL("app/layout.tsx", root), "utf8"),
      readFile(new URL("package.json", root), "utf8"),
      readFile(new URL("public/favicon.svg", root), "utf8"),
      readOptionalText(new URL("V4_BASELINE.md", root)),
      readOptionalBytes(new URL("public/og.png", root)),
    ]);
  const v3 = JSON.parse(v3Text);
  const v4 = JSON.parse(v4Text);
  const brand = JSON.parse(brandText);
  const packageJson = JSON.parse(packageText);

  assert.equal(brand.name, "TalkingStage");
  assert.equal(brand.display_name, "TALKINGSTAGE");
  assert.equal(brand.slug, "talkingstage");
  assert.equal(brand.mark, "TS");
  assert.equal(brand.tagline, "Live presentations. Zero prep.");
  assert.equal(brand.status, "locked");
  assert.equal(brand.locked_at, "2026-08-30");

  assert.equal(v4.release, "V4");
  assert.equal(v4.inherits, "V3");
  assert.equal(v4.brand.identity_locked, true);
  assert.deepEqual(v4.realtime, v3.realtime);
  assert.deepEqual(v4.presentation, v3.presentation);
  assert.deepEqual(v4.visuals, v3.visuals);
  assert.deepEqual(v4.delivery, v3.delivery);

  assert.equal(packageJson.name, brand.slug);
  assert.match(pageSource, /import brand from "@\/config\/brand\.json"/);
  assert.match(routeSource, /You are \$\{brand\.name\}/);
  assert.match(layoutSource, /brand\.name/);
  assert.doesNotMatch(`${pageSource}\n${routeSource}\n${layoutSource}`, /\bCue\b/);

  await t.test("the favicon renders the mark brand.json declares", () => {
    assert.match(favicon, new RegExp(`>${brand.mark}</text>`));
  });

  await t.test(
    "V4_BASELINE.md states the identity lock",
    { skip: missing("V4_BASELINE.md", baseline) },
    () => {
      assert.match(baseline, /Treat the TalkingStage identity as immutable/);
    },
  );

  await t.test(
    "the social card matches the dimensions layout.tsx advertises",
    { skip: missing("public/og.png", socialCard) },
    () => {
      assert.equal(socialCard.readUInt32BE(16), 1729);
      assert.equal(socialCard.readUInt32BE(20), 910);
    },
  );
});
