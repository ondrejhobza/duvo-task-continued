"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import { Brain, Check, Copy, TriangleAlert } from "lucide-react";
import { toast } from "sonner";
import { ArtifactLinks } from "@/components/artifact-links";
import { EvaluationBadge } from "@/components/evaluation-badge";
import { RunClarification } from "@/components/run-clarification";
import { RunEvaluation } from "@/components/run-evaluation";
import { RunFollowUp } from "@/components/run-follow-up";
import { RunStatusBadge } from "@/components/run-status-badge";
import { RunSteps } from "@/components/run-steps";
import { RunThread } from "@/components/run-thread";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { formatDateTime, formatMoney, formatMs } from "@/lib/format";
import { mcpServerLabel } from "@/lib/mcp-label";
import {
  clarificationRoundKey,
  describeRunModel,
  isAwaitingInput,
  isEvaluationInFlight,
  runProgressSchema,
  runWorkingMs,
  TERMINAL_RUN_STATUSES,
  type Run,
  type RunProgress,
  type RunStep,
} from "@/lib/schema";

const POLL_INTERVAL_MS = 1000;

function isTerminal(run: Run): boolean {
  return TERMINAL_RUN_STATUSES.includes(run.status);
}

/** Grace window for the evaluation row to appear after the run goes terminal. */
const EVALUATION_HANDOFF_MS = 120_000;

/**
 * The run is over but its verdict is not in yet, either because the evaluation
 * is running or because its row has not been written in the moment after the
 * run finished. Either way the view should keep polling.
 */
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

/** The step the run broke on: the reported error, else the last tool that errored. */
export function findFailingStep(steps: RunStep[]): RunStep | null {
  for (let i = steps.length - 1; i >= 0; i -= 1) {
    const step = steps[i];
    if (step.kind === "error" || step.toolIsError) return step;
  }
  return null;
}

