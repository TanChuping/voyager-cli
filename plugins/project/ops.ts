/**
 * The `project.*` ops through the job's typed ops client. Until the protocol
 * package lists them in `OpName` (the registration that ships with them), the
 * client's types cannot name them, so this is the one place they are cast.
 */
import {
  PROJECT_OP_NAMES,
  type OpName,
  type ProjectOpName,
  type ProjectOpParamsMap,
  type ProjectOpResultMap,
} from '@voyager-crew/bridge-protocol';

import type { JobContext, OpCallOptions } from '../../src/plugins/api';

const asOpName = (op: ProjectOpName): OpName => op as string as OpName;

/** The project ops, as the names a plugin's `requiresOps` lists. */
export const PROJECT_OPS: readonly OpName[] = PROJECT_OP_NAMES.map(asOpName);

type UntypedCall = (op: OpName, params: unknown, options?: OpCallOptions) => Promise<unknown>;

export async function callProjectOp<K extends ProjectOpName>(
  ctx: JobContext,
  op: K,
  params: ProjectOpParamsMap[K],
  options?: OpCallOptions,
): Promise<ProjectOpResultMap[K]> {
  const call = ctx.ops.call as UntypedCall;
  return (await call.call(ctx.ops, asOpName(op), params, options)) as ProjectOpResultMap[K];
}
