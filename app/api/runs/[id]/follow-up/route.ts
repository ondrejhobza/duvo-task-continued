import { after, NextResponse } from "next/server";
import { runAgent, runChainWorkspaceDir } from "@/lib/agent";
import { createFollowUpRun, findActiveRun, getRun, getRunSession } from "@/lib/repo";
import { sessionTranscriptExists } from "@/lib/session-files";
import { canFollowUp, followUpSchema } from "@/lib/schema";

/**
 * Carries a finished run on with another instruction.
 *
 * The follow-up becomes its own run, linked to the one it continues, and —
 * where the earlier session is still on disk — reopens that session so the
 * agent genuinely remembers its own work rather than being told about it. The
 * response says which of the two happened, so the UI never implies a memory
 * the agent does not have.
 */
export async function POST(
  request: Request,
  ctx: RouteContext<"/api/runs/[id]/follow-up">,
): Promise<NextResponse> {
  const { id } = await ctx.params;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Body must be JSON" }, { status: 400 });
  }

  const parsed = followUpSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Invalid input", issues: parsed.error.issues },
      { status: 400 },
    );
  }

  const parent = await getRun(id);
  if (!parent) {
    return NextResponse.json({ error: "Run not found" }, { status: 404 });
  }

  // Only a run that has stopped: continuing one that is still going is what
  // answering its questions, or waiting, is for.
  if (!canFollowUp(parent)) {
    return NextResponse.json(
      { error: "This run has not finished yet, so there is nothing to carry on from." },
      { status: 409 },
    );
  }

  // The same one-at-a-time rule the composer states, enforced where two tabs
  // cannot get around it. A second follow-up fired before the first row was
  // created is caught here too, because that first run is already active.
  const active = await findActiveRun();
  if (active) {
    return NextResponse.json(
      {
        error:
          active.status === "awaiting_input"
            ? "The run in progress is waiting on you. Answer it, or stop it, before starting another."
            : "A run is still going. It will finish on its own; you can carry on then.",
        activeRunId: active.id,
      },
      { status: 409 },
    );
  }

  // Asked before the run is created so the response can be honest about what
  // the user is getting; the runner checks again at the moment it starts.
  const sessionId = await getRunSession(parent.id);
  const resumable =
    sessionId !== null &&
    (await sessionTranscriptExists(sessionId, await runChainWorkspaceDir(parent)));

  const run = await createFollowUpRun(parent, parsed.data.prompt);
  after(() => runAgent(run.id));

  return NextResponse.json({ run, continuation: resumable ? "resumed" : "seeded" }, { status: 201 });
}
