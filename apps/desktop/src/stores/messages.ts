import { create } from 'zustand';
import type { ChannelId, Message, MessageId, UserId } from '@rook/contracts';

/**
 * The message store.
 *
 * This is where the delivery guarantees the backend provides get turned into
 * something a user can look at. Three problems it solves:
 *
 * **Duplicates.** The same message can arrive twice: once as the HTTP response
 * to a send, once as a realtime event, and again from a history refetch after
 * reconnect. Messages are therefore keyed by id in a `Map`, so applying one
 * twice is idempotent. This is the client half of the at-least-once contract —
 * the server does not try to deduplicate, because the client can do it exactly.
 *
 * **Optimistic sends.** A message appears immediately, keyed by its
 * idempotency key, and is replaced by the server's authoritative row when the
 * response arrives. If the send fails it stays visible marked `failed`, with a
 * retry — never silently dropped, and never retried for ever behind the user's
 * back.
 *
 * **Ordering.** Confirmed messages sort by id, which is chronological because
 * ids are UUIDv7. Pending messages always sort last, since they have no server
 * id yet and belong at the bottom where the user just typed them.
 */

export interface PendingMessage {
  readonly idempotencyKey: string;
  readonly channelId: ChannelId;
  readonly authorId: UserId;
  readonly content: string;
  readonly attachmentIds: readonly string[];
  readonly createdAt: string;
  readonly state: 'pending' | 'failed';
  readonly failureReason: string | undefined;
}

/** What the message list renders: a confirmed row or a pending one. */
export type DisplayMessage =
  | { readonly kind: 'confirmed'; readonly message: Message }
  | { readonly kind: 'pending'; readonly pending: PendingMessage };

interface ChannelMessages {
  /** Confirmed messages by id. A Map keeps insertion cheap and dedupe exact. */
  readonly byId: Map<MessageId, Message>;
  /** Unconfirmed sends by idempotency key. */
  readonly pending: Map<string, PendingMessage>;
  /** Cursor for loading older history; null once the start is reached. */
  readonly olderCursor: string | null;
  readonly hasMore: boolean;
  readonly loadedInitial: boolean;
  readonly loadingOlder: boolean;
}

function emptyChannel(): ChannelMessages {
  return {
    byId: new Map(),
    pending: new Map(),
    olderCursor: null,
    hasMore: false,
    loadedInitial: false,
    loadingOlder: false,
  };
}

export interface TypingEntry {
  readonly userId: UserId;
  readonly expiresAt: number;
}

export interface MessagesState {
  readonly channels: Record<string, ChannelMessages>;
  /** Typing indicators by channel. Ephemeral and self-expiring. */
  readonly typing: Record<string, TypingEntry[]>;

  /** Replaces a page of history. Used for the initial load and resync. */
  applyPage: (
    channelId: ChannelId,
    page: { messages: Message[]; nextCursor: string | null; hasMore: boolean },
    options?: { replace?: boolean },
  ) => void;

  /** Prepends older history, keeping the existing cursor chain intact. */
  applyOlderPage: (
    channelId: ChannelId,
    page: { messages: Message[]; nextCursor: string | null; hasMore: boolean },
  ) => void;

  setLoadingOlder: (channelId: ChannelId, loading: boolean) => void;

  /** Applies a single message from a send response or a realtime event. */
  upsert: (channelId: ChannelId, message: Message) => void;

  /** Marks a message deleted in place, keeping it as a tombstone. */
  markDeleted: (channelId: ChannelId, messageId: MessageId, deletedAt: string) => void;

  addPending: (pending: PendingMessage) => void;
  /** Replaces a pending message with the confirmed row from the server. */
  resolvePending: (channelId: ChannelId, idempotencyKey: string, message: Message) => void;
  failPending: (channelId: ChannelId, idempotencyKey: string, reason: string) => void;
  removePending: (channelId: ChannelId, idempotencyKey: string) => void;

  setTyping: (channelId: ChannelId, userId: UserId, expiresAt: number) => void;
  pruneTyping: () => void;

  /** Ordered list for rendering: confirmed oldest-first, then pending. */
  select: (channelId: ChannelId) => DisplayMessage[];
  channelState: (channelId: ChannelId) => ChannelMessages;
}

