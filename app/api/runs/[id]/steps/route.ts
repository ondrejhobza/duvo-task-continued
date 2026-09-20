import { NextResponse } from "next/server";
import { reconcileCancellation } from "@/lib/agent";
import { getRun, listRunEvents } from "@/lib/repo";
import { buildRunProgress } from "@/lib/steps";

export async function GET(
  _request: Request,
  ctx: RouteContext<"/api/runs/[id]/steps">,
): Promise<NextResponse> {
  const { id } = await ctx.params;
  let run = await getRun(id);
  if (!run) {
    return NextResponse.json({ error: "Run not found" }, { status: 404 });
  }

  // The poll is also where a stop left without a loop — the server restarted
  // while it was pending — gets finalised, so the view can never watch a
  // "stopping" run that nobody is stopping.
  if (run.cancelRequestedAt !== null && (await reconcileCancellation(id))) {
    run = (await getRun(id)) ?? run;
  }

  const events = await listRunEvents(id);
  return NextResponse.json(buildRunProgress(run, events));
}
