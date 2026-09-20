import { NextResponse } from "next/server";
import { completeOAuth, McpAuthError, requestOrigin } from "@/lib/mcp-oauth";
import { getMcpServerConfig, setMcpAuthError } from "@/lib/repo";
import { oauthCallbackQuerySchema } from "@/lib/schema";

/** Where the user lands after the consent screen, successfully or not. */
function back(origin: string, params: Record<string, string>): NextResponse {
  const url = new URL("/", origin);
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
  return NextResponse.redirect(url);
}

export async function GET(
  request: Request,
  ctx: RouteContext<"/api/mcp-servers/[id]/oauth/callback">,
): Promise<NextResponse> {
  const { id } = await ctx.params;
  const origin = requestOrigin(request);

  const server = await getMcpServerConfig(id);
  if (!server) {
    return back(origin, { mcpAuth: "error", mcpMessage: "That MCP server no longer exists." });
  }

  const parsed = oauthCallbackQuerySchema.safeParse(
    Object.fromEntries(new URL(request.url).searchParams),
  );
  if (!parsed.success) {
    const message = `${server.name} sent back an unreadable response.`;
    await setMcpAuthError(id, message);
    return back(origin, { mcpAuth: "error", mcpMessage: message });
  }

  const query = parsed.data;
  if (query.error) {
    // Includes the user pressing "cancel" on the consent screen.
    const message =
      query.error === "access_denied"
        ? `Sign-in to ${server.name} was cancelled.`
        : `${server.name} refused the sign-in: ${query.error_description ?? query.error}`;
    await setMcpAuthError(id, message);
    return back(origin, { mcpAuth: "error", mcpMessage: message });
  }

  if (!query.code || !query.state) {
    const message = `${server.name} sent back an incomplete sign-in.`;
    await setMcpAuthError(id, message);
    return back(origin, { mcpAuth: "error", mcpMessage: message });
  }

  try {
    await completeOAuth(server, { code: query.code, state: query.state });
    return back(origin, { mcpAuth: "connected", mcpServer: server.name });
  } catch (error) {
    const message =
      error instanceof McpAuthError
        ? error.message
        : `Could not finish the sign-in to ${server.name}.`;
    // A mismatched state belongs to some other request; the sign-in the user
    // actually started is still pending and stays untouched.
    if (!(error instanceof McpAuthError && error.pendingFlowIntact)) {
      await setMcpAuthError(id, message);
    }
    return back(origin, { mcpAuth: "error", mcpMessage: message });
  }
}
