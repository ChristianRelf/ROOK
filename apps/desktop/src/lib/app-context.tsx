import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import type { ChannelId, ServerEvent } from '@rook/contracts';
import { createApiClient } from './api-client.js';
import { createRealtimeClient, type RealtimeClient } from './realtime-client.js';
import { AppServicesContext, type AppServices } from './services-context.js';
import { useSessionStore } from '../stores/session.js';
import { useMessagesStore } from '../stores/messages.js';
import { useUiStore } from '../stores/ui.js';
import { useServerStore } from './server-config.js';

/**
 * Wires the API client, the realtime client and the stores together.
 *
 * The non-obvious part is how realtime events reach the stores. The socket is
 * created once and reads the token and channel list through *getters* rather
 * than capturing them, because the client outlives any particular render:
 * capturing values would reconnect on every state change, and reconnecting on
 * every render is how a client ends up hammering the gateway.
 *
 * Those getters read `useStore.getState()` directly rather than a ref kept in
 * sync during render. Writing to a ref while rendering is not safe -- React may
 * render a component without committing it, so the ref can end up holding a
 * value from a discarded render. `getState()` always reads the committed store.
 */

export function AppServicesProvider({ children }: { readonly children: ReactNode }) {
  const queryClient = useQueryClient();

  // Subscribed to only so this component re-renders when they change; the
  // clients below read the stores directly.
  const token = useSessionStore((state) => state.token);
  const selectedChannelId = useUiStore((state) => state.selectedChannelId);

  const api = useMemo(
    () =>
      createApiClient({
        getBaseUrl: () => useServerStore.getState().endpoints.apiUrl,
        getToken: () => useSessionStore.getState().token,
        onAuthFailure: () => {
          // One place handles a revoked session. Without this each caller
          // would need to, and the one that forgot would hang.
          void useSessionStore
            .getState()
            .signOut('Your session has expired. Please sign in again.');
        },
      }),
    [],
  );

  const [realtime] = useState<RealtimeClient>(() =>
    createRealtimeClient({
      getUrl: () => useServerStore.getState().endpoints.realtimeUrl,
      getToken: () => useSessionStore.getState().token,
      getChannelIds: () => currentChannelIds(),

      onStateChange: (state, detail) => {
        useUiStore.getState().setConnection(state, detail);
      },

      onEvent: (event) => {
        applyEvent(event, queryClient);
      },

      onResync: () => {
        // Runs on connect and on every reconnect. Redis pub/sub does not
        // retain anything, so events published while we were away are gone;
        // the authoritative recovery path is a history refetch. Messages are
        // keyed by id, so this cannot duplicate anything.
        const channelId = currentChannelIds()[0];
        if (channelId !== undefined) {
          void queryClient.invalidateQueries({ queryKey: ['messages', channelId] });
        }
        void queryClient.invalidateQueries({ queryKey: ['communities'] });
        // Unread counts are derived server-side, so this is the only way to
        // recover badges for messages that arrived while the socket was down.
        void queryClient.invalidateQueries({ queryKey: ['unread'] });
      },
    }),
  );

  // Connect only while signed in, and tear down on sign-out so a revoked
  // token does not drive a reconnect loop.
  useEffect(() => {
    if (token === undefined) {
      realtime.disconnect();
      return;
    }

    realtime.connect();
    return () => realtime.disconnect();
  }, [token, realtime]);

  // Keep the socket's subscriptions in step with the open channel.
  useEffect(() => {
    realtime.setChannels(selectedChannelId !== undefined ? [selectedChannelId] : []);
  }, [selectedChannelId, realtime]);

  // Typing indicators expire on their own; this clears them from the UI.
  useEffect(() => {
    const timer = window.setInterval(() => useMessagesStore.getState().pruneTyping(), 1000);
    return () => window.clearInterval(timer);
  }, []);

  const services = useMemo<AppServices>(() => ({ api, realtime }), [api, realtime]);

  return <AppServicesContext.Provider value={services}>{children}</AppServicesContext.Provider>;
}

/** The channels the open conversation needs events for. */
function currentChannelIds(): ChannelId[] {
  const channelId = useUiStore.getState().selectedChannelId;
  return channelId !== undefined ? [channelId] : [];
}

/**
 * Applies one realtime event to local state.
 *
 * Every branch is idempotent, which is what makes at-least-once delivery safe:
 * the same event applied twice leaves the same state.
 */
