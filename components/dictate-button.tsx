"use client";

import { Mic, MicOff } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import type { useDictation } from "@/lib/use-dictation";
import { cn } from "@/lib/utils";

/**
 * The microphone that sits in a composer's control row. Shared by the prompt
 * composer and the mid-run answer field: dictating a URL the agent asked for
 * is the same act as dictating the task, so it is the same control.
 */
export function DictateButton({
  dictation,
  disabled,
  label = "Dictate instructions",
}: {
  dictation: ReturnType<typeof useDictation>;
  disabled: boolean;
  /** What the microphone is for here, for screen readers. */
  label?: string;
}) {
  const { supported, listening, toggle } = dictation;

  if (!supported) {
    return (
      <Tooltip>
        {/* A disabled button swallows pointer events in some browsers, so the
            native title carries the same explanation as the tooltip. */}
        <TooltipTrigger
          render={<Button type="button" variant="outline" size="sm" disabled />}
          aria-label="Dictation is not available in this browser"
          title="This browser has no speech recognition. Try Chrome or Safari."
        >
          <MicOff />
          Dictate
        </TooltipTrigger>
        <TooltipContent>This browser has no speech recognition. Try Chrome or Safari.</TooltipContent>
      </Tooltip>
    );
  }

  return (
    <Button
      type="button"
      variant={listening ? "secondary" : "outline"}
      size="sm"
      onClick={toggle}
      disabled={disabled}
      aria-pressed={listening}
      aria-label={listening ? "Stop dictation" : label}
    >
      {listening ? <Equalizer /> : <Mic />}
      {listening ? "Listening" : "Dictate"}
    </Button>
  );
}

/** Three bars bouncing while the microphone is open. */
function Equalizer() {
  return (
    <span className="flex h-3.5 items-center gap-0.5" aria-hidden>
      {[0, 150, 300].map((delay) => (
        <span
          key={delay}
          className={cn("h-full w-0.5 rounded-full bg-current animate-equalize")}
          style={{ animationDelay: `${delay}ms` }}
        />
      ))}
    </span>
  );
}
