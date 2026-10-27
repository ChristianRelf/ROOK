import {
  closeCodes,
  fatalCloseCodes,
  PROTOCOL_VERSION,
  serverEventSchema,
  type ChannelId,
  type ServerEvent,
} from '@rook/contracts';

/**
 * The WebSocket client.
 *
 * Responsibilities, in the order they matter:
 *
 *   1. **Reconnect, with backoff and jitter.** A gateway redeploy drops every
 *      socket at once. Without jitter every client comes back in the same
 *      instant and the new instance falls over — so the delay is randomised.
 *
 *   2. **Know when not to reconnect.** A bad token or an unsupported protocol
 *      version will fail identically every time. Those close codes stop the
 *      loop and surface the problem instead of retrying for ever.
 *
 *   3. **Heartbeat.** The server closes a socket that stops responding; the
 *      client sends on the interval the server advertised in `ready`.
 *
 *   4. **Resync on reconnect.** Redis pub/sub has no persistence, so events
 *      published while disconnected are simply gone. On every (re)connect the
 *      client calls `onResync`, which refetches history over HTTP. Events are
 *      idempotent by message id, so a refetch that overlaps live events cannot
 *      duplicate anything.
 *
 * The client owns no message state. It emits validated events and lets the
 * store decide what to do with them.
 */

export type ConnectionState = 'idle' | 'connecting' | 'connected' | 'reconnecting' | 'failed';

export interface RealtimeClientOptions {
  /** Read on each connect attempt, so a changed server address is picked up. */
  readonly getUrl: () => string;
  readonly getToken: () => string | undefined;
  /** Channels to subscribe to on connect. Read fresh on every attempt. */
  readonly getChannelIds: () => ChannelId[];
  readonly onEvent: (event: ServerEvent) => void;
  readonly onStateChange: (state: ConnectionState, detail?: string) => void;
  /**
   * Called once the connection is ready, including after a reconnect.
   *
   * This is the gap-recovery hook: the caller refetches whatever it may have
   * missed while disconnected.
   */
  readonly onResync: () => void;
}

/** Backoff schedule, in milliseconds, with the last value repeating. */
const backoffSchedule = [500, 1000, 2000, 4000, 8000, 15_000, 30_000] as const;

export interface RealtimeClient {
  connect: () => void;
  disconnect: () => void;
  /** Updates the channel subscription set on an open socket. */
  setChannels: (channelIds: readonly ChannelId[]) => void;
  sendTyping: (channelId: ChannelId) => void;
  readonly state: ConnectionState;
}

