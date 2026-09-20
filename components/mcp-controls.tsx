"use client";

import { useEffect, useRef, useState, type FormEvent } from "react";
import Image from "next/image";
import { useRouter } from "next/navigation";
import {
  AlertTriangle,
  ChevronDown,
  KeyRound,
  Loader2,
  Plug,
  PlugZap,
  Settings2,
  Trash2,
  Unplug,
} from "lucide-react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import {
  catalogueEntryFor,
  MCP_CATALOGUE,
  type McpCatalogueEntry,
} from "@/lib/mcp-catalogue";
import {
  mcpServerSchema,
  oauthDisconnectResponseSchema,
  oauthStartResponseSchema,
  NOTION_REMOTE_URL,
  type CreateMcpServerInput,
  type McpServer,
} from "@/lib/schema";

/**
 * A catalogue entry's mark on a raised tile, one size for every entry so a
 * brand logo and a fallback glyph share an optical baseline. The tile is
 * `bg-card` — a token, and a step above the `bg-muted/40` row it sits on —
 * rather than a hardcoded white: every vendored mark is either multi-colour or
 * carries its own light fill (Notion's page is `#FFF`), so none of them needs a
 * light backdrop to stay legible in dark mode. `unoptimized` serves the
 * vendored SVG straight from `public/` instead of the image pipeline.
 */
function McpLogo({ entry }: { entry: McpCatalogueEntry | undefined }) {
  const Fallback = entry?.icon ?? Plug;
  return (
    <span className="flex size-7 shrink-0 items-center justify-center rounded-md border bg-card">
      {entry?.logo ? (
        <Image
          src={entry.logo}
          alt=""
          width={16}
          height={16}
          unoptimized
          className="size-4 object-contain"
        />
      ) : (
        <Fallback className="size-4 text-muted-foreground" />
      )}
    </span>
  );
}

async function readError(response: Response): Promise<string> {
  try {
    const body: unknown = await response.json();
    if (body && typeof body === "object" && "error" in body) {
      const issues =
        "issues" in body && Array.isArray(body.issues)
          ? body.issues
              .map((i: { message?: string }) => i.message)
              .filter(Boolean)
              .join(" ")
          : "";
      return issues || String(body.error);
    }
  } catch {
    // fall through
  }
  return `Request failed (${response.status})`;
}

/** Sends the browser to the consent screen; throws with a readable message. */
async function startOauth(serverId: string): Promise<void> {
  const response = await fetch(`/api/mcp-servers/${serverId}/oauth`, { method: "POST" });
  if (!response.ok) throw new Error(await readError(response));
  const parsed = oauthStartResponseSchema.safeParse(await response.json());
  if (!parsed.success) throw new Error("Unexpected response from server");
  window.location.assign(parsed.data.authorizeUrl);
}

/**
 * Turns the callback's redirect into a toast, then cleans the URL. Reads the
 * query from the browser rather than useSearchParams so the component can be
 * rendered on any page without a Suspense boundary.
 */
function useOauthResult(): void {
  const router = useRouter();
  const handled = useRef(false);

  useEffect(() => {
    if (handled.current) return;
    const params = new URLSearchParams(window.location.search);
    const result = params.get("mcpAuth");
    if (!result) return;
    handled.current = true;

    if (result === "connected") {
      toast.success(`${params.get("mcpServer") ?? "MCP server"} connected`);
    } else {
      toast.error(params.get("mcpMessage") ?? "Could not connect the MCP server");
    }

    for (const key of ["mcpAuth", "mcpServer", "mcpMessage"]) params.delete(key);
    const query = params.toString();
    router.replace(query ? `${window.location.pathname}?${query}` : window.location.pathname, {
      scroll: false,
    });
    router.refresh();
  }, [router]);
}

function accessLabel(server: McpServer): string {
  if (server.allowedTools.length === 0 && server.writeTools.length === 0) return "all tools";
  return server.allowWrites ? "read + write" : "read-only";
}

function needsAttention(server: McpServer): boolean {
  return server.authStatus === "needs_auth" || server.authStatus === "error";
}

