/**
 * OAuth hardening helpers for the HTTP connector mode.
 *
 * - Registered clients persist to CLIENTS_FILE (0600) with a SHA-256 of the
 *   client secret only, so a restart no longer drops every registration.
 * - /oauth/authorize: registered client_id, exact redirect_uri match, PKCE S256.
 * - /oauth/token: client authentication, code bound to client + redirect_uri,
 *   PKCE verifier check.
 * - Session entries gain optional kind / session_expires_at / client_id fields.
 *   Entries written before this change have none of them ("legacy"); they are
 *   never rewritten here. OAUTH_LEGACY_SESSIONS=deny rejects them instead.
 */

import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';
import type { StoredTokens } from './freshbooks/types.js';

export const AUTH_METHODS = ['client_secret_post', 'client_secret_basic', 'none'] as const;
export type AuthMethod = (typeof AUTH_METHODS)[number];

export interface RegisteredClient {
  client_id: string;
  client_secret_sha256: string;
  redirect_uris: string[];
  client_name?: string;
  token_endpoint_auth_method: AuthMethod;
  created_at: number;
}

export class OAuthError extends Error {
  constructor(
    public status: number,
    public error: string,
    public description: string
  ) {
    super(description);
  }
}

const sha256hex = (s: string) => createHash('sha256').update(s, 'utf8').digest('hex');

function safeEqualHex(a: string, b: string): boolean {
  const ab = Buffer.from(a, 'hex');
  const bb = Buffer.from(b, 'hex');
  return ab.length === bb.length && ab.length > 0 && timingSafeEqual(ab, bb);
}

function intEnv(name: string, fallback: number): number {
  const v = Number.parseInt(process.env[name] ?? '', 10);
  return Number.isFinite(v) && v > 0 ? v : fallback;
}

export const oauthSettings = {
  /** Bearer session lifetime (default 12 h). */
  get sessionTtlMs() {
    return intEnv('SESSION_TTL_SECONDS', 12 * 3600) * 1000;
  },
  /** Refresh token lifetime (default 30 days). */
  get refreshTtlMs() {
    return intEnv('REFRESH_TTL_SECONDS', 30 * 24 * 3600) * 1000;
  },
  /** allow (default): entries written before this change keep working. deny: reject them. */
  get legacySessions(): 'allow' | 'deny' {
    return (process.env.OAUTH_LEGACY_SESSIONS ?? '').trim().toLowerCase() === 'deny' ? 'deny' : 'allow';
  },
  get clientsFile() {
    return process.env.CLIENTS_FILE ?? join(homedir(), '.freshbooks-mcp', 'clients.json');
  },
};

// ── Client registry ─────────────────────────────────────────────────────────

function loadClients(): Record<string, RegisteredClient> {
  try {
    return JSON.parse(readFileSync(oauthSettings.clientsFile, 'utf8')) as Record<string, RegisteredClient>;
  } catch {
    return {};
  }
}

function saveClients(data: Record<string, RegisteredClient>): void {
  const file = oauthSettings.clientsFile;
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(data, null, 2), { mode: 0o600 });
}

function isAbsoluteHttpUrl(u: unknown): u is string {
  if (typeof u !== 'string') return false;
  try {
    const parsed = new URL(u);
    return (parsed.protocol === 'https:' || parsed.protocol === 'http:') && !parsed.hash;
  } catch {
    return false;
  }
}

export function registerClient(body: Record<string, unknown>): { client: RegisteredClient; client_secret: string } {
  const uris = body.redirect_uris;
  if (!Array.isArray(uris) || uris.length === 0 || !uris.every(isAbsoluteHttpUrl)) {
    throw new OAuthError(400, 'invalid_redirect_uri', 'redirect_uris must be a non-empty list of absolute http(s) URLs');
  }
  const method = (body.token_endpoint_auth_method ?? 'client_secret_post') as AuthMethod;
  if (!AUTH_METHODS.includes(method)) {
    throw new OAuthError(400, 'invalid_client_metadata', 'unsupported token_endpoint_auth_method');
  }
  const client_secret = randomUUID();
  const client: RegisteredClient = {
    client_id: randomUUID(),
    client_secret_sha256: sha256hex(client_secret),
    redirect_uris: uris as string[],
    client_name: typeof body.client_name === 'string' ? body.client_name : undefined,
    token_endpoint_auth_method: method,
    created_at: Date.now(),
  };
  const all = loadClients();
  all[client.client_id] = client;
  saveClients(all);
  return { client, client_secret };
}

export function getClient(clientId: unknown): RegisteredClient | undefined {
  if (typeof clientId !== 'string' || clientId === '') return undefined;
  return loadClients()[clientId];
}

