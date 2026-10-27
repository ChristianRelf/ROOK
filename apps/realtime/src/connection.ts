import type { WebSocket } from 'ws';
import {
  clientFrameSchema,
  closeCodes,
  PROTOCOL_VERSION,
  type ChannelId,
  type CurrentUser,
  type ErrorCode,
  type ServerEvent,
  type TransportEnvelope,
  type UserId,
} from '@rook/contracts';
import type { RealtimeConfig } from '@rook/config';
import { toLogError, type Logger, type MetricsBundle } from '@rook/observability';
import type { SubscriptionRegistry } from './subscriptions.js';
import type { PresenceTracker } from './presence.js';

/**
 * One client connection, as an explicit state machine.
 *
 * States: `awaiting-identify` -> `ready` -> `closed`.
 *
 * Until `identify` arrives the socket is anonymous and may do nothing else.
 * That ordering is the whole authentication boundary, so it is enforced here
 * rather than per message handler, where one missed check would be a hole.
 *
 * Four protections live on this path, and each exists because of a specific way
 * a socket server falls over:
 *
 *   * **Identify timeout.** An open socket that never authenticates costs
 *     memory and a file descriptor. Unauthenticated sockets are closed quickly.
 *
 *   * **Heartbeat.** TCP can keep a connection "open" long after the peer is
 *     gone (a laptop lid closing, a NAT dropping state). Without a liveness
 *     check the gateway accumulates sockets that will never be read again.
 *
 *   * **Inbound rate limit.** A client that floods frames is throttled by
 *     closing it, not by queueing — queueing is how one client's loop becomes
 *     everyone's latency.
 *
 *   * **Backpressure.** If a client cannot keep up, its outbound buffer grows
 *     in *our* heap. Past a threshold the socket is closed and the client
 *     reconnects and resyncs over HTTP, which bounds our memory regardless of
 *     how slow the slowest client is.
 */

type ConnectionState = 'awaiting-identify' | 'ready' | 'closed';

export interface ConnectionDependencies {
  readonly config: RealtimeConfig;
  readonly logger: Logger;
  readonly metrics: MetricsBundle;
  readonly subscriptions: SubscriptionRegistry;
  readonly presence: PresenceTracker;
  readonly instanceId: string;
  /** Resolves a bearer token to a user, or undefined. */
  readonly authenticate: (token: string) => Promise<CurrentUser | undefined>;
  /** Channel ids the user may subscribe to. One query, not one per channel. */
  readonly listAccessibleChannelIds: (userId: UserId) => Promise<ChannelId[]>;
  /**
   * Communities the user belongs to.
   *
   * Needed because some events are community-scoped rather than
   * channel-scoped: `channel.created` has to reach a member who could not
   * possibly be subscribed to the new channel yet, since it did not exist.
   */
  readonly listCommunityIds: (userId: UserId) => Promise<string[]>;
}

export interface Connection {
  readonly id: string;
  close: (code: number, reason: string) => void;
}

let connectionCounter = 0;

