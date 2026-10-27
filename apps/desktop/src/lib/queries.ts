import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useCallback } from 'react';
import { limits, type ChannelId, type CommunityId, type MessageId } from '@rook/contracts';
import { ApiRequestError } from './api-client.js';
import { useServices } from './services-context.js';
import { useMessagesStore } from '../stores/messages.js';
import { useSessionStore } from '../stores/session.js';
import { useUiStore } from '../stores/ui.js';

/**
 * Server-state hooks.
 *
 * Communities, channels and members are ordinary queries — TanStack Query
 * owns their cache. Messages are different: they live in the message store
 * because they are mutated by realtime events, optimistic sends and history
 * pagination at once, and reconciling three write paths inside a query cache
 * is far more awkward than owning the collection directly.
 *
 * So: the query *fetches* a page and hands it to the store, and components
 * read from the store.
 */

export const queryKeys = {
  communities: ['communities'] as const,
  channels: (communityId: CommunityId) => ['channels', communityId] as const,
  members: (communityId: CommunityId) => ['members', communityId] as const,
  messages: (channelId: ChannelId) => ['messages', channelId] as const,
  media: (assetId: string) => ['media', assetId] as const,
};

export function useCommunities() {
  const { api } = useServices();
  const signedIn = useSessionStore((state) => state.status === 'signedIn');

  return useQuery({
    queryKey: queryKeys.communities,
    queryFn: ({ signal }) => api.listCommunities(signal).then((result) => result.communities),
    enabled: signedIn,
  });
}

export function useChannels(communityId: CommunityId | undefined) {
  const { api } = useServices();

  return useQuery({
    queryKey: communityId !== undefined ? queryKeys.channels(communityId) : ['channels', 'none'],
    queryFn: ({ signal }) =>
      api.listChannels(communityId as CommunityId, signal).then((result) => result.channels),
    enabled: communityId !== undefined,
  });
}

export function useMembers(communityId: CommunityId | undefined) {
  const { api } = useServices();

  return useQuery({
    queryKey: communityId !== undefined ? queryKeys.members(communityId) : ['members', 'none'],
    queryFn: ({ signal }) =>
      api
        .listMembers(communityId as CommunityId, undefined, signal)
        .then((result) => result.members),
    enabled: communityId !== undefined,
  });
}

/**
 * Loads the most recent page of a channel's history into the message store.
 *
 * `replace: true` on apply is what makes this safe to refetch after a
 * reconnect: the server's page is authoritative for the range it covers, so
 * edits and deletions missed while offline are corrected rather than merged
 * with stale local copies.
 */
export function useChannelHistory(channelId: ChannelId | undefined) {
  const { api } = useServices();
  const applyPage = useMessagesStore((state) => state.applyPage);

  return useQuery({
    queryKey: channelId !== undefined ? queryKeys.messages(channelId) : ['messages', 'none'],
    queryFn: async ({ signal }) => {
      const page = await api.listMessages(
        channelId as ChannelId,
        { limit: limits.messagePageDefault },
        signal,
      );

      applyPage(channelId as ChannelId, page, { replace: true });
      return page;
    },
    enabled: channelId !== undefined,
    // History is pushed to us by the socket, so periodic polling would be
    // wasted work. The reconnect path invalidates this explicitly.
    refetchOnWindowFocus: false,
    staleTime: Infinity,
  });
}

/** Loads the next older page when the user scrolls to the top. */
export function useLoadOlderMessages(channelId: ChannelId | undefined) {
  const { api } = useServices();

  return useCallback(async () => {
    if (channelId === undefined) return;

    const store = useMessagesStore.getState();
    const channel = store.channelState(channelId);

    // Guards against firing repeatedly while a load is already in flight,
    // which is easy to do from a scroll handler.
    if (!channel.hasMore || channel.loadingOlder || channel.olderCursor === null) return;

    store.setLoadingOlder(channelId, true);
    try {
      const page = await api.listMessages(channelId, {
        cursor: channel.olderCursor,
        direction: 'before',
        limit: limits.messagePageDefault,
      });
      store.applyOlderPage(channelId, page);
    } catch (error) {
      store.setLoadingOlder(channelId, false);
      throw error;
    }
  }, [api, channelId]);
}

/**
 * Sending a message, optimistically.
 *
 * The flow, and why each step is there:
 *
 *   1. Generate an idempotency key and show the message immediately. The key
 *      is generated once and reused by the retry, which is what makes a retry
 *      after a timeout safe — the server resolves it to the same row instead
 *      of creating a second message.
 *   2. POST it.
 *   3. On success, replace the optimistic row with the server's.
 *   4. On failure, mark it failed and leave it visible with a retry.
 *
 * There is no automatic retry. A send that failed because the channel was
 * deleted or the message was rejected would retry for ever; the user decides.
 */
