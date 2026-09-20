import {
  CircleDashed,
  CircleHelp,
  CircleSlash2,
  Loader2,
  Minus,
  Target,
  ThumbsDown,
  TriangleAlert,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { effectiveVerdict, type Evaluation } from "@/lib/schema";

/**
 * Answers "did the run do what was asked", which is a different question from
 * the run's own status. The wording stays in the user's terms on purpose, so
 * this badge can never be mistaken for the succeeded/failed one beside it.
 */

type BadgeVariant = "default" | "secondary" | "destructive" | "outline";

export interface EvaluationPresentation {
  label: string;
  /** Terser wording for table cells, where the column header supplies context. */
  shortLabel: string;
  variant: BadgeVariant;
  Icon: typeof Target;
  spin: boolean;
  hint: string;
}

const NOT_EVALUATED: EvaluationPresentation = {
  label: "Not evaluated",
  shortLabel: "Not evaluated",
  variant: "outline",
  Icon: CircleDashed,
  spin: false,
  hint: "No one has checked whether this run did what was asked.",
};

export function evaluationPresentation(
  evaluation: Evaluation | null,
): EvaluationPresentation {
  if (!evaluation) return NOT_EVALUATED;

  if (evaluation.status === "pending" || evaluation.status === "running") {
    return {
      label: "Checking…",
      shortLabel: "Checking…",
      variant: "secondary",
      Icon: Loader2,
      spin: true,
      hint: "Reading what the run produced and comparing it with the request.",
    };
  }

  if (evaluation.status === "unavailable") {
    return {
      label: "Check unavailable",
      shortLabel: "Unavailable",
      variant: "outline",
      Icon: TriangleAlert,
      spin: false,
      hint: evaluation.judgeError ?? "The evaluation could not be completed.",
    };
  }

  if (evaluation.status === "not_evaluable") {
    return {
      label: "Nothing to judge",
      shortLabel: "Nothing to judge",
      variant: "outline",
      Icon: Minus,
      spin: false,
      hint: "The run never finished, so there is no output to compare with the request.",
    };
  }

  const verdict = effectiveVerdict(evaluation);
  const by = evaluation.humanVerdict ? " Recorded by you." : "";

  switch (verdict) {
    case "pass":
      return {
        label: "Did what was asked",
        shortLabel: "Yes",
        variant: "default",
        Icon: Target,
        spin: false,
        hint: `Every requirement in the request was met.${by}`,
      };
    case "partial":
      return {
        label: "Partly did what was asked",
        shortLabel: "Partly",
        variant: "secondary",
        Icon: CircleSlash2,
        spin: false,
        hint: `Real work on the task, but at least one requirement is unmet.${by}`,
      };
    case "fail":
      return {
        label: "Did not do what was asked",
        shortLabel: "No",
        variant: "destructive",
        Icon: ThumbsDown,
        spin: false,
        hint: `The output does not satisfy the request.${by}`,
      };
    case "inconclusive":
      return {
        label: "Cannot tell",
        shortLabel: "Cannot tell",
        variant: "outline",
        Icon: CircleHelp,
        spin: false,
        hint: "The request is too open-ended to check an output against.",
      };
    default:
      return NOT_EVALUATED;
  }
}

export function EvaluationBadge({
  evaluation,
  compact = false,
}: {
  evaluation: Evaluation | null;
  compact?: boolean;
}) {
  const { label, shortLabel, variant, Icon, spin, hint } = evaluationPresentation(evaluation);
  return (
    <Badge variant={variant} title={hint}>
      <Icon className={spin ? "animate-spin" : undefined} />
      {compact ? shortLabel : label}
    </Badge>
  );
}
