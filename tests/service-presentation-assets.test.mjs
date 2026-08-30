import assert from "node:assert/strict";
import test from "node:test";
import { loadLib } from "./helpers/services.mjs";

const {
  PRESENTATION_ASSET_KINDS,
  assetTerms,
  encodePresentationAssetCatalog,
  inferPresentationAssetKind,
  matchPresentationAssets,
  presentationAssetCatalog,
  presentationAssetFit,
  presentationAssetMode,
  presentationAssetShape,
  resolvePresentationAssets,
} = await loadLib("presentation-assets");

function asset(overrides = {}) {
  return {
    id: "asset-1",
    name: "Asset",
    aliases: [],
    description: "",
    kind: "photo",
    mimeType: "image/jpeg",
    url: "data:image/jpeg;base64,private-pixels",
    ...overrides,
  };
}

const RAMSRI = asset({
  id: "asset-ramsri",
  name: "Ramsri",
  aliases: ["ram sri"],
  description: "Co-founder and product lead",
  kind: "person",
  referenceUrl: "data:image/webp;base64,reference-copy",
});

const LOGO = asset({
  id: "asset-logo",
  name: "TalkingStage mark",
  description: "Official company identity for title and closing moments",
  kind: "logo",
  mimeType: "image/png",
  url: "data:image/png;base64,private-logo",
  referenceUrl: "data:image/webp;base64,reference-logo",
});

const DASHBOARD = asset({
  id: "asset-dashboard",
  name: "Analytics view",
  description: "Product dashboard screenshot showing weekly growth",
  kind: "screenshot",
  width: 2400,
  height: 1350,
});

test("kinds are a closed vocabulary the director schema can enumerate", () => {
  assert.deepEqual([...PRESENTATION_ASSET_KINDS], [
    "person",
    "logo",
    "product",
    "screenshot",
    "chart",
    "photo",
    "illustration",
  ]);
});

test("matching ranks an exact name or alias above a topical overlap", () => {
  const assets = [RAMSRI, LOGO, DASHBOARD];

  assert.deepEqual(
    matchPresentationAssets("Ramsri walks through the roadmap", assets).map((match) => match.id),
    ["asset-ramsri"],
  );
  assert.deepEqual(
    matchPresentationAssets("ram sri walks through the roadmap", assets).map((match) => match.id),
    ["asset-ramsri"],
    "an alias counts as an exact term",
  );
  // A description overlap alone is enough, without the name being spoken.
  assert.deepEqual(
    matchPresentationAssets("Our dashboard shows weekly growth", assets).map((match) => match.id),
    ["asset-dashboard"],
  );
});

test("a term only counts on a word boundary", () => {
  const ram = asset({ id: "asset-ram", name: "Ram", aliases: [] });

  assert.deepEqual(matchPresentationAssets("Meet Ram, our lead.", [ram]).map((m) => m.id), ["asset-ram"]);
  assert.deepEqual(
    matchPresentationAssets("We added more RAM and a rambling changelog.", [ram]).map((m) => m.id),
    ["asset-ram"],
    "case-insensitive, but only as a standalone word",
  );
  assert.deepEqual(matchPresentationAssets("Rambling on about programs.", [ram]), []);
});

test("weak, stop-word, and empty overlaps do not place an asset", () => {
  const assets = [RAMSRI, LOGO, DASHBOARD];

  assert.deepEqual(matchPresentationAssets("Thank you all for coming today.", assets), []);
  assert.deepEqual(matchPresentationAssets("", assets), []);
  assert.deepEqual(matchPresentationAssets("The and for with that this", assets), []);
  assert.deepEqual(matchPresentationAssets("Anything at all", []), []);
});

test("matching returns at most the requested number of assets, best first", () => {
  const crowd = Array.from({ length: 6 }, (_, index) =>
    asset({
      id: `asset-${index}`,
      name: `Speaker ${index}`,
      description: "Founder speaker portrait from the customer team",
      kind: "person",
    }),
  );

  assert.equal(matchPresentationAssets("Our founder and the customer team", crowd).length, 3);
  assert.equal(matchPresentationAssets("Our founder and the customer team", crowd, 1).length, 1);
});

test("assetTerms drops fragments too short or too punctuated to match on", () => {
  assert.deepEqual(assetTerms({ name: "Ramsri", aliases: ["ram sri", "R", "  ", "---", "Q3 2026"] }), [
    "ramsri",
    "ram sri",
    "q3 2026",
  ]);
});

test("resolvePresentationAssets keeps the director's order, drops unknowns, and dedupes", () => {
  const assets = [RAMSRI, LOGO, DASHBOARD];

  assert.deepEqual(
    resolvePresentationAssets(["asset-logo", "asset-ramsri"], assets).map((match) => match.id),
    ["asset-logo", "asset-ramsri"],
  );
  assert.deepEqual(
    resolvePresentationAssets(["asset-logo", "does-not-exist", "asset-logo"], assets).map((m) => m.id),
    ["asset-logo"],
  );
  assert.deepEqual(resolvePresentationAssets([], assets), []);
  assert.deepEqual(resolvePresentationAssets(undefined, assets), []);
  assert.equal(
    resolvePresentationAssets(["asset-ramsri", "asset-logo", "asset-dashboard"], assets, 2).length,
    2,
  );
});

