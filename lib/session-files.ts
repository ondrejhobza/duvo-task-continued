import { access } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";

/**
 * Whether an agent session can still be reopened.
 *
 * The SDK resumes a session by reading its transcript back from disk, so the
 * question "can this run be continued" is really "is that file still there".
 * Asking before starting is what lets a follow-up say honestly which kind of
 * continuation the user is getting, instead of promising the agent's memory
 * and then quietly handing it a summary.
 */

/** Where the CLI keeps transcripts; overridable the same way the CLI does it. */
function configDir(): string {
  return process.env.CLAUDE_CONFIG_DIR ?? path.join(homedir(), ".claude");
}

/**
 * Transcripts are filed per working directory, under a name derived from the
 * path with the separators flattened. Mirrors the CLI's own scheme; a miss is
 * treated as "not resumable", which is the safe way to be wrong.
 */
function projectDir(cwd: string): string {
  const slug = path.resolve(cwd).replace(/[/.]/g, "-");
  return path.join(configDir(), "projects", slug);
}

export async function sessionTranscriptExists(
  sessionId: string,
  cwd: string,
): Promise<boolean> {
  try {
    await access(path.join(projectDir(cwd), `${sessionId}.jsonl`));
    return true;
  } catch {
    return false;
  }
}