export function createRealtimeClient(options: RealtimeClientOptions): RealtimeClient {
  let socket: WebSocket | undefined;
  let state: ConnectionState = 'idle';
  let attempt = 0;
  let reconnectTimer: number | undefined;
  let heartbeatTimer: number | undefined;
  /** False once `disconnect()` is called, so a pending retry is abandoned. */
  let wanted = false;
  let subscribed: ChannelId[] = [];
  /** Throttles outbound typing frames; the server also debounces. */
  let lastTypingSentAt = 0;

  function setState(next: ConnectionState, detail?: string): void {
    if (state === next) return;
    state = next;
    options.onStateChange(next, detail);
  }

  function clearTimers(): void {
    if (reconnectTimer !== undefined) {
      window.clearTimeout(reconnectTimer);
      reconnectTimer = undefined;
    }
    if (heartbeatTimer !== undefined) {
      window.clearInterval(heartbeatTimer);
      heartbeatTimer = undefined;
    }
  }

  function send(frame: unknown): void {
    if (socket === undefined || socket.readyState !== WebSocket.OPEN) return;
    socket.send(JSON.stringify(frame));
  }

  function scheduleReconnect(reason: string): void {
    if (!wanted) return;

    const base = backoffSchedule[Math.min(attempt, backoffSchedule.length - 1)] ?? 30_000;
    // +/-25% jitter. Without it, every client dropped by a redeploy retries in
    // lockstep and stampedes the replacement instance.
    const jittered = Math.round(base * (0.75 + Math.random() * 0.5));
    attempt += 1;

    setState('reconnecting', reason);
    reconnectTimer = window.setTimeout(open, jittered);
  }

  function open(): void {
    if (!wanted) return;

    const token = options.getToken();
    if (token === undefined) {
      setState('failed', 'not signed in');
      return;
    }

    clearTimers();
    setState(attempt === 0 ? 'connecting' : 'reconnecting');

    let next: WebSocket;
    try {
      next = new WebSocket(options.getUrl());
    } catch (error) {
      scheduleReconnect(error instanceof Error ? error.message : 'could not open socket');
      return;
    }

    socket = next;

    next.onopen = () => {
      subscribed = options.getChannelIds();

      // The token travels in the first frame, not the query string: query
      // strings end up in proxy and access logs.
      send({
        type: 'identify',
        protocolVersion: PROTOCOL_VERSION,
        token,
        channelIds: subscribed,
      });
    };

    next.onmessage = (message: MessageEvent<string>) => {
      let parsed: unknown;
      try {
        parsed = JSON.parse(message.data);
      } catch {
        // A frame we cannot read is dropped rather than treated as fatal.
        console.warn('Discarding unreadable realtime frame');
        return;
      }

      const result = serverEventSchema.safeParse(parsed);
      if (!result.success) {
        // Per the protocol, an unrecognised event is ignored, not an error:
        // that is what lets the server add event types before clients update.
        console.debug('Ignoring unrecognised realtime event', parsed);
        return;
      }

      const event = result.data;

      if (event.type === 'ready') {
        // A successful handshake resets the backoff, so the next unrelated
        // drop starts from a short delay again.
        attempt = 0;
        setState('connected');

        clearTimers();
        heartbeatTimer = window.setInterval(() => {
          send({ type: 'heartbeat' });
        }, event.heartbeatIntervalMs);

        // Recover anything missed while disconnected.
        options.onResync();
        return;
      }

      if (event.type === 'heartbeat.ack') {
        return;
      }

      options.onEvent(event);
    };

    next.onclose = (closeEvent: CloseEvent) => {
      clearTimers();
      socket = undefined;

      if (!wanted) {
        setState('idle');
        return;
      }

      // Codes where retrying with the same credentials cannot possibly work.
      if ((fatalCloseCodes as readonly number[]).includes(closeEvent.code)) {
        setState(
          'failed',
          closeEvent.code === closeCodes.unsupportedProtocolVersion
            ? 'This version of Rook is out of date. Please update.'
            : 'Your session has expired. Please sign in again.',
        );
        return;
      }

      scheduleReconnect(
        closeEvent.reason.length > 0 ? closeEvent.reason : `closed (${closeEvent.code})`,
      );
    };

    next.onerror = () => {
      // `onerror` carries no useful detail by design (to avoid leaking
      // cross-origin information), and is always followed by `onclose`, which
      // is where reconnection is handled.
    };
  }

  return {
    get state() {
      return state;
    },

    connect() {
      if (wanted) return;
      wanted = true;
      attempt = 0;
      open();
    },

    disconnect() {
      wanted = false;
      clearTimers();

      if (socket !== undefined) {
        // 1000: a normal closure, so the server does not log it as a fault.
        socket.close(1000, 'client disconnected');
        socket = undefined;
      }
      setState('idle');
    },

    setChannels(channelIds) {
      const next = [...channelIds];
      const added = next.filter((id) => !subscribed.includes(id));
      const removed = subscribed.filter((id) => !next.includes(id));
      subscribed = next;

      if (added.length > 0) send({ type: 'subscribe', channelIds: added });
      if (removed.length > 0) send({ type: 'unsubscribe', channelIds: removed });
    },

    sendTyping(channelId) {
      // Throttled client-side as well as server-side: there is no reason to
      // put a frame on the wire for every keystroke.
      const now = Date.now();
      if (now - lastTypingSentAt < 2000) return;
      lastTypingSentAt = now;

      send({ type: 'typing', channelId });
    },
  };
}
