"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { ArrowRight } from "lucide-react";
import { toast } from "sonner";
import { ArtifactLinks } from "@/components/artifact-links";
import { EvaluationBadge } from "@/components/evaluation-badge";
import { FailurePanel, findFailingStep } from "@/components/run-detail";
import { RunClarification } from "@/components/run-clarification";
import { RunFollowUp } from "@/components/run-follow-up";
import { RunStatusBadge } from "@/components/run-status-badge";
import { StopRunButton } from "@/components/run-stop-button";
import { RunThread } from "@/components/run-thread";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { formatMoney, formatMs } from "@/lib/format";
import {
  clarificationRoundKey,
  isAwaitingInput,
  isEvaluationInFlight,
  PHASE_LABEL,
  runProgressSchema,
  runWorkingMs,
  TERMINAL_RUN_STATUSES,
  type Run,
  type RunProgress,
} from "@/lib/schema";

/**
 * The run the user is looking at right now, directly under the composer: what
 * the agent is saying, what it is reasoning about, and — while it is paused —
 * the questions it needs answered. Deliberately tighter than the run detail
 * page: the play-by-play and the full record live there, one link away.
 */

const POLL_INTERVAL_MS = 1000;

/** Grace window for the evaluation row to appear after the run goes terminal. */
const EVALUATION_HANDOFF_MS = 120_000;

function isTerminal(run: Run): boolean {
  return TERMINAL_RUN_STATUSES.includes(run.status);
}

function awaitingVerdict(run: Run): boolean {
  if (!isTerminal(run)) return false;
  if (isEvaluationInFlight(run.evaluation)) return true;
  if (run.evaluation !== null) return false;
  const finishedAt = run.finishedAt ? new Date(run.finishedAt).getTime() : 0;
  return Date.now() - finishedAt < EVALUATION_HANDOFF_MS;
}

async function fetchProgress(id: string): Promise<RunProgress> {
  const response = await fetch(`/api/runs/${id}/steps`, { cache: "no-store" });
  if (!response.ok) throw new Error(`Request failed (${response.status})`);
  const parsed = runProgressSchema.safeParse(await response.json());
  if (!parsed.success) throw new Error("Unexpected response from server");
  return parsed.data;
}

