import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { WebSocket } from 'ws';
import { loadApiConfig } from '@rook/config';

/**
 * End-to-end test: the flow from the definition of done.
 *
 * Register two accounts, create a community and channel, join the second
 * account to it, connect both over WebSocket, and exchange a persisted message
 * in real time — through the real HTTP API and the real gateway, over the
 * network, with no internals stubbed.
 *
 * This is the only suite that treats the system as a black box. It needs the
 * API and the realtime gateway running:
 *
 *     pnpm infra:up && pnpm db:migrate && pnpm dev
 *     pnpm test:e2e
 */

const config = loadApiConfig();
const apiUrl = config.http.publicUrl;

// The API's config intentionally excludes realtime settings (each service
// validates only what it uses), so the gateway URL is read from the same
// variable the desktop client uses.
const realtimeUrl = `${(process.env['REALTIME_PUBLIC_URL'] ?? 'ws://127.0.0.1:4001').replace(
  /\/+$/u,
  '',
)}/ws`;

interface CallResult {
  readonly status: number;
  readonly body: Record<string, never> & Record<string, unknown>;
}

async function call(
  method: string,
  path: string,
  options: { token?: string; body?: unknown } = {},
): Promise<CallResult> {
  const response = await fetch(`${apiUrl}${path}`, {
    method,
    headers: {
      ...(options.body !== undefined ? { 'content-type': 'application/json' } : {}),
      ...(options.token !== undefined ? { authorization: `Bearer ${options.token}` } : {}),
    },
    ...(options.body !== undefined ? { body: JSON.stringify(options.body) } : {}),
  });

  const text = await response.text();
  return {
    status: response.status,
    body: (text.length > 0 ? JSON.parse(text) : {}) as CallResult['body'],
  };
}

/** A test client that records every event it receives. */
function connect(token: string, channelIds: string[]) {
  const socket = new WebSocket(realtimeUrl, { origin: 'http://localhost:1420' });
  const events: Record<string, unknown>[] = [];

  const decode = (data: Buffer | ArrayBuffer | Buffer[]): Record<string, unknown> =>
    JSON.parse(
      Array.isArray(data)
        ? Buffer.concat(data).toString('utf8')
        : Buffer.from(data as ArrayBuffer).toString('utf8'),
    ) as Record<string, unknown>;

  socket.on('message', (data) => {
    events.push(decode(data));
  });

  return {
    socket,
    events,
    opened: () =>
      new Promise<void>((resolve, reject) => {
        socket.once('open', () => resolve());
        socket.once('error', reject);
      }),
    identify: () =>
      socket.send(JSON.stringify({ type: 'identify', protocolVersion: 1, token, channelIds })),
    /** Resolves with the first event matching `predicate`, or undefined. */
    waitFor: (predicate: (event: Record<string, unknown>) => boolean, timeoutMs = 8000) =>
      new Promise<Record<string, unknown> | undefined>((resolve) => {
        const existing = events.find(predicate);
        if (existing !== undefined) {
          resolve(existing);
          return;
        }

        const onMessage = (data: Buffer): void => {
          const event = decode(data);
          if (predicate(event)) {
            socket.off('message', onMessage);
            resolve(event);
          }
        };

        socket.on('message', onMessage);
        setTimeout(() => {
          socket.off('message', onMessage);
          resolve(undefined);
        }, timeoutMs).unref?.();
      }),
    close: () => socket.close(),
  };
}

type Client = ReturnType<typeof connect>;

const unique = (prefix: string): string =>
  `${prefix}${Date.now().toString(36)}${Math.floor(Math.random() * 1000)}`;

let aliceToken: string;
let bobToken: string;
let aliceId: string;
let channelId: string;
let joinCode: string;
let alice: Client;
let bob: Client;

beforeAll(async () => {
  // Fail with something actionable if the services are not up, rather than a
  // wall of connection errors from every test.
  try {
    const health = await fetch(`${apiUrl}/health/ready`, { signal: AbortSignal.timeout(3000) });
    if (!health.ok) throw new Error(`API readiness returned ${health.status}`);
  } catch (error) {
    throw new Error(
      `The API is not reachable at ${apiUrl}. Start the services with \`pnpm dev\` before running the e2e suite.`,
      { cause: error },
    );
  }
}, 20_000);

afterAll(() => {
  alice?.close();
  bob?.close();
});

