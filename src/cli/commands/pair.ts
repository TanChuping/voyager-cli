import { BRIDGE_PATHS, type PairingCodeResponse } from '@voyager-crew/bridge-protocol';

import { ensureServe } from '../../client/serveClient';
import type { CodeState } from '../../server/pairing';
import { CLI_LOCAL_PATHS } from '../../server/paths';
import type { StatePaths } from '../../state/paths';
import { parse } from '../args';
import { EXIT } from '../exitCodes';
import { note, printLine } from '../output';

/**
 * `voyager pair`: show a one-time code, then wait for the extension to redeem
 * it. The code goes to the terminal only, never to a log. With `--json`, one
 * JSON object per line: `{"event":"code",…}` first, then `paired` or `expired`.
 */
export async function pairCommand(paths: StatePaths, argv: readonly string[]): Promise<number> {
  const args = parse(argv, {
    revoke: { type: 'boolean', summary: 'forget the paired extension' },
    json: { type: 'boolean', summary: 'JSON lines on stdout' },
  });
  const json = args.options.json === true;
  const client = await ensureServe(paths);

  if (args.options.revoke === true) {
    const { revoked } = await client.request<{ revoked: boolean }>('POST', CLI_LOCAL_PATHS.unpair);
    if (json) printLine(JSON.stringify({ event: 'revoked', revoked }));
    else
      note(
        revoked ? 'Pairing revoked. Remove it in the Voyager popup too.' : 'Nothing was paired.',
      );
    return 0;
  }

  const { code, expiresAt } = await client.request<PairingCodeResponse>(
    'POST',
    BRIDGE_PATHS.pairingCodes,
  );
  const shown = `${code.slice(0, 4)}-${code.slice(4)}`;
  if (json) printLine(JSON.stringify({ event: 'code', code: shown, expiresAt }));
  else {
    printLine(`Pairing code: ${shown}`);
    note('In Voyager’s popup, open the ChatGPT bridge card, enter this code and click Pair.');
    note('The code works once and expires in 5 minutes. Waiting…');
  }

  for (;;) {
    await new Promise((resolve) => setTimeout(resolve, 500));
    const state = await client.request<CodeState>('GET', CLI_LOCAL_PATHS.pairingCode(code));
    if (state.state === 'paired') {
      if (json) {
        printLine(
          JSON.stringify({
            event: 'paired',
            browser: state.browser,
            extensionVersion: state.extensionVersion,
          }),
        );
      } else note(`Paired with ${state.browser}, Voyager ${state.extensionVersion}.`);
      return 0;
    }
    if (state.state === 'expired') {
      if (json) printLine(JSON.stringify({ event: 'expired' }));
      else note('The code expired or was voided after wrong attempts. Run voyager pair again.');
      return EXIT.offline;
    }
  }
}
