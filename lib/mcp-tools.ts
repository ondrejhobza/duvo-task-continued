import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

/**
 * Asks a remote MCP server which tools it actually advertises, and splits them
 * into "reads" and "writes".
 *
 * The split is deliberately not a list of names kept in this repo: a hardcoded
 * allow-list goes stale the moment the server ships a tool, and silently keeps
 * the agent on an older surface than the one the user connected to.
 */

const LIST_TIMEOUT_MS = 15_000;

export interface AdvertisedTools {
  readTools: string[];
  writeTools: string[];
  /** True when the server labelled its own tools, so the split is authoritative. */
  annotated: boolean;
}

/**
 * Verbs that mutate, used only when a server ships no annotations. Matched per
 * name segment so `notion-create-pages` is a write and `notion-search` is not.
 */
const MUTATING_VERBS = new Set([
  "add",
  "append",
  "archive",
  "convert",
  "create",
  "delete",
  "duplicate",
  "edit",
  "insert",
  "merge",
  "move",
  "patch",
  "remove",
  "rename",
  "restore",
  "send",
  "set",
  "spawn",
  "stop",
  "update",
  "upload",
  "write",
]);

function looksMutating(name: string): boolean {
  return name
    .split(/[-_.]/)
    .some((segment) => MUTATING_VERBS.has(segment.toLowerCase()));
}

interface ToolAnnotations {
  readOnlyHint?: boolean;
  destructiveHint?: boolean;
}

interface AdvertisedTool {
  name: string;
  annotations?: ToolAnnotations;
}

/** Prefers what the server says about itself; falls back to the verb in the name. */
function isWrite(tool: AdvertisedTool): boolean {
  const hints = tool.annotations;
  if (typeof hints?.readOnlyHint === "boolean") return !hints.readOnlyHint;
  if (hints?.destructiveHint === true) return true;
  return looksMutating(tool.name);
}

export function splitTools(tools: AdvertisedTool[]): AdvertisedTools {
  const readTools: string[] = [];
  const writeTools: string[] = [];
  for (const tool of tools) {
    (isWrite(tool) ? writeTools : readTools).push(tool.name);
  }
  return {
    readTools: readTools.sort(),
    writeTools: writeTools.sort(),
    annotated: tools.some((t) => typeof t.annotations?.readOnlyHint === "boolean"),
  };
}

/**
 * Connects to a streamable-HTTP MCP server and reads its tool list. Throws with
 * a readable message; callers decide whether that is fatal.
 */
export async function listAdvertisedTools(
  url: string,
  headers: Record<string, string>,
): Promise<AdvertisedTools> {
  const client = new Client({ name: "duvo-automations", version: "1.0.0" });
  const transport = new StreamableHTTPClientTransport(new URL(url), {
    requestInit: { headers },
  });
  try {
    await client.connect(transport);
    const tools: AdvertisedTool[] = [];
    let cursor: string | undefined;
    do {
      const page = await client.listTools({ cursor }, { timeout: LIST_TIMEOUT_MS });
      tools.push(...page.tools);
      cursor = page.nextCursor;
    } while (cursor);
    return splitTools(tools);
  } finally {
    await client.close().catch(() => undefined);
  }
}