function McpServerDialog({ server, disabled }: { server: McpServer; disabled: boolean }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [allowWrites, setAllowWrites] = useState(server.allowWrites);
  const [confirmingWrites, setConfirmingWrites] = useState(false);
  const [confirmingRemoval, setConfirmingRemoval] = useState(false);

  const hasWriteTools = server.writeTools.length > 0;
  const isOauth = server.authMode === "oauth";
  const isConnected = server.authStatus === "connected";

  async function setWrites(next: boolean) {
    const previous = allowWrites;
    setAllowWrites(next);
    setConfirmingWrites(false);
    setSaving(true);
    try {
      const response = await fetch(`/api/mcp-servers/${server.id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ allowWrites: next }),
      });
      if (!response.ok) throw new Error(await readError(response));
      toast.success(next ? `${server.name} can now write` : `${server.name} is read-only again`);
      router.refresh();
    } catch (error) {
      setAllowWrites(previous);
      toast.error(error instanceof Error ? error.message : "Could not change the write setting");
    } finally {
      setSaving(false);
    }
  }

  /**
   * Drops the account: the grant is withdrawn where the server allows it, and
   * the tokens and client registration are deleted. Distinct from the on/off
   * switch, which keeps everything and only stops offering tools to runs.
   */
  async function removeConnection() {
    setConfirmingRemoval(false);
    setSaving(true);
    try {
      const response = await fetch(`/api/mcp-servers/${server.id}/oauth`, { method: "DELETE" });
      if (!response.ok) throw new Error(await readError(response));
      const parsed = oauthDisconnectResponseSchema.safeParse(await response.json());
      const warning = parsed.success ? parsed.data.warning : null;
      if (warning) {
        toast.warning(warning);
      } else {
        toast.success(`Removed the ${server.name} connection`);
      }
      setOpen(false);
      router.refresh();
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : "Could not remove the connection",
      );
    } finally {
      setSaving(false);
    }
  }

  async function connect() {
    setSaving(true);
    try {
      await startOauth(server.id);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Could not start the sign-in");
      setSaving(false);
      router.refresh();
    }
  }

  /** Removes the whole server row. Only offered for servers we added by hand. */
  async function remove() {
    setConfirmingRemoval(false);
    setSaving(true);
    try {
      const response = await fetch(`/api/mcp-servers/${server.id}`, { method: "DELETE" });
      if (!response.ok) throw new Error(await readError(response));
      toast.success(`${server.name} removed`);
      setOpen(false);
      router.refresh();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Could not remove the MCP server");
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger
        render={<Button type="button" variant="ghost" size="icon-xs" disabled={disabled} />}
        aria-label={`Settings for ${server.name} MCP`}
      >
        <Settings2 />
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{server.name} MCP</DialogTitle>
          <DialogDescription>
            {server.url ?? server.command ?? "Local MCP server"}
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-4">
          {server.authMode === "oauth" && (
            <div className="flex flex-col gap-3 rounded-lg border bg-muted/40 p-3">
              <div className="flex items-center justify-between gap-3">
                <div className="flex flex-col">
                  <p className="text-sm font-medium">Account</p>
                  <span className="text-xs text-muted-foreground">
                    {isConnected
                      ? "Signed in with OAuth. Tokens stay on this machine. Turning the server off keeps them."
                      : "Sign in with OAuth to let the agent use this server."}
                  </span>
                </div>
                {!isConnected && (
                  <Button type="button" size="sm" onClick={() => void connect()} disabled={saving}>
                    {saving ? <Loader2 className="animate-spin" /> : <KeyRound />}
                    Sign in
                  </Button>
                )}
              </div>
              {server.authError && (
                <p className="text-xs text-destructive">{server.authError}</p>
              )}
            </div>
          )}

          <div className="flex flex-col gap-3 rounded-lg border bg-muted/40 p-3">
            <div className="flex items-center justify-between gap-3">
              <div className="flex flex-col">
                <Label htmlFor={`writes-${server.id}`}>Allow writes</Label>
                <span className="text-xs text-muted-foreground">
                  {hasWriteTools
                    ? `${server.writeTools.length} tools that create, change or delete things in ${server.name}.`
                    : "This server has no separate write tools; the agent gets everything it exposes."}
                </span>
              </div>
              <Switch
                id={`writes-${server.id}`}
                checked={allowWrites || confirmingWrites}
                onCheckedChange={(next) =>
                  next ? setConfirmingWrites(true) : void setWrites(false)
                }
                disabled={saving || !hasWriteTools}
              />
            </div>
            {confirmingWrites && (
              <div className="flex flex-col gap-2 rounded-lg border bg-card p-3">
                <p className="flex items-center gap-2 text-sm font-medium">
                  <AlertTriangle className="size-4 text-destructive" />
                  Let runs change your {server.name} data?
                </p>
                <p className="text-xs text-muted-foreground">
                  The agent runs unattended. Anything it creates, edits or deletes in{" "}
                  {server.name} cannot be undone from here.
                </p>
                <div className="flex justify-end gap-2">
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    onClick={() => setConfirmingWrites(false)}
                    disabled={saving}
                  >
                    Cancel
                  </Button>
                  <Button
                    type="button"
                    variant="destructive"
                    size="sm"
                    onClick={() => void setWrites(true)}
                    disabled={saving}
                  >
                    Allow writes
                  </Button>
                </div>
              </div>
            )}
          </div>

          <div className="flex flex-col gap-3 rounded-lg border bg-muted/40 p-3">
            <div className="flex items-center justify-between gap-3">
              <div className="flex flex-col">
                <p className="text-sm font-medium">
                  {isOauth ? "Remove connection" : "Remove server"}
                </p>
                <span className="text-xs text-muted-foreground">
                  {isOauth
                    ? "Withdraws access and deletes the stored credentials. Signing in again starts from scratch."
                    : "Removes the server and any stored credentials."}
                </span>
              </div>
              <Button
                type="button"
                variant="destructive"
                size="sm"
                onClick={() => setConfirmingRemoval(true)}
                disabled={saving || confirmingRemoval}
              >
                {saving ? <Loader2 className="animate-spin" /> : isOauth ? <Unplug /> : <Trash2 />}
                Remove
              </Button>
            </div>
            {confirmingRemoval && (
              <div className="flex flex-col gap-2 rounded-lg border bg-card p-3">
                <p className="flex items-center gap-2 text-sm font-medium">
                  <AlertTriangle className="size-4 text-destructive" />
                  {isOauth
                    ? `Remove the ${server.name} connection?`
                    : `Remove ${server.name}?`}
                </p>
                <p className="text-xs text-muted-foreground">
                  {isOauth
                    ? `This cannot be undone from here: you would sign in to ${server.name} again to restore it. To keep the connection and just stop runs using it, close this and switch the server off instead.`
                    : `Runs will no longer be able to use ${server.name}.`}
                </p>
                <div className="flex justify-end gap-2">
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    onClick={() => setConfirmingRemoval(false)}
                    disabled={saving}
                  >
                    Cancel
                  </Button>
                  <Button
                    type="button"
                    variant="destructive"
                    size="sm"
                    onClick={() => void (isOauth ? removeConnection() : remove())}
                    disabled={saving}
                  >
                    {saving ? <Loader2 className="animate-spin" /> : null}
                    {isOauth ? "Remove connection" : "Remove server"}
                  </Button>
                </div>
              </div>
            )}
          </div>
        </div>

        <DialogFooter>
          <Button type="button" variant="ghost" onClick={() => setOpen(false)} disabled={saving}>
            Close
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/**
 * One place for MCP: what is connected (and its settings) above what could be
 * connected. Catalogue entries that are not built yet are shown as unavailable
 * rather than hidden, so the directory reads as a roadmap instead of a dead end.
 *
 * This is the only MCP control in the composer, so its trigger carries the
 * count that used to be visible per server. The full state, including any
 * server needing a sign-in, stays in the trigger's accessible name and in the
 * rows below; the control row itself is kept quiet on purpose.
 */
export function McpDirectoryDialog({
  servers,
  disabled,
}: {
  servers: McpServer[];
  disabled: boolean;
}) {
  useOauthResult();
  const [open, setOpen] = useState(false);
  const [showCustom, setShowCustom] = useState(false);

  // An entry already backed by a server belongs under "Connected", not here.
  const connectedIds = new Set(
    servers.flatMap((s) => {
      const entry = catalogueEntryFor(s);
      return entry ? [entry.id] : [];
    }),
  );
  const available = MCP_CATALOGUE.filter((entry) => !connectedIds.has(entry.id));

  const attention = servers.filter(needsAttention);
  const active = servers.filter((s) => s.enabled && !needsAttention(s));
  // "Connect MCP" stops being true the moment something is connected, so the
  // label becomes the neutral noun and the count carries the state.
  const label = servers.length === 0 ? "Connect MCP" : "MCP";
  const summary =
    servers.length === 0
      ? "No MCP servers connected"
      : [
          `${active.length} of ${servers.length} MCP server${servers.length === 1 ? "" : "s"} on`,
          attention.length > 0 ? `${attention.length} needs attention` : null,
        ]
          .filter(Boolean)
          .join(", ");

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger
        render={<Button type="button" variant="outline" size="sm" disabled={disabled} />}
        aria-label={`${label}. ${summary}`}
      >
        <Plug />
        {label}
        {active.length > 0 && (
          <Badge variant="secondary" className="tabular-nums">
            {active.length}
          </Badge>
        )}
      </DialogTrigger>
      <DialogContent className="max-h-[85vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>MCP servers</DialogTitle>
          <DialogDescription>
            Connected servers give the agent their tools on the next run, read-only until you
            allow writes. Signing in happens in the browser; nothing is stored there.
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-5">
          <section className="flex flex-col gap-2">
            <h3 className="text-sm font-medium">Connected</h3>
            {servers.length === 0 ? (
              <div className="flex flex-col items-center gap-1 rounded-lg border bg-muted/40 p-6 text-center">
                <p className="text-sm font-medium">No MCP servers yet</p>
                <p className="text-xs text-muted-foreground">
                  Connect one below to give the agent tools beyond the web and its own files.
                </p>
              </div>
            ) : (
              <div className="flex flex-col gap-2">
                {servers.map((server) => (
                  // Keyed on the auth status so a sign-in that lands while the
                  // dialog is open remounts the row with the new state.
                  <ConnectedServerRow
                    key={`${server.id}:${server.authStatus}`}
                    server={server}
                    disabled={disabled}
                  />
                ))}
              </div>
            )}
          </section>

          <section className="flex flex-col gap-2">
            <h3 className="text-sm font-medium">Available</h3>
            {available.length === 0 ? (
              <div className="rounded-lg border bg-muted/40 p-6 text-center">
                <p className="text-xs text-muted-foreground">
                  Everything in the directory is already connected.
                </p>
              </div>
            ) : (
              <div className="flex flex-col gap-2">
                {available.map((entry) => (
                  <CatalogueRow key={entry.id} entry={entry} disabled={disabled} />
                ))}
              </div>
            )}
          </section>

          <Collapsible open={showCustom} onOpenChange={setShowCustom}>
            <CollapsibleTrigger
              render={<Button type="button" variant="ghost" size="sm" className="w-full" />}
            >
              <ChevronDown
                className={showCustom ? "rotate-180 transition-transform" : "transition-transform"}
              />
              Add a server by URL
            </CollapsibleTrigger>
            <CollapsibleContent className="pt-3">
              <CustomServerForm
                takenKeys={servers.map((s) => s.key)}
                onDone={() => setOpen(false)}
              />
            </CollapsibleContent>
          </Collapsible>
        </div>

        <DialogFooter>
          <Button type="button" variant="ghost" onClick={() => setOpen(false)}>
            Close
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** A connected server: switch it off without losing the connection, or open its settings. */
function ConnectedServerRow({ server, disabled }: { server: McpServer; disabled: boolean }) {
  const router = useRouter();
  const [enabled, setEnabled] = useState(server.enabled);
  const [saving, setSaving] = useState(false);
  const entry = catalogueEntryFor(server);
  const needsAuth = needsAttention(server);

  async function toggle(next: boolean) {
    const previous = enabled;
    setEnabled(next);
    setSaving(true);
    try {
      const response = await fetch(`/api/mcp-servers/${server.id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ enabled: next }),
      });
      if (!response.ok) throw new Error(await readError(response));
      router.refresh();
    } catch (error) {
      setEnabled(previous);
      toast.error(error instanceof Error ? error.message : "Could not update the MCP server");
    } finally {
      setSaving(false);
    }
  }

  async function connect() {
    setSaving(true);
    try {
      await startOauth(server.id);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Could not start the sign-in");
      setSaving(false);
      router.refresh();
    }
  }

  return (
    <div className="flex items-center gap-3 rounded-lg border bg-muted/40 p-3">
      <McpLogo entry={entry} />
      <div className="flex min-w-0 flex-col">
        <p className="truncate text-sm font-medium">{server.name}</p>
        <span className="truncate text-xs text-muted-foreground">
          {needsAuth
            ? server.authStatus === "error"
              ? "Sign-in failed"
              : "Not signed in"
            : enabled
              ? `On · ${accessLabel(server)}`
              : "Off · connection kept"}
        </span>
      </div>
      <div className="ml-auto flex items-center gap-2">
        {needsAuth ? (
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => void connect()}
            disabled={disabled || saving}
          >
            {saving ? <Loader2 className="animate-spin" /> : <KeyRound />}
            Sign in
          </Button>
        ) : (
          <Switch
            checked={enabled}
            onCheckedChange={(next) => void toggle(next)}
            disabled={disabled || saving}
            aria-label={`Use ${server.name} MCP on the next run`}
          />
        )}
        <McpServerDialog server={server} disabled={disabled || saving} />
      </div>
    </div>
  );
}