export const useMessagesStore = create<MessagesState>((set, get) => ({
  channels: {},
  typing: {},

  applyPage(channelId, page, options) {
    set((state) => {
      const existing = state.channels[channelId] ?? emptyChannel();
      // `replace` is used on resync: the server's page is authoritative for
      // the range it covers, including edits and deletions we may have missed.
      const byId =
        options?.replace === true ? new Map<MessageId, Message>() : new Map(existing.byId);

      for (const message of page.messages) {
        byId.set(message.id, message);
      }

      return {
        channels: {
          ...state.channels,
          [channelId]: {
            ...existing,
            byId,
            olderCursor: page.nextCursor,
            hasMore: page.hasMore,
            loadedInitial: true,
          },
        },
      };
    });
  },

  applyOlderPage(channelId, page) {
    set((state) => {
      const existing = state.channels[channelId] ?? emptyChannel();
      const byId = new Map(existing.byId);

      for (const message of page.messages) {
        // Older pages never overwrite a newer copy of the same message: a
        // history page can be stale relative to an edit we already applied.
        if (!byId.has(message.id)) byId.set(message.id, message);
      }

      return {
        channels: {
          ...state.channels,
          [channelId]: {
            ...existing,
            byId,
            olderCursor: page.nextCursor,
            hasMore: page.hasMore,
            loadingOlder: false,
          },
        },
      };
    });
  },

  setLoadingOlder(channelId, loading) {
    set((state) => ({
      channels: {
        ...state.channels,
        [channelId]: { ...(state.channels[channelId] ?? emptyChannel()), loadingOlder: loading },
      },
    }));
  },

  upsert(channelId, message) {
    set((state) => {
      const existing = state.channels[channelId] ?? emptyChannel();
      const byId = new Map(existing.byId);
      byId.set(message.id, message);

      return {
        channels: { ...state.channels, [channelId]: { ...existing, byId } },
      };
    });
  },

  markDeleted(channelId, messageId, deletedAt) {
    set((state) => {
      const existing = state.channels[channelId];
      if (existing === undefined) return state;

      const current = existing.byId.get(messageId);
      // Nothing to tombstone: the message was never loaded here, so the
      // deletion needs no local representation.
      if (current === undefined) return state;

      const byId = new Map(existing.byId);
      byId.set(messageId, { ...current, content: null, deletedAt });

      return {
        channels: { ...state.channels, [channelId]: { ...existing, byId } },
      };
    });
  },

  addPending(pending) {
    set((state) => {
      const existing = state.channels[pending.channelId] ?? emptyChannel();
      const map = new Map(existing.pending);
      map.set(pending.idempotencyKey, pending);

      return {
        channels: { ...state.channels, [pending.channelId]: { ...existing, pending: map } },
      };
    });
  },

  resolvePending(channelId, idempotencyKey, message) {
    set((state) => {
      const existing = state.channels[channelId] ?? emptyChannel();

      const pending = new Map(existing.pending);
      pending.delete(idempotencyKey);

      const byId = new Map(existing.byId);
      byId.set(message.id, message);

      // Both happen in one update, so the optimistic row never disappears for
      // a frame before the confirmed one appears.
      return {
        channels: { ...state.channels, [channelId]: { ...existing, byId, pending } },
      };
    });
  },

  failPending(channelId, idempotencyKey, reason) {
    set((state) => {
      const existing = state.channels[channelId];
      if (existing === undefined) return state;

      const current = existing.pending.get(idempotencyKey);
      if (current === undefined) return state;

      const pending = new Map(existing.pending);
      // Kept in the list, marked failed: a message that silently vanishes is
      // worse than one that visibly needs retrying.
      pending.set(idempotencyKey, { ...current, state: 'failed', failureReason: reason });

      return {
        channels: { ...state.channels, [channelId]: { ...existing, pending } },
      };
    });
  },

  removePending(channelId, idempotencyKey) {
    set((state) => {
      const existing = state.channels[channelId];
      if (existing === undefined) return state;

      const pending = new Map(existing.pending);
      pending.delete(idempotencyKey);

      return {
        channels: { ...state.channels, [channelId]: { ...existing, pending } },
      };
    });
  },

  setTyping(channelId, userId, expiresAt) {
    set((state) => {
      const entries = (state.typing[channelId] ?? []).filter((entry) => entry.userId !== userId);
      return {
        typing: { ...state.typing, [channelId]: [...entries, { userId, expiresAt }] },
      };
    });
  },

  pruneTyping() {
    const now = Date.now();
    set((state) => {
      const next: Record<string, TypingEntry[]> = {};
      let changed = false;

      for (const [channelId, entries] of Object.entries(state.typing)) {
        const live = entries.filter((entry) => entry.expiresAt > now);
        if (live.length !== entries.length) changed = true;
        if (live.length > 0) next[channelId] = live;
      }

      // Returning the same object when nothing expired avoids a re-render on
      // every tick of the prune timer.
      return changed ? { typing: next } : state;
    });
  },

  select(channelId) {
    const channel = get().channels[channelId];
    if (channel === undefined) return [];

    // UUIDv7 ids sort chronologically, so this is creation order with no
    // separate timestamp comparison.
    const confirmed = [...channel.byId.values()]
      .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
      .map((message): DisplayMessage => ({ kind: 'confirmed', message }));

    const pending = [...channel.pending.values()]
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
      .map((item): DisplayMessage => ({ kind: 'pending', pending: item }));

    // Pending always last: they have no server id, and they are what the user
    // just typed, so they belong at the bottom.
    return [...confirmed, ...pending];
  },

  channelState(channelId) {
    return get().channels[channelId] ?? emptyChannel();
  },
}));
