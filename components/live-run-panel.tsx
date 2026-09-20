"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { ArrowRight, Brain, ChevronRight, ListChecks } from "lucide-react";
import { toast } from "sonner";
import { ArtifactLinks } from "@/components/artifact-links";
import { CopyButton } from "@/components/copy-button";
import { EvaluationBadge } from "@/components/evaluation-badge";
import { Markdown } from "@/components/markdown";
import { FailurePanel, findFailingStep } from "@/components/run-detail";
import { RunClarification } from "@/components/run-clarification";
import { RunStatusBadge } from "@/components/run-status-badge";
import { StopRunButton } from "@/components/run-stop-button";
import { RunSteps } from "@/components/run-steps";
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
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { formatDuration, formatMoney } from "@/lib/format";
import {
  clarificationRoundKey,
  isAwaitingInput,
  isEvaluationInFlight,
  PHASE_LABEL,
  runProgressSchema,
  TERMINAL_RUN_STATUSES,
  type Run,
  type RunProgress,
  type RunStep,
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

/** The answer so far: the finished summary, else the last thing the agent said. */
function latestOutput(run: Run, steps: RunStep[]): string | null {
  if (run.resultText) return run.resultText;
  for (let i = steps.length - 1; i >= 0; i -= 1) {
    const step = steps[i];
    if (step.kind === "text" && step.detail) return step.detail;
  }
  return null;
}

function lastActivity(steps: RunStep[]): string | null {
  return steps.at(-1)?.title ?? null;
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
  const output = latestOutput(run, steps);
  const activity = lastActivity(steps);
  /** The agent is mid-task, so the last step doubles as a progress line. */
  const working = !paused && !isTerminal(run) && activity !== null;
  const thinking = steps.filter((step) => step.kind === "thinking");

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

        {/* One turn of a conversation: what was asked, then what came back, with
            the reasoning folded away underneath. Capped and scrolled so a long
            answer cannot push the rest of the page off the screen. */}
        <div className="flex max-h-[32rem] flex-col gap-4 overflow-y-auto">
          <section className="flex flex-col gap-2 rounded-lg border bg-muted/40 p-4">
            <p className="text-xs font-medium text-muted-foreground">You asked</p>
            <p className="text-sm leading-relaxed whitespace-pre-wrap">{run.prompt}</p>
          </section>

          <section className="flex min-w-0 flex-col gap-2 px-1">
            {(working || output) && (
              <div className="flex items-start gap-2">
                {working && (
                  <p className="flex min-w-0 items-center gap-2 text-sm text-muted-foreground">
                    <span className="size-1.5 shrink-0 animate-pulse rounded-full bg-current" />
                    <span className="truncate">{activity}</span>
                  </p>
                )}
                {/* Copies the markdown source of what is on screen at click
                    time, so a reply still arriving copies as far as it has got. */}
                {output && (
                  <span className="ml-auto">
                    <CopyButton value={output} label="Copy reply as markdown" />
                  </span>
                )}
              </div>
            )}
            {output ? (
              <Markdown>{output}</Markdown>
            ) : (
              <p className="text-sm text-muted-foreground">
                {midRun
                  ? "Nothing written yet — it is waiting on the value below."
                  : paused
                    ? "Nothing yet — the agent is waiting for your answers below."
                    : isTerminal(run)
                      ? "The agent finished without writing a summary."
                      : "Nothing written yet — the agent is still working."}
              </p>
            )}
          </section>

          {/* Only when the run was actually asked to think: an empty reasoning
              section is worse than none at all. */}
          {run.reasoning && <ReasoningBlock steps={thinking} settled={isTerminal(run)} />}
        </div>

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

        {/* Open by default when the agent stopped mid-way: what it managed to do
            before it got stuck is the context for the question it is asking. */}
        <Collapsible defaultOpen={midRun}>
          <CollapsibleTrigger
            className="group flex w-full items-center gap-2 rounded-lg px-1 py-1.5 text-left text-sm text-muted-foreground hover:bg-muted/60"
          >
            <ListChecks className="size-4" />
            Every step
            <span className="tabular-nums">({steps.length})</span>
            <ChevronRight className="ml-auto size-3.5 transition-transform group-data-[panel-open]:rotate-90" />
          </CollapsibleTrigger>
          <CollapsibleContent>
            <div className="pt-2">
              <RunSteps progress={progress} failingStepSeq={failingStep?.seq ?? null} />
            </div>
          </CollapsibleContent>
        </Collapsible>

        {isTerminal(run) && (
          <div className="flex flex-col gap-2 rounded-lg border bg-muted/40 p-4">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <p className="text-xs font-medium text-muted-foreground">Output files</p>
              <p className="text-xs text-muted-foreground tabular-nums">
                {formatDuration(run.startedAt, run.finishedAt)} · {formatMoney(run.costUsd)}
              </p>
            </div>
            <ArtifactLinks artifacts={run.artifacts} emptyLabel="No files — the answer is above." />
          </div>
        )}
      </CardContent>
    </Card>
  );
}

/**
 * Extended thinking, folded away. It is long, repetitive and not the answer;
 * one line says whether there is any, and opening it shows the lot.
 */
function ReasoningBlock({ steps, settled }: { steps: RunStep[]; settled: boolean }) {
  if (steps.length === 0) {
    // Reasoning was switched on but the model volunteered none. Say so once the
    // run is over; while it runs, there may still be some coming.
    if (!settled) return null;
    return (
      <p className="flex items-center gap-2 px-1 text-sm text-muted-foreground">
        <Brain className="size-4" />
        The model returned no reasoning for this run.
      </p>
    );
  }

  return (
    <Collapsible>
      <CollapsibleTrigger className="group flex w-full items-center gap-2 rounded-lg px-1 py-1.5 text-left text-sm text-muted-foreground hover:bg-muted/60">
        <Brain className="size-4" />
        Reasoning
        <span className="tabular-nums">({steps.length})</span>
        <ChevronRight className="ml-auto size-3.5 transition-transform group-data-[panel-open]:rotate-90" />
      </CollapsibleTrigger>
      <CollapsibleContent>
        <div className="mt-2 flex max-h-64 flex-col gap-3 overflow-y-auto rounded-lg border bg-muted/40 p-4">
          {steps.map((step) => (
            <p
              key={step.seq}
              className="text-sm leading-relaxed whitespace-pre-wrap text-muted-foreground italic"
            >
              {step.detail ?? step.title}
            </p>
          ))}
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
}
