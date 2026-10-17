/**
 * The single task slot (spec §2.2 delivery, §4.3 job slot). At most one task
 * exists at a time across the whole server, so the page never runs two ops at
 * once. A task leaves the slot only when the extension can no longer be acting
 * on it: its result arrived, the extension stopped listing it after an abort,
 * or the extension stopped polling altogether.
 *
 * queued → dispatched → acked → running → (released)
 *   dispatched and absent from the next poll's `inflight`: delivered again, same taskId.
 *   acked/running and absent from `inflight`: failed as `extension-reloaded`, never again.
 *   abandoned (cancel, deadline): the promise rejects now; the next poll carries
 *   `abort`, and the slot stays taken until the extension lets go.
 */
import {
  bridgeError,
  EXTENSION_OFFLINE_MS,
  OP_VERSIONS,
  TASK_ACK_DEADLINE_MS,
  validateOpResult,
  type BridgeTask,
  type Envelope,
  type ErrorCode,
  type Issue,
  type OpName,
  type PolicyState,
  type PollResponse,
  type ValidatedBridgeTask,
} from '@voyager-crew/bridge-protocol';

import { policyFailure } from '../server/extensionState';
import { BridgeFailure, failure } from '../util/errors';
import { newId } from '../util/ids';

export interface TaskSlotOptions {
  readonly now?: () => number;
  readonly ackDeadlineMs?: number;
  readonly extensionOfflineMs?: number;
  /** Added to a task's own deadline before the server gives up on it. */
  readonly deadlineGraceMs?: number;
  /** How often an abort is sent again while the extension still lists the task. */
  readonly abortResendMs?: number;
}

type TaskState = 'queued' | 'dispatched' | 'acked' | 'running';

interface Entry {
  readonly task: { -readonly [K in keyof BridgeTask]: BridgeTask[K] };
  state: TaskState;
  delivered: boolean;
  abandoned?: ErrorCode;
  abortDelivered: boolean;
  abortSentAt: number;
  lastSeq: number;
  settled: boolean;
  readonly resolve: (value: unknown) => void;
  readonly reject: (error: BridgeFailure) => void;
  readonly onProgress?: (event: Readonly<Record<string, unknown>>) => void;
  ackTimer?: NodeJS.Timeout;
  deadlineTimer?: NodeJS.Timeout;
  resendTimer?: NodeJS.Timeout;
}

export interface PollView {
  readonly inflight: ReadonlySet<string>;
  /** Ops the extension declared; null until it has polled once. */
  readonly ops: ReadonlySet<OpName> | null;
  readonly policy: PolicyState;
}

export interface RunTaskInput {
  readonly jobId: string;
  readonly op: OpName;
  /** Already checked with `validateOpParams`. */
  readonly params: unknown;
  readonly deadlineMs: number;
  readonly signal?: AbortSignal;
  readonly onProgress?: (event: Readonly<Record<string, unknown>>) => void;
}

export type TaskReply =
  | { readonly kind: 'ok' }
  | { readonly kind: 'duplicate' }
  | { readonly kind: 'gone' }
  | { readonly kind: 'not-found' }
  | { readonly kind: 'invalid'; readonly issues: readonly Issue[] };

const FINISHED_MEMORY = 64;

export class TaskSlot {
  private entry: Entry | undefined;
  private readonly finished = new Map<string, 'done' | 'abandoned'>();
  private readonly idleWaiters: (() => void)[] = [];
  private readonly listeners = new Set<() => void>();
  private offlineTimer: NodeJS.Timeout | undefined;
  private readonly now: () => number;
  private readonly ackDeadlineMs: number;
  private readonly extensionOfflineMs: number;
  private readonly deadlineGraceMs: number;
  private readonly abortResendMs: number;

  constructor(options: TaskSlotOptions = {}) {
    this.now = options.now ?? Date.now;
    this.ackDeadlineMs = options.ackDeadlineMs ?? TASK_ACK_DEADLINE_MS;
    this.extensionOfflineMs = options.extensionOfflineMs ?? EXTENSION_OFFLINE_MS;
    this.deadlineGraceMs = options.deadlineGraceMs ?? 5_000;
    this.abortResendMs = options.abortResendMs ?? 2_000;
  }

