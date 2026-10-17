import { request } from 'node:http';

export interface RawResponse {
  readonly status: number;
  readonly headers: Record<string, string | string[] | undefined>;
  readonly json: unknown;
}

export interface RawRequest {
  readonly port: number;
  readonly method?: string;
  readonly path: string;
  readonly headers?: Record<string, string>;
  readonly body?: unknown;
  /** Send this exact string as the body. */
  readonly rawBody?: string;
  readonly signal?: AbortSignal;
}

/** node:http rather than fetch, so tests control Host and Origin exactly. */
export function rawRequest(options: RawRequest): Promise<RawResponse> {
  const body =
    options.rawBody ?? (options.body === undefined ? undefined : JSON.stringify(options.body));
  return new Promise((resolve, reject) => {
    const req = request(
      {
        host: '127.0.0.1',
        port: options.port,
        method: options.method ?? 'GET',
        path: options.path,
        headers: {
          host: `127.0.0.1:${options.port}`,
          ...(body === undefined ? {} : { 'content-type': 'application/json' }),
          ...options.headers,
        },
        ...(options.signal === undefined ? {} : { signal: options.signal }),
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          resolve({
            status: res.statusCode ?? 0,
            headers: res.headers,
            json: text === '' ? undefined : (JSON.parse(text) as unknown),
          });
        });
        res.on('error', reject);
      },
    );
    req.on('error', reject);
    if (body !== undefined) req.write(body);
    req.end();
  });
}
