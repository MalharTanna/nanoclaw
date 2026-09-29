/**
 * Miroflow shared-number installs (NANOCLAW_SHARED_NUMBER=true): every agent
 * group belongs to a paying customer, and the customer's owner numbers are
 * scoped admins of it (so they get limit notices). Admin approval is therefore
 * NOT a trust boundary there: a customer could approve their own agent's
 * request. So on these installs, from the container path:
 *
 * - create_agent, install_packages and add_mcp_server are denied outright;
 * - `ncl` is limited to `tasks` (reminders and scheduled messages);
 * - the /cost and /upload-trace chat commands are dropped.
 *
 * The operator still changes a tenant's setup from the host (ncl over the
 * socket, driven by the Miroflow control plane).
 */
import { readEnvFile } from './env.js';

/** ncl resources a tenant's agent may use from chat. */
export const TENANT_CHAT_RESOURCES: ReadonlySet<string> = new Set(['tasks']);

/** Admin chat commands customers never get on a shared install. */
export const TENANT_BLOCKED_COMMANDS: ReadonlySet<string> = new Set(['/cost', '/upload-trace']);

export const TENANT_LOCKED_REASON = 'Not available on Miroflow: the assistant setup is managed by Miroflow.';

export function tenantLocked(): boolean {
  const v = process.env.NANOCLAW_SHARED_NUMBER || readEnvFile(['NANOCLAW_SHARED_NUMBER']).NANOCLAW_SHARED_NUMBER;
  return v === 'true';
}
