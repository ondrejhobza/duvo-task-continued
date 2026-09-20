"use client";

import { useEffect, useRef, useState } from "react";
import {
  AlertCircle,
  Brain,
  CheckCircle2,
  ChevronRight,
  FilePen,
  Globe,
  ListChecks,
  MessageSquareText,
  Plug,
  Power,
  Search,
  Sparkles,
  Wrench,
  XCircle,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { mcpServerLabel } from "@/lib/mcp-label";
import { cn } from "@/lib/utils";
import { PHASE_LABEL, type RunPhase, type RunProgress, type RunStep } from "@/lib/schema";

const ACTIVE_PHASES: readonly RunPhase[] = [
  "queued",
  "starting",
  "thinking",
  "searching",
  "reading",
  "writing",
  "using_mcp",
  "summarising",
  // The run is winding down but has not landed yet; the clock is still running.
  "stopping",
];

function formatClock(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${String(s).padStart(2, "0")}`;
}

function StepIcon({ step, className }: { step: RunStep; className?: string }) {
  if (step.mcpServer) return <Plug className={className} />;
  switch (step.kind) {
    case "init":
      return <Power className={className} />;
    case "routing":
      return <Sparkles className={className} />;
    case "thinking":
      return <Brain className={className} />;
    case "text":
      return <MessageSquareText className={className} />;
    case "result":
      return <CheckCircle2 className={className} />;
    case "notice":
      return <AlertCircle className={className} />;
    case "error":
      return <XCircle className={className} />;
    case "tool":
      switch (step.toolName) {
        case "WebSearch":
          return <Search className={className} />;
        case "WebFetch":
          return <Globe className={className} />;
        case "Write":
        case "Edit":
          return <FilePen className={className} />;
        default:
          return <Wrench className={className} />;
      }
  }
}

function phaseVariant(phase: RunPhase): "default" | "secondary" | "destructive" | "outline" {
  if (phase === "done") return "default";
  if (phase === "failed") return "destructive";
  // Stopped is not an error: the user asked for it.
  if (phase === "queued" || phase === "cancelled") return "outline";
  return "secondary";
}

/** Live elapsed time while the run is active, frozen afterwards. */
function useElapsed(startedAt: string | null, finishedAt: string | null, active: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [active]);
  if (!startedAt) return 0;
  const end = finishedAt ? new Date(finishedAt).getTime() : now;
  return end - new Date(startedAt).getTime();
}

export function RunSteps({
  progress,
  failingStepSeq = null,
}: {
  progress: RunProgress | null;
  /** Seq of the step a failed run broke on; it is flagged and opened by default. */
  failingStepSeq?: number | null;
}) {
  const listRef = useRef<HTMLOListElement>(null);
  const active = progress ? ACTIVE_PHASES.includes(progress.phase) : false;
  const elapsed = useElapsed(
    progress?.run.startedAt ?? null,
    progress?.run.finishedAt ?? null,
    active,
  );
  const stepCount = progress?.steps.length ?? 0;

  useEffect(() => {
    if (!active) return;
    listRef.current?.lastElementChild?.scrollIntoView({ block: "nearest" });
  }, [stepCount, active]);

  if (!progress) {
    return (
      <div className="flex h-full min-h-48 flex-col items-center justify-center gap-2 rounded-lg border bg-muted/40 p-6 text-center">
        <ListChecks className="size-5 text-muted-foreground" />
        <p className="text-sm font-medium">No run selected</p>
        <p className="text-sm text-muted-foreground">
          Start a run or pick one from the list to watch it step by step.
        </p>
      </div>
    );
  }

  const { phase, steps, filesWritten } = progress;

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-col gap-2 rounded-lg border bg-muted/40 p-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <Badge variant={phaseVariant(phase)}>
              {active && <span className="size-2 animate-pulse rounded-full bg-current" />}
              {PHASE_LABEL[phase]}
            </Badge>
            {progress.run.model && (
              <span className="font-mono text-xs text-muted-foreground">{progress.run.model}</span>
            )}
          </div>
          <p className="text-xs text-muted-foreground tabular-nums">
            {formatClock(elapsed)} · {steps.length} step{steps.length === 1 ? "" : "s"}
            {filesWritten.length > 0 &&
              ` · ${filesWritten.length} file${filesWritten.length === 1 ? "" : "s"} written`}
          </p>
        </div>
        {filesWritten.length > 0 && (
          <p className="truncate font-mono text-xs text-muted-foreground" title={filesWritten.join(", ")}>
            {filesWritten.join(", ")}
          </p>
        )}
      </div>

      {steps.length === 0 ? (
        <p className="p-3 text-sm text-muted-foreground">
          {active ? "Waiting for the agent's first step…" : "This run produced no steps."}
        </p>
      ) : (
        <StepList
          ref={listRef}
          steps={steps}
          attachedServers={progress.run.mcpServers}
          active={active}
          failingStepSeq={failingStepSeq}
        />
      )}
    </div>
  );
}

/**
 * The play-by-play on its own, without the header. Shared with the history
 * thread, which renders one of these per turn: the steps of a run should look
 * and behave the same wherever they are read back.
 */
export function StepList({
  ref,
  steps,
  attachedServers,
  active,
  failingStepSeq = null,
}: {
  ref?: React.Ref<HTMLOListElement>;
  steps: readonly RunStep[];
  /** Server names as of this run, for turning a tool's server key into a label. */
  attachedServers: readonly string[];
  /** The steps are still arriving: the last one pulses and the clock runs. */
  active: boolean;
  failingStepSeq?: number | null;
}) {
  return (
    <ol ref={ref} className="flex max-h-[32rem] flex-col gap-1 overflow-y-auto pr-1">
      {steps.map((step, index) => (
        <StepItem
          key={step.seq + ":" + index}
          step={step}
          attachedServers={attachedServers}
          isLast={index === steps.length - 1 && active}
          failed={step.seq === failingStepSeq}
        />
      ))}
    </ol>
  );
}

function StepItem({
  step,
  attachedServers,
  isLast,
  failed,
}: {
  step: RunStep;
  /** Server names as of this run, for turning a tool's server key into a label. */
  attachedServers: readonly string[];
  isLast: boolean;
  failed: boolean;
}) {
  const hasDetail = Boolean(step.detail || step.toolResult);
  const tone =
    step.kind === "error" || step.kind === "notice" || step.toolIsError
      ? "text-destructive"
      : step.kind === "result"
        ? "text-foreground"
        : "text-muted-foreground";

  return (
    <li>
      <Collapsible disabled={!hasDetail} defaultOpen={failed && hasDetail}>
        <CollapsibleTrigger
          className={cn(
            "group flex w-full items-start gap-2 rounded-lg px-2 py-1.5 text-left text-sm hover:bg-muted/60 disabled:cursor-default disabled:hover:bg-transparent",
            isLast && "bg-muted/40",
            failed && "bg-destructive/10 hover:bg-destructive/15",
          )}
        >
          <StepIcon
            step={step}
            className={cn(
              "mt-0.5 size-4 shrink-0",
              tone,
              isLast &&
                step.kind !== "result" &&
                step.kind !== "error" &&
                step.kind !== "notice" &&
                "animate-pulse",
            )}
          />
          <span className="flex min-w-0 flex-1 flex-col gap-0.5">
            <span className="flex flex-wrap items-center gap-1.5">
              {failed && (
                <Badge variant="destructive" className="font-semibold uppercase tracking-wide">
                  Failed here
                </Badge>
              )}
              {step.mcpServer && (
                <Badge variant="mcp" className="font-semibold">
                  {mcpServerLabel(step.mcpServer, attachedServers)}
                </Badge>
              )}
              <span className={cn("break-words", step.kind === "thinking" && "italic")}>{step.title}</span>
            </span>
            {step.toolIsError && (
              <span className="flex items-center gap-1 text-xs text-destructive">
                <AlertCircle className="size-3" /> The tool returned an error
              </span>
            )}
          </span>
          <span className="ml-auto flex shrink-0 items-center gap-1 text-xs text-muted-foreground tabular-nums">
            {formatClock(step.atMs)}
            {hasDetail && (
              <ChevronRight className="size-3.5 transition-transform group-data-[panel-open]:rotate-90" />
            )}
          </span>
        </CollapsibleTrigger>
        {hasDetail && (
          <CollapsibleContent>
            <div className="mb-1 flex flex-col gap-2 rounded-lg border bg-muted/40 p-3">
              {step.detail && (
                <DetailBlock
                  label={step.kind === "tool" ? "Input" : step.kind === "thinking" ? "Reasoning" : "Text"}
                  text={step.detail}
                  mono={step.kind === "tool"}
                />
              )}
              {step.toolResult && (
                <DetailBlock
                  label={step.toolIsError ? "Error" : "Result"}
                  text={step.toolResult}
                  mono
                />
              )}
            </div>
          </CollapsibleContent>
        )}
      </Collapsible>
    </li>
  );
}

function DetailBlock({ label, text, mono }: { label: string; text: string; mono?: boolean }) {
  return (
    <div className="flex flex-col gap-1">
      <p className="text-xs font-medium text-muted-foreground">{label}</p>
      <pre
        className={cn(
          "max-h-64 overflow-auto whitespace-pre-wrap break-words text-xs leading-relaxed",
          mono ? "font-mono" : "font-sans",
        )}
      >
        {text}
      </pre>
    </div>
  );
}
