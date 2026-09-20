"use client";

import { useCallback, useMemo, useState, type ReactNode } from "react";
import Link from "next/link";
import { Brain, ChevronDown, Inbox, Loader2 } from "lucide-react";
import { toast } from "sonner";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { ArtifactLinks } from "@/components/artifact-links";
import { EvaluationBadge } from "@/components/evaluation-badge";
import { RunStatusBadge } from "@/components/run-status-badge";
import { StopRunButton } from "@/components/run-stop-button";
import { Button } from "@/components/ui/button";
import { formatDateTime, formatDuration, formatMoney } from "@/lib/format";
import {
  describeRunModel,
  isTerminalRunStatus,
  runPageSchema,
  runSchema,
  RUNS_PAGE_SIZE,
  type Run,
} from "@/lib/schema";

function Cell({ children, title }: { children: ReactNode; title?: string }) {
  return (
    <TableCell className="align-top whitespace-nowrap" title={title}>
      {children}
    </TableCell>
  );
}

/**
 * The versioned model the run used, with the exact API identifier and the
 * auto/reasoning facts one hover away. Shows what it *resolved to*: "Auto"
 * alone tells the reader nothing after the fact.
 */
function ModelCell({ run }: { run: Run }) {
  const model = describeRunModel(run);

  // Predates the model being recorded: an em dash says so, where a default
  // would be a guess presented as fact.
  if (model.state === "none") {
    return <Cell><span className="text-muted-foreground">—</span></Cell>;
  }

  if (model.state === "pending") {
    return (
      <Cell title="Auto has not chosen a model for this run yet">
        <span className="text-muted-foreground">Auto…</span>
      </Cell>
    );
  }

  // A family alias resolved at call time and this run never reported back, so
  // the version is unknowable rather than merely unformatted.
  if (model.state === "unversioned") {
    return (
      <Cell title={`${model.name} — the exact version this run used was not recorded`}>
        <span className="flex items-center gap-1.5">
          {model.name}
          <span className="text-xs text-muted-foreground">version not recorded</span>
        </span>
      </Cell>
    );
  }

  const title = [
    model.apiId,
    model.auto ? "chosen by Auto" : null,
    run.reasoning ? "extended thinking on" : null,
  ]
    .filter(Boolean)
    .join(" · ");

  return (
    <Cell title={title}>
      <span className="flex items-center gap-1.5">
        {model.name}
        {model.auto && <span className="text-xs text-muted-foreground">Auto</span>}
        {run.reasoning && (
          <Brain className="size-4 text-muted-foreground" aria-label="Extended thinking" />
        )}
      </span>
    </Cell>
  );
}

/** How long a stopped row keeps checking for the state it actually landed in. */
const SETTLE_TIMEOUT_MS = 30_000;
const SETTLE_INTERVAL_MS = 1000;

