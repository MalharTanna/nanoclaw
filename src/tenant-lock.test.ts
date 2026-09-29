/**
 * Shared-number installs: customers are the admin chain of their own agent,
 * so self-modification, sub-agents and non-task ncl commands are denied
 * outright instead of being held for (their own) approval.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { commandGuardSpec } from './cli/guard.js';
import type { CommandDef } from './cli/registry.js';
import { gateCommand } from './command-gate.js';
import { closeDb, createAgentGroup, initTestDb, runMigrations } from './db/index.js';
import { agentsCreate } from './modules/agent-to-agent/guard.js';
import { createUser } from './modules/permissions/db/users.js';
import { grantRole } from './modules/permissions/db/user-roles.js';
import { selfModAddMcpServer, selfModInstallPackages } from './modules/self-mod/guard.js';
import { TENANT_LOCKED_REASON } from './tenant-lock.js';

const agent = { kind: 'agent' as const, agentGroupId: 'ag-1' };
const cmd = (name: string, resource: string, access: 'open' | 'approval') =>
  commandGuardSpec({ name, resource, access } as unknown as CommandDef);

let origShared: string | undefined;

beforeEach(() => {
  const db = initTestDb();
  runMigrations(db);
  const now = new Date().toISOString();
  createAgentGroup({ id: 'ag-1', name: 'AG1', folder: 'ag-1', agent_provider: null, created_at: now });
  createUser({ id: 'whatsapp:owner', kind: 'whatsapp', display_name: null, created_at: now });
  grantRole({ user_id: 'whatsapp:owner', role: 'admin', agent_group_id: 'ag-1', granted_by: null, granted_at: now });
  origShared = process.env.NANOCLAW_SHARED_NUMBER;
});

afterEach(() => {
  closeDb();
  if (origShared === undefined) delete process.env.NANOCLAW_SHARED_NUMBER;
  else process.env.NANOCLAW_SHARED_NUMBER = origShared;
});

describe('shared install (tenant-locked)', () => {
  beforeEach(() => {
    process.env.NANOCLAW_SHARED_NUMBER = 'true';
  });

  it('denies create_agent, install_packages and add_mcp_server instead of holding for approval', () => {
    for (const action of [agentsCreate, selfModInstallPackages, selfModAddMcpServer]) {
      expect(action.decide({ actor: agent, payload: { name: 'x' } })).toMatchObject({
        effect: 'deny',
        reason: TENANT_LOCKED_REASON,
      });
    }
  });

  it('limits ncl to tasks', () => {
    expect(cmd('tasks-create', 'tasks', 'open').decide({ actor: agent, payload: {} }).effect).toBe('allow');
    expect(cmd('groups-update', 'groups', 'approval').decide({ actor: agent, payload: {} }).effect).toBe('deny');
    expect(cmd('members-add', 'members', 'approval').decide({ actor: agent, payload: {} }).effect).toBe('deny');
    expect(cmd('destinations-list', 'destinations', 'open').decide({ actor: agent, payload: {} }).effect).toBe('deny');
    expect(cmd('sessions-list', 'sessions', 'open').decide({ actor: agent, payload: {} }).effect).toBe('deny');
  });

  it('still lets the operator run anything from the host socket', () => {
    expect(cmd('groups-update', 'groups', 'approval').decide({ actor: { kind: 'host' }, payload: {} }).effect).toBe(
      'allow',
    );
  });

  it('drops /cost and /upload-trace even for the customer admin, keeps /clear', () => {
    expect(gateCommand('/cost', 'whatsapp:owner', 'ag-1')).toEqual({ action: 'filter' });
    expect(gateCommand('/upload-trace', 'whatsapp:owner', 'ag-1')).toEqual({ action: 'filter' });
    expect(gateCommand('/clear', 'whatsapp:owner', 'ag-1')).toEqual({ action: 'pass' });
  });
});

describe('own install (not shared)', () => {
  beforeEach(() => {
    process.env.NANOCLAW_SHARED_NUMBER = 'false';
  });

  it('keeps the usual admin-approval flow', () => {
    expect(agentsCreate.decide({ actor: agent, payload: { name: 'x' } }).effect).toBe('hold');
    expect(selfModInstallPackages.decide({ actor: agent, payload: {} }).effect).toBe('hold');
    expect(cmd('groups-update', 'groups', 'approval').decide({ actor: agent, payload: {} }).effect).toBe('hold');
    expect(gateCommand('/cost', 'whatsapp:owner', 'ag-1')).toEqual({ action: 'pass' });
  });
});
