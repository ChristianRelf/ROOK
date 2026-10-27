/**
 * `@rook/database` — schema, migrations and repositories.
 *
 * Everything that touches PostgreSQL goes through here. Application code calls
 * repository methods and never writes SQL, which keeps query shapes, index
 * assumptions and column exposure reviewable in one place.
 */

export { sql, raw, empty, join, sortDirection, SqlFragment, RawSql } from './sql.js';
export {
  createDatabaseClient,
  type DatabaseClient,
  type Queryable,
  type QueryResult,
  type CreateDatabaseOptions,
} from './pool.js';

export {
  createMigrator,
  readMigrationFiles,
  migrationChecksum,
  type Migrator,
  type MigrationFile,
  type MigrationStatus,
  type AppliedMigration,
} from './migrator.js';

export {
  newChannelId,
  newCommunityId,
  newEventId,
  newMediaAssetId,
  newMessageId,
  newSessionId,
  newUserId,
  timestampFromUuidV7,
} from './ids.js';

export { encodeCursor, decodeCursor, decodeOptionalCursor, InvalidCursorError } from './cursor.js';

export {
  pgErrorCodes,
  isUniqueViolation,
  isForeignKeyViolation,
  isCheckViolation,
  isRetryableTransactionError,
  isQueryCanceled,
  violatedConstraint,
  RecordNotFoundError,
} from './errors.js';

export {
  SingleShardRouter,
  communityPartition,
  globalPartition,
  type PartitionKey,
  type CommunityPartitionKey,
  type GlobalPartitionKey,
  type ShardRouter,
} from './routing.js';

export {
  createUserRepository,
  type UserRepository,
  type CreateUserInput,
  type CreateUserResult,
  type CreateUserConflict,
  type UserWithCredentials,
} from './repositories/users.js';

export {
  createSessionRepository,
  type SessionRepository,
  type CreateSessionInput,
  type SessionRecord,
  type AuthenticatedSession,
} from './repositories/sessions.js';

export {
  createCommunityRepository,
  type CommunityRepository,
  type CreateCommunityInput,
  type JoinCommunityResult,
  type MembershipRecord,
} from './repositories/communities.js';

export {
  createChannelRepository,
  type ChannelRepository,
  type CreateChannelInput,
  type CreateChannelResult,
  type AccessibleChannel,
} from './repositories/channels.js';

export {
  createMessageRepository,
  type MessageRepository,
  type SendMessageInput,
  type SendMessageResult,
  type MessagePage,
} from './repositories/messages.js';

export {
  createMediaRepository,
  storageKeyFor,
  type MediaRepository,
  type ReserveAssetInput,
  type ReservedAsset,
  type ConfirmUploadInput,
  type VariantInput,
  type PendingAsset,
} from './repositories/media.js';

export {
  createOutboxRepository,
  type OutboxRepository,
  type EnqueueEventInput,
  type OutboxRow,
} from './repositories/outbox.js';

export { createRepositories, type Repositories } from './repositories/index.js';
export { migrationsDirectory } from './paths.js';
