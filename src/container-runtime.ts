/**
 * Container runtime abstraction for NanoClaw.
 * All runtime-specific logic lives here so swapping runtimes means changing one file.
 */
import { execSync, spawn } from 'child_process';
import os from 'os';

import { CONTAINER_INSTALL_LABEL } from './config.js';
import { log } from './log.js';

/** The container runtime binary name. */
export const CONTAINER_RUNTIME_BIN = 'docker';

/** CLI args needed for the container to resolve the host gateway. */
export function hostGatewayArgs(): string[] {
  // On Linux, host.docker.internal isn't built-in — add it explicitly
  if (os.platform() === 'linux') {
    return ['--add-host=host.docker.internal:host-gateway'];
  }
  return [];
}

/** Returns CLI args for a readonly bind mount. */
export function readonlyMountArgs(hostPath: string, containerPath: string): string[] {
  return ['-v', `${hostPath}:${containerPath}:ro`];
}

/**
 * Seconds a container gets to shut down cleanly before the runtime SIGKILLs it.
 *
 * Must comfortably exceed the agent-runner's own SIGTERM drain (closing the
 * session DBs). Too short and every reap lands as exit 137 mid-transaction,
 * leaving a hot rollback journal on outbound.db that the host's read-only
 * delivery handle cannot recover — surfacing as SQLITE_READONLY on a plain
 * SELECT. See the shutdown handler in container/agent-runner/src/index.ts.
 */
export const STOP_GRACE_SECONDS = 15;

function assertContainerName(name: string): void {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/.test(name)) {
    throw new Error(`Invalid container name: ${name}`);
  }
}

/**
 * Stop a container by name, blocking until it exits.
 *
 * Startup and cleanup paths only. Anything running on a timer must use
 * stopContainerAsync — see the note there.
 */
export function stopContainer(name: string): void {
  assertContainerName(name);
  execSync(`${CONTAINER_RUNTIME_BIN} stop -t ${STOP_GRACE_SECONDS} ${name}`, { stdio: 'pipe' });
}

/**
 * Fire-and-forget stop. Never blocks the event loop.
 *
 * The grace period is long enough that stopping synchronously would freeze the
 * host — and with it every channel adapter's socket — for its full duration,
 * once per container reaped in a single sweep tick. Callers that need to know
 * the container is gone should hook the child process 'close' event instead of
 * waiting on this. `onSpawnError` fires only when the runtime binary itself
 * could not be launched, not when the stop command fails.
 */
export function stopContainerAsync(name: string, onSpawnError?: (err: Error) => void): void {
  assertContainerName(name);
  const child = spawn(CONTAINER_RUNTIME_BIN, ['stop', '-t', String(STOP_GRACE_SECONDS), name], { stdio: 'ignore' });
  child.on('error', (err) => onSpawnError?.(err));
  child.unref();
}

/** Ensure the container runtime is running, starting it if needed. */
export function ensureContainerRuntimeRunning(): void {
  try {
    execSync(`${CONTAINER_RUNTIME_BIN} info`, {
      stdio: 'pipe',
      timeout: 10000,
    });
    log.debug('Container runtime already running');
  } catch (err) {
    log.error('Failed to reach container runtime', { err });
    console.error('\n╔════════════════════════════════════════════════════════════════╗');
    console.error('║  FATAL: Container runtime failed to start                      ║');
    console.error('║                                                                ║');
    console.error('║  Agents cannot run without a container runtime. To fix:        ║');
    console.error('║  1. Ensure Docker is installed and running                     ║');
    console.error('║  2. Run: docker info                                           ║');
    console.error('║  3. Restart NanoClaw                                           ║');
    console.error('╚════════════════════════════════════════════════════════════════╝\n');
    throw new Error('Container runtime is required but failed to start', {
      cause: err,
    });
  }
}

/**
 * Kill orphaned NanoClaw containers from THIS install's previous runs.
 *
 * Scoped by label `nanoclaw-install=<slug>` so a crash-looping peer install
 * cannot reap our containers, and we cannot reap theirs. The label is
 * stamped onto every container at spawn time — see container-runner.ts.
 */
export function cleanupOrphans(): void {
  try {
    const output = execSync(
      `${CONTAINER_RUNTIME_BIN} ps --filter label=${CONTAINER_INSTALL_LABEL} --format '{{.Names}}'`,
      {
        stdio: ['pipe', 'pipe', 'pipe'],
        encoding: 'utf-8',
      },
    );
    const orphans = output.trim().split('\n').filter(Boolean);
    if (orphans.length > 0) {
      orphans.forEach(assertContainerName);
      // One call with every name: the runtime stops them concurrently, so
      // startup costs one grace period total rather than STOP_GRACE_SECONDS
      // per orphan. That wait blocks the boot path — and with it the channel
      // adapters — so it must not scale with the number of orphans.
      try {
        execSync(`${CONTAINER_RUNTIME_BIN} stop -t ${STOP_GRACE_SECONDS} ${orphans.join(' ')}`, { stdio: 'pipe' });
      } catch {
        /* best effort — some may have already exited on their own */
      }
    }
    if (orphans.length > 0) {
      log.info('Stopped orphaned containers', { count: orphans.length, names: orphans });
    }
  } catch (err) {
    log.warn('Failed to clean up orphaned containers', { err });
  }
}
