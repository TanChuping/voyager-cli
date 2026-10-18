/**
 * `voyager ask --model`: the extension expands a preset through the site data
 * (`{ preset }`), so the CLI only names it. The selection stays afterwards:
 * the person asks on Pro, and the point is that a page left on another
 * effort is moved back to Pro before the send, not the other way round.
 */
import type { ModelSelection } from '@voyager-crew/bridge-protocol';

import type { JobContext } from '../../src/plugins/api';
import { failure } from '../../src/util/errors';

/** `current` selects nothing and keeps whatever the page has. */
export const ASK_MODELS = ['pro', 'extra-high', 'high', 'medium', 'instant', 'current'] as const;
export type AskModel = (typeof ASK_MODELS)[number];
export const DEFAULT_ASK_MODEL: AskModel = 'pro';

export function parseAskModel(raw: unknown): AskModel {
  if (raw === undefined) return DEFAULT_ASK_MODEL;
  const found = ASK_MODELS.find((name) => name === raw);
  if (found === undefined) {
    throw failure('bad-request', `--model must be one of ${ASK_MODELS.join(', ')}`, {
      models: [...ASK_MODELS],
    });
  }
  return found;
}

/** What `ask` reports as `model`: what was asked for, what the page showed before and after. */
export interface ModelReport {
  readonly requested: AskModel;
  readonly observed: ModelSelection | null;
  readonly previous: ModelSelection | null;
}

export async function chooseModel(ctx: JobContext, requested: AskModel): Promise<ModelReport> {
  if (requested === 'current') return { requested, observed: null, previous: null };
  const selected = await ctx.ops.call('model.select', {
    target: { preset: requested },
    capturePrevious: true,
  });
  return { requested, observed: selected.observed, previous: selected.previous ?? null };
}
