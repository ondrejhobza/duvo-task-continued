import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowLeft } from "lucide-react";
import { RunDetail, RunHeading } from "@/components/run-detail";
import { StopRunButton } from "@/components/run-stop-button";
import { Button } from "@/components/ui/button";
import { getRun, listRunEvents } from "@/lib/repo";
import { deriveRunSteps } from "@/lib/steps";

export const dynamic = "force-dynamic";

export default async function RunPage({ params }: PageProps<"/runs/[id]">) {
  const { id } = await params;
  const run = await getRun(id);
  if (!run) notFound();

  const events = await listRunEvents(run.id);
  const derived = deriveRunSteps(events, run.status, run.startedAt, run.cancelRequestedAt !== null);

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
          <RunHeading run={run} mcpServersUsed={derived.mcpServersUsed} />
          <h1 className="line-clamp-2 text-2xl font-semibold tracking-tight" title={run.prompt}>
            {run.prompt}
          </h1>
        </div>
        {/* Hides itself once there is nothing left to stop. The detail below
            refreshes this shell when the run settles, so it goes away on its
            own; a click that loses the race is answered with a 409. */}
        <StopRunButton run={run} />
      </header>

      <RunDetail initialProgress={{ run, ...derived }} />
    </main>
  );
}
