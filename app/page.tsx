import { Sparkles } from "lucide-react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { LiveRunPanel } from "@/components/live-run-panel";
import { RunComposer } from "@/components/run-composer";
import { RunList } from "@/components/run-list";
import { findActiveRun, getRunSummary, listMcpServers, listRunEvents, listRunsPage } from "@/lib/repo";
import type { Run } from "@/lib/schema";
import { buildRunProgress } from "@/lib/steps";

export const dynamic = "force-dynamic";

export default async function HomePage() {
  const [summary, firstPage, mcpServers, active] = await Promise.all([
    getRunSummary(),
    listRunsPage(),
    listMcpServers(),
    findActiveRun(),
  ]);
  // The panel follows whatever is live, falling back to the newest run when
  // nothing is. The two are usually the same run; they part company when an
  // older run is picked up again with a follow-up, and then it is the one
  // working that the user wants to watch. Rebuilt from the database on every
  // request, so a reload mid-run comes back to exactly where the run is.
  const latest = active ?? firstPage.runs[0] ?? null;
  const latestProgress = latest ? buildRunProgress(latest, await listRunEvents(latest.id)) : null;

  return (
    <main className="mx-auto flex w-full max-w-7xl flex-1 flex-col gap-6 p-4 sm:p-6">
      <header className="flex flex-col gap-1">
        <h1 className="text-2xl font-semibold tracking-tight">Automations</h1>
        <p className="text-sm text-muted-foreground">
          Give the agent instructions, watch it work step by step, and download what it produced.
        </p>
      </header>

      {/* The fifth card is conditional, so the desktop track count follows it:
          a fixed four would leave the last card stranded on its own row. */}
      <section
        className={
          summary.awaitingInput > 0
            ? "grid gap-4 sm:grid-cols-2 lg:grid-cols-5"
            : "grid gap-4 sm:grid-cols-2 lg:grid-cols-4"
        }
      >
        <PassRateStat evaluated={summary.evaluated} passed={summary.passed} />
        <SummaryStat label="Total runs" value={summary.total} />
        <SummaryStat label="Ran without error" value={summary.succeeded} />
        <SummaryStat label="Errored" value={summary.failed} />
        {/* Only when there is something to act on: a paused run needs the user. */}
        {summary.awaitingInput > 0 && (
          <SummaryStat label="Waiting for your answer" value={summary.awaitingInput} />
        )}
      </section>

      <Card>
        <CardHeader>
          <CardTitle>Run</CardTitle>
          <CardDescription>
            The agent can search and read the web and write files into its own workspace. It runs
            below, live: if the task is ambiguous it will ask you a question or two first.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <RunComposer mcpServers={mcpServers} busyReason={busyReason(latest)} />
        </CardContent>
      </Card>

      {/* The last run stays put until the next one replaces it; only a brand new
          user, with nothing to show, sees an empty state here. */}
      {latestProgress ? <LiveRunPanel initialProgress={latestProgress} /> : <NoRunsYet />}

      <Card>
        <CardHeader>
          <CardTitle>Recent runs</CardTitle>
          <CardDescription>
            Newest first. Click a run to open it{firstPage.hasMore && ", or load more below"}.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <RunList initialRuns={firstPage.runs} initialHasMore={firstPage.hasMore} />
        </CardContent>
      </Card>
    </main>
  );
}

/**
 * Why the composer is closed for business. One run at a time, like a chat: a
 * second prompt would either abandon the run on screen or quietly compete with
 * it, and neither is what the user meant by pressing Run again.
 */
function busyReason(latest: Run | null): string | null {
  if (!latest) return null;
  if (latest.status === "awaiting_input") {
    return latest.clarification.state === "awaiting_mid_run"
      ? "The run below is waiting on you. Give it the value, or tell it to carry on without."
      : "Answer the questions below — or choose “Run without answering” — before starting another run.";
  }
  if (latest.status === "queued" || latest.status === "running") {
    return "A run is still going. It will finish on its own; the box is free again then.";
  }
  return null;
}

/**
 * The only genuinely empty case: nobody has run anything yet. Worth more than a
 * shrug, so it says what the agent is for and what a good first task looks like.
 */
function NoRunsYet() {
  return (
    <section className="flex flex-col gap-3 rounded-xl border bg-card p-6">
      <div className="flex items-center gap-2">
        <Sparkles className="size-4 text-muted-foreground" />
        <p className="text-sm font-medium">Your run will show up here</p>
      </div>
      <p className="text-sm text-muted-foreground">
        Describe a task in the box above. The agent searches and reads the web, writes files when
        the task calls for one, and asks you a question first if the task could be read two ways.
      </p>
      <ul className="flex flex-col gap-1 text-sm text-muted-foreground">
        {EXAMPLE_PROMPTS.map((example) => (
          <li key={example} className="rounded-lg border bg-muted/40 px-3 py-2">
            {example}
          </li>
        ))}
      </ul>
    </section>
  );
}

const EXAMPLE_PROMPTS = [
  "Find the five most recent EU AI Act updates and save them as a CSV.",
  "Summarise what changed in the latest Next.js release in ten bullet points.",
  "Compare the pricing pages of the three biggest project management tools.",
];

/**
 * The headline number: of the runs we could check, how many actually did what
 * was asked. Deliberately not the same as "ran without error" beside it.
 */
function PassRateStat({ evaluated, passed }: { evaluated: number; passed: number }) {
  const rate = evaluated === 0 ? null : Math.round((passed / evaluated) * 100);
  return (
    <div className="rounded-xl border bg-card p-4">
      <p className="text-sm text-muted-foreground">Did what was asked</p>
      <p className="text-3xl font-semibold tabular-nums">{rate === null ? "—" : `${rate}%`}</p>
      <p className="text-xs text-muted-foreground tabular-nums">
        {/* Counted in SQL over every run, so paging the table below cannot move it. */}
        {evaluated === 0
          ? "No runs checked yet"
          : `${passed} of ${evaluated} checked, across all runs`}
      </p>
    </div>
  );
}

function SummaryStat({ label, value }: { label: string; value: number }) {
  return (
    <div className="rounded-xl border bg-card p-4">
      <p className="text-sm text-muted-foreground">{label}</p>
      <p className="text-3xl font-semibold tabular-nums">{value}</p>
    </div>
  );
}
