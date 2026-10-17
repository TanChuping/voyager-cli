import {
  BRIDGE_PATHS,
  negotiateProtocol,
  PROTOCOL,
  validateMessage,
  type HelloResponse,
  type PairResponse,
} from '@voyager-crew/bridge-protocol';

import { failure } from '../../util/errors';
import { CLI_VERSION } from '../../version';
import { bearer } from '../guards';
import type { Route, ServerCore } from '../http';
import { HttpFailure } from '../respond';

const exact = (path: string): RegExp => new RegExp(`^${path.replace(/[.]/g, '\\.')}$`);

export function openRoutes(core: ServerCore): Route[] {
  return [
    {
      method: 'POST',
      pattern: exact(BRIDGE_PATHS.hello),
      access: 'open',
      handle: ({ req, body, origin }) => {
        const checked = validateMessage('helloRequest', body);
        if (!checked.ok) throw failure('bad-request', 'invalid hello', { issues: checked.issues });
        const hello = checked.value;
        const negotiation =
          hello.client === 'extension'
            ? negotiateProtocol({ extension: hello.protocol, cli: PROTOCOL })
            : negotiateProtocol({ extension: PROTOCOL, cli: hello.protocol });
        if (!negotiation.ok) {
          throw new HttpFailure(
            400,
            failure('protocol-mismatch', 'no protocol version in common', {
              supported: PROTOCOL,
              upgrade: hello.client === 'cli' ? 'cli' : negotiation.upgrade,
            }).error,
          );
        }
        // An extension learns whether its own token still counts; a CLI, whether anything is paired.
        const paired =
          hello.client === 'extension'
            ? core.pairing.checkToken(bearer(req), origin) === 'ok'
            : core.pairing.current !== null;
        const data: HelloResponse = {
          serverId: core.pairing.serverId,
          serverVersion: CLI_VERSION,
          protocol: { ...PROTOCOL, selected: negotiation.selected },
          paired,
        };
        return { status: 200, data };
      },
    },
    {
      method: 'POST',
      pattern: exact(BRIDGE_PATHS.pair),
      access: 'pair',
      handle: async ({ body, origin }) => {
        const checked = validateMessage('pairRequest', body);
        if (!checked.ok)
          throw failure('bad-request', 'invalid pair request', { issues: checked.issues });
        if (origin === undefined)
          throw failure('unauthorized', 'pairing has to come from the extension');
        const token = await core.pairing.redeem({ ...checked.value, origin });
        core.extension.forget();
        core.log.info('extension paired', {
          browser: checked.value.browser,
          extensionVersion: checked.value.extensionVersion,
        });
        const data: PairResponse = { token, serverId: core.pairing.serverId };
        return { status: 200, data };
      },
    },
  ];
}
