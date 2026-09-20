import { after, NextResponse } from "next/server";
import { runAgent, runChainWorkspaceDir } from "@/lib/agent";
import { appendRunTurn, findActiveRun, getRun, getRunSession } from "@/lib/repo";
import { sessionTranscriptExists } from "@/lib/session-files";
import { canFollowUp, followUpSchema } from "@/lib/schema";

/**
 * Carries a finished run on with another instruction.
 *
 * The follow-up is another turn of the same run, not a run of its own: it is
 * the same conversation, and the user reads it as one thread. Where the
 * session is still on disk it is reopened, so the agent genuinely remembers
 * its own work rather than being told about it. The response says which of the
 * two happened, so the UI never implies a memory the agent does not have.
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

  const existing = await getRun(id);
  if (!existing) {
    return NextResponse.json({ error: "Run not found" }, { status: 404 });
  }

  // Only a run that has stopped: continuing one that is still going is what
  // answering its questions, or waiting, is for.
  if (!canFollowUp(existing)) {
    return NextResponse.json(
      { error: "This run has not finished yet, so there is nothing to carry on from." },
      { status: 409 },
    );
  }

  // The same one-at-a-time rule the composer states, enforced where two tabs
  // cannot get around it.
  const active = await findActiveRun();
  if (active && active.id !== id) {
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

  // Asked before the turn starts so the response can be honest about what the
  // user is getting; the runner checks again at the moment it begins.
  const sessionId = await getRunSession(existing.id);
  const resumable =
    sessionId !== null &&
    (await sessionTranscriptExists(sessionId, await runChainWorkspaceDir(existing)));

  // Guarded in SQL on the run being finished, so two follow-ups submitted at
  // the same moment cannot both open a turn.
  const appended = await appendRunTurn(id, parsed.data.prompt);
  if (!appended.ok) {
    return appended.reason === "not_found"
      ? NextResponse.json({ error: "Run not found" }, { status: 404 })
      : NextResponse.json(
          { error: "This run started again a moment ago. Wait for it to finish, then carry on." },
          { status: 409 },
        );
  }

  after(() => runAgent(id));

  return NextResponse.json(
    { run: appended.run, turn: appended.seq, continuation: resumable ? "resumed" : "seeded" },
    { status: 201 },
  );
}