  /** Run one op through the extension; waits for the slot to be free first. */
  async run(input: RunTaskInput): Promise<unknown> {
    await this.idle();
    if (input.signal?.aborted) throw failure('cancelled', 'job was cancelled');
    if (this.entry !== undefined) return this.run(input);
    return new Promise<unknown>((resolve, reject) => {
      const entry: Entry = {
        task: {
          taskId: newId('t'),
          jobId: input.jobId,
          op: input.op,
          opVersion: OP_VERSIONS[input.op],
          params: input.params,
          deadlineMs: input.deadlineMs,
          issuedAt: 0,
        },
        state: 'queued',
        delivered: false,
        abortDelivered: false,
        abortSentAt: 0,
        lastSeq: -1,
        settled: false,
        resolve,
        reject,
        ...(input.onProgress === undefined ? {} : { onProgress: input.onProgress }),
      };
      this.entry = entry;
      this.armOffline();
      input.signal?.addEventListener('abort', () => this.abandon(entry, 'cancelled'), {
        once: true,
      });
      this.changed();
    });
  }

  current(): { readonly taskId: string; readonly jobId: string; readonly op: OpName } | undefined {
    const entry = this.entry;
    return entry && { taskId: entry.task.taskId, jobId: entry.task.jobId, op: entry.task.op };
  }

  idle(): Promise<void> {
    if (this.entry === undefined) return Promise.resolve();
    return new Promise((resolve) => this.idleWaiters.push(resolve));
  }

