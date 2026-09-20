import { after, NextResponse } from "next/server";
import type { z } from "zod";
import { runAgent } from "@/lib/agent";
import { appendRunEvent, getRun, resumeRunWithClarification } from "@/lib/repo";
import {
  hasClarificationAnswer,
  inputValueSchema,
  submitClarificationSchema,
  type ClarificationAnswer,
  type PendingInput,
} from "@/lib/schema";

/**
 * Hands the user's answers to a run parked in `awaiting_input` and releases it.
 * The transition is guarded in SQL, so a double submit or a stale tab gets a 409
 * rather than restarting a run that is already on its way.
 *
 * A pre-run pause is re-queued and picked up by a fresh runner here; a mid-run
 * pause is left for the runner that is still holding the session, so the steps
 * it has already taken survive.
 */

/** Typed answers are checked against the shape their request asked for. */
function validate(
  requests: PendingInput[],
  answers: ClarificationAnswer[],
): z.core.$ZodIssue[] {
  const byId = new Map(requests.map((request) => [request.id, request]));
  const issues: z.core.$ZodIssue[] = [];

  answers.forEach((answer, index) => {
    const request = byId.get(answer.questionId);
    if (!request || request.kind !== "text" || answer.skipped) return;
    const parsed = inputValueSchema(request).safeParse(answer.text);
    if (parsed.success) return;
    for (const issue of parsed.error.issues) {
      issues.push({ ...issue, path: ["answers", index, "text"] });
    }
  });

  return issues;
}

export async function POST(
  request: Request,
  ctx: RouteContext<"/api/runs/[id]/clarify">,
): Promise<NextResponse> {
  const { id } = await ctx.params;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Body must be JSON" }, { status: 400 });
  }

  const parsed = submitClarificationSchema.safeParse(body);
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

  const requests = existing.clarification.questions;
  const askedIds = new Set(requests.map((r) => r.id));
  const answers = parsed.data.answers.filter((a) => askedIds.has(a.questionId));

  // A run can ask more than once, so an answer that matches nothing on file is
  // most likely an answer to the previous question, submitted after the agent
  // moved on to the next one. Filing it silently would count as skipping the
  // question actually on screen, so it is refused and the user is told why.
  if (parsed.data.answers.length > 0 && answers.length === 0) {
    return NextResponse.json(
      {
        error: "The agent has moved on and is asking something else now.",
        status: existing.status,
        questionsChanged: true,
      },
      { status: 409 },
    );
  }

  // "Run without answering" is an explicit choice, so nothing is validated;
  // otherwise a typed value has to look like what was asked for.
  if (!parsed.data.proceedWithout) {
    const issues = validate(requests, answers);
    if (issues.length > 0) {
      return NextResponse.json({ error: "Invalid input", issues }, { status: 400 });
    }
  }

  const answered = answers.some(hasClarificationAnswer);
  const state = answered && !parsed.data.proceedWithout ? "answered" : "skipped";

  const resumed = await resumeRunWithClarification(
    id,
    answers,
    state,
    requests.map((request) => request.id),
  );
  if (!resumed.ok) {
    if (resumed.reason === "not_found") {
      return NextResponse.json({ error: "Run not found" }, { status: 404 });
    }
    if (resumed.reason === "questions_changed") {
      return NextResponse.json(
        {
          error: "The agent has moved on and is asking something else now.",
          status: existing.status,
          questionsChanged: true,
        },
        { status: 409 },
      );
    }
    // Read the status back rather than reporting the one from before the
    // guard: a run stopped while this card was open has moved somewhere the
    // user needs naming, not a generic "no longer waiting".
    const current = await getRun(id);
    return NextResponse.json(
      {
        error:
          current?.status === "cancelled"
            ? "You stopped this run, so it never needed your answer."
            : "This run is no longer waiting for answers.",
        status: current?.status ?? existing.status,
      },
      { status: 409 },
    );
  }

  // Mid-run pauses are resumed by the runner that is still waiting on the tool
  // call; starting a second runner here would duplicate the work.
  if (resumed.stage === "pre_run") {
    after(() => runAgent(id));
  } else {
    // The runner records the pre-run round when it restarts; a mid-run answer
    // has no such moment, so the user's turn is written into the step stream
    // here instead of only surfacing inside the tool result.
    await appendRunEvent(id, "clarification_answered", {
      skipped: state === "skipped",
      answers: requests.map((req) => {
        const answer = answers.find((a) => a.questionId === req.id);
        const parts = [...(answer?.selected ?? [])];
        if (answer?.text) parts.push(answer.text);
        return { question: req.question, answer: parts.join("; ") };
      }),
    });
  }

  const run = await getRun(id);
  return NextResponse.json({ run });
}
