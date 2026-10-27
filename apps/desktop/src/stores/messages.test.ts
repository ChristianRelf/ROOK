import { beforeEach, describe, expect, it } from 'vitest';
import type { ChannelId, Message, MessageId, UserId } from '@rook/contracts';
import { useMessagesStore } from './messages.js';

/**
 * Tests for the message store.
 *
 * This is where the backend's at-least-once delivery becomes
 * exactly-once-on-screen, so the cases below are mostly about applying the
 * same thing twice and getting one result.
 */

const channelId = crypto.randomUUID() as ChannelId;
const otherChannelId = crypto.randomUUID() as ChannelId;
const authorId = crypto.randomUUID() as UserId;

/**
 * Builds a message with a UUIDv7-shaped id whose timestamp prefix encodes
 * `sequence`, so ids sort in creation order exactly as real ones do.
 */
function makeMessage(sequence: number, overrides: Partial<Message> = {}): Message {
  const timestamp = (1_700_000_000_000 + sequence * 1000).toString(16).padStart(12, '0');
  const id = `${timestamp.slice(0, 8)}-${timestamp.slice(8, 12)}-7000-8000-${String(sequence).padStart(12, '0')}`;

  return {
    id: id as MessageId,
    channelId,
    author: {
      id: authorId,
      username: 'ada',
      displayName: 'Ada Lovelace',
      avatarAssetId: null,
      createdAt: '2026-01-01T00:00:00.000Z',
    },
    content: `message ${sequence}`,
    attachments: [],
    createdAt: new Date(1_700_000_000_000 + sequence * 1000).toISOString(),
    editedAt: null,
    deletedAt: null,
    ...overrides,
  };
}

function reset(): void {
  useMessagesStore.setState({ channels: {}, typing: {} });
}

describe('applying history', () => {
  beforeEach(reset);

  it('loads a page and records the pagination cursor', () => {
    const store = useMessagesStore.getState();
    store.applyPage(channelId, {
      messages: [makeMessage(1), makeMessage(2)],
      nextCursor: 'cursor-1',
      hasMore: true,
    });

    const state = useMessagesStore.getState().channelState(channelId);
    expect(state.byId.size).toBe(2);
    expect(state.olderCursor).toBe('cursor-1');
    expect(state.hasMore).toBe(true);
    expect(state.loadedInitial).toBe(true);
  });

  it('is idempotent when the same page arrives twice', () => {
    const page = { messages: [makeMessage(1), makeMessage(2)], nextCursor: null, hasMore: false };

    useMessagesStore.getState().applyPage(channelId, page);
    useMessagesStore.getState().applyPage(channelId, page);

    // The resync path reapplies pages routinely; duplicating rows would be
    // immediately visible to the user.
    expect(useMessagesStore.getState().select(channelId)).toHaveLength(2);
  });

  it('replaces local state on resync so missed edits are corrected', () => {
    useMessagesStore.getState().applyPage(channelId, {
      messages: [makeMessage(1, { content: 'original' })],
      nextCursor: null,
      hasMore: false,
    });

    // While disconnected the message was edited; the resync page is
    // authoritative for the range it covers.
    useMessagesStore.getState().applyPage(
      channelId,
      {
        messages: [
          makeMessage(1, { content: 'edited while offline', editedAt: '2026-01-02T00:00:00.000Z' }),
        ],
        nextCursor: null,
        hasMore: false,
      },
      { replace: true },
    );

    const items = useMessagesStore.getState().select(channelId);
    expect(items).toHaveLength(1);
    expect(items[0]?.kind === 'confirmed' && items[0].message.content).toBe('edited while offline');
  });

  it('keeps channels separate', () => {
    useMessagesStore.getState().applyPage(channelId, {
      messages: [makeMessage(1)],
      nextCursor: null,
      hasMore: false,
    });

    expect(useMessagesStore.getState().select(otherChannelId)).toHaveLength(0);
  });
});