function applyEvent(event: ServerEvent, queryClient: ReturnType<typeof useQueryClient>): void {
  const messages = useMessagesStore.getState();

  switch (event.type) {
    case 'message.created': {
      // Keyed by message id, so a duplicate is a no-op.
      messages.upsert(event.channelId, event.message);

      // A message in a channel the user is not looking at changes its badge.
      // Invalidating rather than incrementing locally keeps one source of
      // truth for the count: the server derives it from read position, and a
      // local counter would drift the first time an event arrived twice —
      // which at-least-once delivery guarantees will happen.
      //
      // Skipped for the open channel, which marks itself read instead.
      if (event.channelId !== useUiStore.getState().selectedChannelId) {
        void queryClient.invalidateQueries({ queryKey: ['unread'] });
      }
      return;
    }

    case 'message.updated': {
      messages.upsert(event.channelId, event.message);
      // An edit can add or remove a mention, so the badge may change even
      // though no new message arrived.
      void queryClient.invalidateQueries({ queryKey: ['unread'] });
      return;
    }

    case 'message.deleted': {
      messages.markDeleted(event.channelId, event.messageId, event.deletedAt);
      return;
    }

    case 'typing': {
      messages.setTyping(event.channelId, event.userId, new Date(event.expiresAt).getTime());
      return;
    }

    case 'channel.created':
    case 'channel.updated': {
      // Channels are server state, so the query is invalidated rather than
      // patched: refetching is cheap and avoids two sources of truth.
      void queryClient.invalidateQueries({ queryKey: ['channel-tree', event.communityId] });
      void queryClient.invalidateQueries({ queryKey: ['channels', event.communityId] });
      void queryClient.invalidateQueries({ queryKey: ['unread'] });
      return;
    }

    case 'channel.deleted': {
      // The selection is cleared first so the conversation pane does not spend
      // a frame rendering a channel that is gone. The shell's stale-selection
      // effect then falls back to the first remaining channel.
      if (useUiStore.getState().selectedChannelId === event.channelId) {
        useUiStore.getState().selectChannel(undefined);
      }
      void queryClient.invalidateQueries({ queryKey: ['channel-tree', event.communityId] });
      void queryClient.invalidateQueries({ queryKey: ['channels', event.communityId] });
      void queryClient.invalidateQueries({ queryKey: ['unread'] });
      return;
    }

    case 'category.created':
    case 'category.updated':
    case 'category.deleted': {
      // Deleting a category leaves its channels in place as uncategorised, so
      // the whole tree is refetched rather than reparenting rows locally —
      // which would be a second implementation of the server's grouping rule.
      void queryClient.invalidateQueries({ queryKey: ['channel-tree', event.communityId] });
      return;
    }

    case 'member.joined': {
      void queryClient.invalidateQueries({ queryKey: ['members', event.communityId] });
      void queryClient.invalidateQueries({ queryKey: ['communities'] });
      return;
    }

    case 'member.updated': {
      void queryClient.invalidateQueries({ queryKey: ['members', event.communityId] });
      // The viewer's own role may be what changed, and that decides which
      // administrative affordances the UI offers.
      void queryClient.invalidateQueries({ queryKey: ['communities'] });
      return;
    }

    case 'member.removed': {
      const session = useSessionStore.getState();

      // If it was us, the community is gone from our list entirely — including
      // its channels and badges. Deselecting first avoids rendering a
      // community we are no longer in while the refetch is in flight.
      if (session.user?.id === event.userId) {
        if (useUiStore.getState().selectedCommunityId === event.communityId) {
          useUiStore.getState().selectCommunity(undefined);
        }
        void queryClient.invalidateQueries({ queryKey: ['unread'] });
      }

      void queryClient.invalidateQueries({ queryKey: ['members', event.communityId] });
      void queryClient.invalidateQueries({ queryKey: ['communities'] });
      return;
    }

    case 'media.updated': {
      // A thumbnail finished (or failed). Invalidating lets an already
      // rendered message swap its placeholder without a full reload.
      void queryClient.invalidateQueries({ queryKey: ['media', event.asset.id] });
      return;
    }

    case 'error': {
      // Non-fatal problems are surfaced in the console; fatal ones arrive as
      // a close code and are handled by the realtime client's state machine.
      console.warn(`Realtime error (${event.code}): ${event.message}`);
      return;
    }

    case 'ready':
    case 'heartbeat.ack':
    case 'subscriptions': {
      // Connection-level frames, handled inside the realtime client.
      return;
    }
  }
}
