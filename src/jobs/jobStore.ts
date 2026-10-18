import {
  type AccountPlan,
  type BridgeError,
  type JobEvent,
  type JobEventType,
  type JobStatus,
  type JobSummary,
} from '@voyager-crew/bridge-protocol';
/**
 * Job records on disk (spec §4.3): `jobs/<id>/job.json` (atomic rewrite),
 * `events.jsonl` (append-only), `output/`. Events also live in memory so the
 * long poll of `GET /v1/jobs/:id/events` can wake on the next one.
 */
import { appendFile, mkdir, readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

import type { StatePaths } from '../state/paths';
import { isErrno, readJsonFile, writeJsonAtomic } from '../util/files';
import { newId } from '../util/ids';
import { isRecord } from '../util/isRecord';

export const TERMINAL_STATUSES: ReadonlySet<JobStatus> = new Set<JobStatus>([
  'succeeded',
  'failed',
  'cancelled',
  'needs-user',
  'detached',
]);

export function isTerminal(status: JobStatus): boolean {
  return TERMINAL_STATUSES.has(status);
}

export interface JobRecord {
  readonly jobId: string;
  readonly plugin: string;
  readonly command: string;
  readonly input: unknown;
  status: JobStatus;
  readonly createdAt: number;
  updatedAt: number;
  error?: BridgeError;
  result?: Readonly<Record<string, unknown>>;
  checkpoints: Record<string, Readonly<Record<string, unknown>>>;
  /** The ChatGPT plan the extension reported when the job ended; null when it had none. */
  account?: AccountPlan | null;
}

/** What `GET /v1/jobs/:id` returns: the protocol summary plus result and checkpoints. */
export interface JobDetail extends JobSummary {
  readonly result?: Readonly<Record<string, unknown>>;
  readonly checkpoints: Readonly<Record<string, Readonly<Record<string, unknown>>>>;
  readonly outputDir: string;
  readonly account?: AccountPlan | null;
}

interface Waiter {
  readonly after: number;
  readonly wake: (events: JobEvent[]) => void;
}

const MAX_WAIT_MS = 25_000;

export class JobStore {
  private readonly jobs = new Map<string, JobRecord>();
  private readonly events = new Map<string, JobEvent[]>();
  private readonly waiters = new Map<string, Set<Waiter>>();
  private readonly writes = new Map<string, Promise<void>>();
  /** The first write that failed for each job since its last flush. */
  private readonly failures = new Map<string, unknown>();

  constructor(
    private readonly paths: StatePaths,
    private readonly now: () => number = Date.now,
  ) {}

  /**
   * A job that was running when serve stopped is `detached`: serve never resumes
   * it on its own (`voyager job harvest` is the explicit way back).
   */
  async init(): Promise<void> {
    for (const jobId of await this.listIds()) {
      const job = await this.load(jobId);
      if (job === undefined || isTerminal(job.status)) continue;
      await this.loadEvents(jobId);
      const status: JobStatus = job.status === 'cancelling' ? 'cancelled' : 'detached';
      this.update(job, { status });
      this.appendEvent(jobId, 'status', { status, reason: 'serve restarted' });
      this.appendEvent(jobId, 'done', { status });
    }
    await this.flush();
  }

  create(plugin: string, command: string, input: unknown): JobRecord {
    const at = this.now();
    const job: JobRecord = {
      jobId: newId('j'),
      plugin,
      command,
      input,
      status: 'running',
      createdAt: at,
      updatedAt: at,
      checkpoints: {},
    };
    this.jobs.set(job.jobId, job);
    this.events.set(job.jobId, []);
    this.enqueue(job.jobId, async () => {
      await mkdir(this.outputDir(job.jobId), { recursive: true, mode: 0o700 });
    });
    this.persist(job);
    return job;
  }

  async get(jobId: string): Promise<JobRecord | undefined> {
    return this.jobs.get(jobId) ?? (await this.load(jobId));
  }

  update(
    job: JobRecord,
    patch: Partial<Omit<JobRecord, 'jobId' | 'plugin' | 'command' | 'input' | 'createdAt'>>,
  ): void {
    Object.assign(job, patch, { updatedAt: this.now() });
    this.persist(job);
  }

  appendEvent(
    jobId: string,
    type: JobEventType,
    data: Readonly<Record<string, unknown>>,
  ): JobEvent {
    const list = this.events.get(jobId) ?? [];
    this.events.set(jobId, list);
    const event: JobEvent = { seq: (list.at(-1)?.seq ?? 0) + 1, at: this.now(), type, data };
    list.push(event);
    this.enqueue(jobId, () =>
      appendFile(join(this.jobDir(jobId), 'events.jsonl'), `${JSON.stringify(event)}\n`, {
        mode: 0o600,
      }),
    );
    for (const waiter of this.waiters.get(jobId) ?? []) {
      if (event.seq > waiter.after) waiter.wake([event]);
    }
    return event;
  }

  /** Events after `after`; with `waitMs`, holds until one arrives or the wait ends (then `[]`). */
  async eventsAfter(jobId: string, after: number, waitMs = 0): Promise<JobEvent[]> {
    const list = await this.loadEvents(jobId);
    const ready = list.filter((event) => event.seq > after);
    if (ready.length > 0 || waitMs <= 0) return ready;
    const set = this.waiters.get(jobId) ?? new Set<Waiter>();
    this.waiters.set(jobId, set);
    return new Promise((resolve) => {
      const waiter: Waiter = {
        after,
        wake: (events) => {
          clearTimeout(timer);
          set.delete(waiter);
          resolve(events);
        },
      };
      const timer = setTimeout(() => waiter.wake([]), Math.min(waitMs, MAX_WAIT_MS));
      set.add(waiter);
    });
  }

  async list(): Promise<JobSummary[]> {
    const jobs: JobSummary[] = [];
    for (const jobId of await this.listIds()) {
      const job = await this.get(jobId);
      if (job !== undefined) jobs.push(summarize(job));
    }
    return jobs.sort((a, b) => b.createdAt - a.createdAt);
  }

  detail(job: JobRecord): JobDetail {
    return {
      ...summarize(job),
      ...(job.result === undefined ? {} : { result: job.result }),
      checkpoints: job.checkpoints,
      outputDir: this.outputDir(job.jobId),
      ...(job.account === undefined ? {} : { account: job.account }),
    };
  }

  jobDir(jobId: string): string {
    return join(this.paths.jobs, jobId);
  }

  outputDir(jobId: string): string {
    return join(this.jobDir(jobId), 'output');
  }

  /**
   * Wait for the pending writes of `jobId` (of every job when omitted). Rejects
   * when one of them failed since the last flush: the caller must not take the
   * state as saved. Each failure is reported once.
   */
  async flush(jobId?: string): Promise<void> {
    const ids = jobId === undefined ? [...this.writes.keys()] : [jobId];
    await Promise.all(ids.map((id) => this.writes.get(id)));
    const failed = ids.filter((id) => this.failures.has(id));
    const first = failed.length > 0 ? this.failures.get(failed[0]) : undefined;
    for (const id of failed) this.failures.delete(id);
    if (failed.length > 0) {
      throw new Error(`could not save job ${failed.join(', ')}: ${String(first)}`, {
        cause: first,
      });
    }
  }

  /** Wake every held events request with no events (shutdown). */
  releaseWaiters(): void {
    // Deleting from a Set while iterating it is safe; `wake` removes each waiter.
    for (const set of this.waiters.values()) for (const waiter of set) waiter.wake([]);
  }

  private persist(job: JobRecord): void {
    const snapshot = JSON.parse(JSON.stringify(job)) as JobRecord;
    this.enqueue(job.jobId, () =>
      writeJsonAtomic(join(this.jobDir(job.jobId), 'job.json'), snapshot),
    );
  }

  /** Writes for one job run in order, so job.json never goes back to an older state. */
  private enqueue(jobId: string, write: () => Promise<unknown>): void {
    const previous =
      this.writes.get(jobId) ??
      mkdir(this.jobDir(jobId), { recursive: true, mode: 0o700 }).then(() => undefined);
    const next = previous.then(write).then(
      () => undefined,
      (error: unknown) => {
        process.stderr.write(`voyager: failed to write job ${jobId}: ${String(error)}\n`);
        // Kept for flush(): a checkpoint that did not reach disk must not count as saved.
        if (!this.failures.has(jobId)) this.failures.set(jobId, error);
      },
    );
    this.writes.set(jobId, next);
  }

  private async listIds(): Promise<string[]> {
    try {
      const entries = await readdir(this.paths.jobs, { withFileTypes: true });
      return entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name);
    } catch (error) {
      if (isErrno(error, 'ENOENT')) return [];
      throw error;
    }
  }

  private async load(jobId: string): Promise<JobRecord | undefined> {
    if (!/^[A-Za-z0-9_-]{1,128}$/.test(jobId)) return undefined;
    const raw = await readJsonFile(join(this.jobDir(jobId), 'job.json'));
    if (!isRecord(raw) || raw.jobId !== jobId || typeof raw.status !== 'string') return undefined;
    const job = raw as unknown as JobRecord;
    job.checkpoints = isRecord(job.checkpoints) ? job.checkpoints : {};
    this.jobs.set(jobId, job);
    return job;
  }

  private async loadEvents(jobId: string): Promise<JobEvent[]> {
    const cached = this.events.get(jobId);
    if (cached !== undefined) return cached;
    let text = '';
    try {
      text = await readFile(join(this.jobDir(jobId), 'events.jsonl'), 'utf8');
    } catch (error) {
      if (!isErrno(error, 'ENOENT')) throw error;
    }
    const list = text
      .split('\n')
      .filter((line) => line.trim() !== '')
      .flatMap((line): JobEvent[] => {
        try {
          return [JSON.parse(line) as JobEvent];
        } catch {
          return [];
        }
      });
    this.events.set(jobId, list);
    return list;
  }
}

export function summarize(job: JobRecord): JobSummary {
  return {
    jobId: job.jobId,
    plugin: job.plugin,
    command: job.command,
    status: job.status,
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
    ...(job.error === undefined ? {} : { error: job.error }),
  };
}
