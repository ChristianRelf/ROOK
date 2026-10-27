import {
  useInfiniteQuery,
  useMutation,
  useQuery,
  useQueryClient,
  type QueryClient,
} from '@tanstack/react-query';
import { useCallback } from 'react';
import {
  limits,
  type AssignableRole,
  type AuditAction,
  type CategoryId,
  type ChannelId,
  type CommunityId,
  type InviteDuration,
  type InviteId,
  type MessageId,
  type UserId,
} from '@rook/contracts';
import { useServices } from './services-context.js';
import { useSessionStore } from '../stores/session.js';
import { useUiStore } from '../stores/ui.js';

/**
 * Server-state hooks for the administration surfaces and read state.
 *
 * Kept apart from `queries.ts`, which owns the conversation: these are the
 * hooks nothing renders until someone opens a settings panel, and keeping them
 * in a separate module means the conversation's query keys stay readable.
 *
 * Two conventions run through all of it:
 *
 *   * **Mutations invalidate; they do not patch the cache.** Every one of
 *     these changes is also broadcast as a realtime event, so a client that
 *     patched locally *and* applied the event would have two code paths
 *     producing the same state — and they would disagree the first time one
 *     was changed. Refetching a sidebar is cheap; reconciling two sources of
 *     truth is not.
 *
 *   * **The member list is an infinite query, not a flat one.** A community of
 *     any size loads its member sidebar one page at a time, which is the whole
 *     reason the endpoint is cursor-paginated.
 */

export const adminQueryKeys = {
  channelTree: (communityId: CommunityId) => ['channel-tree', communityId] as const,
  members: (communityId: CommunityId) => ['members', communityId] as const,
  invites: (communityId: CommunityId) => ['invites', communityId] as const,
  auditLog: (communityId: CommunityId, filters: { action?: AuditAction; actorId?: string }) =>
    ['audit-log', communityId, filters.action ?? 'all', filters.actorId ?? 'all'] as const,
  unread: ['unread'] as const,
};

/**
 * Invalidates everything a structural change to a community can affect.
 *
 * Collected in one place because the set is not obvious: deleting a channel
 * changes the tree *and* the unread summary (its badge has to go), and a role
 * change affects the member list *and* the community list, since the viewer's
 * own capabilities may have changed.
 */
export async function invalidateCommunityStructure(
  queryClient: QueryClient,
  communityId: CommunityId,
): Promise<void> {
  await Promise.all([
    queryClient.invalidateQueries({ queryKey: adminQueryKeys.channelTree(communityId) }),
    queryClient.invalidateQueries({ queryKey: ['channels', communityId] }),
    queryClient.invalidateQueries({ queryKey: adminQueryKeys.unread }),
  ]);
}

// --------------------------------------------------------------------------
// Channel tree
// --------------------------------------------------------------------------

/**
 * Categories and channels, in one query.
 *
 * Fetched together because the sidebar cannot render either alone — two
 * queries would guarantee a frame where channels are grouped wrongly.
 */
export function useChannelTree(communityId: CommunityId | undefined) {
  const { api } = useServices();

  return useQuery({
    queryKey:
      communityId !== undefined
        ? adminQueryKeys.channelTree(communityId)
        : ['channel-tree', 'none'],
    queryFn: ({ signal }) => api.getChannelTree(communityId as CommunityId, signal),
    enabled: communityId !== undefined,
  });
}

// --------------------------------------------------------------------------
// Unread state
// --------------------------------------------------------------------------

/**
 * The unread summary for every channel the user can see.
 *
 * Refetched on a slow interval as a backstop, not as the primary mechanism:
 * counts are invalidated by the realtime message handler, and the interval
 * only covers the case where an event was missed while the socket was down and
 * the reconnect resync has not landed yet.
 */
export function useUnread() {
  const { api } = useServices();
  const signedIn = useSessionStore((state) => state.status === 'signedIn');

  return useQuery({
    queryKey: adminQueryKeys.unread,
    queryFn: ({ signal }) => api.getUnread(signal),
    enabled: signedIn,
    staleTime: 15_000,
    refetchInterval: 120_000,
  });
}

/**
 * Marks a channel read up to a specific message.
 *
 * Not a `useMutation`: this fires on every channel view and on every message
 * that arrives while a channel is open, and a mutation's pending state would
 * be meaningless noise for something the user never waits on. A failure is
 * swallowed deliberately — the cost is a badge that clears on the next summary
 * refetch, and surfacing "could not mark as read" would be a dialog nobody can
 * act on.
 */
