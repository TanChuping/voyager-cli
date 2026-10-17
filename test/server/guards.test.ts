import { BRIDGE_PATHS, PROTOCOL, PROTOCOL_HEADER } from '@voyager-crew/bridge-protocol';
import { stat } from 'node:fs/promises';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { EXT_ORIGIN, FakeExtension, pairFake } from '../helpers/fakeExtension';
import { rawRequest } from '../helpers/http';
import { errorCode, startTestServer, type TestServer } from '../helpers/server';

let t: TestServer;

beforeEach(async () => {
  t = await startTestServer();
});
afterEach(async () => {
  await t.close();
});

const cliHeaders = (extra: Record<string, string> = {}) => ({
  authorization: `Bearer ${t.cliToken}`,
  [PROTOCOL_HEADER]: '1',
  ...extra,
});
const hello = { client: 'cli', version: '0.0.0', protocol: PROTOCOL };

describe('Host header (DNS rebinding)', () => {
  it('refuses a foreign Host even with the right token', async () => {
    const response = await rawRequest({
      port: t.port,
      path: BRIDGE_PATHS.status,
      headers: cliHeaders({ host: `evil.example:${t.port}` }),
    });
    expect(response.status).toBe(403);
    expect(errorCode(response)).toBe('unauthorized');
  });

  it('refuses the right host on another port', async () => {
    const response = await rawRequest({
      port: t.port,
      path: BRIDGE_PATHS.status,
      headers: cliHeaders({ host: `127.0.0.1:${t.port + 1}` }),
    });
    expect(response.status).toBe(403);
  });

  it('accepts localhost with this port', async () => {
    const response = await rawRequest({
      port: t.port,
      path: BRIDGE_PATHS.status,
      headers: cliHeaders({ host: `localhost:${t.port}` }),
    });
    expect(response.status).toBe(200);
  });
});

describe('Origin rules', () => {
  it('refuses a CLI request from a web page even with the CLI token', async () => {
    const response = await rawRequest({
      port: t.port,
      method: 'POST',
      path: BRIDGE_PATHS.jobs,
      body: { plugin: 'ask', command: 'ask', input: { prompt: 'x' } },
      headers: cliHeaders({ origin: 'https://evil.example' }),
    });
    expect(response.status).toBe(403);
  });

  it('refuses a CLI request carrying an extension Origin', async () => {
    const response = await rawRequest({
      port: t.port,
      path: BRIDGE_PATHS.status,
      headers: cliHeaders({ origin: EXT_ORIGIN }),
    });
    expect(response.status).toBe(403);
  });

  it('refuses hello from a web page but answers a CLI and the extension', async () => {
    const page = await rawRequest({
      port: t.port,
      method: 'POST',
      path: BRIDGE_PATHS.hello,
      body: hello,
      headers: { origin: 'http://localhost:3000' },
    });
    expect(page.status).toBe(403);
    const sandboxed = await rawRequest({
      port: t.port,
      method: 'POST',
      path: BRIDGE_PATHS.hello,
      body: hello,
      headers: { origin: 'null' },
    });
    expect(sandboxed.status).toBe(403);
    const cli = await rawRequest({
      port: t.port,
      method: 'POST',
      path: BRIDGE_PATHS.hello,
      body: hello,
    });
    expect(cli.status).toBe(200);
    const fake = new FakeExtension(t.port);
    expect((await fake.hello()).status).toBe(200);
    expect(fake.protocolErrors).toEqual([]);
  });

  it('accepts pairing only from an extension Origin', async () => {
    const issued = await t.cli('POST', BRIDGE_PATHS.pairingCodes);
    const { code } = (issued.json as { data: { code: string } }).data;
    const body = { code, browser: 'chrome', extensionVersion: '2.1.0' };
    const fromCli = await rawRequest({
      port: t.port,
      method: 'POST',
      path: BRIDGE_PATHS.pair,
      body,
      headers: { [PROTOCOL_HEADER]: '1' },
    });
    expect(fromCli.status).toBe(403);
    const fromPage = await rawRequest({
      port: t.port,
      method: 'POST',
      path: BRIDGE_PATHS.pair,
      body,
      headers: { [PROTOCOL_HEADER]: '1', origin: 'https://chatgpt.com' },
    });
    expect(fromPage.status).toBe(403);
  });

  it('refuses the paired token from another extension Origin', async () => {
    const fake = new FakeExtension(t.port);
    await pairFake(fake, t.cli);
    fake.origin = `chrome-extension://${'p'.repeat(32)}`;
    expect((await fake.poll()).status).toBe(403);
  });

  it('never answers a preflight and never sends CORS headers', async () => {
    const preflight = await rawRequest({
      port: t.port,
      method: 'OPTIONS',
      path: BRIDGE_PATHS.jobs,
      headers: { origin: 'https://evil.example', 'access-control-request-method': 'POST' },
    });
    expect(preflight.status).toBe(403);
    const ok = await t.cli('GET', BRIDGE_PATHS.status);
    for (const response of [preflight, ok]) {
      expect(
        Object.keys(response.headers).filter((name) => name.startsWith('access-control-')),
      ).toEqual([]);
    }
  });
});