  /** Called whenever the slot may have something new for a held poll. */
  onChange(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Every poll proves the extension is alive, whatever it receives. */
  notePoll(): void {
    if (this.entry !== undefined) this.armOffline();
  }

  /** What this poll should carry now, or undefined to keep holding it. */
  poll(view: PollView): PollResponse | undefined {
    const entry = this.entry;
    if (entry === undefined) return undefined;
    const { taskId } = entry.task;
    const listed = view.inflight.has(taskId);

    if (entry.abandoned !== undefined) {
      if (!entry.delivered) {
        this.release(entry);
        return undefined;
      }
      if (entry.abortDelivered && !listed) {
        this.release(entry);
        return undefined;
      }
      // Still listed after an abort: that abort may have gone to a connection that had
      // already dropped, so send it again, at most once per resend interval.
      if (!entry.abortDelivered || this.now() - entry.abortSentAt >= this.abortResendMs) {
        entry.abortDelivered = true;
        entry.abortSentAt = this.now();
        clearTimeout(entry.resendTimer);
        entry.resendTimer = setTimeout(() => this.changed(), this.abortResendMs);
        return { kind: 'abort', taskId, reason: entry.abandoned };
      }
      return undefined;
    }

    if ((entry.state === 'acked' || entry.state === 'running') && !listed) {
      // An acked task is never delivered twice: the page may already have acted on it.
      this.settle(
        entry,
        failure('extension-reloaded', `extension lost task ${taskId} (${entry.task.op})`),
      );
      this.release(entry);
      return undefined;
    }
    if (entry.state === 'dispatched' && listed) {
      entry.state = 'acked';
      clearTimeout(entry.ackTimer);
      return undefined;
    }
    if (entry.state === 'queued') {
      const refused = policyFailure(view.policy);
      if (refused !== undefined) {
        this.settle(entry, refused);
        this.release(entry);
        return undefined;
      }
      if (view.ops !== null && !view.ops.has(entry.task.op)) {
        this.settle(
          entry,
          failure('unsupported-op', `the extension does not offer ${entry.task.op}`, {
            available: [...view.ops],
          }),
        );
        this.release(entry);
        return undefined;
      }
      return this.dispatch(entry);
    }
    if (entry.state === 'dispatched') return this.dispatch(entry);
    return undefined;
  }

  ack(taskId: string): TaskReply {
    const entry = this.match(taskId);
    if (entry === undefined) return this.unknown(taskId);
    if (entry.abandoned !== undefined) return { kind: 'gone' };
    if (entry.state === 'dispatched' || entry.state === 'queued') {
      entry.state = 'acked';
      clearTimeout(entry.ackTimer);
    }
    return { kind: 'ok' };
  }

  progress(taskId: string, seq: number, event: Readonly<Record<string, unknown>>): TaskReply {
    const entry = this.match(taskId);
    if (entry === undefined) return this.unknown(taskId);
    if (entry.abandoned !== undefined) return { kind: 'gone' };
    if (seq <= entry.lastSeq) return { kind: 'duplicate' };
    entry.lastSeq = seq;
    if (entry.state !== 'running') {
      entry.state = 'running';
      clearTimeout(entry.ackTimer);
    }
    entry.onProgress?.(event);
    return { kind: 'ok' };
  }

  /** The first result counts; later ones are acknowledged and dropped. */
  result(taskId: string, envelope: Envelope<unknown>): TaskReply {
    const entry = this.match(taskId);
    if (entry === undefined) {
      const finished = this.finished.get(taskId);
      if (finished === 'done') return { kind: 'duplicate' };
      return finished === 'abandoned' ? { kind: 'gone' } : { kind: 'not-found' };
    }
    if (entry.abandoned !== undefined) {
      this.release(entry);
      return { kind: 'gone' };
    }
    let reply: TaskReply = { kind: 'ok' };
    if (envelope.ok) {
      const checked = validateOpResult(entry.task.op, envelope.data);
      if (checked.ok) this.settle(entry, undefined, checked.value);
      else {
        reply = { kind: 'invalid', issues: checked.issues };
        this.settle(
          entry,
          failure('bad-request', `extension sent an invalid ${entry.task.op} result`, {
            issues: checked.issues,
          }),
        );
      }
    } else {
      this.settle(
        entry,
        new BridgeFailure(
          bridgeError(envelope.error.code, envelope.error.message, envelope.error.details),
        ),
      );
    }
    this.release(entry);
    return reply;
  }

  /** Give up on the current task (cancel or deadline); the extension hears it on its next poll. */
  abandonCurrent(reason: ErrorCode): void {
    if (this.entry !== undefined) this.abandon(this.entry, reason);
  }

  close(): void {
    const entry = this.entry;
    if (entry !== undefined) {
      this.settle(entry, failure('server-unreachable', 'voyager serve stopped'));
      this.release(entry);
    }
  }

  private dispatch(entry: Entry): PollResponse {
    if (!entry.delivered) {
      entry.delivered = true;
      entry.task.issuedAt = this.now();
      entry.deadlineTimer = setTimeout(
        () => this.abandon(entry, 'timeout'),
        entry.task.deadlineMs + this.deadlineGraceMs,
      );
    }
    entry.state = 'dispatched';
    clearTimeout(entry.ackTimer);
    entry.ackTimer = setTimeout(() => {
      // Never acked: offer it again to whichever poll comes next.
      if (this.entry === entry && entry.state === 'dispatched' && entry.abandoned === undefined) {
        entry.state = 'queued';
        this.changed();
      }
    }, this.ackDeadlineMs);
    // Params were validated against `op` before the task was created.
    return { kind: 'task', task: { ...entry.task } as ValidatedBridgeTask };
  }

  private abandon(entry: Entry, reason: ErrorCode): void {
    if (this.entry !== entry || entry.abandoned !== undefined) return;
    const message = reason === 'timeout' ? `${entry.task.op} timed out` : 'job was cancelled';
    this.settle(entry, failure(reason, message));
    clearTimeout(entry.ackTimer);
    clearTimeout(entry.deadlineTimer);
    if (!entry.delivered) {
      this.release(entry);
      return;
    }
    entry.abandoned = reason;
    this.changed();
  }

  private armOffline(): void {
    clearTimeout(this.offlineTimer);
    this.offlineTimer = setTimeout(() => {
      const entry = this.entry;
      if (entry === undefined) return;
      // Nobody is polling, so nobody is running the task: the slot can be freed.
      this.settle(
        entry,
        failure(
          'extension-offline',
          `no poll from the extension for ${this.extensionOfflineMs / 1000}s`,
        ),
      );
      this.release(entry);
    }, this.extensionOfflineMs);
  }

  private settle(entry: Entry, error: BridgeFailure | undefined, value?: unknown): void {
    if (entry.settled) return;
    entry.settled = true;
    if (error !== undefined) entry.reject(error);
    else entry.resolve(value);
  }

  private release(entry: Entry): void {
    if (this.entry !== entry) return;
    clearTimeout(entry.ackTimer);
    clearTimeout(entry.deadlineTimer);
    clearTimeout(entry.resendTimer);
    clearTimeout(this.offlineTimer);
    this.offlineTimer = undefined;
    this.finished.set(entry.task.taskId, entry.abandoned === undefined ? 'done' : 'abandoned');
    while (this.finished.size > FINISHED_MEMORY) {
      const oldest = this.finished.keys().next().value;
      if (oldest === undefined) break;
      this.finished.delete(oldest);
    }
    this.entry = undefined;
    for (const wake of this.idleWaiters.splice(0)) wake();
    this.changed();
  }

  private match(taskId: string): Entry | undefined {
    return this.entry?.task.taskId === taskId ? this.entry : undefined;
  }

  private unknown(taskId: string): TaskReply {
    return this.finished.has(taskId) ? { kind: 'gone' } : { kind: 'not-found' };
  }

  private changed(): void {
    for (const listener of this.listeners) listener();
  }
}
