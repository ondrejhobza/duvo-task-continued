import { NextResponse } from "next/server";
import { isRunInFlight, reconcileCancellation } from "@/lib/agent";
import { getRun, requestRunCancellation } from "@/lib/repo";
import { cancelRunSchema } from "@/lib/schema";

/**
 * Stops a run the user no longer wants. Two halves: the intent is written
 * here, guarded in SQL on the run still being non-terminal, and the agent loop
 * honours it at its next step boundary — so a stop that races a run finishing
 * on its own gets a 409 instead of corrupting a finished outcome.
 *
 * When no loop in this process owns the run — the server restarted while the
 * stop was pending, or the runner died — there is nobody to honour it, so the
 * run is finalised here instead of sitting in "stopping" for ever.
 */
export async function POST(
  request: Request,
  ctx: RouteContext<"/api/runs/[id]/cancel">,
): Promise<NextResponse> {
  const { id } = await ctx.params;

  // A body is optional: stopping takes no arguments and needs no reason. What
  // does arrive is still validated, so a client sending something unexpected
  // hears about it at the boundary.
  const raw = await request.text();
  let body: unknown = {};
  if (raw.trim().length > 0) {
    try {
      body = JSON.parse(raw);
    } catch {
      return NextResponse.json({ error: "Body must be JSON" }, { status: 400 });
    }
  }

  const parsed = cancelRunSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Invalid input", issues: parsed.error.issues },
      { status: 400 },
    );
  }

  const requested = await requestRunCancellation(id);
  if (!requested.ok) {
    if (requested.reason === "not_found") {
      return NextResponse.json({ error: "Run not found" }, { status: 404 });
    }
    const run = await getRun(id);
    return NextResponse.json(
      {
        error: "This run has already finished, so there is nothing to stop.",
        status: run?.status ?? null,
        run,
      },
      { status: 409 },
    );
  }

  if (!isRunInFlight(id)) await reconcileCancellation(id, 0);

  // Read back rather than returning the row from the update: the loop may have
  // landed the run on `cancelled` in between, and the client should see that.
  const run = await getRun(id);
  return NextResponse.json({ run: run ?? requested.run });
}
