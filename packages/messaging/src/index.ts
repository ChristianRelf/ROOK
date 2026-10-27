/**
 * `@rook/messaging` — the chat domain layer.
 *
 * Holds the application logic for messages, channels, communities and media
 * metadata: authorisation decisions, the persist-then-publish ordering, and
 * the result types the transport maps to status codes. It knows nothing about
 * HTTP or WebSockets, which is what lets these flows be tested against a
 * database without starting a server.
 */

export { createEventPublisher, type EventPublisher } from './events.js';

export {
  createMessageService,
  type MessageService,
  type SendMessageCommand,
  type SendResult,
  type SendFailure,
  type EditResult,
  type DeleteResult,
  type HistoryResult,
} from './message-service.js';

export {
  createCommunityService,
  type CommunityService,
  type CreateCommunityResult,
  type JoinCommunityResult,
  type CreateChannelResult,
  type ListChannelsResult,
  type ChannelTreeResult,
  type ListMembersResult,
} from './community-service.js';

export {
  createAdministrationService,
  type AdministrationService,
  type AuthorizationFailure,
  type CategoryResult,
  type CategoryMutationResult,
  type CategoryDeleteResult,
  type ChannelMutationResult,
  type ChannelDeleteResult,
  type ReorderResult,
  type MemberRoleResult,
  type MemberRemoveResult,
  type InviteResult,
  type InviteListResult,
  type InviteRevokeResult,
  type InvitePreviewResult,
  type AcceptInviteResult,
  type AuditListResult,
} from './administration-service.js';

export {
  createReadStateService,
  type ReadStateService,
  type MarkReadResult,
} from './read-state-service.js';

export {
  createMediaService,
  type MediaService,
  type AuthorizeUploadResult,
  type ConfirmUploadResult,
} from './media-service.js';