/** A directory entry. Everything except Notion is a signpost, and says so. */
function CatalogueRow({
  entry,
  disabled,
}: {
  entry: McpCatalogueEntry;
  disabled: boolean;
}) {
  const router = useRouter();
  const [saving, setSaving] = useState(false);

  async function connect() {
    if (!entry.url) return;
    setSaving(true);
    try {
      const input: CreateMcpServerInput = {
        key: entry.id,
        name: entry.name,
        transport: "http",
        url: entry.url,
        args: [],
        env: {},
        headers: {},
        allowedTools: [],
        writeTools: [],
        allowWrites: false,
        authMode: "oauth",
      };
      const response = await fetch("/api/mcp-servers", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(input),
      });
      if (!response.ok) throw new Error(await readError(response));
      const body: unknown = await response.json();
      const parsed = mcpServerSchema.safeParse((body as { server?: unknown }).server);
      if (!parsed.success) throw new Error("Unexpected response from server");
      await startOauth(parsed.data.id);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : `Could not connect ${entry.name}`);
      setSaving(false);
      router.refresh();
    }
  }

  return (
    <div className="flex items-center gap-3 rounded-lg border bg-muted/40 p-3">
      <span className={entry.available ? undefined : "opacity-60"}>
        <McpLogo entry={entry} />
      </span>
      <div className="flex min-w-0 flex-col">
        <p className="truncate text-sm font-medium">{entry.name}</p>
        <span className="truncate text-xs text-muted-foreground">{entry.description}</span>
      </div>
      <div className="ml-auto">
        {entry.available ? (
          <Button
            type="button"
            size="sm"
            onClick={() => void connect()}
            disabled={disabled || saving}
          >
            {saving ? <Loader2 className="animate-spin" /> : <KeyRound />}
            Connect
          </Button>
        ) : (
          <Badge variant="outline">Soon</Badge>
        )}
      </div>
    </div>
  );
}

