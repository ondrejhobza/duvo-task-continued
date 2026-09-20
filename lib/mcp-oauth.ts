import { randomUUID, timingSafeEqual } from "node:crypto";
import {
  discoverOAuthServerInfo,
  exchangeAuthorization,
  refreshAuthorization,
  registerClient,
  startAuthorization,
} from "@modelcontextprotocol/sdk/client/auth.js";
import type {
  AuthorizationServerMetadata,
  OAuthClientInformation,
  OAuthTokens,
} from "@modelcontextprotocol/sdk/shared/auth.js";
import { listAdvertisedTools, type AdvertisedTools } from "@/lib/mcp-tools";
import {
  saveMcpOAuthTokens,
  saveMcpServerTools,
  setMcpAuthError,
  startMcpOAuthFlow,
  type McpServerConfigRow,
} from "@/lib/repo";

/**
 * OAuth 2.1 for remote MCP servers, per the MCP authorization spec: protected
 * resource discovery (RFC 9728), dynamic client registration (RFC 7591),
 * authorization code + PKCE, resource indicators (RFC 8707) and refresh.
 *
 * The protocol itself comes from the MCP SDK's client/auth helpers; this module
 * only supplies the persistence and the "who is asking" half that the SDK's
 * browser-oriented OAuthClientProvider cannot do for a server-rendered app.
 */

/** Refresh this long before the token actually expires so a run does not die mid-flight. */
const EXPIRY_MARGIN_MS = 5 * 60_000;

const CLIENT_NAME = "Duvo Automations";

/** Raised when a server needs the user to (re-)authorize; never crashes a run. */
export class McpAuthError extends Error {
  constructor(
    message: string,
    readonly serverName: string,
    /**
     * Set when the stored sign-in is untouched by this failure, so the caller
     * must not discard it. A callback whose `state` does not match is not the
     * flow the user started, and clearing on it would let any stray request
     * kill a legitimate sign-in that is still in progress.
     */
    readonly pendingFlowIntact = false,
  ) {
    super(message);
    this.name = "McpAuthError";
  }
}

/** The redirect URI registered with the authorization server, derived from the request. */
export function oauthCallbackUrl(origin: string, serverId: string): string {
  return `${origin}/api/mcp-servers/${serverId}/oauth/callback`;
}

/** Honours a reverse proxy so the redirect URI matches what the browser sees. */
export function requestOrigin(request: Request): string {
  const url = new URL(request.url);
  const host = request.headers.get("x-forwarded-host") ?? url.host;
  const proto = request.headers.get("x-forwarded-proto") ?? url.protocol.replace(":", "");
  return `${proto}://${host}`;
}

interface Endpoints {
  authorizationServerUrl: string;
  metadata: AuthorizationServerMetadata | undefined;
  resource: URL | undefined;
  scope: string | undefined;
}

/**
 * Discovery with fallbacks: if the server publishes neither protected-resource
 * nor authorization-server metadata, treat the MCP server itself as the
 * authorization server and let the SDK use the default endpoint paths.
 */
