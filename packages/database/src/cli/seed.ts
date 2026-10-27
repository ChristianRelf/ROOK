#!/usr/bin/env node
import { loadApiConfig } from '@rook/config';
import { createLogger } from '@rook/observability';
import { createPasswordHasher, generateJoinCode } from '@rook/auth';
import { createDatabaseClient } from '../pool.js';
import { createRepositories } from '../repositories/index.js';

/**
 * Development seed data.
 *
 * Creates two accounts in one community so the two-client realtime flow can be
 * exercised immediately after setup, without registering through the UI twice.
 *
 * Idempotent: re-running reuses existing accounts rather than failing or
 * duplicating them, because `pnpm db:seed` gets run repeatedly during
 * development.
 *
 * Refuses to run against `NODE_ENV=production`. The passwords here are
 * published in the repository, so seeding production would create known
 * credentials on a live system.
 */

const seedUsers = [
  {
    username: 'ada',
    email: 'ada@rook.test',
    displayName: 'Ada Lovelace',
    password: 'rook-dev-password-ada',
  },
  {
    username: 'grace',
    email: 'grace@rook.test',
    displayName: 'Grace Hopper',
    password: 'rook-dev-password-grace',
  },
] as const;

async function main(): Promise<void> {
  const config = loadApiConfig();
  const logger = createLogger({ service: 'seed', runtime: config.runtime });

  if (config.runtime.isProduction) {
    throw new Error('Refusing to seed with NODE_ENV=production: these credentials are public.');
  }

  const db = createDatabaseClient({ config: config.database, logger });
  const hasher = createPasswordHasher(config.session);

  try {
    const result = await db.transaction('seed', async (tx) => {
      const repos = createRepositories(tx);

      // --- Accounts ------------------------------------------------------
      const users = [];
      for (const seed of seedUsers) {
        const existing = await repos.users.findByIdentifier(seed.username);
        if (existing !== undefined) {
          logger.info({ username: seed.username }, 'user already exists; reusing');
          users.push(existing.user);
          continue;
        }

        const created = await repos.users.create({
          username: seed.username,
          email: seed.email,
          displayName: seed.displayName,
          passwordHash: await hasher.hash(seed.password),
        });

        if (!created.ok) {
          // Can happen if the username is free but the email is taken, or
          // vice versa. Reported rather than silently skipped.
          throw new Error(`Could not create ${seed.username}: ${created.conflict}`);
        }

        logger.info({ username: seed.username }, 'created user');
        users.push(created.user);
      }

      const [owner, member] = users;
      if (owner === undefined || member === undefined) {
        throw new Error('seed expected two users');
      }

      // --- Community -----------------------------------------------------
      const existingCommunities = await repos.communities.listForUser(owner.id);
      let community = existingCommunities.find((c) => c.name === 'Rook HQ');

      if (community === undefined) {
        community = await repos.communities.create({
          name: 'Rook HQ',
          ownerId: owner.id,
          joinCode: generateJoinCode(),
        });
        logger.info({ joinCode: community.joinCode }, 'created community');
      } else {
        logger.info({ joinCode: community.joinCode }, 'community already exists; reusing');
      }

      // --- Second member -------------------------------------------------
      const membership = await repos.communities.findMembership(community.id, member.id);
      if (membership === undefined) {
        const joined = await repos.communities.joinByCode(community.joinCode, member.id);
        if (!joined.ok && joined.reason !== 'already_a_member') {
          throw new Error(`Could not add ${member.username}: ${joined.reason}`);
        }
        logger.info({ username: member.username }, 'added member to community');
      }

      // --- Channels ------------------------------------------------------
      const existingChannels = await repos.channels.listForCommunity(community.id);
      const wanted = [
        { name: 'general', topic: 'Anything and everything' },
        { name: 'engineering', topic: 'Architecture and implementation' },
      ];

      for (const channel of wanted) {
        if (existingChannels.some((c) => c.name === channel.name)) continue;

        const created = await repos.channels.create({
          communityId: community.id,
          name: channel.name,
          topic: channel.topic,
          createdBy: owner.id,
        });

        if (!created.ok) {
          throw new Error(`Could not create #${channel.name}: ${created.reason}`);
        }
        logger.info({ channel: channel.name }, 'created channel');
      }

      return { community, users };
    });

    logger.info(
      {
        community: result.community.name,
        joinCode: result.community.joinCode,
        accounts: seedUsers.map((u) => u.username),
      },
      'seed complete',
    );

    // Printed to stdout so it is readable without parsing the log stream.
    process.stdout.write(
      [
        '',
        'Seeded development data:',
        `  community   Rook HQ  (join code: ${result.community.joinCode})`,
        '  channels    #general, #engineering',
        '  accounts:',
        ...seedUsers.map((u) => `    ${u.username.padEnd(8)} ${u.password}`),
        '',
      ].join('\n'),
    );
  } finally {
    await db.close();
  }
}

await main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