describe('older pages', () => {
  beforeEach(reset);

  it('prepends older messages and advances the cursor', () => {
    const store = useMessagesStore.getState();
    store.applyPage(channelId, {
      messages: [makeMessage(10), makeMessage(11)],
      nextCursor: 'cursor-10',
      hasMore: true,
    });

    store.applyOlderPage(channelId, {
      messages: [makeMessage(8), makeMessage(9)],
      nextCursor: 'cursor-8',
      hasMore: true,
    });

    const items = useMessagesStore.getState().select(channelId);
    expect(items).toHaveLength(4);
    // Oldest first, by id.
    expect(items[0]?.kind === 'confirmed' && items[0].message.content).toBe('message 8');

    const state = useMessagesStore.getState().channelState(channelId);
    expect(state.olderCursor).toBe('cursor-8');
    expect(state.loadingOlder).toBe(false);
  });

  it('does not let a stale older page overwrite a newer copy', () => {
    const store = useMessagesStore.getState();

    store.applyPage(channelId, {
      messages: [makeMessage(5, { content: 'edited', editedAt: '2026-01-02T00:00:00.000Z' })],
      nextCursor: 'c',
      hasMore: true,
    });

    // A history page fetched before the edit landed.
    store.applyOlderPage(channelId, {
      messages: [makeMessage(5, { content: 'stale original' })],
      nextCursor: null,
      hasMore: false,
    });

    const items = useMessagesStore.getState().select(channelId);
    expect(items).toHaveLength(1);
    expect(items[0]?.kind === 'confirmed' && items[0].message.content).toBe('edited');
  });
});

describe('realtime upserts', () => {
  beforeEach(reset);

  it('adds a new message', () => {
    useMessagesStore.getState().upsert(channelId, makeMessage(1));
    expect(useMessagesStore.getState().select(channelId)).toHaveLength(1);
  });

  it('applying the same event twice yields one message', () => {
    const message = makeMessage(1);

    // The exact duplicate case the outbox's at-least-once delivery produces.
    useMessagesStore.getState().upsert(channelId, message);
    useMessagesStore.getState().upsert(channelId, message);

    expect(useMessagesStore.getState().select(channelId)).toHaveLength(1);
  });

  it('an update replaces the existing copy in place', () => {
    useMessagesStore.getState().upsert(channelId, makeMessage(1, { content: 'before' }));
    useMessagesStore
      .getState()
      .upsert(
        channelId,
        makeMessage(1, { content: 'after', editedAt: '2026-01-02T00:00:00.000Z' }),
      );

    const items = useMessagesStore.getState().select(channelId);
    expect(items).toHaveLength(1);
    expect(items[0]?.kind === 'confirmed' && items[0].message.content).toBe('after');
  });

  it('orders messages by id, regardless of arrival order', () => {
    const store = useMessagesStore.getState();

    // Events can arrive out of order across a reconnect.
    store.upsert(channelId, makeMessage(3));
    store.upsert(channelId, makeMessage(1));
    store.upsert(channelId, makeMessage(2));

    const contents = useMessagesStore
      .getState()
      .select(channelId)
      .map((item) => (item.kind === 'confirmed' ? item.message.content : null));

    expect(contents).toEqual(['message 1', 'message 2', 'message 3']);
  });
});

describe('deletion', () => {
  beforeEach(reset);

  it('turns a message into a tombstone rather than removing it', () => {
    useMessagesStore.getState().upsert(channelId, makeMessage(1));
    useMessagesStore
      .getState()
      .markDeleted(channelId, makeMessage(1).id, '2026-01-03T00:00:00.000Z');

    const items = useMessagesStore.getState().select(channelId);
    // Kept in the list: a client already displaying it must be told it is
    // gone, and removing it would make pagination inconsistent.
    expect(items).toHaveLength(1);
    expect(items[0]?.kind === 'confirmed' && items[0].message.content).toBeNull();
    expect(items[0]?.kind === 'confirmed' && items[0].message.deletedAt).toBe(
      '2026-01-03T00:00:00.000Z',
    );
  });

  it('ignores a deletion for a message that was never loaded', () => {
    useMessagesStore
      .getState()
      .markDeleted(channelId, makeMessage(99).id, '2026-01-03T00:00:00.000Z');
    expect(useMessagesStore.getState().select(channelId)).toHaveLength(0);
  });

  it('is idempotent', () => {
    const store = useMessagesStore.getState();
    store.upsert(channelId, makeMessage(1));
    store.markDeleted(channelId, makeMessage(1).id, '2026-01-03T00:00:00.000Z');
    store.markDeleted(channelId, makeMessage(1).id, '2026-01-03T00:00:00.000Z');

    expect(useMessagesStore.getState().select(channelId)).toHaveLength(1);
  });
});