export function handleConnection(socket: WebSocket, deps: ConnectionDependencies): Connection {
  const { config, logger, metrics, subscriptions, presence, instanceId } = deps;

  const connectionId = `c${++connectionCounter}`;
  let state: ConnectionState = 'awaiting-identify';
  let user: CurrentUser | undefined;

  /** Channels this socket is subscribed to, and what it may subscribe to. */
  const subscribed = new Set<ChannelId>();
  let accessible = new Set<ChannelId>();
  /** Community-scoped subscriptions, for events that are not tied to a channel. */
  const subscribedCommunities = new Set<string>();

  // Inbound frame budget for the current window.
  let windowStart = Date.now();
  let framesInWindow = 0;

  let lastHeartbeat = Date.now();
  let heartbeatTimer: NodeJS.Timeout | undefined;

  const log = logger.child({ connectionId });

  function send(event: ServerEvent): void {
    if (state === 'closed' || socket.readyState !== socket.OPEN) return;

    // Backpressure check before writing, not after: once the buffer is past
    // the limit the memory is already committed.
    if (socket.bufferedAmount > config.maxBufferedBytes) {
      log.warn(
        { bufferedBytes: socket.bufferedAmount, limit: config.maxBufferedBytes },
        'closing slow consumer',
      );
      metrics.realtimeDropped.inc({ reason: 'backpressure' });
      close(closeCodes.backpressure, 'client could not keep up');
      return;
    }

    try {
      socket.send(JSON.stringify(event));
      metrics.realtimeEvents.inc({ event: event.type, direction: 'out' });
    } catch (error) {
      log.error({ err: toLogError(error) }, 'failed to send frame');
      close(closeCodes.goingAway, 'send failed');
    }
  }

  /** Reports a problem with something the client sent, without closing. */
  function sendError(code: ErrorCode, message: string, fatal: boolean): void {
    send({
      v: PROTOCOL_VERSION,
      ts: new Date().toISOString(),
      type: 'error',
      code,
      message,
      fatal,
    });
  }

  /** Delivers a transport envelope to this socket, honouring origin suppression. */
  const onEnvelope = (envelope: TransportEnvelope): void => {
    if (state !== 'ready' || user === undefined) return;

    // The sender already applied this change optimistically; echoing it back
    // makes the message visibly flicker as it is replaced by an identical one.
    if (envelope.originUserId !== null && envelope.originUserId === user.id) {
      return;
    }

    send(envelope.payload);
  };

  function close(code: number, reason: string): void {
    if (state === 'closed') return;
    state = 'closed';

    clearTimeout(identifyTimer);
    if (heartbeatTimer !== undefined) clearInterval(heartbeatTimer);

    // Detach from Redis before the socket goes, so no further events are
    // routed to a dead connection.
    void teardownSubscriptions().finally(() => {
      try {
        socket.close(code, reason);
      } catch {
        // Already closing or closed; nothing useful to do.
        socket.terminate();
      }
    });

    metrics.realtimeConnections.dec({ state: 'open' });
  }

  async function teardownSubscriptions(): Promise<void> {
    const tasks: Promise<void>[] = [];

    for (const channelId of subscribed) {
      tasks.push(subscriptions.removeChannel(channelId, onEnvelope));
    }
    subscribed.clear();

    for (const communityId of subscribedCommunities) {
      tasks.push(subscriptions.removeCommunity(communityId, onEnvelope));
    }
    subscribedCommunities.clear();

    if (user !== undefined) {
      tasks.push(subscriptions.removeUser(user.id, onEnvelope));
    }

    await Promise.allSettled(tasks);
  }

  /** True when the frame is within the inbound budget. */
  function withinRateLimit(): boolean {
    const now = Date.now();

    if (now - windowStart >= config.rateWindowMs) {
      windowStart = now;
      framesInWindow = 0;
    }

    framesInWindow += 1;
    return framesInWindow <= config.maxFramesPerWindow;
  }

  async function subscribeTo(channelIds: readonly ChannelId[]): Promise<{
    accepted: ChannelId[];
    rejected: ChannelId[];
  }> {
    const accepted: ChannelId[] = [];
    const rejected: ChannelId[] = [];

    for (const channelId of channelIds) {
      // Checked against the set resolved at identify time. A client cannot
      // subscribe to a channel by guessing its id.
      if (!accessible.has(channelId)) {
        rejected.push(channelId);
        continue;
      }
      if (subscribed.has(channelId)) {
        accepted.push(channelId);
        continue;
      }

      await subscriptions.addChannel(channelId, onEnvelope);
      subscribed.add(channelId);
      accepted.push(channelId);
    }

    return { accepted, rejected };
  }

  async function handleIdentify(frame: { token: string; channelIds: ChannelId[] }): Promise<void> {
    const authenticated = await deps.authenticate(frame.token);

    if (authenticated === undefined) {
      metrics.realtimeDropped.inc({ reason: 'auth' });
      // Fatal: reconnecting with the same token cannot succeed, so the client
      // must re-authenticate rather than loop.
      close(closeCodes.authenticationFailed, 'authentication failed');
      return;
    }

    user = authenticated;
    state = 'ready';

    clearTimeout(identifyTimer);

    // Resolved once per connection and cached for its lifetime. A channel
    // created later arrives as a `channel.created` event, which the client
    // follows with a subscribe — and that path re-checks access.
    accessible = new Set(await deps.listAccessibleChannelIds(user.id));

    // User-scoped events (media processing results) go to all their devices.
    await subscriptions.addUser(user.id, onEnvelope);

    // Community-scoped events: channel creation and member joins. Subscribed
    // for every community the user belongs to, because these events are not
    // addressed to a channel the client could already be watching.
    for (const communityId of await deps.listCommunityIds(user.id)) {
      await subscriptions.addCommunity(communityId, onEnvelope);
      subscribedCommunities.add(communityId);
    }

    const { accepted } = await subscribeTo(frame.channelIds);

    send({
      v: PROTOCOL_VERSION,
      ts: new Date().toISOString(),
      type: 'ready',
      userId: user.id,
      instanceId,
      heartbeatIntervalMs: config.heartbeatIntervalMs,
      subscribedChannelIds: accepted,
    });

    log.info({ userId: user.id, channels: accepted.length }, 'connection ready');

    // Started only once authenticated, so an anonymous socket is governed by
    // the identify timeout instead.
    heartbeatTimer = setInterval(() => {
      if (Date.now() - lastHeartbeat > config.heartbeatTimeoutMs) {
        log.info({ userId: user?.id }, 'heartbeat timeout');
        metrics.realtimeDropped.inc({ reason: 'heartbeat' });
        close(closeCodes.heartbeatTimeout, 'heartbeat timeout');
      }
    }, config.heartbeatIntervalMs);
  }

  async function handleFrame(raw: string): Promise<void> {
    if (!withinRateLimit()) {
      log.warn({ userId: user?.id, frames: framesInWindow }, 'inbound rate limit exceeded');
      metrics.realtimeDropped.inc({ reason: 'rate_limit' });
      close(closeCodes.rateLimited, 'too many frames');
      return;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      close(closeCodes.invalidFrame, 'frame was not valid JSON');
      return;
    }

    // Every inbound frame is schema-validated before any handler sees it.
    const result = clientFrameSchema.safeParse(parsed);
    if (!result.success) {
      // A version mismatch is reported distinctly, because the client should
      // prompt for an update rather than retry.
      const isVersionProblem = result.error.issues.some((issue) =>
        issue.message.includes('protocol version'),
      );

      if (isVersionProblem) {
        close(closeCodes.unsupportedProtocolVersion, 'unsupported protocol version');
        return;
      }

      close(closeCodes.invalidFrame, 'frame failed validation');
      return;
    }

    const frame = result.data;
    metrics.realtimeEvents.inc({ event: frame.type, direction: 'in' });

    // The authentication boundary: nothing but `identify` is accepted first.
    if (state === 'awaiting-identify' && frame.type !== 'identify') {
      close(closeCodes.authenticationFailed, 'identify must be the first frame');
      return;
    }

    switch (frame.type) {
      case 'identify': {
        if (state !== 'awaiting-identify') {
          // Re-identifying would let a socket silently change user.
          close(closeCodes.invalidFrame, 'already identified');
          return;
        }
        await handleIdentify({ token: frame.token, channelIds: frame.channelIds });
        return;
      }

      case 'heartbeat': {
        lastHeartbeat = Date.now();
        send({ v: PROTOCOL_VERSION, ts: new Date().toISOString(), type: 'heartbeat.ack' });
        return;
      }

      case 'subscribe': {
        const { rejected } = await subscribeTo(frame.channelIds);

        if (rejected.length > 0) {
          log.warn(
            { userId: user?.id, rejected: rejected.length },
            'rejected subscription to inaccessible channels',
          );
        }

        send({
          v: PROTOCOL_VERSION,
          ts: new Date().toISOString(),
          type: 'subscriptions',
          subscribedChannelIds: [...subscribed],
          // Named explicitly so the client stops waiting for events that will
          // never arrive, rather than appearing to hang.
          rejectedChannelIds: rejected,
        });
        return;
      }

      case 'unsubscribe': {
        for (const channelId of frame.channelIds) {
          if (!subscribed.has(channelId)) continue;
          await subscriptions.removeChannel(channelId, onEnvelope);
          subscribed.delete(channelId);
        }

        send({
          v: PROTOCOL_VERSION,
          ts: new Date().toISOString(),
          type: 'subscriptions',
          subscribedChannelIds: [...subscribed],
          rejectedChannelIds: [],
        });
        return;
      }

      case 'typing': {
        if (user === undefined) return;

        // Authorised like anything else: a non-member must not be able to
        // inject a typing indicator into a channel.
        if (!accessible.has(frame.channelId)) {
          sendError('forbidden', 'You cannot type in that channel.', false);
          return;
        }

        // Ephemeral: written to Redis with a TTL, never to PostgreSQL. A
        // database write per keystroke is exactly what this avoids.
        await presence.markTyping(frame.channelId, user.id);
        return;
      }
    }
  }

  // --- Wiring --------------------------------------------------------------

  metrics.realtimeConnections.inc({ state: 'open' });

  const identifyTimer = setTimeout(() => {
    if (state === 'awaiting-identify') {
      log.debug('closing socket that never identified');
      metrics.realtimeDropped.inc({ reason: 'identify_timeout' });
      close(closeCodes.identifyTimeout, 'identify timeout');
    }
  }, 10_000);

  socket.on('message', (data, isBinary) => {
    if (isBinary) {
      // The protocol is JSON text only. Accepting binary would mean a second
      // parsing path to validate.
      close(closeCodes.invalidFrame, 'binary frames are not supported');
      return;
    }

    // `ws` hands over a Buffer, an ArrayBuffer or an array of Buffers for a
    // fragmented message. A bare toString() on the array form would join it
    // with commas and corrupt the frame.
    const text = Array.isArray(data)
      ? Buffer.concat(data).toString('utf8')
      : Buffer.from(data as ArrayBuffer).toString('utf8');

    void handleFrame(text).catch((error: unknown) => {
      log.error({ err: toLogError(error) }, 'frame handler failed');
      close(closeCodes.goingAway, 'internal error');
    });
  });

  socket.on('pong', () => {
    // Protocol-level keepalive, separate from the application heartbeat.
    lastHeartbeat = Date.now();
  });

  socket.on('close', (code) => {
    log.debug({ userId: user?.id, code }, 'socket closed');
    if (state !== 'closed') {
      state = 'closed';
      clearTimeout(identifyTimer);
      if (heartbeatTimer !== undefined) clearInterval(heartbeatTimer);
      void teardownSubscriptions();
      metrics.realtimeConnections.dec({ state: 'open' });
    }
  });

  socket.on('error', (error) => {
    log.warn({ userId: user?.id, err: toLogError(error) }, 'socket error');
    close(closeCodes.goingAway, 'socket error');
  });

  return {
    id: connectionId,
    close,
  };
}
