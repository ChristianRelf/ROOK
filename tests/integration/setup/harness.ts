import { randomUUID } from 'node:crypto';
import { loadApiConfig } from '@rook/config';
import { createLogger } from '@rook/observability';
import { createDatabaseClient, createRepositories, type DatabaseClient } from '@rook/database';
import { createPasswordHasher, createSessionTokenService, generateJoinCode } from '@rook/auth';
import type { ChannelId, CommunityId, CurrentUser, UserId } from '@rook/contracts';

/**
 * Shared fixtures for integration tests.
 *
 * Tests run against the real development database rather than a transactional
 * rollback or a fresh schema per test. Two reasons:
 *
 *   * The behaviour under test often *is* the transaction boundary (the
 *     outbox commits with the message), and wrapping each test in an outer
 *     transaction would change the thing being measured.
 *   * The suite is meant to catch problems in real SQL against a real
 *     PostgreSQL, including constraints and index behaviour.
 *
 * Isolation comes from unique data instead: every fixture gets a random
 * username and community, so tests never collide even when run repeatedly.
 */

export interface TestHarness {
  readonly db: DatabaseClient;
  readonly repositories: ReturnType<typeof createRepositories>;
  readonly config: ReturnType<typeof loadApiConfig>;
  close: () => Promise<void>;
}

export function createHarness(): TestHarness {
  const config = loadApiConfig();
  // Silent: a passing suite should not print anything, and a failing test
  // reports through the assertion rather than the log.
  const logger = createLogger({
    service: 'test',
    runtime: { ...config.runtime, logLevel: 'fatal', logPretty: false },
  });

  const db = createDatabaseClient({ config: config.database, logger });

  return {
    db,
    repositories: createRepositories(db),
    config,
    close: () => db.close(),
  };
}

export interface TestUser {
  readonly user: CurrentUser;
  readonly password: string;
  readonly token: string;
  readonly tokenHash: Buffer;
}

/** Creates a user with a live session, straight through the repositories. */
export async function createTestUser(harness: TestHarness): Promise<TestUser> {
  const suffix = randomUUID().replace(/-/gu, '').slice(0, 12);
  const username = `t${suffix}`;
  const password = 'integration-test-password';

  const hasher = createPasswordHasher({
    ...harness.config.session,
    // Minimum permitted cost: these tests create many users and are not
    // measuring Argon2.
    argon2: { memoryCost: 8192, timeCost: 1, parallelism: 1 },
  });

  const created = await harness.repositories.users.create({
    username,
    email: `${username}@rook.test`,
    displayName: `Test ${suffix}`,
    passwordHash: await hasher.hash(password),
  });

  if (!created.ok) {
    throw new Error(`could not create test user: ${created.conflict}`);
  }

  const tokens = createSessionTokenService(harness.config.session);
  const { token, tokenHash } = tokens.issue();

  await harness.repositories.sessions.create({
    userId: created.user.id,
    tokenHash,
    expiresAt: tokens.expiresAt(),
    userAgent: 'integration-test',
  });

  return { user: created.user, password, token, tokenHash };
}

export interface TestCommunity {
  readonly communityId: CommunityId;
  readonly channelId: ChannelId;
  readonly joinCode: string;
}

/** Creates a community with one channel, owned by `ownerId`. */
export async function createTestCommunity(
  harness: TestHarness,
  ownerId: UserId,
): Promise<TestCommunity> {
  const community = await harness.repositories.communities.create({
    name: `Test ${randomUUID().slice(0, 8)}`,
    ownerId,
    joinCode: generateJoinCode(),
  });

  const channel = await harness.repositories.channels.create({
    communityId: community.id,
    name: 'general',
    topic: 'integration tests',
    createdBy: ownerId,
  });

  if (!channel.ok) {
    throw new Error(`could not create test channel: ${channel.reason}`);
  }

  return {
    communityId: community.id,
    channelId: channel.channel.id,
    joinCode: community.joinCode,
  };
}
