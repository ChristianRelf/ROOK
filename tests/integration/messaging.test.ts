import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { createEventPublisher, createMessageService } from '@rook/messaging';
import { sql } from '@rook/database';
import type { ChannelId, MessageId } from '@rook/contracts';
import {
  createHarness,
  createTestCommunity,
  createTestUser,
  type TestCommunity,
  type TestHarness,
  type TestUser,
} from './setup/harness.js';

/**
 * Integration tests for messaging against a real PostgreSQL.
 *
 * These cover the behaviour that only exists once real SQL runs: the unique
 * index that makes sends idempotent, the transaction that commits a message
 * and its outbox event together, cursor pagination over a real index, and the
 * membership join that enforces authorisation.
 *
 * Unit tests cannot reach any of that, which is exactly why this suite exists.
 */

let harness: TestHarness;
let owner: TestUser;
let outsider: TestUser;
let community: TestCommunity;
let service: ReturnType<typeof createMessageService>;

beforeAll(async () => {
  harness = createHarness();
  owner = await createTestUser(harness);
  outsider = await createTestUser(harness);
  community = await createTestCommunity(harness, owner.user.id);

  service = createMessageService({
    db: harness.db,
    events: createEventPublisher(harness.repositories.outbox),
  });
});

afterAll(async () => {
  await harness.close();
});

/** Outbox rows addressed to a channel, newest first. */
async function outboxFor(channelId: ChannelId): Promise<{ event_type: string }[]> {
  const result = await harness.db.query<{ event_type: string }>(
    sql`
      select event_type
      from event_outbox
      where audience_scope = 'channel' and audience_id = ${channelId}
      order by id desc
    `,
    'test.outboxFor',
  );
  return result.rows;
}

