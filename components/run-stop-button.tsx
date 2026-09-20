"use client";

import { useState, type MouseEvent } from "react";
import { CircleStop, Loader2 } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { canRequestCancellation, isCancelling, runSchema, type Run } from "@/lib/schema";

/**
 * Stops a run that is still going: the single stop control, used by the live
 * panel, the run page and each row of the runs table. Everything that decides
 * whether stopping is possible lives here — the same two predicates
 * (`canRequestCancellation` / `isCancelling`), the same request, the same
 * optimistic "Stopping…" and the same rollback — so the three surfaces cannot
 * drift apart, and all three lose the control the moment the run goes terminal.
 *
 * Deliberately one click rather than a confirm dialog, in every surface:
 * nothing is destroyed — every step and file the run produced is kept — and a
 * runaway agent is the one case where a second click costs the user money.
 */
export function StopRunButton({
  run,
  onStopped,
  compact = false,
}: {
  run: Run;
  /** Handed the run as the server last described it, so callers can resync. */
  onStopped?: (run: Run | null) => void;
  /** Icon-only, for a table row where a labelled button would not fit. */
  compact?: boolean;
}) {
  const [sending, setSending] = useState(false);
  const [optimistic, setOptimistic] = useState(false);

  // The run finished, by itself or because it was already stopped. Nothing
  // left to stop, so the control is simply not there.
  if (!canRequestCancellation(run) && !isCancelling(run)) return null;

  const stopping = isCancelling(run) || optimistic;

  async function stop() {
    if (sending || stopping) return;
    setSending(true);
    setOptimistic(true);
    try {
      const response = await fetch(`/api/runs/${run.id}/cancel`, { method: "POST" });
      const body: unknown = await response.json().catch(() => null);
      const parsed = runSchema.safeParse(
        body && typeof body === "object" && "run" in body ? body.run : null,
      );

      if (response.status === 409) {
        // It crossed the line while the click was in flight. Not an error: the
        // run is over, which is what the user wanted.
        toast.info("That run had already finished on its own.");
        onStopped?.(parsed.success ? parsed.data : null);
        return;
      }
      if (!response.ok) throw new Error(`Request failed (${response.status})`);
      onStopped?.(parsed.success ? parsed.data : null);
    } catch {
      // Roll the optimistic "Stopping…" back: the run is still going, and
      // saying otherwise would be the one lie this button must never tell.
      setOptimistic(false);
      toast.error("Could not stop the run. Try again.");
    } finally {
      setSending(false);
    }
  }

  const label = stopping ? "Stopping this run" : "Stop this run";

  // In a row the whole surface is a link to the run, laid over the cells; the
  // click has to stay on the button rather than opening the page behind it.
  function handleClick(event: MouseEvent<HTMLButtonElement>) {
    event.preventDefault();
    event.stopPropagation();
    void stop();
  }

  if (compact) {
    return (
      <Button
        type="button"
        variant="ghost"
        size="icon-sm"
        onClick={handleClick}
        disabled={stopping}
        aria-label={label}
        title={label}
      >
        {stopping ? <Loader2 className="animate-spin" /> : <CircleStop />}
      </Button>
    );
  }

  return (
    <Button
      type="button"
      variant="destructive"
      size="sm"
      onClick={handleClick}
      disabled={stopping}
      aria-label={label}
    >
      {stopping ? <Loader2 className="animate-spin" /> : <CircleStop />}
      {stopping ? "Stopping…" : "Stop"}
    </Button>
  );
}