export function RunDetail({
  initialProgress,
  /** Set when another run is in flight, so a follow-up is refused for the same
   * reason the composer on the home page refuses a new run. */
  busyReason = null,
}: {
  initialProgress: RunProgress;
  busyReason?: string | null;
}) {
  const router = useRouter();
  const [progress, setProgress] = useState(initialProgress);
  const warnedRef = useRef(false);
  const settledRef = useRef(false);
  const runId = initialProgress.run.id;
  // Set when the user asks for a re-check, so polling restarts before the
  // first poll has seen the new evaluation row.
  const [recheckRequested, setRecheckRequested] = useState(false);
  const active =
    !isTerminal(progress.run) || awaitingVerdict(progress.run) || recheckRequested;

  // The heading's "used this server" badges are rendered in the server shell
  // above us, so the first call to a server has to nudge it to re-render.
  const usedKey = progress.mcpServersUsed.join(",");
  const usedRef = useRef(usedKey);
  useEffect(() => {
    if (usedRef.current === usedKey) return;
    usedRef.current = usedKey;
    router.refresh();
  }, [usedKey, router]);

  // Poll while the run is moving and while its verdict is still being decided;
  // the interval tears itself down once both have settled.
  useEffect(() => {
    if (!active) return;
    let cancelled = false;
    const timer = setInterval(async () => {
      try {
        const next = await fetchProgress(runId);
        if (cancelled) return;
        warnedRef.current = false;
        setProgress(next);

        if (isEvaluationInFlight(next.run.evaluation)) {
          settledRef.current = false;
          setRecheckRequested(false);
        } else if (isTerminal(next.run)) {
          if (next.run.evaluation !== null) setRecheckRequested(false);
          // Keep the server-rendered shell (and the run list) in step, once.
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

  const { run } = progress;
  const failingStep = run.status === "failed" ? findFailingStep(progress.steps) : null;

  return (
    <div className="flex flex-col gap-6">
      {run.status === "failed" && <FailurePanel run={run} failingStep={failingStep} />}

      {/* Sits above the run's own detail while it is paused: the questions are
          the only thing the user can act on, and the poll below clears the card
          the moment the answers land and the run moves off awaiting_input. */}
      {run.status === "awaiting_input" && isAwaitingInput(run.clarification.state) && (
        <RunClarification
          // One card per round of questions: a run that asks again gets an
          // empty field and the focus back, not the last answer still sitting
          // in it. See `clarificationRoundKey`.
          key={clarificationRoundKey(run.clarification)}
          runId={run.id}
          clarification={run.clarification}
          onResumed={() => router.refresh()}
        />
      )}

      <section className="grid gap-4 sm:grid-cols-4">
        <SummaryStat label="Started" value={formatDateTime(run.createdAt)} />
        {/* Time the agent spent working, summed over the turns — not the wall
            clock from the first turn to the last, which would count the time
            the run sat finished waiting for the user's next instruction. */}
        <SummaryStat label="Working time" value={formatMs(runWorkingMs(run))} />
        <SummaryStat label="Cost" value={formatMoney(run.costUsd)} />
        <SummaryStat
          label={progress.turns.length > 1 ? "Turns in this conversation" : "Turns"}
          value={
            progress.turns.length > 1
              ? String(progress.turns.length)
              : run.numTurns === null
                ? "—"
                : String(run.numTurns)
          }
        />
      </section>

      {/* The conversation leads now, and takes the wider column: the play-by-play
          beside it is supporting evidence for whichever turn is current. */}
      <div className="grid gap-6 lg:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
        <div className="flex flex-col gap-4">
          {/* The conversation in full: every instruction, every reply, oldest
              first, in its own scroll box. */}
          <Panel title={progress.turns.length > 1 ? "Conversation" : "Instructions and result"}>
            <RunThread
              progress={progress}
              failingStepSeq={failingStep?.seq ?? null}
              // The current turn's steps are already beside this, in full.
              currentTurnSteps={false}
              heightClass="max-h-[44rem]"
            />
          </Panel>

          {/* Reads in the order the work happened: what was asked, what came
              back, and the box that takes it further. */}
          <RunFollowUp run={run} busyReason={busyReason} />

          <RunEvaluation run={run} onRecheck={() => setRecheckRequested(true)} />

          <Panel title="Output files">
            <ArtifactLinks
              artifacts={run.artifacts}
              emptyLabel={
                !isTerminal(run)
                  ? "Nothing written yet."
                  : "No files — the agent only writes one when the task asks for it. The answer is in the result above."
              }
            />
          </Panel>
        </div>

        <RunSteps progress={progress} failingStepSeq={failingStep?.seq ?? null} />
      </div>
    </div>
  );
}

/**
 * Sits above everything else on a failed run: what broke, where, and the raw
 * message in full. Long messages and stack traces wrap and scroll rather than
 * being cut off.
 */
export function FailurePanel({ run, failingStep }: { run: Run; failingStep: RunStep | null }) {
  const message = run.error?.trim() ?? "";

  return (
    <section className="flex flex-col gap-3 rounded-xl border border-destructive/40 bg-destructive/5 p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex items-start gap-2">
          <TriangleAlert className="mt-0.5 size-4 shrink-0 text-destructive" />
          <div className="flex flex-col gap-1">
            <p className="text-sm font-semibold text-destructive">This run failed</p>
            <p className="text-sm text-muted-foreground">
              {failingStep
                ? <>It broke at: <span className="text-foreground">{failingStep.title}</span></>
                : "The agent stopped before it could finish."}
            </p>
          </div>
        </div>
        {message && <CopyErrorButton text={message} />}
      </div>

      {message ? (
        <pre className="max-h-64 overflow-auto rounded-lg border bg-card p-3 font-mono text-xs leading-relaxed whitespace-pre-wrap break-words text-destructive select-text">
          {message}
        </pre>
      ) : (
        <p className="text-sm text-muted-foreground">
          No error details were recorded for this run.
        </p>
      )}

      {failingStep?.toolResult && (
        <details className="rounded-lg border bg-card p-3">
          <summary className="cursor-pointer text-xs font-medium text-muted-foreground">
            Output of the failing step
          </summary>
          <pre className="mt-2 max-h-64 overflow-auto font-mono text-xs leading-relaxed whitespace-pre-wrap break-words">
            {failingStep.toolResult}
          </pre>
        </details>
      )}
    </section>
  );
}

function CopyErrorButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);

  async function copy() {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      toast.error("Could not copy to the clipboard");
    }
  }

  return (
    <Button type="button" variant="outline" size="sm" onClick={copy}>
      {copied ? <Check /> : <Copy />}
      {copied ? "Copied" : "Copy error"}
    </Button>
  );
}

export function RunHeading({
  run,
  mcpServersUsed = [],
}: {
  run: Run;
  /** Servers the run actually called. Attached-but-untouched earns no badge. */
  mcpServersUsed?: string[];
}) {
  return (
    <div className="flex flex-wrap items-center gap-2">
      {/* Two different questions: did it run, and did it deliver. */}
      <RunStatusBadge status={run.status} />
      <EvaluationBadge evaluation={run.evaluation} />
      {/* What it ran on, not what was asked for: on an Auto run those differ,
          and the resolved model is the useful fact. */}
      <RunModelBadge run={run} />
      {run.reasoning && (
        <Badge variant="secondary" title="Extended thinking was enabled for this run">
          <Brain />
          Reasoning
        </Badge>
      )}
      {mcpServersUsed.map((key) => (
        <Badge
          key={key}
          variant="mcp"
          className="font-semibold"
          title="This run called this server"
        >
          {mcpServerLabel(key, run.mcpServers)}
        </Badge>
      ))}
      <span className="font-mono text-xs text-muted-foreground">{run.id.slice(0, 8)}</span>
    </div>
  );
}

/** Same formatter as the runs table, so the two can never disagree. */
function RunModelBadge({ run }: { run: Run }) {
  const model = describeRunModel(run);
  if (model.state === "none") return null;

  if (model.state === "pending") {
    return (
      <Badge variant="secondary" title="Auto has not chosen a model for this run yet">
        Auto…
      </Badge>
    );
  }

  if (model.state === "unversioned") {
    return (
      <Badge
        variant="secondary"
        title={`${model.name} — the exact version this run used was not recorded`}
      >
        {model.name}
        <span className="font-normal opacity-70">version not recorded</span>
      </Badge>
    );
  }

  return (
    <Badge variant="secondary" title={model.apiId}>
      {model.name}
      {model.auto && <span className="font-normal opacity-70">Auto</span>}
    </Badge>
  );
}

function SummaryStat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-xl border bg-card p-4">
      <p className="text-sm text-muted-foreground">{label}</p>
      <p className="text-lg font-semibold tabular-nums">{value}</p>
    </div>
  );
}

function Panel({
  title,
  action,
  children,
}: {
  title: string;
  /** Control for the panel's own content, kept level with the title. */
  action?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="flex flex-col gap-2 rounded-lg border bg-muted/40 p-4">
      <div className="flex items-center justify-between gap-2">
        <p className="text-xs font-medium text-muted-foreground">{title}</p>
        {action}
      </div>
      {children}
    </section>
  );
}