/**
 * The escape hatch for anything not in the directory. Remote and OAuth only:
 * a server reports its own tools once a token exists, so there is nothing to
 * preset and no credential to paste here.
 */
function CustomServerForm({
  takenKeys,
  onDone,
}: {
  takenKeys: string[];
  onDone: () => void;
}) {
  const [saving, setSaving] = useState(false);
  const [name, setName] = useState("Notion");
  const [key, setKey] = useState("notion");
  const [url, setUrl] = useState(NOTION_REMOTE_URL);

  const keyTaken = takenKeys.includes(key);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (saving) return;
    setSaving(true);
    try {
      const input: CreateMcpServerInput = {
        key,
        name,
        allowedTools: [],
        writeTools: [],
        allowWrites: false,
        transport: "http",
        url,
        args: [],
        env: {},
        headers: {},
        authMode: "oauth",
      };
      const response = await fetch("/api/mcp-servers", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(input),
      });
      if (!response.ok) throw new Error(await readError(response));
      const body: unknown = await response.json();
      const parsed = mcpServerSchema.safeParse((body as { server?: unknown }).server);
      if (!parsed.success) throw new Error("Unexpected response from server");
      onDone();
      await startOauth(parsed.data.id);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Could not connect the MCP server");
      setSaving(false);
    }
  }

  return (
    <form onSubmit={handleSubmit} className="flex flex-col gap-3">
      <div className="grid gap-3 sm:grid-cols-2">
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="mcp-name">Name</Label>
          <Input id="mcp-name" value={name} onChange={(e) => setName(e.target.value)} required />
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="mcp-key">Key</Label>
          <Input
            id="mcp-key"
            value={key}
            onChange={(e) => setKey(e.target.value.toLowerCase())}
            pattern="[a-z][a-z0-9-]*"
            className="font-mono text-xs"
            required
          />
        </div>
      </div>

      <div className="flex flex-col gap-1.5">
        <Label htmlFor="mcp-url">Server URL</Label>
        <Input
          id="mcp-url"
          type="url"
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          className="font-mono text-xs"
          required
        />
        <p className="text-xs text-muted-foreground">
          Connecting opens the server&apos;s consent screen and returns here.
        </p>
      </div>

      {keyTaken && (
        <p className="text-sm text-destructive">
          The key &quot;{key}&quot; is already connected; pick another one.
        </p>
      )}

      <div className="flex justify-end">
        <Button type="submit" size="sm" disabled={saving || keyTaken}>
          {saving ? <Loader2 className="animate-spin" /> : <PlugZap />}
          {saving ? "Connecting…" : "Connect server"}
        </Button>
      </div>
    </form>
  );
}