describe('the full messaging flow', () => {
  it('registers two accounts', async () => {
    const aliceName = unique('e2ea');
    const bobName = unique('e2eb');
    const password = 'an-end-to-end-password';

    const aliceResult = await call('POST', '/v1/auth/register', {
      body: { username: aliceName, email: `${aliceName}@rook.test`, password },
    });
    const bobResult = await call('POST', '/v1/auth/register', {
      body: { username: bobName, email: `${bobName}@rook.test`, password },
    });

    expect(aliceResult.status).toBe(201);
    expect(bobResult.status).toBe(201);

    aliceToken = (aliceResult.body as { token: string }).token;
    bobToken = (bobResult.body as { token: string }).token;
    aliceId = (aliceResult.body as { user: { id: string } }).user.id;

    expect(aliceToken).toBeTypeOf('string');
    expect(bobToken).toBeTypeOf('string');
  });

  it('signs in with the registered credentials', async () => {
    // Proves the password was hashed and can be verified, not just stored.
    const me = await call('GET', '/v1/auth/me', { token: aliceToken });
    expect(me.status).toBe(200);
  });

  it('creates a community and a channel', async () => {
    const community = await call('POST', '/v1/communities', {
      token: aliceToken,
      body: { name: 'End to end' },
    });
    expect(community.status).toBe(201);

    const created = (
      community.body as {
        community: { id: string; joinCode: string; role: string };
      }
    ).community;

    expect(created.role).toBe('owner');
    joinCode = created.joinCode;

    const channel = await call('POST', `/v1/communities/${created.id}/channels`, {
      token: aliceToken,
      body: { name: 'general', topic: 'end to end' },
    });
    expect(channel.status).toBe(201);

    channelId = (channel.body as { channel: { id: string } }).channel.id;
  });

  it('denies channel access to a non-member', async () => {
    // Authorisation is enforced server-side, before any membership exists.
    const denied = await call('GET', `/v1/channels/${channelId}/messages`, { token: bobToken });

    expect(denied.status).toBe(404);
    expect((denied.body as { error: { code: string } }).error.code).toBe('channel_not_found');
  });

  it('grants access once the second account joins', async () => {
    const joined = await call('POST', '/v1/communities/join', {
      token: bobToken,
      body: { joinCode },
    });
    expect(joined.status).toBe(200);
    expect((joined.body as { community: { role: string } }).community.role).toBe('member');

    const allowed = await call('GET', `/v1/channels/${channelId}/messages`, { token: bobToken });
    expect(allowed.status).toBe(200);
  });

  it('connects both clients over WebSocket', async () => {
    alice = connect(aliceToken, [channelId]);
    bob = connect(bobToken, [channelId]);

    await alice.opened();
    await bob.opened();

    alice.identify();
    bob.identify();

    const aliceReady = await alice.waitFor((event) => event['type'] === 'ready');
    const bobReady = await bob.waitFor((event) => event['type'] === 'ready');

    expect(aliceReady?.['type']).toBe('ready');
    expect(bobReady?.['type']).toBe('ready');
    expect((aliceReady as { subscribedChannelIds: string[] }).subscribedChannelIds).toContain(
      channelId,
    );
  });

  it('delivers a sent message to the other client in real time', async () => {
    const sent = await call('POST', `/v1/channels/${channelId}/messages`, {
      token: aliceToken,
      body: { content: 'hello over the wire', idempotencyKey: randomUUID() },
    });

    expect(sent.status).toBe(201);
    const messageId = (sent.body as { message: { id: string } }).message.id;

    const received = await bob.waitFor(
      (event) =>
        event['type'] === 'message.created' &&
        (event as { message: { id: string } }).message.id === messageId,
    );

    expect(received).toBeDefined();
    expect((received as { message: { content: string } }).message.content).toBe(
      'hello over the wire',
    );
    // The author is embedded, so the client needs no second request to render.
    expect((received as { message: { author: { id: string } } }).message.author.id).toBe(aliceId);
  });

  it('persists the message, so a cold read returns it', async () => {
    // The event is a notification; PostgreSQL is the source of truth. A fresh
    // HTTP read is what proves it was actually persisted.
    const history = await call('GET', `/v1/channels/${channelId}/messages`, { token: bobToken });

    expect(history.status).toBe(200);
    const messages = (history.body as { messages: { content: string }[] }).messages;
    expect(messages.some((message) => message.content === 'hello over the wire')).toBe(true);
  });

  it('does not echo a message back to its sender', async () => {
    const sent = await call('POST', `/v1/channels/${channelId}/messages`, {
      token: aliceToken,
      body: { content: 'no echo please', idempotencyKey: randomUUID() },
    });

    const messageId = (sent.body as { message: { id: string } }).message.id;

    // Bob receives it...
    const bobGot = await bob.waitFor(
      (event) =>
        event['type'] === 'message.created' &&
        (event as { message: { id: string } }).message.id === messageId,
    );
    expect(bobGot).toBeDefined();

    // ...but Alice, who already rendered it optimistically, does not.
    const aliceEcho = await alice.waitFor(
      (event) =>
        event['type'] === 'message.created' &&
        (event as { message: { id: string } }).message.id === messageId,
      1500,
    );
    expect(aliceEcho).toBeUndefined();
  });

  it('delivers edits and deletions', async () => {
    const sent = await call('POST', `/v1/channels/${channelId}/messages`, {
      token: aliceToken,
      body: { content: 'before', idempotencyKey: randomUUID() },
    });
    const messageId = (sent.body as { message: { id: string } }).message.id;

    await bob.waitFor(
      (event) =>
        event['type'] === 'message.created' &&
        (event as { message: { id: string } }).message.id === messageId,
    );

    await call('PATCH', `/v1/messages/${messageId}`, {
      token: aliceToken,
      body: { content: 'after' },
    });

    const updated = await bob.waitFor(
      (event) =>
        event['type'] === 'message.updated' &&
        (event as { message: { id: string } }).message.id === messageId,
    );
    expect((updated as { message: { content: string } }).message.content).toBe('after');

    await call('DELETE', `/v1/messages/${messageId}`, { token: aliceToken });

    const deleted = await bob.waitFor(
      (event) =>
        event['type'] === 'message.deleted' &&
        (event as { messageId: string }).messageId === messageId,
    );
    expect(deleted).toBeDefined();
    // The deletion carries ids only; deleted text must not travel.
    expect(deleted).not.toHaveProperty('message');
  });

  it('treats a retried send as the same message', async () => {
    const key = randomUUID();
    const body = { content: 'exactly once', idempotencyKey: key };

    const first = await call('POST', `/v1/channels/${channelId}/messages`, {
      token: aliceToken,
      body,
    });
    const second = await call('POST', `/v1/channels/${channelId}/messages`, {
      token: aliceToken,
      body,
    });

    expect(first.status).toBe(201);
    // 200 rather than 201: the retry created nothing.
    expect(second.status).toBe(200);
    expect((second.body as { message: { id: string } }).message.id).toBe(
      (first.body as { message: { id: string } }).message.id,
    );

    // And only one copy exists in history.
    const history = await call('GET', `/v1/channels/${channelId}/messages?limit=100`, {
      token: aliceToken,
    });
    const matching = (history.body as { messages: { content: string }[] }).messages.filter(
      (message) => message.content === 'exactly once',
    );
    expect(matching).toHaveLength(1);
  });

  it('recovers missed messages over HTTP after a reconnect', async () => {
    bob.close();
    await new Promise((resolve) => setTimeout(resolve, 300));

    const missed = await call('POST', `/v1/channels/${channelId}/messages`, {
      token: aliceToken,
      body: { content: 'sent while bob was away', idempotencyKey: randomUUID() },
    });
    const missedId = (missed.body as { message: { id: string } }).message.id;

    // Let the relay publish while nobody is listening. Redis pub/sub keeps
    // nothing, so this event is genuinely gone from the socket's perspective.
    await new Promise((resolve) => setTimeout(resolve, 1200));

    bob = connect(bobToken, [channelId]);
    await bob.opened();
    bob.identify();
    await bob.waitFor((event) => event['type'] === 'ready');

    // Nothing is replayed on the socket...
    const replayed = await bob.waitFor((event) => event['type'] === 'message.created', 1500);
    expect(replayed).toBeUndefined();

    // ...and the authoritative recovery path is a history fetch.
    const history = await call('GET', `/v1/channels/${channelId}/messages?limit=100`, {
      token: bobToken,
    });
    const recovered = (
      history.body as { messages: { id: string; content: string }[] }
    ).messages.find((message) => message.id === missedId);
    expect(recovered?.content).toBe('sent while bob was away');

    // And live delivery resumes, exactly once.
    const live = await call('POST', `/v1/channels/${channelId}/messages`, {
      token: aliceToken,
      body: { content: 'back online', idempotencyKey: randomUUID() },
    });
    const liveId = (live.body as { message: { id: string } }).message.id;

    await bob.waitFor(
      (event) =>
        event['type'] === 'message.created' &&
        (event as { message: { id: string } }).message.id === liveId,
    );

    const duplicates = bob.events.filter(
      (event) =>
        event['type'] === 'message.created' &&
        (event as { message: { id: string } }).message.id === liveId,
    );
    expect(duplicates).toHaveLength(1);
  });

  it('refuses a socket bearing a revoked token', async () => {
    const extra = await call('POST', '/v1/auth/login', {
      body: {
        identifier: await call('GET', '/v1/auth/me', { token: bobToken }).then(
          (result) => (result.body as { user: { username: string } }).user.username,
        ),
        password: 'an-end-to-end-password',
      },
    });

    const token = (extra.body as { token: string }).token;
    await call('POST', '/v1/auth/logout', { token });

    const rejected = connect(token, [channelId]);
    await rejected.opened();
    rejected.identify();

    const closeCode = await new Promise<number | undefined>((resolve) => {
      rejected.socket.once('close', (code) => resolve(code));
      setTimeout(() => resolve(undefined), 5000).unref?.();
    });

    // 4001: authentication failed, and fatal — the client must not retry.
    expect(closeCode).toBe(4001);
  });
});
