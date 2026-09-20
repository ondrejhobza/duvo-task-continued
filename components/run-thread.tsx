"use client";

import { useEffect, useLayoutEffect, useRef, type ReactNode } from "react";
import { Brain, ChevronRight, ListChecks } from "lucide-react";
import { CopyButton } from "@/components/copy-button";
import { Markdown } from "@/components/markdown";
import { StepList } from "@/components/run-steps";
import { Badge } from "@/components/ui/badge";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { formatMoney } from "@/lib/format";
import { cn } from "@/lib/utils";
import { isTerminalRunStatus, type RunStep, type RunTurnProgress, type RunProgress } from "@/lib/schema";

/** Below this many pixels from the bottom, the user counts as "at the bottom". */
const STICK_THRESHOLD_PX = 48;

/** The reply so far: the finished one, else the last thing the agent said. */
function turnOutput(turn: RunTurnProgress): string | null {
  if (turn.resultText) return turn.resultText;
  for (let i = turn.steps.length - 1; i >= 0; i -= 1) {
    const step = turn.steps[i];
    if (step.kind === "text" && step.detail) return step.detail;
  }
  return null;
}

/**
 * The run as a conversation: every instruction the user gave, what the agent
 * did about each, and the reply it came back with — oldest first, in one
 * scrollable thread.
 *
 * It scrolls itself rather than the page. A ten-turn run would otherwise run to
 * several screens, pushing the follow-up box and the files below it out of
 * reach, and the newest content is what the user wants to land on.
 */
export function RunThread({
  progress,
  failingStepSeq = null,
  /**
   * Set where the current turn's steps are already on screen beside the
   * thread, so the same list is not offered twice.
   */
  currentTurnSteps = true,
  /** Opens the current turn's steps on arrival; used when the agent is stuck. */
  openCurrentSteps = false,
  /** Room to breathe where the thread is the main event, as on the run page. */
  heightClass = "max-h-[32rem]",
}: {
  progress: RunProgress;
  failingStepSeq?: number | null;
  currentTurnSteps?: boolean;
  openCurrentSteps?: boolean;
  heightClass?: string;
}) {
  const { run, turns } = progress;
  const scrollRef = useRef<HTMLDivElement>(null);
  // Whether the view should follow new content. True until the user scrolls up
  // to read something, false from then until they come back to the bottom:
  // yanking the thread away mid-sentence is the one thing a history view must
  // never do.
  const stickToBottom = useRef(true);

  // Land on the newest content, including after a reload part-way through a
  // turn: the thread is read from the bottom.
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, []);

  // Anything that makes the thread taller: a new step, a longer reply, a new
  // turn. Cheap enough to recompute, and it catches all three.
  const contentKey = turns.map((turn) => `${turn.seq}:${turn.steps.length}:${(turn.resultText ?? "").length}`).join("|");

  useEffect(() => {
    const el = scrollRef.current;
    if (!el || !stickToBottom.current) return;
    el.scrollTop = el.scrollHeight;
  }, [contentKey]);

  function handleScroll() {
    const el = scrollRef.current;
    if (!el) return;
    stickToBottom.current =
      el.scrollHeight - el.scrollTop - el.clientHeight <= STICK_THRESHOLD_PX;
  }

  const multi = turns.length > 1;

  return (
    <div
      ref={scrollRef}
      onScroll={handleScroll}
      className={cn("flex flex-col gap-4 overflow-y-auto", heightClass)}
    >
      {turns.map((turn, index) => (
        <TurnBlock
          key={turn.seq}
          turn={turn}
          numbered={multi ? { index: index + 1, total: turns.length } : null}
          isCurrent={index === turns.length - 1}
          reasoning={run.reasoning}
          showSteps={index < turns.length - 1 || currentTurnSteps}
          openSteps={index === turns.length - 1 && openCurrentSteps}
          failingStepSeq={failingStepSeq}
          attachedServers={run.mcpServers}
        />
      ))}
    </div>
  );
}

