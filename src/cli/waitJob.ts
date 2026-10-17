import { bridgePath, type JobEvent, type JobEventsResponse } from '@voyager-crew/bridge-protocol';

import type { ServeClient } from '../client/serveClient';
import type { JobDetail } from '../jobs/jobStore';

const POLL_WAIT_S = 25;

export type WaitOutcome =
  | { readonly kind: 'done'; readonly job: JobDetail }
  | { readonly kind: 'timeout'; readonly job: JobDetail };

/** Follow a job's events until it ends or `timeoutMs` passes; a timeout never touches the job. */
export async function waitForJob(
  client: ServeClient,
  jobId: string,
  timeoutMs: number,
  onEvent: (event: JobEvent) => void = () => {},
): Promise<WaitOutcome> {
  const deadline = Date.now() + timeoutMs;
  let after = 0;
  for (;;) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) break;
    const wait = Math.max(1, Math.min(POLL_WAIT_S, Math.floor(remaining / 1000)));
    const { events } = await client.request<JobEventsResponse>(
      'GET',
      `${bridgePath.jobEvents(jobId)}?after=${after}&wait=${wait}`,
      undefined,
      { timeoutMs: (wait + 10) * 1000 },
    );
    let finished = false;
    for (const event of events) {
      after = event.seq;
      onEvent(event);
      if (event.type === 'done') finished = true;
    }
    if (finished) {
      return { kind: 'done', job: await client.request<JobDetail>('GET', bridgePath.job(jobId)) };
    }
  }
  return { kind: 'timeout', job: await client.request<JobDetail>('GET', bridgePath.job(jobId)) };
}

/** One stderr line per event worth showing a person. */
export function describeEvent(event: JobEvent): string | undefined {
  const data = event.data;
  if (event.type === 'status') return `· ${String(data.status)}`;
  if (event.type === 'checkpoint') return `· ${String(data.name)}`;
  if (event.type === 'log') return `· ${String(data.level)}: ${String(data.message)}`;
  if (event.type === 'progress' && typeof data.op === 'string') {
    const progress = data.event as Record<string, unknown> | undefined;
    const phase = progress?.phase === undefined ? '' : ` ${String(progress.phase)}`;
    const elapsed =
      typeof progress?.elapsedMs === 'number' ? ` ${Math.round(progress.elapsedMs / 1000)}s` : '';
    return `· ${data.op}${phase}${elapsed}`;
  }
  return undefined;
}
