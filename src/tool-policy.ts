/**
 * MCP tool exposure policy (read-only by default).
 *
 * Env:
 *   MCP_READ_ONLY   Read-only unless explicitly set to 0/false/off/no.
 *                   Unset => read-only. NODE_ENV=production => always read-only.
 *   TOOL_ALLOWLIST  Optional comma-separated tool names. When set, only these
 *                   tools are registered. A write tool is registered only when
 *                   it is listed here AND read-only is off. Unknown names fail
 *                   startup (never fail open).
 *
 * Read tools are names starting with `list_` or `get_`. Every other name is a
 * write tool (default deny for any tool added later).
 */

const FALSY = new Set(['0', 'false', 'off', 'no']);

export interface ToolPolicy {
  readOnly: boolean;
  /** null = no allowlist (all read tools); otherwise the exact set of names. */
  allowlist: Set<string> | null;
}

export class ToolPolicyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ToolPolicyError';
  }
}

export function isReadTool(name: string): boolean {
  return name.startsWith('list_') || name.startsWith('get_');
}

export function resolveToolPolicy(env: NodeJS.ProcessEnv = process.env): ToolPolicy {
  const production = (env.NODE_ENV ?? '').trim().toLowerCase() === 'production';
  const raw = env.MCP_READ_ONLY;
  const explicitOff = raw !== undefined && FALSY.has(raw.trim().toLowerCase());
  const readOnly = production || !explicitOff;

  let allowlist: Set<string> | null = null;
  if (env.TOOL_ALLOWLIST !== undefined) {
    const names = env.TOOL_ALLOWLIST.split(',').map((s) => s.trim()).filter(Boolean);
    allowlist = new Set(names);
  }

  if (!readOnly && (allowlist === null || allowlist.size === 0)) {
    throw new ToolPolicyError(
      'MCP_READ_ONLY is off but TOOL_ALLOWLIST is empty or unset: refusing to start. ' +
        'Name every tool to expose in TOOL_ALLOWLIST.'
    );
  }
  return { readOnly, allowlist };
}

export function isToolAllowed(name: string, policy: ToolPolicy): boolean {
  if (policy.allowlist !== null && !policy.allowlist.has(name)) return false;
  if (isReadTool(name)) return true;
  // Write tool: only when explicitly allowlisted and read-only is off.
  return !policy.readOnly && policy.allowlist !== null && policy.allowlist.has(name);
}

/** Fail startup when the allowlist names a tool no module defines. */
export function assertAllowlistKnown(policy: ToolPolicy, definedNames: Iterable<string>): void {
  if (policy.allowlist === null) return;
  const defined = new Set(definedNames);
  const unknown = [...policy.allowlist].filter((n) => !defined.has(n)).sort();
  if (unknown.length > 0) {
    throw new ToolPolicyError(`TOOL_ALLOWLIST names unknown tools: ${unknown.join(', ')}`);
  }
}