async function discover(server: McpServerConfigRow): Promise<Endpoints> {
  if (!server.url) {
    throw new McpAuthError(`${server.name} has no URL to authorize against.`, server.name);
  }
  try {
    const info = await discoverOAuthServerInfo(server.url);
    return {
      authorizationServerUrl: info.authorizationServerUrl,
      metadata: info.authorizationServerMetadata,
      resource: info.resourceMetadata ? new URL(info.resourceMetadata.resource) : undefined,
      scope: info.resourceMetadata?.scopes_supported?.join(" "),
    };
  } catch (error) {
    // Metadata is optional; a stored authorization server from an earlier
    // successful discovery still lets refresh and exchange work.
    if (!server.oauth.serverUrl) {
      throw new McpAuthError(
        `Could not reach ${server.name} to discover its sign-in details: ${describe(error)}`,
        server.name,
      );
    }
    return {
      authorizationServerUrl: server.oauth.serverUrl,
      metadata: undefined,
      resource: server.oauth.resource ? new URL(server.oauth.resource) : undefined,
      scope: server.oauth.scope ?? undefined,
    };
  }
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function clientInformationOf(server: McpServerConfigRow): OAuthClientInformation | null {
  if (!server.oauth.clientId) return null;
  return {
    client_id: server.oauth.clientId,
    ...(server.oauth.clientSecret ? { client_secret: server.oauth.clientSecret } : {}),
  };
}

function expiryOf(tokens: OAuthTokens): string | null {
  return tokens.expires_in ? new Date(Date.now() + tokens.expires_in * 1000).toISOString() : null;
}

/**
 * Registers a client if needed, then returns the URL the user must visit.
 * The PKCE verifier and the CSRF state are stored on the server record.
 */
export async function beginOAuth(server: McpServerConfigRow, origin: string): Promise<string> {
  const endpoints = await discover(server);
  const redirectUri = oauthCallbackUrl(origin, server.id);
  const scope = server.oauth.scope ?? endpoints.scope;

  // A client is registered per redirect URI, so a different origin re-registers.
  const existing = server.oauth.redirectUri === redirectUri ? clientInformationOf(server) : null;
  let clientInformation: OAuthClientInformation;
  if (existing) {
    clientInformation = existing;
  } else {
    if (endpoints.metadata && !endpoints.metadata.registration_endpoint) {
      throw new McpAuthError(
        `${server.name} does not support dynamic client registration. Add the credentials as headers instead.`,
        server.name,
      );
    }
    try {
      const registered = await registerClient(endpoints.authorizationServerUrl, {
        metadata: endpoints.metadata,
        clientMetadata: {
          client_name: CLIENT_NAME,
          redirect_uris: [redirectUri],
          grant_types: ["authorization_code", "refresh_token"],
          response_types: ["code"],
          token_endpoint_auth_method: "none",
          ...(scope ? { scope } : {}),
        },
        ...(scope ? { scope } : {}),
      });
      clientInformation = {
        client_id: registered.client_id,
        ...(registered.client_secret ? { client_secret: registered.client_secret } : {}),
      };
    } catch (error) {
      throw new McpAuthError(
        `${server.name} refused to register this app: ${describe(error)}`,
        server.name,
      );
    }
  }

  const state = randomUUID();
  const { authorizationUrl, codeVerifier } = await startAuthorization(
    endpoints.authorizationServerUrl,
    {
      metadata: endpoints.metadata,
      clientInformation,
      redirectUrl: redirectUri,
      state,
      ...(scope ? { scope } : {}),
      ...(endpoints.resource ? { resource: endpoints.resource } : {}),
    },
  );

  await startMcpOAuthFlow(
    server.id,
    {
      clientId: clientInformation.client_id,
      clientSecret: clientInformation.client_secret ?? null,
      serverUrl: endpoints.authorizationServerUrl,
      resource: endpoints.resource?.toString() ?? null,
      redirectUri,
      scope: scope ?? null,
    },
    { state, codeVerifier },
  );

  return authorizationUrl.toString();
}

function statesMatch(expected: string | null, received: string): boolean {
  if (!expected) return false;
  const a = Buffer.from(expected);
  const b = Buffer.from(received);
  return a.length === b.length && timingSafeEqual(a, b);
}

/** Verifies the CSRF state, then trades the authorization code for tokens. */
export async function completeOAuth(
  server: McpServerConfigRow,
  params: { code: string; state: string },
): Promise<void> {
  if (!statesMatch(server.oauth.state, params.state)) {
    throw new McpAuthError(
      `The sign-in for ${server.name} did not match the one this app started. Try again.`,
      server.name,
      true,
    );
  }
  // A server the user deliberately switched off stays off when they sign in
  // again; only a genuinely new connection turns itself on.
  const firstConnection = !server.oauth.accessToken;
  const clientInformation = clientInformationOf(server);
  if (!clientInformation || !server.oauth.codeVerifier || !server.oauth.redirectUri) {
    throw new McpAuthError(
      `The sign-in for ${server.name} expired. Start it again.`,
      server.name,
    );
  }

  const endpoints = await discover(server);
  try {
    const tokens = await exchangeAuthorization(endpoints.authorizationServerUrl, {
      metadata: endpoints.metadata,
      clientInformation,
      authorizationCode: params.code,
      codeVerifier: server.oauth.codeVerifier,
      redirectUri: server.oauth.redirectUri,
      ...(endpoints.resource ? { resource: endpoints.resource } : {}),
    });
    await saveMcpOAuthTokens(
      server.id,
      {
        accessToken: tokens.access_token,
        refreshToken: tokens.refresh_token ?? null,
        expiresAt: expiryOf(tokens),
      },
      { enable: firstConnection },
    );
    // Now that there is a token, ask the server what it actually offers, so the
    // settings dialog shows this connection's real tools rather than a guess.
    await refreshAdvertisedTools(server, tokens.access_token);
  } catch (error) {
    const message = `${server.name} rejected the authorization code: ${describe(error)}`;
    await setMcpAuthError(server.id, message);
    throw new McpAuthError(message, server.name);
  }
}

/**
 * RFC 8414 allows `revocation_endpoint` and Notion publishes one, but the SDK's
 * metadata type does not declare it, so it is read off the parsed document.
 */
function revocationEndpointOf(metadata: AuthorizationServerMetadata | undefined): string | undefined {
  const value = (metadata as Record<string, unknown> | undefined)?.revocation_endpoint;
  return typeof value === "string" ? value : undefined;
}

/**
 * Withdraws the grant at the authorization server (RFC 7009) before the local
 * credentials are deleted. Returns null when there is nothing left to withdraw,
 * or a sentence telling the user where to finish the job by hand: losing the
 * local tokens must never be blocked on the remote server cooperating.
 */
export async function revokeOAuthGrant(server: McpServerConfigRow): Promise<string | null> {
  const { accessToken, refreshToken, clientId, clientSecret } = server.oauth;
  const token = refreshToken ?? accessToken;
  if (!token || !clientId) return null;

  let endpoint: string | undefined;
  try {
    endpoint = revocationEndpointOf((await discover(server)).metadata);
  } catch {
    endpoint = undefined;
  }
  if (!endpoint) {
    return `${server.name} does not offer a way to withdraw access remotely. The credentials here are gone; remove this app in your ${server.name} account settings to revoke it there too.`;
  }

  try {
    const body = new URLSearchParams({
      token,
      token_type_hint: refreshToken ? "refresh_token" : "access_token",
      client_id: clientId,
    });
    if (clientSecret) body.set("client_secret", clientSecret);
    const response = await fetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body,
    });
    if (!response.ok) throw new Error(`the server answered ${response.status}`);
    return null;
  } catch (error) {
    return `Could not ask ${server.name} to withdraw access (${describe(error)}). The credentials here are gone, but the grant may still exist; remove this app in your ${server.name} account settings.`;
  }
}