/** Client authentication at /oauth/token (client_secret_post, client_secret_basic, or none). */
export function authenticateClient(
  body: Record<string, unknown>,
  authorizationHeader: string | undefined
): RegisteredClient {
  let clientId = typeof body.client_id === 'string' ? body.client_id : undefined;
  let secret = typeof body.client_secret === 'string' ? body.client_secret : undefined;
  const basic = /^Basic (.+)$/i.exec(authorizationHeader ?? '');
  if (basic) {
    const decoded = Buffer.from(basic[1], 'base64').toString('utf8');
    const idx = decoded.indexOf(':');
    if (idx > 0) {
      clientId = decodeURIComponent(decoded.slice(0, idx));
      secret = decodeURIComponent(decoded.slice(idx + 1));
    }
  }
  const client = getClient(clientId);
  if (!client) throw new OAuthError(401, 'invalid_client', 'Unknown client_id');
  if (client.token_endpoint_auth_method === 'none') return client;
  if (!secret || !safeEqualHex(sha256hex(secret), client.client_secret_sha256)) {
    throw new OAuthError(401, 'invalid_client', 'Client authentication failed');
  }
  return client;
}

// ── Authorize + PKCE ────────────────────────────────────────────────────────

export interface PendingAuthorization {
  client_id: string;
  redirect_uri: string;
  state: string;
  code_challenge: string;
}

const PKCE_CHALLENGE = /^[A-Za-z0-9_-]{43,128}$/;
const PKCE_VERIFIER = /^[A-Za-z0-9._~-]{43,128}$/;

export function validateAuthorizeRequest(q: Record<string, unknown>): PendingAuthorization {
  if (q.response_type !== undefined && q.response_type !== 'code') {
    throw new OAuthError(400, 'unsupported_response_type', 'Only response_type=code is supported');
  }
  const client = getClient(q.client_id);
  if (!client) throw new OAuthError(400, 'invalid_client', 'Unknown client_id');
  if (typeof q.redirect_uri !== 'string' || !client.redirect_uris.includes(q.redirect_uri)) {
    throw new OAuthError(400, 'invalid_request', 'redirect_uri does not exactly match a registered redirect_uri');
  }
  if (typeof q.code_challenge !== 'string' || !PKCE_CHALLENGE.test(q.code_challenge)) {
    throw new OAuthError(400, 'invalid_request', 'PKCE code_challenge is required');
  }
  if (q.code_challenge_method !== 'S256') {
    throw new OAuthError(400, 'invalid_request', 'code_challenge_method must be S256');
  }
  return {
    client_id: client.client_id,
    redirect_uri: q.redirect_uri,
    state: typeof q.state === 'string' ? q.state : '',
    code_challenge: q.code_challenge,
  };
}

export function verifyPkce(verifier: unknown, challenge: string): boolean {
  if (typeof verifier !== 'string' || !PKCE_VERIFIER.test(verifier)) return false;
  const computed = createHash('sha256').update(verifier, 'ascii').digest('base64url');
  const a = Buffer.from(computed);
  const b = Buffer.from(challenge);
  return a.length === b.length && timingSafeEqual(a, b);
}

// ── Session entries ─────────────────────────────────────────────────────────

export function newAccessEntry(tokens: StoredTokens, clientId?: string): StoredTokens {
  return {
    access_token: tokens.access_token,
    refresh_token: tokens.refresh_token,
    expires_at: tokens.expires_at,
    kind: 'access',
    session_expires_at: Date.now() + oauthSettings.sessionTtlMs,
    ...(clientId ? { client_id: clientId } : {}),
  };
}

export function newRefreshEntry(tokens: StoredTokens, sessionToken: string, clientId?: string): StoredTokens {
  return {
    access_token: sessionToken,
    refresh_token: tokens.refresh_token,
    expires_at: tokens.expires_at,
    kind: 'refresh',
    session_expires_at: Date.now() + oauthSettings.refreshTtlMs,
    ...(clientId ? { client_id: clientId } : {}),
  };
}

/**
 * Is this entry a refresh-token record? New entries say so; legacy refresh
 * records are recognised because their access_token is itself a session key.
 */
export function isRefreshEntry(entry: StoredTokens, lookup: (k: string) => StoredTokens | undefined): boolean {
  if (entry.kind) return entry.kind === 'refresh';
  return lookup(entry.access_token) !== undefined;
}

export type BearerVerdict = 'ok' | 'refresh_token' | 'expired' | 'legacy_denied';

export function checkBearerEntry(
  entry: StoredTokens,
  lookup: (k: string) => StoredTokens | undefined,
  now = Date.now()
): BearerVerdict {
  if (isRefreshEntry(entry, lookup)) return 'refresh_token';
  if (entry.kind === 'access') {
    return typeof entry.session_expires_at === 'number' && entry.session_expires_at > now ? 'ok' : 'expired';
  }
  return oauthSettings.legacySessions === 'deny' ? 'legacy_denied' : 'ok';
}