export function LiveRunPanel({ initialProgress }: { initialProgress: RunProgress }) {
  const router = useRouter();
  const [progress, setProgress] = useState(initialProgress);
  const warnedRef = useRef(false);
  const settledRef = useRef(false);

  // The server is the source of truth for *which* run to follow: a reload
  // mid-run, or a new run started from the composer above, both arrive as a
  // fresh prop. A payload for the run already on screen is ignored, because the
  // poll below has a newer version of it.
  const followedRef = useRef(initialProgress.run.id);
  useEffect(() => {
    if (initialProgress.run.id === followedRef.current) return;
    followedRef.current = initialProgress.run.id;
    settledRef.current = false;
    warnedRef.current = false;
    setProgress(initialProgress);
  }, [initialProgress]);

  const { run, steps } = progress;
  const runId = run.id;
  const active = !isTerminal(run) || awaitingVerdict(run);

  // Same endpoint and the same stopping rule as the run detail page: the
  // interval tears itself down as soon as the run and its verdict have settled,
  // so an idle tab polls nothing.
  useEffect(() => {
    if (!active) return;
    let cancelled = false;
    const timer = setInterval(async () => {
      try {
        const next = await fetchProgress(runId);
        if (cancelled) return;
        warnedRef.current = false;
        setProgress((current) => (current.run.id === runId ? next : current));

        if (isTerminal(next.run) && !isEvaluationInFlight(next.run.evaluation)) {
          // Bring the stats and the runs list in step, once.
          if (!settledRef.current) {
            settledRef.current = true;
            router.refresh();
          }
        }
      } catch {
        if (cancelled || warnedRef.current) return;
        warnedRef.current = true;
        toast.error("Lost contact with the run. Still retrying…");
      }
    }, POLL_INTERVAL_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [runId, active, router]);

  /** The server's own description of the run, straight after a stop. */
  function handleStopped(stopped: Run | null) {
    if (stopped) {
      setProgress((current) => (current.run.id === stopped.id ? { ...current, run: stopped } : current));
    }
    router.refresh();
  }

  const paused = run.status === "awaiting_input" && isAwaitingInput(run.clarification.state);
  const midRun = paused && run.clarification.state === "awaiting_mid_run";
  // Answers are in but the runner has not picked them up yet — a second or two
  // where the run is neither waiting on the user nor visibly working.
  const resuming = run.status === "awaiting_input" && !paused;
  const failingStep = run.status === "failed" ? findFailingStep(steps) : null;

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex flex-wrap items-center gap-2">
          {paused ? "Waiting for you" : isTerminal(run) ? "Latest run" : "Running now"}
          <RunStatusBadge status={run.status} run={run} />
          <EvaluationBadge evaluation={run.evaluation} compact />
          {!isTerminal(run) && !paused && (
            <Badge variant="secondary">
              <span className="size-2 animate-pulse rounded-full bg-current" />
              {PHASE_LABEL[progress.phase]}
            </Badge>
          )}
        </CardTitle>
        <CardDescription>
          {midRun
            ? "The agent stopped partway through: it needs something only you can give it."
            : paused
              ? "The agent needs a couple of answers before it starts."
              : resuming
                ? "Your answers are in. The agent is picking the work back up."
                : run.status === "cancelled"
                  ? "You stopped this run. Everything it got through before that is below."
                  : isTerminal(run)
                    ? "Your last run stays here until you start the next one."
                    : "Watching the agent work. It will keep going if you leave this page."}
        </CardDescription>
        <CardAction className="flex items-center gap-2">
          {/* Present for as long as there is something to stop — including
              while the run is parked on a question, where killing it is often
              what the user means instead of answering. */}
          <StopRunButton run={run} onStopped={handleStopped} />
          <Button variant="outline" size="sm" nativeButton={false} render={<Link href={`/runs/${run.id}`} />}>
            Full run
            <ArrowRight data-icon="inline-end" />
          </Button>
        </CardAction>
      </CardHeader>

      <CardContent className="flex flex-col gap-4">
        {run.status === "failed" && <FailurePanel run={run} failingStep={failingStep} />}

        {/* The conversation, oldest turn first: what was asked, what came back,
            what was asked next. Capped and scrolled so a long answer — or a
            long run — cannot push the rest of the page off the screen. */}
        <RunThread
          progress={progress}
          failingStepSeq={failingStep?.seq ?? null}
          // Open on arrival when the agent is stuck: what it got through before
          // it got stuck is the context for the question it is asking.
          openCurrentSteps={midRun}
        />

        {/* Outside the scroll box on purpose: a card the user has to type into
            must never be half-hidden behind a scrollbar. */}
        {paused && (
          <RunClarification
            // A run can stop for the user more than once. Keying on the round
            // makes the next question a fresh card rather than the previous
            // one with its "answers sent" state and its old text still in it.
            key={clarificationRoundKey(run.clarification)}
            runId={run.id}
            clarification={run.clarification}
            onResumed={() => router.refresh()}
          />
        )}

        {/* A finished run is not a dead end: the next instruction carries on
            this conversation as another turn of it, rather than starting the
            fresh one the box above would. */}
        {isTerminal(run) && <RunFollowUp run={run} />}

        {isTerminal(run) && (
          <div className="flex flex-col gap-2 rounded-lg border bg-muted/40 p-4">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <p className="text-xs font-medium text-muted-foreground">Output files</p>
              <p className="text-xs text-muted-foreground tabular-nums">
                {/* Working time and cost across every turn, which is what this
                    run has actually taken and cost. */}
                {formatMs(runWorkingMs(run))} · {formatMoney(run.costUsd)}
              </p>
            </div>
            <ArtifactLinks artifacts={run.artifacts} emptyLabel="No files — the answer is above." />
          </div>
        )}
      </CardContent>
    </Card>
  );
}

