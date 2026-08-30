import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import path from "node:path";

export type SavedVibe = {
  id: number;
  text: string;
  usedCount: number;
  lastUsedAt: string;
};

const MAX_VIBE_LENGTH = 240;

// Node 22 ships SQLite, so this needs no dependency and no native build.
// ponytail: one local file, single process. Move to libSQL/Turso if this is
// ever deployed serverless — the filesystem there is ephemeral.
const runtimeState = globalThis as typeof globalThis & {
  __gurudornaaiVibeDb?: DatabaseSync;
};

function db() {
  if (runtimeState.__gurudornaaiVibeDb) return runtimeState.__gurudornaaiVibeDb;

  const directory = process.env.GURUDORNAAI_DATA_DIR || path.join(process.cwd(), "data");
  mkdirSync(directory, { recursive: true });
  const database = new DatabaseSync(path.join(directory, "gurudornaai.db"));
  database.exec(`
    CREATE TABLE IF NOT EXISTS vibes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      text TEXT NOT NULL UNIQUE,
      used_count INTEGER NOT NULL DEFAULT 1,
      last_used_at TEXT NOT NULL
    );
  `);
  runtimeState.__gurudornaaiVibeDb = database;
  return database;
}

export function closeVibeDb() {
  runtimeState.__gurudornaaiVibeDb?.close();
  runtimeState.__gurudornaaiVibeDb = undefined;
}

export function normalizeVibe(value: unknown) {
  return typeof value === "string"
    ? value
        .normalize("NFKC")
        // \p{C} is the Unicode "other" category: control and format characters.
        .replace(/\p{C}/gu, " ")
        .replace(/\s+/g, " ")
        .trim()
        .slice(0, MAX_VIBE_LENGTH)
    : "";
}

/** Re-entering a vibe bumps it instead of creating a duplicate row. */
export function saveVibe(value: string): SavedVibe | null {
  const text = normalizeVibe(value);
  if (!text) return null;

  db()
    .prepare(
      `INSERT INTO vibes (text, used_count, last_used_at)
       VALUES (?, 1, ?)
       ON CONFLICT(text) DO UPDATE SET
         used_count = used_count + 1,
         last_used_at = excluded.last_used_at`,
    )
    .run(text, new Date().toISOString());

  return recentVibes(50).find((vibe) => vibe.text === text) ?? null;
}

export function recentVibes(limit = 8): SavedVibe[] {
  const rows = db()
    .prepare(
      `SELECT id, text, used_count, last_used_at
       FROM vibes
       ORDER BY last_used_at DESC
       LIMIT ?`,
    )
    .all(Math.max(1, Math.min(limit, 50))) as Array<Record<string, unknown>>;

  return rows.map((row) => ({
    id: Number(row.id),
    text: String(row.text),
    usedCount: Number(row.used_count),
    lastUsedAt: String(row.last_used_at),
  }));
}
