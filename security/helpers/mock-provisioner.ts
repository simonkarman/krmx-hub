import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

export interface MockProvisioner {
  url: string;
  /** Raw provision requests the hub delivered (for signature assertions). */
  received: { headers: Record<string, string | undefined>; body: string }[];
  close: () => Promise<void>;
}

type Behavior =
  | { kind: 'respond'; status?: number; body: unknown }
  | { kind: 'hang' }; // never responds → exercises the hub's provision timeout (P-06)

/**
 * A stand-in host provision endpoint the hub can call during tests. It does not
 * verify the HMAC (that path is covered directly against the host SDK in
 * provision/host-sdk.test.ts); its job is to return crafted responses so the
 * hub's response-handling invariants can be exercised (P-03, P-04, P-06).
 */
export async function startMockProvisioner(behavior: Behavior): Promise<MockProvisioner> {
  const received: MockProvisioner['received'] = [];
  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      received.push({
        headers: {
          'x-hub-timestamp': first(req.headers['x-hub-timestamp']),
          'x-hub-signature': first(req.headers['x-hub-signature']),
        },
        body: Buffer.concat(chunks).toString('utf8'),
      });
      if (behavior.kind === 'hang') return; // leave the socket open
      res.writeHead(behavior.status ?? 200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(behavior.body));
    });
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;

  return {
    url: `http://127.0.0.1:${port}/provision`,
    received,
    close: () =>
      new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve()))),
  };
}

function first(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}