describe('sending messages', () => {
  it('persists a message and its outbox event in one transaction', async () => {
    const before = (await outboxFor(community.channelId)).length;

    const result = await service.send({
      channelId: community.channelId,
      authorId: owner.user.id,
      content: 'first message',
      attachmentIds: [],
      idempotencyKey: randomUUID(),
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.created).toBe(true);
    expect(result.message.content).toBe('first message');
    // The author is resolved by the same query, not a follow-up.
    expect(result.message.author.id).toBe(owner.user.id);

    // The event exists because the message does: that is the outbox guarantee.
    const after = await outboxFor(community.channelId);
    expect(after.length).toBe(before + 1);
    expect(after[0]?.event_type).toBe('message.created');
  });

  it('is idempotent: the same key yields one row and one event', async () => {
    const key = randomUUID();
    const before = (await outboxFor(community.channelId)).length;

    const first = await service.send({
      channelId: community.channelId,
      authorId: owner.user.id,
      content: 'retried message',
      attachmentIds: [],
      idempotencyKey: key,
    });

    const second = await service.send({
      channelId: community.channelId,
      authorId: owner.user.id,
      content: 'retried message',
      attachmentIds: [],
      idempotencyKey: key,
    });

    expect(first.ok && second.ok).toBe(true);
    if (!first.ok || !second.ok) return;

    expect(second.message.id).toBe(first.message.id);
    expect(first.created).toBe(true);
    // The second call must report that it created nothing, which is what stops
    // a duplicate event being published.
    expect(second.created).toBe(false);

    const after = await outboxFor(community.channelId);
    expect(after.length).toBe(before + 1);
  });

  it('handles concurrent sends with the same key without duplicating', async () => {
    // The real race: two in-flight retries of one send. The unique index is
    // what arbitrates, which is only testable against a real database.
    const key = randomUUID();

    const results = await Promise.all(
      Array.from({ length: 5 }, () =>
        service.send({
          channelId: community.channelId,
          authorId: owner.user.id,
          content: 'concurrent',
          attachmentIds: [],
          idempotencyKey: key,
        }),
      ),
    );

    const ids = new Set(results.filter((result) => result.ok).map((result) => result.message.id));

    expect(results.every((result) => result.ok)).toBe(true);
    // All five resolve to one message.
    expect(ids.size).toBe(1);
    // And exactly one of them reports having created it.
    expect(results.filter((result) => result.ok && result.created)).toHaveLength(1);
  });

  it('refuses a send from a non-member and reveals nothing about the channel', async () => {
    const result = await service.send({
      channelId: community.channelId,
      authorId: outsider.user.id,
      content: 'intruder',
      attachmentIds: [],
      idempotencyKey: randomUUID(),
    });

    expect(result.ok).toBe(false);
    // Deliberately "not found" rather than "forbidden": confirming the
    // channel exists would itself be a disclosure.
    expect(!result.ok && result.reason).toBe('channel_not_found');
  });

  it('refuses a send to a channel that does not exist', async () => {
    const result = await service.send({
      channelId: randomUUID() as ChannelId,
      authorId: owner.user.id,
      content: 'nowhere',
      attachmentIds: [],
      idempotencyKey: randomUUID(),
    });

    expect(!result.ok && result.reason).toBe('channel_not_found');
  });

  it('refuses an attachment the sender does not own', async () => {
    const reserved = await harness.repositories.media.reserve({
      ownerId: outsider.user.id,
      declaredContentType: 'image/png',
      declaredByteSize: 1024,
      filename: 'other.png',
    });

    const result = await service.send({
      channelId: community.channelId,
      authorId: owner.user.id,
      content: 'stealing an attachment',
      attachmentIds: [reserved.id],
      idempotencyKey: randomUUID(),
    });

    // Without the ownership check a client could attach any asset by id.
    expect(!result.ok && result.reason).toBe('attachment_not_found');
  });

  it('refuses an attachment that has not finished processing', async () => {
    const reserved = await harness.repositories.media.reserve({
      ownerId: owner.user.id,
      declaredContentType: 'image/png',
      declaredByteSize: 1024,
      filename: 'pending.png',
    });

    const result = await service.send({
      channelId: community.channelId,
      authorId: owner.user.id,
      content: 'too early',
      attachmentIds: [reserved.id],
      idempotencyKey: randomUUID(),
    });

    expect(!result.ok && result.reason).toBe('attachment_not_ready');
  });
});

describe('cursor pagination', () => {
  let paginationChannel: ChannelId;

  beforeAll(async () => {
    // A dedicated channel so counts are not affected by the other tests.
    const dedicated = await createTestCommunity(harness, owner.user.id);
    paginationChannel = dedicated.channelId;

    // Sequential, so ids are strictly increasing and the expected order is
    // unambiguous.
    for (let index = 0; index < 25; index += 1) {
      await service.send({
        channelId: paginationChannel,
        authorId: owner.user.id,
        content: `page message ${index}`,
        attachmentIds: [],
        idempotencyKey: randomUUID(),
      });
    }
  });

  it('returns the newest page first, ordered oldest-first within it', async () => {
    const result = await service.history({
      channelId: paginationChannel,
      viewerId: owner.user.id,
      cursor: undefined,
      direction: 'before',
      limit: 10,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.page.messages).toHaveLength(10);
    expect(result.page.hasMore).toBe(true);
    expect(result.page.nextCursor).not.toBeNull();

    // The page covers the 10 most recent, presented oldest-first so a client
    // can append without reversing.
    const contents = result.page.messages.map((message) => message.content);
    expect(contents[0]).toBe('page message 15');
    expect(contents[9]).toBe('page message 24');
  });

  it('walks backwards through history without gaps or overlaps', async () => {
    const seen: string[] = [];
    let cursor: string | undefined;

    for (let page = 0; page < 4; page += 1) {
      const result = await service.history({
        channelId: paginationChannel,
        viewerId: owner.user.id,
        cursor,
        direction: 'before',
        limit: 10,
      });

      if (!result.ok) throw new Error('history failed');

      seen.push(...result.page.messages.map((message) => message.content));
      if (result.page.nextCursor === null) break;
      cursor = result.page.nextCursor;
    }

    // Every message exactly once: the property offset pagination loses when
    // rows are inserted mid-scroll.
    expect(new Set(seen).size).toBe(25);
    expect(seen).toHaveLength(25);
  });

  it('reports the end of history', async () => {
    let cursor: string | undefined;
    let hasMore = true;
    let guard = 0;

    while (hasMore && guard < 10) {
      const result = await service.history({
        channelId: paginationChannel,
        viewerId: owner.user.id,
        cursor,
        direction: 'before',
        limit: 10,
      });

      if (!result.ok) throw new Error('history failed');
      hasMore = result.page.hasMore;
      cursor = result.page.nextCursor ?? undefined;
      guard += 1;
    }

    expect(hasMore).toBe(false);
  });

  it('reads forwards with direction=after, for catching up', async () => {
    const firstPage = await service.history({
      channelId: paginationChannel,
      viewerId: owner.user.id,
      cursor: undefined,
      direction: 'before',
      limit: 5,
    });

    if (!firstPage.ok || firstPage.page.nextCursor === null) {
      throw new Error('expected a cursor');
    }

    const forwards = await service.history({
      channelId: paginationChannel,
      viewerId: owner.user.id,
      cursor: firstPage.page.nextCursor,
      direction: 'after',
      limit: 5,
    });

    expect(forwards.ok).toBe(true);
    if (!forwards.ok) return;
    expect(forwards.page.messages.length).toBeGreaterThan(0);
  });

  it('rejects a malformed cursor instead of failing in the driver', async () => {
    const result = await service.history({
      channelId: paginationChannel,
      viewerId: owner.user.id,
      cursor: 'not-a-real-cursor',
      direction: 'before',
      limit: 10,
    });

    expect(!result.ok && result.reason).toBe('invalid_cursor');
  });

  it('refuses history to a non-member', async () => {
    const result = await service.history({
      channelId: paginationChannel,
      viewerId: outsider.user.id,
      cursor: undefined,
      direction: 'before',
      limit: 10,
    });

    expect(!result.ok && result.reason).toBe('channel_not_found');
  });
});

describe('editing and deleting', () => {
  it('edits content and records editedAt', async () => {
    const sent = await service.send({
      channelId: community.channelId,
      authorId: owner.user.id,
      content: 'before edit',
      attachmentIds: [],
      idempotencyKey: randomUUID(),
    });
    if (!sent.ok) throw new Error('send failed');

    const edited = await service.edit({
      messageId: sent.message.id,
      viewerId: owner.user.id,
      content: 'after edit',
    });

    expect(edited.ok).toBe(true);
    if (!edited.ok) return;

    expect(edited.message.content).toBe('after edit');
    expect(edited.message.editedAt).not.toBeNull();
  });

  it('will not let another member edit a message', async () => {
    const sent = await service.send({
      channelId: community.channelId,
      authorId: owner.user.id,
      content: 'mine',
      attachmentIds: [],
      idempotencyKey: randomUUID(),
    });
    if (!sent.ok) throw new Error('send failed');

    // Joined as a member, so they can read the channel but still must not be
    // able to rewrite someone else's words.
    const member = await createTestUser(harness);
    await harness.repositories.communities.joinByCode(community.joinCode, member.user.id);

    const result = await service.edit({
      messageId: sent.message.id,
      viewerId: member.user.id,
      content: 'not mine',
    });

    expect(!result.ok && result.reason).toBe('forbidden');
  });

  it('soft-deletes, leaving a tombstone with no content', async () => {
    const sent = await service.send({
      channelId: community.channelId,
      authorId: owner.user.id,
      content: 'delete me',
      attachmentIds: [],
      idempotencyKey: randomUUID(),
    });
    if (!sent.ok) throw new Error('send failed');

    const deleted = await service.remove({
      messageId: sent.message.id,
      viewerId: owner.user.id,
    });

    expect(deleted.ok).toBe(true);

    const reloaded = await harness.repositories.messages.findById(sent.message.id);
    // The row survives so clients are told it is gone and pagination stays
    // consistent, but the text itself is cleared from the database.
    expect(reloaded).toBeDefined();
    expect(reloaded?.content).toBeNull();
    expect(reloaded?.deletedAt).not.toBeNull();
  });

  it('reports a second delete as not found rather than forbidden', async () => {
    const sent = await service.send({
      channelId: community.channelId,
      authorId: owner.user.id,
      content: 'delete twice',
      attachmentIds: [],
      idempotencyKey: randomUUID(),
    });
    if (!sent.ok) throw new Error('send failed');

    await service.remove({ messageId: sent.message.id, viewerId: owner.user.id });
    const again = await service.remove({ messageId: sent.message.id, viewerId: owner.user.id });

    // It is gone, not off-limits -- telling an author they lack permission to
    // delete their own message would be misleading.
    expect(!again.ok && again.reason).toBe('message_not_found');
  });

  it('will not edit a deleted message', async () => {
    const sent = await service.send({
      channelId: community.channelId,
      authorId: owner.user.id,
      content: 'edit after delete',
      attachmentIds: [],
      idempotencyKey: randomUUID(),
    });
    if (!sent.ok) throw new Error('send failed');

    await service.remove({ messageId: sent.message.id, viewerId: owner.user.id });

    const result = await service.edit({
      messageId: sent.message.id,
      viewerId: owner.user.id,
      content: 'resurrected',
    });

    expect(!result.ok && result.reason).toBe('message_not_found');
  });

  it('reports an unknown message as not found', async () => {
    const result = await service.edit({
      messageId: randomUUID() as MessageId,
      viewerId: owner.user.id,
      content: 'nothing here',
    });

    expect(!result.ok && result.reason).toBe('message_not_found');
  });
});

describe('session revocation', () => {
  it('stops authenticating a revoked session', async () => {
    // Regression test. The session lookup joins `users`, and both tables have
    // an `id` column: an unaliased select resolved `id` to the *user's* id, so
    // logout revoked a session that did not exist and the token kept working.
    const user = await createTestUser(harness);

    const before = await harness.repositories.sessions.findActiveByTokenHash(user.tokenHash);
    expect(before).toBeDefined();
    // The session id must be the session's, not the user's.
    expect(before?.session.id).not.toBe(user.user.id);
    expect(before?.session.userId).toBe(user.user.id);

    const revoked = await harness.repositories.sessions.revoke(before?.session.id as never);
    expect(revoked).toBe(true);

    const after = await harness.repositories.sessions.findActiveByTokenHash(user.tokenHash);
    expect(after).toBeUndefined();
  });

  it('revokes every session for a user', async () => {
    const user = await createTestUser(harness);
    const count = await harness.repositories.sessions.revokeAllForUser(user.user.id);

    expect(count).toBeGreaterThanOrEqual(1);
    await expect(
      harness.repositories.sessions.findActiveByTokenHash(user.tokenHash),
    ).resolves.toBeUndefined();
  });
});
