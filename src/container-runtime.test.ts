import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock log
vi.mock('./log.js', () => ({
  log: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    fatal: vi.fn(),
  },
}));

// Mock child_process — store the mock fn so tests can configure it
const mockExecSync = vi.fn();
const mockSpawn = vi.fn(() => ({ on: vi.fn(), unref: vi.fn() }));
vi.mock('child_process', () => ({
  execSync: (...args: unknown[]) => mockExecSync(...args),
  spawn: (...args: unknown[]) => mockSpawn(...(args as [])),
}));

import {
  CONTAINER_RUNTIME_BIN,
  STOP_GRACE_SECONDS,
  readonlyMountArgs,
  stopContainer,
  stopContainerAsync,
  ensureContainerRuntimeRunning,
  cleanupOrphans,
} from './container-runtime.js';
import { CONTAINER_INSTALL_LABEL } from './config.js';
import { log } from './log.js';

beforeEach(() => {
  vi.clearAllMocks();
});

// --- Pure functions ---

describe('readonlyMountArgs', () => {
  it('returns -v flag with :ro suffix', () => {
    const args = readonlyMountArgs('/host/path', '/container/path');
    expect(args).toEqual(['-v', '/host/path:/container/path:ro']);
  });
});

describe('stopContainer', () => {
  it('calls docker stop for valid container names', () => {
    stopContainer('nanoclaw-test-123');
    expect(mockExecSync).toHaveBeenCalledWith(
      `${CONTAINER_RUNTIME_BIN} stop -t ${STOP_GRACE_SECONDS} nanoclaw-test-123`,
      { stdio: 'pipe' },
    );
  });

  it('allows the agent-runner enough grace to close its session DBs', () => {
    // A 1s grace period meant docker escalated to SIGKILL before the runner
    // could finish closing outbound.db, leaving a hot rollback journal.
    expect(STOP_GRACE_SECONDS).toBeGreaterThanOrEqual(10);
  });

  it('rejects names with shell metacharacters', () => {
    expect(() => stopContainer('foo; rm -rf /')).toThrow('Invalid container name');
    expect(() => stopContainer('foo$(whoami)')).toThrow('Invalid container name');
    expect(() => stopContainer('foo`id`')).toThrow('Invalid container name');
    expect(mockExecSync).not.toHaveBeenCalled();
  });
});

describe('stopContainerAsync', () => {
  it('spawns docker stop without blocking on the result', () => {
    stopContainerAsync('nanoclaw-test-123');
    expect(mockSpawn).toHaveBeenCalledWith(
      CONTAINER_RUNTIME_BIN,
      ['stop', '-t', String(STOP_GRACE_SECONDS), 'nanoclaw-test-123'],
      { stdio: 'ignore' },
    );
    // Must never go through the blocking path — the host event loop drives
    // every channel adapter while the grace period elapses.
    expect(mockExecSync).not.toHaveBeenCalled();
  });

  it('rejects names with shell metacharacters', () => {
    expect(() => stopContainerAsync('foo; rm -rf /')).toThrow('Invalid container name');
    expect(mockSpawn).not.toHaveBeenCalled();
  });
});

// --- ensureContainerRuntimeRunning ---

describe('ensureContainerRuntimeRunning', () => {
  it('does nothing when runtime is already running', () => {
    mockExecSync.mockReturnValueOnce('');

    ensureContainerRuntimeRunning();

    expect(mockExecSync).toHaveBeenCalledTimes(1);
    expect(mockExecSync).toHaveBeenCalledWith(`${CONTAINER_RUNTIME_BIN} info`, {
      stdio: 'pipe',
      timeout: 10000,
    });
    expect(log.debug).toHaveBeenCalledWith('Container runtime already running');
  });

  it('throws when docker info fails', () => {
    mockExecSync.mockImplementationOnce(() => {
      throw new Error('Cannot connect to the Docker daemon');
    });

    expect(() => ensureContainerRuntimeRunning()).toThrow('Container runtime is required but failed to start');
    expect(log.error).toHaveBeenCalled();
  });
});

// --- cleanupOrphans ---

describe('cleanupOrphans', () => {
  it('filters ps by the install label so peers are not reaped', () => {
    mockExecSync.mockReturnValueOnce('');

    cleanupOrphans();

    expect(mockExecSync).toHaveBeenCalledWith(
      `${CONTAINER_RUNTIME_BIN} ps --filter label=${CONTAINER_INSTALL_LABEL} --format '{{.Names}}'`,
      expect.any(Object),
    );
  });

  it('stops orphaned nanoclaw containers', () => {
    // docker ps returns container names, one per line
    mockExecSync.mockReturnValueOnce('nanoclaw-group1-111\nnanoclaw-group2-222\n');
    // stop calls succeed
    mockExecSync.mockReturnValue('');

    cleanupOrphans();

    // ps + ONE batched stop. Stopping serially would cost a full grace period
    // per orphan and block the boot path (and every channel adapter) for it.
    expect(mockExecSync).toHaveBeenCalledTimes(2);
    expect(mockExecSync).toHaveBeenNthCalledWith(
      2,
      `${CONTAINER_RUNTIME_BIN} stop -t ${STOP_GRACE_SECONDS} nanoclaw-group1-111 nanoclaw-group2-222`,
      { stdio: 'pipe' },
    );
    expect(log.info).toHaveBeenCalledWith('Stopped orphaned containers', {
      count: 2,
      names: ['nanoclaw-group1-111', 'nanoclaw-group2-222'],
    });
  });

  it('refuses to batch names that failed validation', () => {
    // Names come from `docker ps` output, which is interpolated into a shell
    // string — every one must clear the allowlist before it gets there.
    mockExecSync.mockReturnValueOnce('nanoclaw-ok-1\nevil; rm -rf /\n');
    mockExecSync.mockReturnValue('');

    cleanupOrphans();

    // ps only — no stop issued for the batch containing the bad name.
    expect(mockExecSync).toHaveBeenCalledTimes(1);
    expect(log.warn).toHaveBeenCalled();
  });

  it('does nothing when no orphans exist', () => {
    mockExecSync.mockReturnValueOnce('');

    cleanupOrphans();

    expect(mockExecSync).toHaveBeenCalledTimes(1);
    expect(log.info).not.toHaveBeenCalled();
  });

  it('warns and continues when ps fails', () => {
    mockExecSync.mockImplementationOnce(() => {
      throw new Error('docker not available');
    });

    cleanupOrphans(); // should not throw

    expect(log.warn).toHaveBeenCalledWith(
      'Failed to clean up orphaned containers',
      expect.objectContaining({ err: expect.any(Error) }),
    );
  });

  it('survives a stop that exits non-zero', () => {
    mockExecSync.mockReturnValueOnce('nanoclaw-a-1\nnanoclaw-b-2\n');
    // `docker stop a b` exits non-zero if ANY name failed (e.g. already gone),
    // having still attempted each container independently. Cleanup is best
    // effort — a non-zero exit must not throw out of the boot path.
    mockExecSync.mockImplementationOnce(() => {
      throw new Error('No such container: nanoclaw-a-1');
    });

    cleanupOrphans(); // should not throw

    expect(mockExecSync).toHaveBeenCalledTimes(2);
    expect(log.info).toHaveBeenCalledWith('Stopped orphaned containers', {
      count: 2,
      names: ['nanoclaw-a-1', 'nanoclaw-b-2'],
    });
  });
});
