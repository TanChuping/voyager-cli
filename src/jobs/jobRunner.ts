/**
 * The single job slot (spec §4.3/§4.4). One active job at a time; a second
 * submit is refused with `busy`, never queued. A job reaches its final status
 * only once the task slot is empty, so a cancelled job cannot overlap the next
 * one on the page.
 */
import {
  categoryOf,
  type BridgeError,
  type JobStatus,
  type OpName,
} from '@voyager-crew/bridge-protocol';

import type { CommandDef, JobContext } from '../plugins/api';
import type { PluginRegistry } from '../plugins/registry';
import { type ExtensionState, policyFailure } from '../server/extensionState';
import { failure, toBridgeError } from '../util/errors';
import type { Logger } from '../util/log';
import { isTerminal, type JobRecord, type JobStore } from './jobStore';
import { createOpsClient } from './opsClient';
import type { TaskSlot } from './taskSlot';

export interface JobRunnerDeps {
  readonly store: JobStore;
  readonly slot: TaskSlot;
  readonly registry: PluginRegistry;
  readonly extension: ExtensionState;
  readonly isPaired: () => boolean;
  readonly log: Logger;
}

interface Active {
  readonly job: JobRecord;
  readonly controller: AbortController;
  readonly done: Promise<void>;
}

export class JobRunner {
  private active: Active | undefined;

  constructor(private readonly deps: JobRunnerDeps) {}

  /** Synchronous up to the busy check, so concurrent submits cannot both pass it. */
  submit(plugin: string, command: string, input: unknown): JobRecord {
    if (this.active !== undefined) {
      throw failure('busy', 'another job is running; it is not queued', {
        activeJobId: this.active.job.jobId,
      });
    }
    const def = this.deps.registry.command(plugin, command);
    if (def === undefined) throw failure('bad-request', `unknown command ${plugin} ${command}`);
    if (!this.deps.isPaired()) {
      throw failure('not-paired', 'no extension is paired; run `voyager pair`');
    }
    const refused = policyFailure(this.deps.extension.policy?.state);
    if (refused !== undefined) throw refused;
    const available = this.deps.extension.opNames();
    const required = this.deps.registry.plugin(plugin)?.requiresOps ?? [];
    const missing = available === null ? [] : required.filter((op) => !available.has(op));
    if (missing.length > 0) {
      throw failure('unsupported-op', `the extension does not offer ${missing.join(', ')}`, {
        missing,
      });
    }

    const job = this.deps.store.create(plugin, command, input);
    const controller = new AbortController();
    this.deps.store.appendEvent(job.jobId, 'status', { status: 'running' });
    const done = this.execute(job, def, controller);
    this.active = { job, controller, done };
    return job;
  }

  activeJob(): { jobId: string; op?: OpName } | undefined {
    if (this.active === undefined) return undefined;
    const op = this.deps.slot.current()?.op;
    return op === undefined
      ? { jobId: this.active.job.jobId }
      : { jobId: this.active.job.jobId, op };
  }

  async cancel(jobId: string): Promise<JobRecord> {
    const job = await this.deps.store.get(jobId);
    if (job === undefined) throw failure('not-found', `no job ${jobId}`);
    if (this.active?.job !== job) {
      throw failure('gone', `job ${jobId} has already ended (${job.status})`);
    }
    if (job.status !== 'cancelling') {
      this.setStatus(job, 'cancelling');
      this.active.controller.abort();
    }
    return job;
  }

  /** Resolves when the active job (if any) has fully ended. */
  async settled(): Promise<void> {
    await this.active?.done;
  }

  private async execute(
    job: JobRecord,
    def: CommandDef,
    controller: AbortController,
  ): Promise<void> {
    // Let `submit` return (and record `active`) before the plugin starts.
    await Promise.resolve();
    let status: JobStatus;
    let error: BridgeError | undefined;
    let result: Readonly<Record<string, unknown>> | undefined;
    try {
      const output = await def.run(this.context(job, controller), job.input);
      if (controller.signal.aborted) throw failure('cancelled', 'job was cancelled');
      status = 'succeeded';
      result = output.data;
    } catch (thrown) {
      error = controller.signal.aborted
        ? toBridgeError(failure('cancelled', 'job was cancelled'))
        : toBridgeError(thrown);
      status = statusForError(error, job.checkpoints);
    }
    // The page may still hold an abandoned task; the job ends only when it lets go.
    await this.deps.slot.idle();
    this.deps.store.update(job, {
      status,
      ...(error === undefined ? {} : { error }),
      ...(result === undefined ? {} : { result }),
    });
    this.deps.store.appendEvent(job.jobId, 'status', { status });
    this.deps.store.appendEvent(job.jobId, 'done', {
      status,
      ...(error === undefined ? {} : { error }),
    });
    this.deps.log.info('job finished', { jobId: job.jobId, status, code: error?.code });
    this.active = undefined;
  }

  private context(job: JobRecord, controller: AbortController): JobContext {
    const { store, slot, extension, log } = this.deps;
    const ops = createOpsClient({
      jobId: job.jobId,
      signal: controller.signal,
      slot,
      available: () => extension.opNames(),
      policy: () => extension.policy?.state,
      onStart: (op) => {
        if (op === 'turns.waitReply' && job.status === 'running')
          this.setStatus(job, 'waiting-reply');
      },
      onEnd: () => {
        if (job.status === 'waiting-reply') this.setStatus(job, 'running');
      },
      onProgress: (op, event) => store.appendEvent(job.jobId, 'progress', { op, event }),
    });
    const phaseC = (): Promise<never> =>
      Promise.reject(
        failure('bad-request', 'attachments and downloads are not available yet (Phase C)'),
      );
    return {
      jobId: job.jobId,
      signal: controller.signal,
      outputDir: store.outputDir(job.jobId),
      ops,
      blobs: { register: phaseC, save: phaseC },
      progress: (event) => store.appendEvent(job.jobId, 'progress', event),
      checkpoint: async (name, data) => {
        job.checkpoints[name] = data;
        store.update(job, {});
        store.appendEvent(job.jobId, 'checkpoint', { name, data });
        await store.flush();
      },
      log: {
        info: (message, fields) => {
          store.appendEvent(job.jobId, 'log', { level: 'info', message, ...fields });
          log.info(message, { jobId: job.jobId, ...fields });
        },
        warn: (message, fields) => {
          store.appendEvent(job.jobId, 'log', { level: 'warn', message, ...fields });
          log.warn(message, { jobId: job.jobId, ...fields });
        },
      },
    };
  }

  private setStatus(job: JobRecord, status: JobStatus): void {
    if (isTerminal(job.status)) return;
    this.deps.store.update(job, { status });
    this.deps.store.appendEvent(job.jobId, 'status', { status });
  }
}

/**
 * user-action → needs-user; a transient loss after the prompt went out →
 * detached (the conversation still exists); everything else → failed.
 */
export function statusForError(
  error: BridgeError,
  checkpoints: Readonly<Record<string, Readonly<Record<string, unknown>>>>,
): JobStatus {
  if (error.code === 'cancelled') return 'cancelled';
  const category = categoryOf(error.code);
  if (category === 'user-action') return 'needs-user';
  const knowsConversation = Object.values(checkpoints).some(
    (data) => typeof data.conversationId === 'string',
  );
  if (category === 'transient' && knowsConversation && error.code !== 'busy') return 'detached';
  return 'failed';
}
