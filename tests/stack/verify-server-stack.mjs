// Verifies the containerised server stack through Caddy, exactly as the
// Cloudflare tunnel will reach it. Requires the local override:
//
//   docker compose -f docker-compose.server.yml -f docker-compose.server.local.yml \
//     --env-file .env.server up -d
import { WebSocket } from 'ws';

const API = 'http://127.0.0.1:8080';
const WS = 'ws://127.0.0.1:8080/ws';

let pass = 0;
const fails = [];
const check = (name, expected, actual) => {
  if (String(expected) === String(actual)) pass += 1;
  else {
    fails.push(`${name}: expected ${expected}, got ${actual}`);
    console.log(`  FAIL ${name}: expected ${expected}, got ${actual}`);
  }
};

async function call(method, path, options = {}) {
  const response = await fetch(API + path, {
    method,
    headers: {
      ...(options.body ? { 'content-type': 'application/json' } : {}),
      ...(options.token ? { authorization: `Bearer ${options.token}` } : {}),
      // The real client is the Tauri webview, so requests carry that origin.
      origin: 'tauri://localhost',
    },
    ...(options.body ? { body: JSON.stringify(options.body) } : {}),
  });
  const text = await response.text();

  let body;
  try {
    body = text ? JSON.parse(text) : {};
  } catch {
    // Caddy's refusal for blocked paths is plain text, not JSON.
    body = { raw: text };
  }

  return { status: response.status, body };
}

const unique = (prefix) => prefix + Date.now().toString(36) + Math.floor(Math.random() * 1000);

console.log('== edge routing ==');
check('api root', 200, (await call('GET', '/')).status);
// Health and metrics are unauthenticated, so they must not be reachable from
// the edge even though they work internally.
check('health blocked at the edge', 404, (await call('GET', '/health/live')).status);
check('metrics blocked at the edge', 404, (await call('GET', '/metrics')).status);

console.log('== auth ==');
const name = unique('srv');
const registered = await call('POST', '/v1/auth/register', {
  body: { username: name, email: `${name}@rook.test`, password: 'a-long-enough-password' },
});
check('register', 201, registered.status);
const token = registered.body.token;
check('authenticated read', 200, (await call('GET', '/v1/auth/me', { token })).status);

console.log('== community and channel ==');
const community = await call('POST', '/v1/communities', { token, body: { name: 'Server Test' } });
check('community created', 201, community.status);
const communityId = community.body.community.id;

const channel = await call('POST', `/v1/communities/${communityId}/channels`, {
  token,
  body: { name: 'general' },
});
check('channel created', 201, channel.status);
const channelId = channel.body.channel.id;

console.log('== persisted messaging ==');
const sent = await call('POST', `/v1/channels/${channelId}/messages`, {
  token,
  body: { content: 'hello from docker', idempotencyKey: crypto.randomUUID() },
});
check('message sent', 201, sent.status);

const history = await call('GET', `/v1/channels/${channelId}/messages`, { token });
check('message persisted', 'hello from docker', history.body.messages?.[0]?.content);

console.log('== realtime through the proxy ==');
const mate = unique('mate');
const mateRegistered = await call('POST', '/v1/auth/register', {
  body: { username: mate, email: `${mate}@rook.test`, password: 'a-long-enough-password' },
});
await call('POST', '/v1/communities/join', {
  token: mateRegistered.body.token,
  body: { joinCode: community.body.community.joinCode },
});

const socket = new WebSocket(WS, { origin: 'tauri://localhost' });
const events = [];
socket.on('message', (data) => events.push(JSON.parse(data.toString())));

await new Promise((resolve, reject) => {
  socket.once('open', resolve);
  socket.once('error', reject);
});
check('websocket upgraded through caddy', true, socket.readyState === WebSocket.OPEN);

socket.send(
  JSON.stringify({
    type: 'identify',
    protocolVersion: 1,
    token: mateRegistered.body.token,
    channelIds: [channelId],
  }),
);

const waitFor = (predicate, timeoutMs = 8000) =>
  new Promise((resolve) => {
    const existing = events.find(predicate);
    if (existing) return resolve(existing);
    const handler = (data) => {
      const event = JSON.parse(data.toString());
      if (predicate(event)) {
        socket.off('message', handler);
        resolve(event);
      }
    };
    socket.on('message', handler);
    setTimeout(() => {
      socket.off('message', handler);
      resolve(undefined);
    }, timeoutMs).unref?.();
  });

check('ready received', 'ready', (await waitFor((e) => e.type === 'ready'))?.type);

const live = await call('POST', `/v1/channels/${channelId}/messages`, {
  token,
  body: { content: 'live through the proxy', idempotencyKey: crypto.randomUUID() },
});
const delivered = await waitFor(
  (e) => e.type === 'message.created' && e.message?.id === live.body.message.id,
);
check('realtime delivery', 'live through the proxy', delivered?.message?.content);

console.log('== media authorisation ==');
const upload = await call('POST', '/v1/media/uploads', {
  token,
  body: { declaredContentType: 'image/png', declaredByteSize: 2048, filename: 'x.png' },
});
check('upload authorised', 201, upload.status);
// The presigned URL must name the PUBLIC storage hostname: the client resolves
// it, so an internal service name would be unreachable.
check(
  'presigned url uses the public storage hostname',
  true,
  String(upload.body.uploadUrl).startsWith('https://files.rook.relf.cc'),
);

console.log('== outbox drained ==');
// Scraped internally; the edge refuses it.
const metrics = await fetch('http://127.0.0.1:8080/metrics').then((r) => r.status);
check('metrics not public', 404, metrics);

socket.close();
console.log(`\nRESULT: ${pass} passed, ${fails.length} failed`);
if (fails.length) {
  for (const failure of fails) console.log(`  - ${failure}`);
  process.exit(1);
}
process.exit(0);
