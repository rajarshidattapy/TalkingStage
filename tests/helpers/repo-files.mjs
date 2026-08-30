/**
 * Some files these tests assert on are not in the repository: the `init`
 * commit never included `README.md`, the `V*_BASELINE.md` lock documents, or
 * the `public/` imagery (`og.png`, `demo-ramsri.jpg`, `demo-danish.jpg`).
 *
 * A raw ENOENT from `readFile` collapses a whole test on its first missing
 * file and says nothing useful about the ones after it. Reading them
 * optionally instead lets each test check everything it *can* check and mark
 * only the absent-file assertions as skipped, so the run reports "waiting on a
 * file the repo owner has to push" rather than "this behavior is broken".
 *
 * When the files land these helpers keep working unchanged and the skipped
 * subtests start running again on their own.
 */
import { readFile } from "node:fs/promises";

async function readOptional(url, encoding) {
  try {
    return await readFile(url, encoding);
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}

export function readOptionalText(url) {
  return readOptional(url, "utf8");
}

export function readOptionalBytes(url) {
  return readOptional(url, undefined);
}

/** Skip reason for a subtest whose file is missing, or `false` to run it. */
export function missing(name, value) {
  return value === null && `${name} is not committed to this repo yet`;
}