describe('tokens', () => {
  it('refuses a missing or wrong CLI token', async () => {
    const missing = await rawRequest({
      port: t.port,
      path: BRIDGE_PATHS.status,
      headers: { [PROTOCOL_HEADER]: '1' },
    });
    expect(missing.status).toBe(401);
    const wrong = await rawRequest({
      port: t.port,
      path: BRIDGE_PATHS.status,
      headers: { authorization: `Bearer ${'x'.repeat(43)}`, [PROTOCOL_HEADER]: '1' },
    });
    expect(wrong.status).toBe(401);
  });

  it('refuses a missing or wrong extension token', async () => {
    const fake = new FakeExtension(t.port);
    await pairFake(fake, t.cli);
    const realToken = fake.token;
    fake.token = undefined;
    expect((await fake.poll()).status).toBe(401);
    fake.token = `${realToken?.slice(0, -1)}${realToken?.endsWith('A') ? 'B' : 'A'}`;
    expect((await fake.poll()).status).toBe(401);
    fake.token = realToken;
    expect((await fake.poll()).status).toBe(204);
  });

  it('keeps the CLI token private to the user', async () => {
    expect((await stat(t.paths.cliToken)).mode & 0o777).toBe(0o600);
    expect((await stat(t.paths.home)).mode & 0o777).toBe(0o700);
  });
});

describe('protocol header and body limits', () => {
  it('refuses requests without a protocol version, naming the side to upgrade', async () => {
    const cli = await rawRequest({
      port: t.port,
      path: BRIDGE_PATHS.status,
      headers: { authorization: `Bearer ${t.cliToken}` },
    });
    expect(cli.status).toBe(400);
    expect(errorCode(cli)).toBe('protocol-mismatch');

    const fake = new FakeExtension(t.port);
    await pairFake(fake, t.cli);
    const newer = await rawRequest({
      port: t.port,
      method: 'POST',
      path: BRIDGE_PATHS.extPoll,
      body: {},
      headers: {
        origin: EXT_ORIGIN,
        authorization: `Bearer ${fake.token}`,
        [PROTOCOL_HEADER]: '2',
      },
    });
    expect(newer.status).toBe(400);
    expect((newer.json as { error: { details: { upgrade: string } } }).error.details.upgrade).toBe(
      'cli',
    );
  });

  it('refuses a hello whose range does not meet ours', async () => {
    const response = await rawRequest({
      port: t.port,
      method: 'POST',
      path: BRIDGE_PATHS.hello,
      body: { client: 'extension', version: '9', protocol: { min: 2, max: 3 } },
      headers: { origin: EXT_ORIGIN },
    });
    expect(response.status).toBe(400);
    expect(
      (response.json as { error: { details: { upgrade: string } } }).error.details.upgrade,
    ).toBe('cli');
  });

  it('refuses JSON bodies over 1 MiB', async () => {
    const response = await rawRequest({
      port: t.port,
      method: 'POST',
      path: BRIDGE_PATHS.jobs,
      rawBody: JSON.stringify({
        plugin: 'ask',
        command: 'ask',
        input: { prompt: 'x'.repeat(1_100_000) },
      }),
      headers: cliHeaders(),
    });
    expect(response.status).toBe(413);
  });
});