export function RunList({
  initialRuns,
  initialHasMore,
}: {
  initialRuns: Run[];
  initialHasMore: boolean;
}) {
  // Three sources, combined during render rather than copied into one piece of
  // state: the first page as the server last sent it, the pages the user loaded
  // with Load more, and the rows this list has changed itself by stopping them.
  // Keeping them apart is what lets a server refresh update a row without
  // discarding a loaded page or an in-flight stop.
  const [olderPages, setOlderPages] = useState<Run[]>([]);
  const [stopped, setStopped] = useState<Record<string, Run>>({});
  const [hasMore, setHasMore] = useState(initialHasMore);
  const [loading, setLoading] = useState(false);

  const runs = useMemo(() => {
    const seen = new Set(initialRuns.map((run) => run.id));
    const all = [...initialRuns, ...olderPages.filter((run) => !seen.has(run.id))];
    // A locally stopped row stands in for the server's until the server agrees
    // the run is over; after that its word is final and the overlay is ignored.
    return all.map((run) => {
      const local = stopped[run.id];
      return local && !isTerminalRunStatus(run.status) ? local : run;
    });
  }, [initialRuns, olderPages, stopped]);

  const patchRun = useCallback((next: Run) => {
    setStopped((current) => ({ ...current, [next.id]: next }));
  }, []);

  // A stop is a request, not an outcome: the loop honours it a beat later, and
  // a row nobody is polling would otherwise sit on "Stopping…" until a reload.
  // Scoped to the one run, and it gives up by itself.
  const settleAfterStop = useCallback(
    (justStopped: Run | null) => {
      if (!justStopped) return;
      patchRun(justStopped);
      if (isTerminalRunStatus(justStopped.status)) return;

      const deadline = Date.now() + SETTLE_TIMEOUT_MS;
      const timer = setInterval(async () => {
        if (Date.now() > deadline) {
          clearInterval(timer);
          return;
        }
        try {
          const response = await fetch(`/api/runs/${justStopped.id}/steps`, { cache: "no-store" });
          if (!response.ok) return;
          const body: unknown = await response.json();
          const parsed = runSchema.safeParse(
            body && typeof body === "object" && "run" in body ? body.run : null,
          );
          if (!parsed.success) return;
          patchRun(parsed.data);
          if (isTerminalRunStatus(parsed.data.status)) clearInterval(timer);
        } catch {
          // Transient: the next tick tries again, and the deadline ends it.
        }
      }, SETTLE_INTERVAL_MS);
    },
    [patchRun],
  );

  async function loadMore() {
    const last = runs.at(-1);
    if (loading || !last) return;
    setLoading(true);
    try {
      const params = new URLSearchParams({
        limit: String(RUNS_PAGE_SIZE),
        cursorCreatedAt: last.createdAt,
        cursorId: last.id,
      });
      const response = await fetch(`/api/runs?${params}`, { cache: "no-store" });
      if (!response.ok) throw new Error(`Request failed (${response.status})`);
      const parsed = runPageSchema.safeParse(await response.json());
      if (!parsed.success) throw new Error("Unexpected response from server");
      // Append rather than replace, and guard against a row arriving twice if
      // the page was reloaded underneath.
      setOlderPages((current) => {
        const seen = new Set(current.map((r) => r.id));
        return [...current, ...parsed.data.runs.filter((r) => !seen.has(r.id))];
      });
      setHasMore(parsed.data.hasMore);
    } catch (error) {
      // The rows already loaded stay exactly where they are.
      toast.error(error instanceof Error ? error.message : "Could not load more runs");
    } finally {
      setLoading(false);
    }
  }

  if (runs.length === 0) {
    return (
      <div className="flex flex-col items-center gap-2 rounded-lg border bg-muted/40 p-8 text-center">
        <Inbox className="size-5 text-muted-foreground" />
        <p className="text-sm font-medium">No runs yet</p>
        <p className="text-sm text-muted-foreground">
          Give the agent some instructions above and press Run.
        </p>
      </div>
    );
  }

  const table = (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>Status</TableHead>
          <TableHead>Outcome</TableHead>
          <TableHead>Instructions</TableHead>
          <TableHead>Output files</TableHead>
          <TableHead>Model</TableHead>
          <TableHead>Started</TableHead>
          <TableHead className="text-right">Duration</TableHead>
          <TableHead className="text-right">Cost</TableHead>
          <TableHead className="w-px">
            <span className="sr-only">Stop a run that is still going</span>
          </TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {runs.map((run) => (
          <TableRow key={run.id} className="relative hover:bg-muted/50">
            {/* The full failure text lives on the run page; the row only carries it
                as a tooltip so it can never spill out of the scrolling table. */}
            <TableCell className="align-top" title={run.error ?? undefined}>
              {/* Given the run as well as the status, so a row being stopped
                  says "Stopping…" instead of still claiming to be running. */}
              <RunStatusBadge status={run.status} run={run} />
            </TableCell>
            <TableCell className="relative z-10 align-top">
              <EvaluationBadge evaluation={run.evaluation} compact />
            </TableCell>
            <TableCell className="max-w-md align-top">
              <Link
                href={`/runs/${run.id}`}
                className="block truncate font-medium hover:underline after:absolute after:inset-0 after:content-['']"
                title={run.prompt}
              >
                {run.prompt}
              </Link>
            </TableCell>
            <TableCell className="relative z-10 align-top">
              <ArtifactLinks artifacts={run.artifacts} emptyLabel="—" />
            </TableCell>
            <ModelCell run={run} />
            <TableCell className="align-top tabular-nums text-muted-foreground">
              {formatDateTime(run.createdAt)}
            </TableCell>
            <TableCell className="text-right align-top tabular-nums">
              {formatDuration(run.startedAt, run.finishedAt)}
            </TableCell>
            <TableCell className="text-right align-top tabular-nums">
              {formatMoney(run.costUsd)}
            </TableCell>
            {/* Above the row's own link overlay, so the click stops the run
                rather than opening it. Finished rows — most of the table —
                render nothing at all rather than a dead disabled button. */}
            <TableCell className="relative z-10 align-top">
              <StopRunButton run={run} onStopped={settleAfterStop} compact />
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );

  // Hidden once the last page has been read, so the button never does nothing.
  if (!hasMore) return table;

  return (
    <div className="flex flex-col gap-4">
      {table}
      <div className="flex justify-center">
        <Button type="button" variant="outline" onClick={loadMore} disabled={loading}>
          {loading ? <Loader2 className="animate-spin" /> : <ChevronDown />}
          {loading ? "Loading…" : "Load more"}
        </Button>
      </div>
    </div>
  );
}
