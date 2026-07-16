/**
 * Stdio transport — for local testing with MCP inspector or Claude Desktop.
 *
 * Requires a valid FreshBooks access token, either:
 *   - FRESHBOOKS_ACCESS_TOKEN env var  (quick testing)
 *   - Run `npm run dev:http` first, complete OAuth in a browser, then copy the
 *     session token — or obtain a token directly from FreshBooks developer console.
 */

import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createMcpServer } from './mcp-server.js';
import { FreshBooksClient } from './freshbooks/client.js';
import { config } from './config.js';
import axios from 'axios';
import type { StoredTokens } from './freshbooks/types.js';

// ── Token persistence ─────────────────────────────────────────────────────────

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';

// Canonical single token store (reconciled 2026-07-16). The old private store
// ~/.freshbooks-mcp/tokens.json diverged from the financial-intelligence store
// (FreshBooks rotates refresh tokens, so two independent refreshers kill each
// other's chain). Every consumer now shares the one file the Python ingest
// pipeline refreshes; FRESHBOOKS_TOKEN_PATH overrides for tests.
const TOKEN_FILE =
  process.env.FRESHBOOKS_TOKEN_PATH ??
  join(
    homedir(),
    'CascadeProjects/apps/silvergate/financial-intelligence/data/freshbooks_token.json'
  );

/** Canonical-store expires_at is epoch SECONDS (float, python time.time());
 *  legacy/env flows used epoch ms; tolerate both plus ISO strings. */
function toEpochMs(v: unknown): number {
  if (typeof v === 'number') return v < 1e12 ? v * 1000 : v;
  if (typeof v === 'string') {
    const t = Date.parse(v);
    if (!Number.isNaN(t)) return t;
  }
  return 0;
}

// Extra canonical-store fields (account_id, saved_at, ...) that must survive a
// round-trip through this process — the Python consumers depend on them.
let canonicalExtras: Record<string, unknown> = {};

async function loadTokens(): Promise<StoredTokens | null> {
  try {
    const raw = await readFile(TOKEN_FILE, 'utf8');
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const { access_token, refresh_token, expires_at, ...rest } = parsed;
    canonicalExtras = rest;
    if (typeof access_token !== 'string' || typeof refresh_token !== 'string') return null;
    return {
      access_token,
      refresh_token,
      expires_at: toEpochMs(expires_at),
    } as StoredTokens;
  } catch {
    return null;
  }
}

async function saveTokens(tokens: StoredTokens): Promise<void> {
  await mkdir(dirname(TOKEN_FILE), { recursive: true });
  // Persist in the canonical schema: epoch-seconds expires_at + preserved
  // extras (account_id etc.), so the Python pipeline keeps working.
  const body = {
    ...canonicalExtras,
    access_token: tokens.access_token,
    refresh_token: tokens.refresh_token,
    expires_at: tokens.expires_at / 1000,
    saved_at: Date.now() / 1000,
  };
  await writeFile(TOKEN_FILE, JSON.stringify(body, null, 2), { mode: 0o600 });
}

async function refreshIfNeeded(tokens: StoredTokens): Promise<StoredTokens> {
  if (tokens.expires_at - Date.now() > 60_000) return tokens;
  if (!config.freshbooks.clientId || !config.freshbooks.clientSecret) {
    throw new Error('Token is expired and FRESHBOOKS_CLIENT_ID/SECRET are not set — cannot refresh.');
  }

  const { data } = await axios.post(config.freshbooks.tokenUrl, {
    grant_type: 'refresh_token',
    refresh_token: tokens.refresh_token,
    client_id: config.freshbooks.clientId,
    client_secret: config.freshbooks.clientSecret,
  });

  const next: StoredTokens = {
    access_token: data.access_token,
    refresh_token: data.refresh_token ?? tokens.refresh_token,
    expires_at: Date.now() + data.expires_in * 1000,
  };
  await saveTokens(next);
  return next;
}

// ── Resolve access token ──────────────────────────────────────────────────────

async function resolveAccessToken(): Promise<string> {
  // 1. Direct env var (highest priority — useful for CI / quick tests)
  if (process.env.FRESHBOOKS_ACCESS_TOKEN) {
    return process.env.FRESHBOOKS_ACCESS_TOKEN;
  }

  // 2. Persisted tokens from a previous OAuth flow
  const stored = await loadTokens();
  if (stored) {
    try {
      const refreshed = await refreshIfNeeded(stored);
      return refreshed.access_token;
    } catch (err) {
      console.error('Failed to refresh stored token:', err);
    }
  }

  // 3. Build tokens from FRESHBOOKS_REFRESH_TOKEN env var
  if (process.env.FRESHBOOKS_REFRESH_TOKEN && config.freshbooks.clientId) {
    try {
      const { data } = await axios.post(config.freshbooks.tokenUrl, {
        grant_type: 'refresh_token',
        refresh_token: process.env.FRESHBOOKS_REFRESH_TOKEN,
        client_id: config.freshbooks.clientId,
        client_secret: config.freshbooks.clientSecret,
      });
      const next: StoredTokens = {
        access_token: data.access_token,
        refresh_token: data.refresh_token ?? process.env.FRESHBOOKS_REFRESH_TOKEN,
        expires_at: Date.now() + data.expires_in * 1000,
      };
      await saveTokens(next);
      return next.access_token;
    } catch (err) {
      console.error('Failed to exchange refresh token:', err);
    }
  }

  console.error(
    'No FreshBooks access token found.\n' +
      'Provide one of:\n' +
      '  • FRESHBOOKS_ACCESS_TOKEN env var\n' +
      '  • FRESHBOOKS_REFRESH_TOKEN + FRESHBOOKS_CLIENT_ID + FRESHBOOKS_CLIENT_SECRET env vars\n' +
      '  • Re-auth the canonical store: python3 scripts/freshbooks_reauth.py in\n' +
      '    apps/silvergate/financial-intelligence (writes data/freshbooks_token.json)\n'
  );
  process.exit(1);
}

// ── Main ──────────────────────────────────────────────────────────────────────

export async function startStdioServer() {
  const accessToken = await resolveAccessToken();

  // We create one client per server start; the FreshBooksClient caches the
  // identity (account ID / business ID) after the first API call.
  const fbClient = new FreshBooksClient(accessToken);

  const mcpServer = createMcpServer(() => fbClient);
  const transport = new StdioServerTransport();

  await mcpServer.connect(transport);
}
