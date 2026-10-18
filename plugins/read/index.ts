/**
 * Official `read` plugin: open an existing conversation, read its last
 * finished reply into `output/response.md`, close the tab. Nothing is typed or
 * sent; a reply still being written is refused (`unverified`), never swapped
 * for an earlier one.
 */
import {
  definePlugin,
  type ForegroundContext,
  type JobContext,
  type JobResult,
  type ParsedArgs,
} from '../../src/plugins/api';
import { parseConversationRef } from '../../src/util/conversationRef';
import { failure } from '../../src/util/errors';
import { closeBridgeTab, presentResponse, responseBlock, saveResponse } from '../shared/response';

export interface ReadInput {
  readonly conversationId: string;
  readonly keepTab: boolean;
}

async function prepare(_fg: ForegroundContext, argv: ParsedArgs): Promise<ReadInput> {
  if (argv.positionals.length !== 1) {
    throw failure('bad-request', 'usage: voyager read <conversation link or id>');
  }
  return {
    conversationId: parseConversationRef(argv.positionals[0]),
    keepTab: argv.options['keep-tab'] === true,
  };
}

async function run(ctx: JobContext, input: ReadInput): Promise<JobResult> {
  const startedAt = Date.now();
  // The extension checks the tab really shows this conversation (`expect`), and
  // refuses a work-mode one before anything is read.
  const opened = await ctx.ops.call('conversation.open', { conversationId: input.conversationId });
  if (!opened.ready.loggedIn) throw failure('login-required', 'ChatGPT is not logged in');
  // Kept free of `conversationId`: that key in a checkpoint marks a sent prompt.
  await ctx.checkpoint('opened', { tabId: opened.tabId, url: opened.url });

  const read = await ctx.ops.call('turns.read', {
    conversationId: input.conversationId,
    latest: true,
  });
  const saved = await saveResponse(ctx, read);
  await ctx.checkpoint('read', { turnKey: read.turnKey, responsePath: saved.responsePath });

  if (!input.keepTab) await closeBridgeTab(ctx, opened.tabId);

  return {
    data: {
      conversationUrl: opened.url,
      conversationId: input.conversationId,
      responsePath: saved.responsePath,
      turnKey: read.turnKey,
      files: [],
      timings: { startedAt, finishedAt: Date.now() },
      response: responseBlock(read, saved),
    },
  };
}

export const readPlugin = definePlugin({
  name: 'read',
  apiVersion: 1,
  requiresOps: ['conversation.open', 'turns.read', 'conversation.close'],
  commands: {
    read: {
      summary: "Read an existing conversation's last finished reply into response.md",
      args: [{ name: 'conversation', summary: 'a chatgpt.com conversation link, or its id' }],
      options: {
        'keep-tab': { type: 'boolean', summary: 'leave the bridge tab open afterwards' },
      },
      prepare,
      run,
      present: presentResponse,
    },
  },
});