export function useSendMessage(channelId: ChannelId | undefined) {
  const { api } = useServices();
  const user = useSessionStore((state) => state.user);
  const clearDraft = useUiStore((state) => state.clearDraft);

  return useCallback(
    async (content: string, attachmentIds: string[] = [], existingKey?: string) => {
      if (channelId === undefined || user === undefined) return;

      const trimmed = content.trim();
      if (trimmed.length === 0 && attachmentIds.length === 0) return;

      const store = useMessagesStore.getState();
      const idempotencyKey = existingKey ?? crypto.randomUUID();

      // Only add the optimistic row on a first attempt; a retry already has
      // one on screen.
      if (existingKey === undefined) {
        store.addPending({
          idempotencyKey,
          channelId,
          authorId: user.id,
          content: trimmed,
          attachmentIds,
          createdAt: new Date().toISOString(),
          state: 'pending',
          failureReason: undefined,
        });
        clearDraft(channelId);
      } else {
        // Flip a failed row back to pending so the retry is visible.
        store.addPending({
          idempotencyKey,
          channelId,
          authorId: user.id,
          content: trimmed,
          attachmentIds,
          createdAt: new Date().toISOString(),
          state: 'pending',
          failureReason: undefined,
        });
      }

      try {
        const result = await api.sendMessage(channelId, {
          ...(trimmed.length > 0 ? { content: trimmed } : {}),
          ...(attachmentIds.length > 0 ? { attachmentIds } : {}),
          idempotencyKey,
        });

        store.resolvePending(channelId, idempotencyKey, result.message);
      } catch (error) {
        const message =
          error instanceof ApiRequestError
            ? error.message
            : 'Could not send. Check your connection.';

        store.failPending(channelId, idempotencyKey, message);
      }
    },
    [api, channelId, user, clearDraft],
  );
}

export function useEditMessage() {
  const { api } = useServices();
  const upsert = useMessagesStore((state) => state.upsert);

  return useMutation({
    mutationFn: ({ messageId, content }: { messageId: MessageId; content: string }) =>
      api.editMessage(messageId, { content }),
    onSuccess: (result) => {
      // Applied locally as well as broadcast: the author suppresses their own
      // events (to avoid a flicker), so without this their own edit would not
      // appear until a refetch.
      upsert(result.message.channelId, result.message);
    },
  });
}

export function useDeleteMessage() {
  const { api } = useServices();
  const markDeleted = useMessagesStore((state) => state.markDeleted);

  return useMutation({
    mutationFn: ({ messageId, channelId }: { messageId: MessageId; channelId: ChannelId }) =>
      api.deleteMessage(messageId).then((result) => ({ result, messageId, channelId })),
    onSuccess: ({ messageId, channelId }) => {
      markDeleted(channelId, messageId, new Date().toISOString());
    },
  });
}

export function useCreateCommunity() {
  const { api } = useServices();
  const queryClient = useQueryClient();
  const selectCommunity = useUiStore((state) => state.selectCommunity);

  return useMutation({
    mutationFn: (name: string) => api.createCommunity({ name }),
    onSuccess: async (result) => {
      await queryClient.invalidateQueries({ queryKey: queryKeys.communities });
      // Navigate straight into it: creating a community and being left on the
      // previous screen is disorienting.
      selectCommunity(result.community.id);
    },
  });
}

export function useJoinCommunity() {
  const { api } = useServices();
  const queryClient = useQueryClient();
  const selectCommunity = useUiStore((state) => state.selectCommunity);

  return useMutation({
    mutationFn: (joinCode: string) => api.joinCommunity({ joinCode }),
    onSuccess: async (result) => {
      await queryClient.invalidateQueries({ queryKey: queryKeys.communities });
      selectCommunity(result.community.id);
    },
  });
}

export function useCreateChannel(communityId: CommunityId | undefined) {
  const { api } = useServices();
  const queryClient = useQueryClient();
  const selectChannel = useUiStore((state) => state.selectChannel);

  return useMutation({
    mutationFn: ({ name, topic }: { name: string; topic?: string }) =>
      api.createChannel(communityId as CommunityId, {
        name,
        ...(topic !== undefined && topic.length > 0 ? { topic } : {}),
      }),
    onSuccess: async (result) => {
      if (communityId !== undefined) {
        await queryClient.invalidateQueries({ queryKey: queryKeys.channels(communityId) });
      }
      selectChannel(result.channel.id);
    },
  });
}