test("identity, brand, and data assets are never handed to the image generator", () => {
  // Only transform-safe material becomes a Gemini reference.
  assert.equal(presentationAssetMode(RAMSRI), "direct");
  assert.equal(presentationAssetMode(LOGO), "direct");
  assert.equal(
    presentationAssetMode({ kind: "illustration", description: "Abstract concept art", referenceUrl: "data:," }),
    "reference",
  );
  for (const description of ["Warm office background", "Moodboard for the visual style", "Mountain scenery"]) {
    assert.equal(
      presentationAssetMode({ kind: "photo", description, referenceUrl: "data:," }),
      "reference",
      description,
    );
  }
  assert.equal(
    presentationAssetMode({ kind: "photo", description: "Customer event photo", referenceUrl: "data:," }),
    "direct",
  );
  // Without a safe cropped copy there is nothing to send upstream at all.
  assert.equal(presentationAssetMode({ kind: "illustration", description: "Abstract concept art" }), "direct");
});

test("fit protects assets that must not be cropped", () => {
  for (const kind of ["logo", "product", "screenshot", "chart", "illustration"]) {
    assert.equal(presentationAssetFit({ kind }), "contain", kind);
  }
  assert.equal(presentationAssetFit({ kind: "person" }), "cover");
  assert.equal(presentationAssetFit({ kind: "photo", width: 1600, height: 1000 }), "cover");
  // Extreme aspect ratios lose their subject to a crop, so they are letterboxed.
  assert.equal(presentationAssetFit({ kind: "photo", width: 3000, height: 500 }), "contain");
  assert.equal(presentationAssetFit({ kind: "photo", width: 500, height: 3000 }), "contain");
  assert.equal(presentationAssetFit({ kind: "photo" }), "cover", "unknown dimensions default to a square-ish crop");
});

test("shape classifies the layout hint from the real dimensions", () => {
  assert.equal(presentationAssetShape({ width: 2400, height: 700 }), "wide");
  assert.equal(presentationAssetShape({ width: 1600, height: 900 }), "landscape");
  assert.equal(presentationAssetShape({ width: 1000, height: 1000 }), "square");
  assert.equal(presentationAssetShape({ width: 600, height: 1200 }), "portrait");
  assert.equal(presentationAssetShape({ width: 400, height: 1200 }), "tall");
  assert.equal(presentationAssetShape({}), "unknown");
  assert.equal(presentationAssetShape({ width: 1600, height: 0 }), "unknown");
});

test("kind inference reads the description first and the filename as a fallback", () => {
  assert.equal(inferPresentationAssetKind("Headshot of our co-founder"), "person");
  assert.equal(inferPresentationAssetKind("Logo of TalkingStage"), "logo");
  assert.equal(inferPresentationAssetKind("Questgen app screenshot"), "screenshot");
  assert.equal(inferPresentationAssetKind("Revenue chart for Q3"), "chart");
  assert.equal(inferPresentationAssetKind("Product packaging mockup"), "product");
  assert.equal(inferPresentationAssetKind("Hand drawn diagram"), "illustration");
  assert.equal(inferPresentationAssetKind("A moment from the launch event"), "photo");
  // A described person wins over a filename that says otherwise.
  assert.equal(inferPresentationAssetKind("Person Ramsri building Questgen", "logo.png"), "person");
  assert.equal(inferPresentationAssetKind("   ", "company-logo.png"), "logo");
  assert.equal(inferPresentationAssetKind("", ""), "photo");
});

test("the catalog carries meaning and hints but never the pixels", () => {
  const [entry] = presentationAssetCatalog([RAMSRI]);

  assert.deepEqual(Object.keys(entry).sort(), [
    "aliases",
    "description",
    "fit",
    "id",
    "kind",
    "mode",
    "name",
    "shape",
  ]);
  assert.equal(entry.id, "asset-ramsri");
  assert.equal(entry.description, "Co-founder and product lead");
  assert.equal(entry.fit, "cover");
  assert.equal(entry.mode, "direct");
  assert.equal(entry.shape, "unknown");
  assert.equal("url" in entry, false, "the private image never leaves the browser");
  assert.equal("referenceUrl" in entry, false);
});

test("catalog text is normalized and every field is bounded", () => {
  const [entry] = presentationAssetCatalog([
    asset({
      id: "asset-messy",
      name: `  Ramsri${"!".repeat(80)}`,
      aliases: ["one", "one", "two", "three", "four", "five"],
      description: `Co-founder  and\t\tproduct lead. ${"detail ".repeat(60)}`,
    }),
  ]);

  assert.equal(entry.name.length, 48);
  assert.equal(entry.description.length, 180);
  assert.match(entry.description, /^Co-founder and product lead\./, "control characters and runs of whitespace collapse");
  assert.deepEqual(entry.aliases, ["one", "two", "three", "four"], "aliases are deduplicated and capped at four");
});

test("the catalog is capped at twelve assets", () => {
  const many = Array.from({ length: 20 }, (_, index) => asset({ id: `asset-${index}`, name: `Asset ${index}` }));
  assert.equal(presentationAssetCatalog(many).length, 12);
});

test("the encoded catalog is base64url that decodes back to the same entries", () => {
  const encoded = encodePresentationAssetCatalog([RAMSRI, LOGO]);

  // base64url so it survives an HTTP header without escaping.
  assert.match(encoded, /^[A-Za-z0-9_-]+$/);
  assert.deepEqual(
    JSON.parse(Buffer.from(encoded, "base64url").toString("utf8")),
    presentationAssetCatalog([RAMSRI, LOGO]),
  );
  // An empty catalog still encodes to a valid empty array rather than nothing.
  assert.deepEqual(
    JSON.parse(Buffer.from(encodePresentationAssetCatalog([]), "base64url").toString("utf8")),
    [],
  );
});

test("non-ASCII names survive the round trip through the header encoding", () => {
  const encoded = encodePresentationAssetCatalog([
    asset({ id: "asset-intl", name: "Café Münchén — 東京", description: "Storefront photo" }),
  ]);

  const [entry] = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8"));
  assert.equal(entry.name, "Café Münchén — 東京");
});