describe('optimistic sends', () => {
  const pending = {
    idempotencyKey: 'key-1',
    channelId,
    authorId,
    content: 'hello',
    attachmentIds: [] as readonly string[],
    createdAt: '2026-01-01T00:00:00.000Z',
    state: 'pending' as const,
    failureReason: undefined,
  };

  beforeEach(reset);

  it('shows a pending message immediately', () => {
    useMessagesStore.getState().addPending(pending);

    const items = useMessagesStore.getState().select(channelId);
    expect(items).toHaveLength(1);
    expect(items[0]?.kind).toBe('pending');
  });

  it('sorts pending messages after confirmed ones', () => {
    const store = useMessagesStore.getState();
    store.upsert(channelId, makeMessage(1));
    store.addPending(pending);

    const items = useMessagesStore.getState().select(channelId);
    // Pending has no server id, and it is what the user just typed, so it
    // belongs at the bottom.
    expect(items[0]?.kind).toBe('confirmed');
    expect(items[1]?.kind).toBe('pending');
  });

  it('replaces the pending row with the confirmed one atomically', () => {
    const store = useMessagesStore.getState();
    store.addPending(pending);
    store.resolvePending(channelId, 'key-1', makeMessage(1, { content: 'hello' }));

    const items = useMessagesStore.getState().select(channelId);
    // Exactly one row: the optimistic copy must not linger beside the real one.
    expect(items).toHaveLength(1);
    expect(items[0]?.kind).toBe('confirmed');
  });

  it('keeps a failed send visible with its reason', () => {
    const store = useMessagesStore.getState();
    store.addPending(pending);
    store.failPending(channelId, 'key-1', 'Could not reach the server.');

    const items = useMessagesStore.getState().select(channelId);
    expect(items).toHaveLength(1);
    expect(items[0]?.kind === 'pending' && items[0].pending.state).toBe('failed');
    expect(items[0]?.kind === 'pending' && items[0].pending.failureReason).toBe(
      'Could not reach the server.',
    );
  });

  it('a retry under the same key reuses the one row', () => {
    const store = useMessagesStore.getState();
    store.addPending(pending);
    store.failPending(channelId, 'key-1', 'network');
    // The retry re-adds under the same idempotency key.
    store.addPending({ ...pending, state: 'pending' });

    const items = useMessagesStore.getState().select(channelId);
    expect(items).toHaveLength(1);
    expect(items[0]?.kind === 'pending' && items[0].pending.state).toBe('pending');
  });

  it('discarding a failed send removes it', () => {
    const store = useMessagesStore.getState();
    store.addPending(pending);
    store.failPending(channelId, 'key-1', 'network');
    store.removePending(channelId, 'key-1');

    expect(useMessagesStore.getState().select(channelId)).toHaveLength(0);
  });

  it('a realtime echo arriving before the response does not duplicate', () => {
    // The race: the server broadcasts message.created and the HTTP response
    // lands afterwards. The echo is suppressed for the sender, but a second
    // device of the same user would deliver it.
    const store = useMessagesStore.getState();
    const confirmed = makeMessage(1, { content: 'hello' });

    store.addPending(pending);
    store.upsert(channelId, confirmed);
    store.resolvePending(channelId, 'key-1', confirmed);

    expect(useMessagesStore.getState().select(channelId)).toHaveLength(1);
  });
});

describe('typing indicators', () => {
  beforeEach(reset);

  it('records a typist and replaces an earlier entry for the same user', () => {
    const store = useMessagesStore.getState();
    store.setTyping(channelId, authorId, Date.now() + 5000);
    store.setTyping(channelId, authorId, Date.now() + 6000);

    expect(useMessagesStore.getState().typing[channelId]).toHaveLength(1);
  });

  it('prunes entries that have expired', () => {
    const store = useMessagesStore.getState();
    const other = crypto.randomUUID() as UserId;

    store.setTyping(channelId, authorId, Date.now() - 1);
    store.setTyping(channelId, other, Date.now() + 10_000);
    store.pruneTyping();

    const entries = useMessagesStore.getState().typing[channelId] ?? [];
    expect(entries).toHaveLength(1);
    expect(entries[0]?.userId).toBe(other);
  });

  it('drops the channel entry once every typist has expired', () => {
    const store = useMessagesStore.getState();
    store.setTyping(channelId, authorId, Date.now() - 1);
    store.pruneTyping();

    expect(useMessagesStore.getState().typing[channelId]).toBeUndefined();
  });

  it('pruning with nothing expired leaves state untouched', () => {
    const store = useMessagesStore.getState();
    store.setTyping(channelId, authorId, Date.now() + 10_000);

    const before = useMessagesStore.getState().typing;
    useMessagesStore.getState().pruneTyping();

    // Returning the same object avoids a re-render on every prune tick.
    expect(useMessagesStore.getState().typing).toBe(before);
  });
});
