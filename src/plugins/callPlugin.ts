import { OP_NAMES, type FilesDownloadParams, type OpName } from '@voyager-crew/bridge-protocol';

import { downloadFile } from '../../plugins/shared/files';
import { failure } from '../util/errors';
import { definePlugin, type CommandDef, type FinishedJob } from './api';
import { sendOnce } from './sendGuard';

/** Internal plugin behind `POST /v1/call`: a job with exactly one op. */
export const CALL_PLUGIN = 'call';

function opCommand(op: OpName): CommandDef<unknown> {
  return {
    summary: `run ${op} once`,
    prepare: () => Promise.reject(failure('bad-request', 'use voyager call')),
    run: async (ctx, params) => {
      // The server validated `params` against `op` before submitting.
      // A download is saved under the job's output/files/: its blob is deleted when the job ends.
      if (op === 'files.download') {
        const saved = await downloadFile(ctx, params as FilesDownloadParams);
        return { data: { op, result: saved } };
      }
      // `voyager call composer.send` sends a prompt too: the same never-resend guard applies.
      const result =
        op === 'composer.send'
          ? await sendOnce(ctx, params as never)
          : await ctx.ops.call(op, params as never);
      return { data: { op, result } };
    },
    ...(op === 'files.download' ? { present: presentDownload } : {}),
  };
}

/** `voyager call files.download`: the result as JSON, and where the file went. */
function presentDownload(job: FinishedJob): { stdout: string; notes: string[] } {
  const saved = job.result?.result as { path?: unknown } | undefined;
  return {
    stdout: `${JSON.stringify(job.result ?? {}, null, 2)}\n`,
    notes: [`saved: ${String(saved?.path)}`],
  };
}

export const callPlugin = definePlugin({
  name: CALL_PLUGIN,
  apiVersion: 1,
  requiresOps: [],
  commands: Object.fromEntries(OP_NAMES.map((op) => [op, opCommand(op)])),
});
