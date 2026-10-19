/**
 * Files a reply offers (`turns.read` → `files`), fetched one at a time with
 * `files.download` and saved under `output/files/` beside `response.md`. A
 * file that fails is listed in `failedFiles` and never fails the job: the
 * reply is already saved, and running `ask` again would send the prompt
 * again. `voyager read <conversation>` downloads them again.
 */
import type {
  BridgeError,
  ErrorCode,
  FileCandidate,
  FilesDownloadParams,
} from '@voyager-crew/bridge-protocol';

import type { JobContext } from '../../src/plugins/api';
import { failure, toBridgeError } from '../../src/util/errors';

export interface DownloadedFile {
  readonly name: string;
  readonly path: string;
  readonly size: number;
  readonly sha256: string;
  readonly mime: string;
}

export interface FailedFile {
  readonly label: string;
  readonly href?: string;
  readonly error: BridgeError;
}

export interface ReplyFiles {
  readonly files: readonly DownloadedFile[];
  readonly failedFiles: readonly FailedFile[];
}

/**
 * What an extension without `files.download` (2.1.1 and older) leads to: it
 * either does not declare the op or answers `unsupported-op`. Such builds also
 * offer no files, so this shows only once a newer `turns.read` meets an older op.
 */
export const UPDATE_FOR_FILES = 'update the Voyager extension to download the files a reply offers';

/** After one of these the next download would fail the same way, or wait out the same timeout. */
const STOPS_DOWNLOADS: ReadonlySet<ErrorCode> = new Set<ErrorCode>([
  'tab-closed',
  'document-lost',
  'extension-offline',
  'server-unreachable',
  'unsupported-op',
  'login-required',
  'challenge',
]);

/** Download one candidate and save it under the name the page reports for the file. */
export async function downloadFile(
  ctx: JobContext,
  params: FilesDownloadParams,
): Promise<DownloadedFile> {
  const result = await ctx.ops.call('files.download', params);
  if (!('blobId' in result)) {
    // A path would point into the browser's downloads folder: serve copies nothing from there.
    throw failure('unsupported-data', `${result.name} was not handed over as a blob`);
  }
  const saved = await ctx.blobs.save(result, result.name);
  return {
    name: saved.name,
    path: saved.path,
    size: saved.size,
    sha256: saved.sha256,
    mime: result.mime,
  };
}

/** Each candidate in reply order; a failure is recorded and the next one is tried. */
export async function downloadReplyFiles(
  ctx: JobContext,
  reply: { readonly conversationId: string; readonly assistantTurnKey: string },
  candidates: readonly FileCandidate[],
): Promise<ReplyFiles> {
  const files: DownloadedFile[] = [];
  const failedFiles: FailedFile[] = [];
  const failed = (candidate: FileCandidate, error: BridgeError): void => {
    failedFiles.push({
      label: candidate.label,
      ...(candidate.href === undefined ? {} : { href: candidate.href }),
      error,
    });
  };
  for (const [index, candidate] of candidates.entries()) {
    try {
      files.push(
        await downloadFile(ctx, {
          conversationId: reply.conversationId,
          assistantTurnKey: reply.assistantTurnKey,
          candidate,
        }),
      );
    } catch (thrown) {
      // A cancel ends the job as cancelled, never as a success missing some files.
      if (ctx.signal.aborted) throw thrown;
      const raw = toBridgeError(thrown);
      const error = raw.code === 'unsupported-op' ? { ...raw, message: UPDATE_FOR_FILES } : raw;
      failed(candidate, error);
      ctx.log.warn('a file the reply offers was not downloaded', {
        file: candidate.label,
        code: error.code,
      });
      if (STOPS_DOWNLOADS.has(error.code)) {
        for (const rest of candidates.slice(index + 1)) {
          failed(
            rest,
            error.code === 'unsupported-op'
              ? error
              : {
                  ...error,
                  message: `not tried after ${candidate.label} failed: ${error.message}`,
                },
          );
        }
        break;
      }
    }
  }
  return { files, failedFiles };
}
