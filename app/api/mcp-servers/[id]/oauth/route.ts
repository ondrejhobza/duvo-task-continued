import { NextResponse } from "next/server";
import { beginOAuth, McpAuthError, requestOrigin, revokeOAuthGrant } from "@/lib/mcp-oauth";
import { getMcpServerConfig, removeMcpOAuthConnection, setMcpAuthError } from "@/lib/repo";

/** Starts the OAuth flow and hands the browser the URL to send the user to. */
export async function POST(
  request: Request,
  ctx: RouteContext<"/api/mcp-servers/[id]/oauth">,
): Promise<NextResponse> {
  const { id } = await ctx.params;
  const server = await getMcpServerConfig(id);
  if (!server) {
    return NextResponse.json({ error: "MCP server not found" }, { status: 404 });
  }
  if (server.authMode !== "oauth") {
    return NextResponse.json(
      { error: `${server.name} does not use OAuth.` },
      { status: 409 },
    );
  }

  try {
    const authorizeUrl = await beginOAuth(server, requestOrigin(request));
    return NextResponse.json({ authorizeUrl });
  } catch (error) {
    const message =
      error instanceof McpAuthError
        ? error.message
        : `Could not start sign-in for ${server.name}.`;
    await setMcpAuthError(id, message);
    return NextResponse.json({ error: message }, { status: 502 });
  }
}

/**
 * Removes the connection entirely: the grant is withdrawn at the authorization
 * server where possible, then the tokens, the registered client and the
 * discovered tool list are deleted. Switching a server off is a different
 * thing and lives on PATCH /api/mcp-servers/[id].
 */
export async function DELETE(
  _request: Request,
  ctx: RouteContext<"/api/mcp-servers/[id]/oauth">,
): Promise<NextResponse> {
  const { id } = await ctx.params;
  const server = await getMcpServerConfig(id);
  if (!server) {
    return NextResponse.json({ error: "MCP server not found" }, { status: 404 });
  }
  // A refusal here must not strand the user with credentials they cannot drop.
  const warning = await revokeOAuthGrant(server);
  await removeMcpOAuthConnection(id);
  return NextResponse.json({ warning });
}
