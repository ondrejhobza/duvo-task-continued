"use client";

import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";

/** Joins dictated speech onto a draft without gluing words together. */
export function appendTranscript(draft: string, spoken: string): string {
  if (!draft) return spoken;
  return /\s$/.test(draft) ? draft + spoken : `${draft} ${spoken}`;
}

/**
 * Minimal typing for the Web Speech API. It is not in lib.dom.d.ts, and the
 * constructor is still vendor-prefixed in Chrome and Safari.
 */
interface SpeechRecognitionAlternative {
  transcript: string;
}

interface SpeechRecognitionResult {
  readonly length: number;
  isFinal: boolean;
  [index: number]: SpeechRecognitionAlternative;
}

interface SpeechRecognitionResultList {
  readonly length: number;
  [index: number]: SpeechRecognitionResult;
}

interface SpeechRecognitionEventLike extends Event {
  resultIndex: number;
  results: SpeechRecognitionResultList;
}

interface SpeechRecognitionErrorEventLike extends Event {
  error: string;
}

interface SpeechRecognitionLike extends EventTarget {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  start(): void;
  stop(): void;
  abort(): void;
  onresult: ((event: SpeechRecognitionEventLike) => void) | null;
  onerror: ((event: SpeechRecognitionErrorEventLike) => void) | null;
  onend: (() => void) | null;
}

type SpeechRecognitionCtor = new () => SpeechRecognitionLike;

function getSpeechRecognition(): SpeechRecognitionCtor | null {
  if (typeof window === "undefined") return null;
  const w = window as unknown as {
    SpeechRecognition?: SpeechRecognitionCtor;
    webkitSpeechRecognition?: SpeechRecognitionCtor;
  };
  return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null;
}

const ERROR_MESSAGE: Record<string, string> = {
  "not-allowed": "Microphone access was blocked. Allow it in your browser settings.",
  "service-not-allowed": "Your browser refused the dictation service.",
  "audio-capture": "No microphone was found.",
  network: "Dictation needs a network connection.",
};

/** Whether the browser can do speech recognition; always false while rendering on the server. */
function useSpeechSupported(): boolean {
  return useSyncExternalStore(
    () => () => {},
    () => getSpeechRecognition() !== null,
    () => false,
  );
}

export interface Dictation {
  supported: boolean;
  listening: boolean;
  /** Words recognised but not yet finalised; shown as a live preview. */
  interim: string;
  toggle: () => void;
  stop: () => void;
}

/**
 * Browser dictation. Final phrases are handed to `onTranscript`, which is
 * expected to append them to the draft; interim words stay in `interim`.
 */
export function useDictation({
  onTranscript,
  onError,
}: {
  onTranscript: (text: string) => void;
  onError: (message: string) => void;
}): Dictation {
  const supported = useSpeechSupported();
  const [listening, setListening] = useState(false);
  const [interim, setInterim] = useState("");
  const recognitionRef = useRef<SpeechRecognitionLike | null>(null);

  // Keep the callbacks in refs so the recognition instance never has to be
  // rebuilt (rebuilding mid-sentence would drop audio).
  const transcriptRef = useRef(onTranscript);
  const errorRef = useRef(onError);
  useEffect(() => {
    transcriptRef.current = onTranscript;
    errorRef.current = onError;
  });

  useEffect(() => {
    return () => {
      recognitionRef.current?.abort();
      recognitionRef.current = null;
    };
  }, []);

  const stop = useCallback(() => {
    recognitionRef.current?.stop();
    recognitionRef.current = null;
    setListening(false);
    setInterim("");
  }, []);

  const start = useCallback(() => {
    const Ctor = getSpeechRecognition();
    if (!Ctor) {
      errorRef.current("This browser cannot do dictation.");
      return;
    }

    let recognition: SpeechRecognitionLike;
    try {
      recognition = new Ctor();
    } catch {
      errorRef.current("Dictation could not be started.");
      return;
    }

    recognition.lang = navigator.language || "en-US";
    recognition.continuous = true;
    recognition.interimResults = true;

    recognition.onresult = (event) => {
      let finalText = "";
      let pending = "";
      for (let i = event.resultIndex; i < event.results.length; i += 1) {
        const result = event.results[i];
        const text = result[0]?.transcript ?? "";
        if (result.isFinal) finalText += text;
        else pending += text;
      }
      if (finalText.trim()) transcriptRef.current(finalText.trim());
      setInterim(pending.trim());
    };

    recognition.onerror = (event) => {
      // Firing "aborted" on a user-initiated stop is normal; stay quiet.
      if (event.error !== "aborted" && event.error !== "no-speech") {
        errorRef.current(ERROR_MESSAGE[event.error] ?? `Dictation failed (${event.error}).`);
      }
      recognitionRef.current = null;
      setListening(false);
      setInterim("");
    };

    recognition.onend = () => {
      recognitionRef.current = null;
      setListening(false);
      setInterim("");
    };

    try {
      recognition.start();
    } catch {
      errorRef.current("Dictation is already running.");
      return;
    }
    recognitionRef.current = recognition;
    setListening(true);
  }, []);

  const toggle = useCallback(() => {
    if (recognitionRef.current) stop();
    else start();
  }, [start, stop]);

  return { supported, listening, interim, toggle, stop };
}
