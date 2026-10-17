/**
 * Plugin interface (spec §4.5). A command's `prepare` runs in the foreground
 * `voyager` process; its `run` runs inside `voyager serve`, so a job outlives
 * the terminal that started it. Plugins orchestrate neutral ops; they never
 * see a selector or a page.
 */
import type { BlobRef, OpName, OpParamsMap, OpResultMap } from '@voyager-crew/bridge-protocol';

export interface ArgDef {
  readonly name: string;
  readonly summary: string;
  readonly variadic?: boolean;
}

export interface OptionDef {
  readonly type: 'string' | 'boolean';
  readonly summary: string;
  readonly short?: string;
  readonly multiple?: boolean;
}

export interface ParsedArgs {
  readonly positionals: readonly string[];
  readonly options: Readonly<
    Record<string, string | boolean | readonly (string | boolean)[] | undefined>
  >;
}

export interface ForegroundContext {
  readonly cwd: string;
  /** Copy a local file into the job's `input/` (Phase C: attachments). */
  stage(path: string): Promise<never>;
  /** Progress for the person at the terminal (stderr). */
  note(message: string): void;
}

export interface Logger {
  info(message: string, fields?: Record<string, unknown>): void;
  warn(message: string, fields?: Record<string, unknown>): void;
}

export interface OpCallOptions {
  /** How long the server waits for the extension's result; defaults per op. */
  readonly timeoutMs?: number;
}

export interface OpsClient {
  call<K extends OpName>(
    op: K,
    params: OpParamsMap[K],
    options?: OpCallOptions,
  ): Promise<OpResultMap[K]>;
}

export interface SavedFile {
  readonly path: string;
  readonly name: string;
  readonly size: number;
  readonly sha256: string;
}

export interface JobContext {
  readonly jobId: string;
  readonly signal: AbortSignal;
  readonly outputDir: string;
  readonly ops: OpsClient;
  /** Phase C: blob upload and download. Both throw until then. */
  readonly blobs: {
    register(path: string): Promise<BlobRef>;
    save(blob: BlobRef, name: string): Promise<SavedFile>;
  };
  progress(event: Readonly<Record<string, unknown>>): void;
  checkpoint(name: string, data: Readonly<Record<string, unknown>>): Promise<void>;
  readonly log: Logger;
}

/** What a finished job reports; `data` becomes the job's `result`. */
export interface JobResult {
  readonly data: Readonly<Record<string, unknown>>;
}

export type Checkpoint = Readonly<Record<string, Readonly<Record<string, unknown>>>>;

/** The finished job as the foreground sees it, for `present`. */
export interface FinishedJob {
  readonly jobId: string;
  readonly status: string;
  readonly result?: Readonly<Record<string, unknown>>;
}

export interface CommandDef<I = unknown> {
  readonly summary: string;
  readonly args?: readonly ArgDef[];
  readonly options?: Readonly<Record<string, OptionDef>>;
  prepare(fg: ForegroundContext, argv: ParsedArgs): Promise<I>;
  run(ctx: JobContext, input: I): Promise<JobResult>;
  /** Phase C: resume a detached job with read-side ops only. */
  harvest?(ctx: JobContext, checkpoint: Checkpoint): Promise<JobResult>;
  /** Human output of a succeeded job: what goes to stdout, and notes for stderr. */
  present?(job: FinishedJob): { readonly stdout: string; readonly notes: readonly string[] };
}

export interface VoyagerPlugin {
  readonly name: string;
  readonly apiVersion: 1;
  readonly requiresOps: readonly OpName[];
  // Each command fixes its own input type; the registry only moves `unknown` between them.
  // oxlint-disable-next-line typescript/no-explicit-any
  readonly commands: Readonly<Record<string, CommandDef<any>>>;
}

export function definePlugin<P extends VoyagerPlugin>(plugin: P): P {
  return plugin;
}
