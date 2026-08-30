import v7 from "@/config/v7.json";
import {
  checkRateLimit,
  hasMismatchedOrigin,
  rateLimitResponse,
} from "@/lib/request-guards";
import { recentVibes, saveVibe } from "@/lib/vibes";

export const runtime = "nodejs";

export async function GET() {
  try {
    return Response.json({ vibes: recentVibes() }, { headers: { "Cache-Control": "no-store" } });
  } catch {
    // A missing or unwritable database should not block the setup screen.
    return Response.json({ vibes: [] }, { headers: { "Cache-Control": "no-store" } });
  }
}

export async function POST(request: Request) {
  if (hasMismatchedOrigin(request)) {
    return Response.json({ error: "Cross-origin requests are not allowed." }, { status: 403 });
  }

  const rateLimit = checkRateLimit(
    request,
    "vibes",
    v7.security.setup_requests_per_window,
    v7.security.rate_limit_window_ms,
  );
  if (!rateLimit.allowed) return rateLimitResponse(rateLimit);

  let body: { vibe?: unknown };
  try {
    body = (await request.json()) as { vibe?: unknown };
  } catch {
    return Response.json({ error: "A vibe is required." }, { status: 400 });
  }

  try {
    const saved = saveVibe(String(body.vibe ?? ""));
    if (!saved) return Response.json({ error: "A vibe is required." }, { status: 400 });
    return Response.json({ vibe: saved });
  } catch (error) {
    const message = error instanceof Error ? error.message : "The vibe could not be saved.";
    return Response.json({ error: message }, { status: 500 });
  }
}
