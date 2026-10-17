import { OP_NAMES, type OpName } from '@voyager-crew/bridge-protocol';

import { failure } from '../util/errors';
import { definePlugin, type CommandDef } from './api';

/** Internal plugin behind `POST /v1/call`: a job with exactly one op. */
export const CALL_PLUGIN = 'call';

function opCommand(op: OpName): CommandDef<unknown> {
  return {
    summary: `run ${op} once`,
    prepare: () => Promise.reject(failure('bad-request', 'use voyager call')),
    run: async (ctx, params) => {
      // The server validated `params` against `op` before submitting.
      const result = await ctx.ops.call(op, params as never);
      return { data: { op, result } };
    },
  };
}

export const callPlugin = definePlugin({
  name: CALL_PLUGIN,
  apiVersion: 1,
  requiresOps: [],
  commands: Object.fromEntries(OP_NAMES.map((op) => [op, opCommand(op)])),
});