/**
 * Re-reads the tool list a remote server advertises, with a live token, and
 * caches it. Best effort on purpose: a server that will not answer right now
 * must not break a sign-in or a run, so the last known list stands.
 */
export async function refreshAdvertisedTools(
  server: McpServerConfigRow,
  accessToken: string,
): Promise<AdvertisedTools | null> {
  if (server.transport !== "http" || !server.url) return null;
  try {
    const tools = await listAdvertisedTools(server.url, {
      ...server.headers,
      Authorization: `Bearer ${accessToken}`,
    });
    await saveMcpServerTools(server.id, tools);
    return tools;
  } catch {
    return null;
  }
}

function expiringSoon(expiresAt: string | null): boolean {
  if (!expiresAt) return false;
  return new Date(expiresAt).getTime() - Date.now() < EXPIRY_MARGIN_MS;
}

/**
 * The bearer token to send with MCP requests, refreshed when it is close to
 * expiry. Throws McpAuthError when the user has to sign in again.
 */
export async function bearerTokenFor(server: McpServerConfigRow): Promise<string> {
  const { accessToken, refreshToken } = server.oauth;
  if (!accessToken) {
    throw new McpAuthError(`${server.name} is not signed in yet.`, server.name);
  }
  if (!expiringSoon(server.oauth.expiresAt)) return accessToken;

  const clientInformation = clientInformationOf(server);
  if (!refreshToken || !clientInformation) {
    const message = `The ${server.name} session expired. Sign in again.`;
    await setMcpAuthError(server.id, message);
    throw new McpAuthError(message, server.name);
  }

  const endpoints = await discover(server);
  try {
    const tokens = await refreshAuthorization(endpoints.authorizationServerUrl, {
      metadata: endpoints.metadata,
      clientInformation,
      refreshToken,
      ...(endpoints.resource ? { resource: endpoints.resource } : {}),
    });
    await saveMcpOAuthTokens(server.id, {
      accessToken: tokens.access_token,
      refreshToken: tokens.refresh_token ?? refreshToken,
      expiresAt: expiryOf(tokens),
    });
    return tokens.access_token;
  } catch (error) {
    const message = `${server.name} refused to refresh the session (${describe(error)}). Sign in again.`;
    await setMcpAuthError(server.id, message);
    throw new McpAuthError(message, server.name);
  }
}