export function useMarkRead() {
  const { api } = useServices();
  const queryClient = useQueryClient();

  return useCallback(
    async (channelId: ChannelId, lastReadMessageId: MessageId) => {
      try {
        await api.markChannelRead(channelId, lastReadMessageId);
        await queryClient.invalidateQueries({ queryKey: adminQueryKeys.unread });
      } catch {
        // See above: the next summary refetch corrects this.
      }
    },
    [api, queryClient],
  );
}

export function useSetChannelMuted() {
  const { api } = useServices();
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: ({ channelId, muted }: { channelId: ChannelId; muted: boolean }) =>
      api.setChannelMuted(channelId, muted),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: adminQueryKeys.unread });
    },
  });
}

// --------------------------------------------------------------------------
// Categories
// --------------------------------------------------------------------------

export function useCreateCategory(communityId: CommunityId | undefined) {
  const { api } = useServices();
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (name: string) => api.createCategory(communityId as CommunityId, { name }),
    onSuccess: async () => {
      if (communityId !== undefined) {
        await invalidateCommunityStructure(queryClient, communityId);
      }
    },
  });
}

export function useUpdateCategory(communityId: CommunityId | undefined) {
  const { api } = useServices();
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: ({ categoryId, name }: { categoryId: CategoryId; name: string }) =>
      api.updateCategory(communityId as CommunityId, categoryId, { name }),
    onSuccess: async () => {
      if (communityId !== undefined) {
        await invalidateCommunityStructure(queryClient, communityId);
      }
    },
  });
}

export function useDeleteCategory(communityId: CommunityId | undefined) {
  const { api } = useServices();
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (categoryId: CategoryId) =>
      api.deleteCategory(communityId as CommunityId, categoryId),
    onSuccess: async () => {
      if (communityId !== undefined) {
        await invalidateCommunityStructure(queryClient, communityId);
      }
    },
  });
}

// --------------------------------------------------------------------------
// Channel structure
// --------------------------------------------------------------------------

export function useUpdateChannel(communityId: CommunityId | undefined) {
  const { api } = useServices();
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: ({
      channelId,
      name,
      topic,
      categoryId,
    }: {
      channelId: ChannelId;
      name?: string;
      topic?: string | null;
      categoryId?: CategoryId | null;
    }) =>
      api.updateChannel(communityId as CommunityId, channelId, {
        ...(name !== undefined ? { name } : {}),
        ...(topic !== undefined ? { topic } : {}),
        ...(categoryId !== undefined ? { categoryId } : {}),
      }),
    onSuccess: async () => {
      if (communityId !== undefined) {
        await invalidateCommunityStructure(queryClient, communityId);
      }
    },
  });
}

export function useDeleteChannel(communityId: CommunityId | undefined) {
  const { api } = useServices();
  const queryClient = useQueryClient();
  const selectChannel = useUiStore((state) => state.selectChannel);

  return useMutation({
    mutationFn: (channelId: ChannelId) => api.deleteChannel(communityId as CommunityId, channelId),
    onSuccess: async (_result, channelId) => {
      // Cleared before the refetch so the conversation pane does not spend a
      // frame rendering a channel that no longer exists. The shell's
      // stale-selection effect then picks the first remaining channel.
      if (useUiStore.getState().selectedChannelId === channelId) {
        selectChannel(undefined);
      }
      if (communityId !== undefined) {
        await invalidateCommunityStructure(queryClient, communityId);
      }
    },
  });
}

// --------------------------------------------------------------------------
// Members and roles
// --------------------------------------------------------------------------

/**
 * The member list, one page at a time.
 *
 * `totalCount` comes back with every page, so the sidebar header shows the
 * real total rather than a number that climbs as the user scrolls.
 */
export function useMemberPages(communityId: CommunityId | undefined) {
  const { api } = useServices();

  return useInfiniteQuery({
    queryKey: communityId !== undefined ? adminQueryKeys.members(communityId) : ['members', 'none'],
    queryFn: ({ pageParam, signal }) =>
      api.listMembers(communityId as CommunityId, pageParam ?? undefined, signal),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (lastPage) => lastPage.nextCursor ?? undefined,
    enabled: communityId !== undefined,
  });
}