function TurnBlock({
  turn,
  numbered,
  isCurrent,
  reasoning,
  showSteps,
  openSteps,
  failingStepSeq,
  attachedServers,
}: {
  turn: RunTurnProgress;
  /** Only on a run with more than one turn; "Turn 1 of 1" is noise. */
  numbered: { index: number; total: number } | null;
  isCurrent: boolean;
  reasoning: boolean;
  showSteps: boolean;
  openSteps: boolean;
  failingStepSeq: number | null;
  attachedServers: readonly string[];
}) {
  const settled = isTerminalRunStatus(turn.status);
  const output = turnOutput(turn);
  const activity = turn.steps.at(-1)?.title ?? null;
  const working = isCurrent && !settled && activity !== null;
  const thinking = turn.steps.filter((step) => step.kind === "thinking");

  return (
    <section className="flex flex-col gap-3">
      <div className="flex flex-col gap-2 rounded-lg border bg-muted/40 p-4">
        <div className="flex flex-wrap items-center gap-2">
          <p className="text-xs font-medium text-muted-foreground">You asked</p>
          {numbered && (
            <Badge variant="outline" className="tabular-nums">
              Turn {numbered.index} of {numbered.total}
            </Badge>
          )}
          {/* Only where the turn did not simply succeed: a thread of green
              badges says nothing, a stopped turn in the middle says a lot. */}
          {turn.status === "failed" && <Badge variant="destructive">Failed</Badge>}
          {turn.status === "cancelled" && <Badge variant="outline">You stopped this</Badge>}
          {turn.continuation === "seeded" && (
            <Badge
              variant="secondary"
              title="The earlier session could not be reopened, so the agent worked from a written summary of it rather than remembering it"
            >
              From a summary
            </Badge>
          )}
        </div>
        <p className="text-sm leading-relaxed whitespace-pre-wrap">{turn.prompt}</p>
      </div>

      <div className="flex min-w-0 flex-col gap-2 px-1">
        {(working || output) && (
          <div className="flex items-start gap-2">
            {working && (
              <p className="flex min-w-0 items-center gap-2 text-sm text-muted-foreground">
                <span className="size-1.5 shrink-0 animate-pulse rounded-full bg-current" />
                <span className="truncate">{activity}</span>
              </p>
            )}
            {/* Per turn, so copying the third answer does not hand over the
                first. Copies the markdown source of what is on screen now. */}
            {output && (
              <span className="ml-auto">
                <CopyButton value={output} label="Copy this reply as markdown" />
              </span>
            )}
          </div>
        )}

        {output ? (
          <Markdown>{output}</Markdown>
        ) : (
          <p className="text-sm text-muted-foreground">
            {turn.status === "cancelled"
              ? "Stopped before it wrote a reply."
              : turn.status === "failed"
                ? turn.error
                  ? "It failed before writing a reply; the error is above."
                  : "It failed before writing a reply."
                : settled
                  ? "The agent finished without writing a summary."
                  : "Nothing written yet — the agent is still working."}
          </p>
        )}

        {reasoning && <ReasoningBlock steps={thinking} settled={settled} />}

        {showSteps && turn.steps.length > 0 && (
          <Collapsible defaultOpen={openSteps}>
            <CollapsibleTrigger className="group flex w-full items-center gap-2 rounded-lg px-1 py-1.5 text-left text-sm text-muted-foreground hover:bg-muted/60">
              <ListChecks className="size-4" />
              {isCurrent ? "Every step" : "Steps from this turn"}
              <span className="tabular-nums">({turn.steps.length})</span>
              {turn.costUsd !== null && (
                <span className="tabular-nums">· {formatMoney(turn.costUsd)}</span>
              )}
              <ChevronRight className="ml-auto size-3.5 transition-transform group-data-[panel-open]:rotate-90" />
            </CollapsibleTrigger>
            <CollapsibleContent>
              <div className="pt-2">
                <StepList
                  steps={turn.steps}
                  attachedServers={attachedServers}
                  active={isCurrent && !settled}
                  failingStepSeq={failingStepSeq}
                />
              </div>
            </CollapsibleContent>
          </Collapsible>
        )}
      </div>
    </section>
  );
}

/**
 * Extended thinking, folded away. It is long, repetitive and not the answer;
 * one line says whether there is any, and opening it shows the lot.
 */
function ReasoningBlock({ steps, settled }: { steps: RunStep[]; settled: boolean }): ReactNode {
  if (steps.length === 0) {
    // Reasoning was switched on but the model volunteered none. Say so once the
    // turn is over; while it runs, there may still be some coming.
    if (!settled) return null;
    return (
      <p className="flex items-center gap-2 px-1 text-sm text-muted-foreground">
        <Brain className="size-4" />
        The model returned no reasoning for this turn.
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
