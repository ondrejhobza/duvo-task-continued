import {
  CheckCircle2,
  CircleDashed,
  CircleStop,
  Loader2,
  MessageCircleQuestionMark,
  XCircle,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import type { Run, RunStatus } from "@/lib/schema";
import { isCancelling } from "@/lib/schema";

type BadgeVariant = "default" | "secondary" | "destructive" | "outline" | "success";

const STATUS_CONFIG: Record<
  RunStatus,
  { label: string; variant: BadgeVariant; Icon: typeof CheckCircle2; spin?: boolean }
> = {
  queued: { label: "Queued", variant: "outline", Icon: CircleDashed },
  running: { label: "Running", variant: "secondary", Icon: Loader2, spin: true },
  awaiting_input: {
    label: "Needs your answer",
    variant: "outline",
    Icon: MessageCircleQuestionMark,
  },
  succeeded: { label: "Succeeded", variant: "success", Icon: CheckCircle2 },
  failed: { label: "Failed", variant: "destructive", Icon: XCircle },
  // Outline, not destructive: the user asked for this, so it is an outcome
  // rather than a fault.
  cancelled: { label: "Stopped", variant: "outline", Icon: CircleStop },
};

/**
 * `run` is accepted as well as a bare status so the badge can show the gap
 * between "you pressed stop" and "the loop has stopped", which the status
 * alone cannot express.
 */
export function RunStatusBadge({ status, run }: { status: RunStatus; run?: Run }) {
  if (run && isCancelling(run)) {
    return (
      <Badge variant="outline">
        <Loader2 className="animate-spin" />
        Stopping…
      </Badge>
    );
  }

  const { label, variant, Icon, spin } = STATUS_CONFIG[status];
  return (
    <Badge variant={variant}>
      <Icon className={spin ? "animate-spin" : undefined} />
      {label}
    </Badge>
  );
}
