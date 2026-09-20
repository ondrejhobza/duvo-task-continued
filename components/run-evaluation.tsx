"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import {
  Check,
  ChevronRight,
  CircleSlash2,
  Gavel,
  Loader2,
  RotateCw,
  X,
} from "lucide-react";
import { toast } from "sonner";
import { EvaluationBadge } from "@/components/evaluation-badge";
import { Button } from "@/components/ui/button";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";
import {
  VERDICT_LABEL,
  type Evaluation,
  type RequirementCheck,
  type Run,
} from "@/lib/schema";

type HumanVerdict = "pass" | "partial" | "fail";

const MET_ICON: Record<RequirementCheck["met"], typeof Check> = {
  yes: Check,
  partly: CircleSlash2,
  no: X,
};

async function readError(response: Response, fallback: string): Promise<string> {
  try {
    const body: unknown = await response.json();
    if (body && typeof body === "object" && "error" in body) {
      const message = (body as { error: unknown }).error;
      if (typeof message === "string") return message;
    }
  } catch {
    // Fall through to the generic message.
  }
  return fallback;
}

export function RunEvaluation({
  run,
  onRecheck,
}: {
  run: Run;
  /** Lets the detail view resume polling before the new row is visible. */
  onRecheck?: () => void;
}) {
  const router = useRouter();
  const evaluation = run.evaluation;
  const [rerunning, setRerunning] = useState(false);
  const [overrideOpen, setOverrideOpen] = useState(false);

  const runFinished = run.status === "succeeded" || run.status === "failed";
  const inFlight =
    evaluation?.status === "pending" || evaluation?.status === "running";

  async function startEvaluation() {
    setRerunning(true);
    try {
      const response = await fetch(`/api/runs/${run.id}/evaluate`, { method: "POST" });
      if (!response.ok) {
        toast.error(await readError(response, "Could not start the evaluation."));
        return;
      }
      // The judge runs in the background; the detail view polls for the result.
      onRecheck?.();
      router.refresh();
    } catch {
      toast.error("Could not reach the server.");
    } finally {
      setRerunning(false);
    }
  }

  return (
    <section className="flex flex-col gap-3 rounded-lg border bg-muted/40 p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <p className="text-xs font-medium text-muted-foreground">Did it do what you asked?</p>
          <EvaluationBadge evaluation={evaluation} />
        </div>
        <div className="flex items-center gap-1">
          {evaluation?.status === "done" && (
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setOverrideOpen(true)}
              disabled={rerunning}
            >
              <Gavel />
              I disagree
            </Button>
          )}
          {runFinished && (
            <Button
              variant="outline"
              size="sm"
              onClick={startEvaluation}
              disabled={rerunning || inFlight}
            >
              {rerunning ? <Loader2 className="animate-spin" /> : <RotateCw />}
              {evaluation ? "Re-check" : "Check this run"}
            </Button>
          )}
        </div>
      </div>

      <EvaluationBody evaluation={evaluation} runFinished={runFinished} />

      <OverrideDialog
        open={overrideOpen}
        onOpenChange={setOverrideOpen}
        runId={run.id}
        current={evaluation?.humanVerdict ?? null}
      />
    </section>
  );
}

