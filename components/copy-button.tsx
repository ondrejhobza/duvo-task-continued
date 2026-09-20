"use client";

import { useEffect, useRef, useState } from "react";
import { Check, Copy } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";

/**
 * Icon-only copy control for a block of text, sat in the header of the panel it
 * belongs to rather than hovering over the content: a control that only appears
 * on hover is easy to miss on a panel this tall, and impossible to find on a
 * touch screen.
 *
 * What it copies is whatever string it is handed — for the agent's reply that is
 * the markdown source, not the rendered text, because the headings, list
 * markers, link targets, fences and table pipes are the part worth keeping when
 * the reply lands in a document, a message or another prompt.
 */

/** Long enough to register as confirmation, short enough not to look stuck. */
const REVERT_MS = 2000;

export function CopyButton({
  value,
  label,
  copiedLabel = "Copied",
}: {
  /** Copied verbatim. Read at click time, so a reply still streaming copies as far as it has got. */
  value: string;
  /** What is being copied, for screen readers and the tooltip. */
  label: string;
  copiedLabel?: string;
}) {
  const [copied, setCopied] = useState(false);
  const revertTimer = useRef<number | null>(null);

  function clearRevert() {
    if (revertTimer.current !== null) {
      window.clearTimeout(revertTimer.current);
      revertTimer.current = null;
    }
  }

  // No state update after unmount, and no timer left running behind the page.
  useEffect(() => clearRevert, []);

  async function copy() {
    try {
      // Absent on an insecure origin and inside some embedded browsers, where
      // the call would otherwise reject with nothing catching it.
      if (!navigator.clipboard?.writeText) throw new Error("No clipboard access");
      await navigator.clipboard.writeText(value);
      // A second click restarts the confirmation rather than stacking timers,
      // which is what would leave the tick showing for good.
      clearRevert();
      setCopied(true);
      revertTimer.current = window.setTimeout(() => {
        revertTimer.current = null;
        setCopied(false);
      }, REVERT_MS);
    } catch {
      toast.error("Could not copy. Your browser blocked clipboard access — select the text instead.");
    }
  }

  const description = copied ? copiedLabel : label;

  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            className="-my-1 shrink-0 text-muted-foreground"
            onClick={() => void copy()}
          />
        }
        aria-label={description}
      >
        {copied ? <Check /> : <Copy />}
      </TooltipTrigger>
      <TooltipContent>{description}</TooltipContent>
    </Tooltip>
  );
}
