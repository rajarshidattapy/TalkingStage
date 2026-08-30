/**
 * Next resolves `@/…` through tsconfig paths and imports JSON without an
 * import attribute. `node --test` does neither, so these hooks teach the plain
 * Node loader the same two tricks and let the tests exercise the real route
 * and library modules instead of a re-typed copy of them.
 */
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

const root = new URL("../../", import.meta.url);
const EXTENSIONS = ["", ".ts", ".tsx", ".mjs", ".js", ".json", "/index.ts"];

function probe(specifier, base) {
  for (const extension of EXTENSIONS) {
    const candidate = new URL(`${specifier}${extension}`, base);
    if (existsSync(fileURLToPath(candidate))) return candidate;
  }
  return null;
}

export async function resolve(specifier, context, nextResolve) {
  if (specifier.startsWith("@/")) {
    const target = probe(specifier.slice(2), root);
    if (!target) throw new Error(`Unresolved alias import: ${specifier}`);
    const isJson = target.pathname.endsWith(".json");
    return {
      url: target.href,
      shortCircuit: true,
      ...(isJson ? { format: "json", importAttributes: { type: "json" } } : {}),
    };
  }

  let resolved;
  try {
    resolved = await nextResolve(specifier, context);
  } catch (error) {
    // Next lets source files omit the extension on relative imports too.
    const target = specifier.startsWith(".") && probe(specifier, context.parentURL);
    if (!target) throw error;
    return { url: target.href, shortCircuit: true };
  }

  if (resolved.url.endsWith(".json")) {
    return { ...resolved, format: "json", importAttributes: { type: "json" } };
  }
  return resolved;
}
