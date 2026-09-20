import { after, NextResponse } from "next/server";
import { runWorkspaceDir } from "@/lib/agent";
import { performEvaluation } from "@/lib/evaluate";
import { beginEvaluation, clearHumanVerdict, setHumanVerdict } from "@/lib/repo";
import { humanVerdictSchema } from "@/lib/schema";

/**
 * Starts (or restarts) the automatic evaluation of a finished run. The claim
 * is guarded in SQL, so a double submit gets a 409 rather than a second judge
 * call. The grading itself runs in the background; the client polls for it.
 */
export async function POST(
  _request: Request,
  ctx: RouteContext<"/api/runs/[id]/evaluate">,
): Promise<NextResponse> {
  const { id } = await ctx.params;

  const claim = await beginEvaluation(id);
  if (!claim.ok) {
    if (claim.reason === "not_found") {
      return NextResponse.json({ error: "Run not found" }, { status: 404 });
    }
    const error =
      claim.reason === "run_active"
        ? "The run is still going; it can be evaluated once it finishes."
        : claim.reason === "run_cancelled"
          ? "You stopped this run, so there is no finished attempt to grade."
          : "An evaluation of this run is already running.";
    return NextResponse.json({ error }, { status: 409 });
  }

  after(() => performEvaluation(id, runWorkspaceDir(id)));

  return NextResponse.json({ evaluation: claim.evaluation }, { status: 202 });
}

/** Records the human's own verdict, which overrides the judge's. */
export async function PATCH(
  request: Request,
  ctx: RouteContext<"/api/runs/[id]/evaluate">,
): Promise<NextResponse> {
  const { id } = await ctx.params;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Body must be JSON" }, { status: 400 });
  }

  const parsed = humanVerdictSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Invalid input", issues: parsed.error.issues },
      { status: 400 },
    );
  }

  const evaluation = await setHumanVerdict(id, parsed.data.verdict, parsed.data.note);
  if (!evaluation) {
    return NextResponse.json({ error: "This run has not been evaluated yet" }, { status: 404 });
  }
  return NextResponse.json({ evaluation });
}

/** Withdraws the human verdict, handing the run back to the automatic one. */
export async function DELETE(
  _request: Request,
  ctx: RouteContext<"/api/runs/[id]/evaluate">,
): Promise<NextResponse> {
  const { id } = await ctx.params;
  const evaluation = await clearHumanVerdict(id);
  if (!evaluation) {
    return NextResponse.json({ error: "This run has not been evaluated yet" }, { status: 404 });
  }
  return NextResponse.json({ evaluation });
}
