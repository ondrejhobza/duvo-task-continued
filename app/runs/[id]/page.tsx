import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowLeft, ArrowRight, CornerDownRight } from "lucide-react";
import { RunDetail, RunHeading } from "@/components/run-detail";
import { RunStatusBadge } from "@/components/run-status-badge";
import { StopRunButton } from "@/components/run-stop-button";
import { Button } from "@/components/ui/button";
import { findActiveRun, getRun, listRunContinuations, listRunEvents } from "@/lib/repo";
import type { Run } from "@/lib/schema";
import { buildRunProgress } from "@/lib/steps";

export const dynamic = "force-dynamic";

export default async function RunPage({ params }: PageProps<"/runs/[id]">) {
  const { id } = await params;
  const run = await getRun(id);
  if (!run) notFound();

  const [events, parent, continuations, active] = await Promise.all([
    listRunEvents(run.id),
    run.parentRunId === null ? null : getRun(run.parentRunId),
    listRunContinuations(run.id),
    findActiveRun(),
  ]);
  const progress = buildRunProgress(run, events);
  // A run cannot be continued while another one is going. This run being the
  // active one is not a reason: its own follow-up field is only offered once
  // it has finished anyway.
  const busyReason = active === null || active.id === run.id ? null : followUpBusyReason(active);

  return (
    <main className="mx-auto flex w-full max-w-7xl flex-1 flex-col gap-6 p-4 sm:p-6">
      <div>
        <Button variant="ghost" size="sm" nativeButton={false} render={<Link href="/" />}>
          <ArrowLeft />
          All runs
        </Button>
      </div>

      <header className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex min-w-0 flex-col gap-2">
          <RunHeading run={run} mcpServersUsed={progress.mcpServersUsed} />
          <h1 className="line-clamp-2 text-2xl font-semibold tracking-tight" title={run.prompt}>
            {run.prompt}
          </h1>
        </div>
        {/* Hides itself once there is nothing left to stop. The detail below
            refreshes this shell when the run settles, so it goes away on its
            own; a click that loses the race is answered with a 409. */}
        <StopRunButton run={run} />
      </header>

      <RunChain run={run} parent={parent} continuations={continuations} />

      <RunDetail initialProgress={progress} busyReason={busyReason} />
    </main>
  );
}

/**
 * Links to the runs either side of this one.
 *
 * Only a handful of runs have any: a follow-up is a turn of its own run now,
 * and shows up in the conversation below rather than as a separate record.
 * These are the ones made while it worked the other way, kept navigable rather
 * than rewritten, so nothing the user did disappears.
 */
function RunChain({
  run,
  parent,
  continuations,
}: {
  run: Run;
  parent: Run | null;
  continuations: Run[];
}) {
  if (!parent && continuations.length === 0) return null;

  return (
    <section className="flex flex-col gap-2 rounded-xl border bg-card p-4">
      <p className="text-xs font-medium text-muted-foreground">
        Recorded as separate runs, before follow-ups became turns of one run
      </p>

      {parent && (
        <p className="flex flex-wrap items-center gap-2 text-sm">
          <CornerDownRight className="size-4 shrink-0 text-muted-foreground" />
          <span className="text-muted-foreground">
            {/* The distinction the whole feature turns on, kept visible after
                the fact: this run either remembered the earlier one or was
                handed a summary of it. */}
            {run.continuation === "resumed"
              ? "Continues, in the same session:"
              : "Continues, from a written summary:"}
          </span>
          <Link href={`/runs/${parent.id}`} className="min-w-0 truncate font-medium hover:underline">
            {parent.prompt}
          </Link>
        </p>
      )}

      {continuations.map((child) => (
        <p key={child.id} className="flex flex-wrap items-center gap-2 text-sm">
          <ArrowRight className="size-4 shrink-0 text-muted-foreground" />
          <span className="text-muted-foreground">Carried on by:</span>
          <Link href={`/runs/${child.id}`} className="min-w-0 truncate font-medium hover:underline">
            {child.prompt}
          </Link>
          <RunStatusBadge status={child.status} run={child} />
        </p>
      ))}
    </section>
  );
}

/** The composer's wording, applied to the follow-up field on this page. */
function followUpBusyReason(active: Run): string {
  return active.status === "awaiting_input"
    ? "The run in progress is waiting on an answer. Deal with that before carrying this one on."
    : "A run is still going. It will finish on its own; you can carry this one on then.";
}