function EvaluationBody({
  evaluation,
  runFinished,
}: {
  evaluation: Evaluation | null;
  runFinished: boolean;
}) {
  if (!evaluation) {
    return (
      <p className="text-sm text-muted-foreground">
        {runFinished
          ? "This run has not been checked against your request yet."
          : "The check runs automatically once the run finishes."}
      </p>
    );
  }

  if (evaluation.status === "pending" || evaluation.status === "running") {
    return (
      <p className="text-sm text-muted-foreground">
        Comparing what the run produced with what you asked for…
      </p>
    );
  }

  if (evaluation.status === "not_evaluable") {
    return (
      <div className="flex flex-col gap-2">
        <p className="text-sm text-muted-foreground">
          The run did not finish, so there is no output to compare with your request. This is
          separate from the verdict: the run failed, rather than doing the wrong thing.
        </p>
        <GateChecks checks={evaluation.gateChecks} />
      </div>
    );
  }

  if (evaluation.status === "unavailable") {
    return (
      <div className="flex flex-col gap-2">
        <p className="text-sm text-muted-foreground">
          The check could not be completed, so this run has no verdict. The run itself is
          unaffected — use Re-check to try again.
        </p>
        {evaluation.judgeError && (
          <p className="rounded-lg border bg-card p-3 font-mono text-xs break-words text-muted-foreground">
            {evaluation.judgeError}
          </p>
        )}
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-3">
      {evaluation.humanVerdict && (
        <p className="text-sm">
          <span className="text-muted-foreground">Your verdict: </span>
          {VERDICT_LABEL[evaluation.humanVerdict]}
          {evaluation.humanNote ? ` — ${evaluation.humanNote}` : ""}
        </p>
      )}

      {evaluation.judgeRationale && (
        <p className="text-sm leading-relaxed">{evaluation.judgeRationale}</p>
      )}

      {evaluation.judgeRequirements.length > 0 && (
        <ul className="flex flex-col gap-1.5">
          {evaluation.judgeRequirements.map((requirement, index) => (
            <RequirementRow key={`${index}-${requirement.requirement}`} requirement={requirement} />
          ))}
        </ul>
      )}

      <GateChecks checks={evaluation.gateChecks} />

      <p className="text-xs text-muted-foreground tabular-nums">
        {[
          evaluation.judgeConfidence === null
            ? null
            : `${evaluation.judgeConfidence}% confidence`,
          evaluation.artifactName ? `judged on ${evaluation.artifactName}` : "judged on the reply",
          evaluation.judgeModel,
        ]
          .filter(Boolean)
          .join(" · ")}
      </p>
    </div>
  );
}

function RequirementRow({ requirement }: { requirement: RequirementCheck }) {
  const Icon = MET_ICON[requirement.met];
  return (
    <li className="flex items-start gap-2 text-sm">
      <Icon
        className={cn(
          "mt-0.5 size-4 shrink-0",
          requirement.met === "yes" ? "text-foreground" : "text-muted-foreground",
        )}
      />
      <span className="flex flex-col gap-0.5">
        <span className={cn(requirement.met === "no" && "text-muted-foreground line-through")}>
          {requirement.requirement}
        </span>
        {requirement.evidence && (
          <span className="text-xs text-muted-foreground">{requirement.evidence}</span>
        )}
      </span>
    </li>
  );
}

function GateChecks({ checks }: { checks: Evaluation["gateChecks"] }) {
  if (checks.length === 0) return null;
  const failed = checks.filter((c) => !c.passed).length;

  return (
    <Collapsible defaultOpen={failed > 0}>
      <CollapsibleTrigger className="group flex items-center gap-1.5 text-xs font-medium text-muted-foreground hover:text-foreground">
        <ChevronRight className="size-3.5 transition-transform group-data-[panel-open]:rotate-90" />
        {failed > 0
          ? `${failed} of ${checks.length} automatic checks failed`
          : `${checks.length} automatic checks passed`}
      </CollapsibleTrigger>
      <CollapsibleContent>
        <ul className="mt-1.5 flex flex-col gap-1 rounded-lg border bg-card p-3">
          {checks.map((check) => (
            <li key={check.label} className="flex items-start gap-2 text-xs">
              {check.passed ? (
                <Check className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" />
              ) : (
                <X className="mt-0.5 size-3.5 shrink-0 text-destructive" />
              )}
              <span>
                <span className="font-medium">{check.label}</span>
                <span className="text-muted-foreground"> — {check.detail}</span>
              </span>
            </li>
          ))}
        </ul>
      </CollapsibleContent>
    </Collapsible>
  );
}

function OverrideDialog({
  open,
  onOpenChange,
  runId,
  current,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  runId: string;
  current: Evaluation["humanVerdict"];
}) {
  const router = useRouter();
  const [verdict, setVerdict] = useState<HumanVerdict>(
    current === "pass" || current === "partial" || current === "fail" ? current : "fail",
  );
  const [note, setNote] = useState("");
  const [pending, startTransition] = useTransition();
  const [saving, setSaving] = useState(false);

  const noteRequired = verdict !== "pass";
  const canSave = !saving && (!noteRequired || note.trim().length > 0);

  async function save() {
    setSaving(true);
    try {
      const response = await fetch(`/api/runs/${runId}/evaluate`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ verdict, note: note.trim() }),
      });
      if (!response.ok) {
        toast.error(await readError(response, "Could not save your verdict."));
        return;
      }
      onOpenChange(false);
      setNote("");
      startTransition(() => router.refresh());
    } catch {
      toast.error("Could not reach the server.");
    } finally {
      setSaving(false);
    }
  }

  async function withdraw() {
    setSaving(true);
    try {
      const response = await fetch(`/api/runs/${runId}/evaluate`, { method: "DELETE" });
      if (!response.ok) {
        toast.error(await readError(response, "Could not withdraw your verdict."));
        return;
      }
      onOpenChange(false);
      setNote("");
      startTransition(() => router.refresh());
    } catch {
      toast.error("Could not reach the server.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Record your own verdict</DialogTitle>
          <DialogDescription>
            Your verdict replaces the automatic one everywhere, including the pass rate.
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-3">
          <div className="flex flex-col gap-1.5">
            <Label>Did the run do what you asked?</Label>
            <div className="flex flex-wrap gap-1.5">
              {(["pass", "partial", "fail"] as const).map((value) => (
                <Button
                  key={value}
                  type="button"
                  size="sm"
                  variant={verdict === value ? "default" : "outline"}
                  onClick={() => setVerdict(value)}
                >
                  {VERDICT_LABEL[value]}
                </Button>
              ))}
            </div>
          </div>

          <div className="flex flex-col gap-1.5">
            <Label htmlFor="verdict-note">
              {noteRequired ? "What did it miss?" : "Note (optional)"}
            </Label>
            <Textarea
              id="verdict-note"
              value={note}
              onChange={(event) => setNote(event.target.value)}
              placeholder={
                noteRequired
                  ? "Name the part of your request that went unmet."
                  : "Anything worth remembering about this run."
              }
              rows={3}
              maxLength={500}
            />
            {noteRequired && note.trim().length === 0 && (
              <p className="text-xs text-muted-foreground">
                A reason is required when the run did not fully do what you asked.
              </p>
            )}
          </div>
        </div>

        <DialogFooter className="sm:justify-between">
          {current ? (
            <Button variant="ghost" onClick={withdraw} disabled={saving}>
              Withdraw my verdict
            </Button>
          ) : (
            <span />
          )}
          <div className="flex flex-col-reverse gap-2 sm:flex-row">
            <Button variant="outline" onClick={() => onOpenChange(false)} disabled={saving}>
              Cancel
            </Button>
            <Button onClick={save} disabled={!canSave}>
              {(saving || pending) && <Loader2 className="animate-spin" />}
              Save verdict
            </Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}