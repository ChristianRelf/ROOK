import type { Queryable } from '../pool.js';
import { createUserRepository, type UserRepository } from './users.js';
import { createSessionRepository, type SessionRepository } from './sessions.js';
import { createCommunityRepository, type CommunityRepository } from './communities.js';
import { createChannelRepository, type ChannelRepository } from './channels.js';
import { createMessageRepository, type MessageRepository } from './messages.js';
import { createMediaRepository, type MediaRepository } from './media.js';
import { createOutboxRepository, type OutboxRepository } from './outbox.js';

/**
 * All repositories bound to one `Queryable`.
 *
 * Because every repository is constructed from a `Queryable`, the same set can
 * be built over the pool for ordinary reads or over a transaction handle
 * inside `transaction()`. A service that needs to write a message and its
 * outbox event atomically simply rebuilds the repositories against the
 * transaction — no separate "transactional repository" variants, and no way to
 * accidentally run half a unit of work on the pool.
 */
export interface Repositories {
  readonly users: UserRepository;
  readonly sessions: SessionRepository;
  readonly communities: CommunityRepository;
  readonly channels: ChannelRepository;
  readonly messages: MessageRepository;
  readonly media: MediaRepository;
  readonly outbox: OutboxRepository;
}

export function createRepositories(db: Queryable): Repositories {
  return {
    users: createUserRepository(db),
    sessions: createSessionRepository(db),
    communities: createCommunityRepository(db),
    channels: createChannelRepository(db),
    messages: createMessageRepository(db),
    media: createMediaRepository(db),
    outbox: createOutboxRepository(db),
  };
}