export function useSetMemberRole(communityId: CommunityId | undefined) {
  const { api } = useServices();
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: ({ userId, role }: { userId: UserId; role: AssignableRole }) =>
      api.setMemberRole(communityId as CommunityId, userId, role),
    onSuccess: async () => {
      if (communityId === undefined) return;
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: adminQueryKeys.members(communityId) }),
        // The viewer's own role may have changed, which decides what the rest
        // of the UI offers them.
        queryClient.invalidateQueries({ queryKey: ['communities'] }),
        queryClient.invalidateQueries({ queryKey: adminQueryKeys.auditLog(communityId, {}) }),
      ]);
    },
  });
}

export function useRemoveMember(communityId: CommunityId | undefined) {
  const { api } = useServices();
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (userId: UserId) => api.removeMember(communityId as CommunityId, userId),
    onSuccess: async () => {
      if (communityId === undefined) return;
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: adminQueryKeys.members(communityId) }),
        queryClient.invalidateQueries({ queryKey: ['communities'] }),
        queryClient.invalidateQueries({ queryKey: adminQueryKeys.auditLog(communityId, {}) }),
      ]);
    },
  });
}

// --------------------------------------------------------------------------
// Invites
// --------------------------------------------------------------------------

export function useInvites(communityId: CommunityId | undefined, enabled = true) {
  const { api } = useServices();

  return useQuery({
    queryKey: communityId !== undefined ? adminQueryKeys.invites(communityId) : ['invites', 'none'],
    queryFn: ({ signal }) =>
      api.listInvites(communityId as CommunityId, signal).then((result) => result.invites),
    enabled: communityId !== undefined && enabled,
    // An invite's `active` flag depends on the current time, so a cached list
    // goes stale on its own without anything changing on the server.
    staleTime: 10_000,
  });
}

export function useCreateInvite(communityId: CommunityId | undefined) {
  const { api } = useServices();
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (input: { expiresIn: InviteDuration; maxUses?: number }) =>
      api.createInvite(communityId as CommunityId, input),
    onSuccess: async () => {
      if (communityId === undefined) return;
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: adminQueryKeys.invites(communityId) }),
        queryClient.invalidateQueries({ queryKey: adminQueryKeys.auditLog(communityId, {}) }),
      ]);
    },
  });
}

export function useRevokeInvite(communityId: CommunityId | undefined) {
  const { api } = useServices();
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (inviteId: InviteId) => api.revokeInvite(communityId as CommunityId, inviteId),
    onSuccess: async () => {
      if (communityId === undefined) return;
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: adminQueryKeys.invites(communityId) }),
        queryClient.invalidateQueries({ queryKey: adminQueryKeys.auditLog(communityId, {}) }),
      ]);
    },
  });
}

export function useAcceptInvite() {
  const { api } = useServices();
  const queryClient = useQueryClient();
  const selectCommunity = useUiStore((state) => state.selectCommunity);

  return useMutation({
    mutationFn: (code: string) => api.acceptInvite(code),
    onSuccess: async (result) => {
      await queryClient.invalidateQueries({ queryKey: ['communities'] });
      // Navigate straight in: accepting an invite and staying where you were
      // leaves the user wondering whether it worked.
      selectCommunity(result.community.id);
    },
  });
}

// --------------------------------------------------------------------------
// Audit log
// --------------------------------------------------------------------------

export function useAuditLog(
  communityId: CommunityId | undefined,
  filters: { action?: AuditAction; actorId?: string } = {},
  enabled = true,
) {
  const { api } = useServices();

  return useInfiniteQuery({
    queryKey:
      communityId !== undefined
        ? adminQueryKeys.auditLog(communityId, filters)
        : ['audit-log', 'none'],
    queryFn: ({ pageParam, signal }) =>
      api.listAuditLog(
        communityId as CommunityId,
        {
          ...(pageParam !== undefined ? { cursor: pageParam } : {}),
          limit: limits.auditPageDefault,
          ...(filters.action !== undefined ? { action: filters.action } : {}),
          ...(filters.actorId !== undefined ? { actorId: filters.actorId } : {}),
        },
        signal,
      ),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (lastPage) => lastPage.nextCursor ?? undefined,
    enabled: communityId !== undefined && enabled,
  });
}
