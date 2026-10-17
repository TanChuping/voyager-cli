import {
  BRIDGE_PATHS,
  PAIRING_TOKEN_PATTERN,
  type StatusResponse,
} from '@voyager-crew/bridge-protocol';
import { readFile, stat } from 'node:fs/promises';
import { afterEach, describe, expect, it } from 'vitest';

import { PAIRING_CODE_TTL_MS } from '../../src/server/pairing';
import { CLI_LOCAL_PATHS } from '../../src/server/paths';
import { FakeExtension, pairFake } from '../helpers/fakeExtension';
import { data, startTestServer, type TestServer } from '../helpers/server';

let t: TestServer | undefined;
afterEach(async () => {
  await t?.close();
  t = undefined;
});

async function issueCode(server: TestServer): Promise<string> {
  return data<{ code: string }>(await server.cli('POST', BRIDGE_PATHS.pairingCodes)).code;
}

describe('pairing', () => {
  it('trades a code for a token and stores only its hash, privately', async () => {
    t = await startTestServer();
    const fake = new FakeExtension(t.port);
    const code = await issueCode(t);
    expect(code).toMatch(/^[0-9]{8}$/);

    const paired = await fake.pair(code);
    expect(paired.status).toBe(200);
    expect(fake.token).toMatch(PAIRING_TOKEN_PATTERN);
    expect(fake.protocolErrors).toEqual([]);

    const stored = await readFile(t.paths.pairings, 'utf8');
    expect(stored).not.toContain(fake.token);
    expect((await stat(t.paths.pairings)).mode & 0o777).toBe(0o600);

    const state = data<{ state: string; browser: string }>(
      await t.cli('GET', CLI_LOCAL_PATHS.pairingCode(code)),
    );
    expect(state).toMatchObject({ state: 'paired', browser: 'chrome' });
    const status = data<StatusResponse>(await t.cli('GET', BRIDGE_PATHS.status));
    expect(status.extension).toMatchObject({ paired: true, browser: 'chrome', version: '2.1.0' });

    const hello = await fake.hello();
    expect((hello.json as { data: { paired: boolean } }).data.paired).toBe(true);
  });

  it('accepts a code only once', async () => {
    t = await startTestServer();
    const code = await issueCode(t);
    expect((await new FakeExtension(t.port).pair(code)).status).toBe(200);
    expect((await new FakeExtension(t.port).pair(code)).status).toBe(401);
  });

  it('voids every pending code after five wrong attempts', async () => {
    t = await startTestServer();
    const code = await issueCode(t);
    const wrong = code === '00000000' ? '11111111' : '00000000';
    const attacker = new FakeExtension(t.port);
    for (let attempt = 0; attempt < 5; attempt += 1) {
      expect((await attacker.pair(wrong)).status).toBe(401);
    }
    expect((await new FakeExtension(t.port).pair(code)).status).toBe(401);
    const state = data<{ state: string }>(await t.cli('GET', CLI_LOCAL_PATHS.pairingCode(code)));
    expect(state.state).toBe('expired');
  });

  it('refuses a code after five minutes', async () => {
    let now = Date.now();
    t = await startTestServer({ now: () => now });
    const code = await issueCode(t);
    now += PAIRING_CODE_TTL_MS + 1;
    expect((await new FakeExtension(t.port).pair(code)).status).toBe(401);
  });

  it('tells a replaced or revoked extension it is unpaired', async () => {
    t = await startTestServer();
    const first = new FakeExtension(t.port);
    await pairFake(first, t.cli);
    const second = new FakeExtension(t.port);
    await pairFake(second, t.cli);

    expect((await first.poll()).message).toEqual({ kind: 'unpaired' });
    expect((await second.poll()).status).toBe(204);

    expect(data<{ revoked: boolean }>(await t.cli('POST', CLI_LOCAL_PATHS.unpair)).revoked).toBe(
      true,
    );
    expect((await second.poll()).message).toEqual({ kind: 'unpaired' });
    const status = data<StatusResponse>(await t.cli('GET', BRIDGE_PATHS.status));
    expect(status.extension.paired).toBe(false);
  });

  it('keeps the pairing across a serve restart', async () => {
    t = await startTestServer();
    const fake = new FakeExtension(t.port);
    await pairFake(fake, t.cli);
    t = await t.restart();
    const again = new FakeExtension(t.port);
    again.token = fake.token;
    expect((await again.poll()).status).toBe(204);
  });
});
