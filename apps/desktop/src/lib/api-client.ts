import {
  acceptInviteResponseSchema,
  apiErrorSchema,
  auditLogResponseSchema,
  categoryListResponseSchema,
  categoryResponseSchema,
  channelListResponseSchema,
  channelResponseSchema,
  channelTreeResponseSchema,
  communityListResponseSchema,
  communityResponseSchema,
  confirmUploadResponseSchema,
  createUploadResponseSchema,
  currentUserResponseSchema,
  inviteListResponseSchema,
  invitePreviewResponseSchema,
  inviteResponseSchema,
  markReadResponseSchema,
  mediaAssetResponseSchema,
  memberListResponseSchema,
  memberResponseSchema,
  messagePageResponseSchema,
  messageResponseSchema,
  removeMemberResponseSchema,
  sessionResponseSchema,
  unreadSummaryResponseSchema,
  type AssignableRole,
  type AuditAction,
  type CategoryId,
  type ChannelId,
  type CommunityId,
  type ErrorCode,
  type FieldError,
  type InviteDuration,
  type InviteId,
  type MediaAssetId,
  type MediaContentType,
  type MessageId,
  type PaginationDirection,
  type UserId,
} from '@rook/contracts';
import { z } from 'zod';

/**
 * The typed HTTP client.
 *
 * Every response is parsed against the shared contract schema before it
 * reaches the UI. That is not belt-and-braces: it means a server change that
 * breaks the contract surfaces here, once, with a clear message — instead of
 * as `undefined` deep inside a component three renders later.
 *
 * Errors are normalised into `ApiRequestError`, which carries the contract's
 * `ErrorCode`. Components branch on that code, never on a message string or a
 * raw status.
 */

export class ApiRequestError extends Error {
  readonly code: ErrorCode | 'network_error' | 'invalid_response';
  readonly status: number;
  readonly fields: readonly FieldError[];
  readonly retryAfterSeconds: number | undefined;
  readonly requestId: string | undefined;

  constructor(options: {
    code: ErrorCode | 'network_error' | 'invalid_response';
    message: string;
    status?: number;
    fields?: readonly FieldError[];
    retryAfterSeconds?: number;
    requestId?: string;
    cause?: unknown;
  }) {
    super(options.message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'ApiRequestError';
    this.code = options.code;
    this.status = options.status ?? 0;
    this.fields = options.fields ?? [];
    this.retryAfterSeconds = options.retryAfterSeconds;
    this.requestId = options.requestId;
  }

  /** True when the session is gone and the user must sign in again. */
  get isAuthFailure(): boolean {
    return (
      this.code === 'unauthenticated' ||
      this.code === 'session_expired' ||
      this.code === 'invalid_credentials'
    );
  }

  /** Field errors keyed by path, for rendering beside inputs. */
  fieldErrors(): Record<string, string> {
    const result: Record<string, string> = {};
    for (const field of this.fields) {
      result[field.path] ??= field.message;
    }
    return result;
  }
}

export interface ApiClientOptions {
  /**
   * Read per request, not captured: the user can change the server address at
   * runtime, and the client must follow without being rebuilt.
   */
  readonly getBaseUrl: () => string;
  /** Returns the current token, or undefined when signed out. */
  readonly getToken: () => string | undefined;
  /** Called when the server rejects the token, so the app can sign out. */
  readonly onAuthFailure?: () => void;
}

interface RequestOptions<Schema extends z.ZodType> {
  readonly method: 'GET' | 'POST' | 'PATCH' | 'DELETE';
  readonly path: string;
  readonly schema: Schema;
  readonly body?: unknown;
  readonly signal?: AbortSignal | undefined;
  /** Set false for endpoints that must work while signed out. */
  readonly authenticated?: boolean;
}

export function createApiClient(options: ApiClientOptions) {
  const { getBaseUrl, getToken, onAuthFailure } = options;

  async function request<Schema extends z.ZodType>(
    config: RequestOptions<Schema>,
  ): Promise<z.output<Schema>> {
    const headers: Record<string, string> = { accept: 'application/json' };

    if (config.body !== undefined) {
      headers['content-type'] = 'application/json';
    }

    if (config.authenticated !== false) {
      const token = getToken();
      if (token !== undefined) {
        headers['authorization'] = `Bearer ${token}`;
      }
    }

    let response: Response;
    try {
      response = await fetch(`${getBaseUrl()}${config.path}`, {
        method: config.method,
        headers,
        ...(config.body !== undefined ? { body: JSON.stringify(config.body) } : {}),
        ...(config.signal !== undefined ? { signal: config.signal } : {}),
      });
    } catch (error) {
      // The API is unreachable: offline, wrong port, service down. Reported
      // as a distinct code so the UI can say "cannot reach Rook" rather than
      // inventing a server error.
      throw new ApiRequestError({
        code: 'network_error',
        message: 'Could not reach the server. Check your connection and try again.',
        cause: error,
      });
    }

    // 204 carries no body, so there is nothing to parse.
    if (response.status === 204) {
      return undefined as z.output<Schema>;
    }

    const text = await response.text();
    let payload: unknown;
    try {
      payload = text.length > 0 ? JSON.parse(text) : undefined;
    } catch (error) {
      throw new ApiRequestError({
        code: 'invalid_response',
        message: 'The server sent a response that could not be read.',
        status: response.status,
        cause: error,
      });
    }

    if (!response.ok) {
      const parsed = apiErrorSchema.safeParse(payload);

      if (parsed.success) {
        const { error } = parsed.data;
        const apiError = new ApiRequestError({
          code: error.code,
          message: error.message,
          status: response.status,
          ...(error.fields !== undefined ? { fields: error.fields } : {}),
          ...(error.retryAfterSeconds !== undefined
            ? { retryAfterSeconds: error.retryAfterSeconds }
            : {}),
          ...(error.requestId !== undefined ? { requestId: error.requestId } : {}),
        });

        // Centralised sign-out: every caller would otherwise need to handle
        // a revoked session, and one that forgot would leave the app stuck.
        if (apiError.isAuthFailure && config.authenticated !== false) {
          onAuthFailure?.();
        }

        throw apiError;
      }

      // An error response that does not match the envelope, e.g. from a proxy.
      throw new ApiRequestError({
        code: 'invalid_response',
        message: `The server returned an unexpected ${response.status} response.`,
        status: response.status,
      });
    }

    const parsed = config.schema.safeParse(payload);
    if (!parsed.success) {
      // A contract mismatch. Logged with the detail, surfaced as something a
      // user can act on.
      console.error('Response failed contract validation', {
        path: config.path,
        issues: parsed.error.issues,
      });

      throw new ApiRequestError({
        code: 'invalid_response',
        message: 'The server sent unexpected data. It may be running a different version.',
        status: response.status,
      });
    }

    return parsed.data;
  }

  return {
    // --- Auth -------------------------------------------------------------
    register: (input: {
      username: string;
      email: string;
      password: string;
      displayName?: string;
    }) =>
      request({
        method: 'POST',
        path: '/v1/auth/register',
        schema: sessionResponseSchema,
        body: input,
        authenticated: false,
      }),

    login: (input: { identifier: string; password: string }) =>
      request({
        method: 'POST',
        path: '/v1/auth/login',
        schema: sessionResponseSchema,
        body: input,
        authenticated: false,
      }),

    logout: () =>
      request({
        method: 'POST',
        path: '/v1/auth/logout',
        // 204, so nothing to validate.
        schema: currentUserResponseSchema.optional(),
      }),

    me: (signal?: AbortSignal) =>
      request({
        method: 'GET',
        path: '/v1/auth/me',
        schema: currentUserResponseSchema,
        signal,
      }),

    updateProfile: (input: { displayName?: string; avatarAssetId?: string | null }) =>
      request({
        method: 'PATCH',
        path: '/v1/auth/me',
        schema: currentUserResponseSchema,
        body: input,
      }),

    // --- Communities ------------------------------------------------------
    listCommunities: (signal?: AbortSignal) =>
      request({
        method: 'GET',
        path: '/v1/communities',
        schema: communityListResponseSchema,
        signal,
      }),

    createCommunity: (input: { name: string }) =>
      request({
        method: 'POST',
        path: '/v1/communities',
        schema: communityResponseSchema,
        body: input,
      }),

    joinCommunity: (input: { joinCode: string }) =>
      request({
        method: 'POST',
        path: '/v1/communities/join',
        schema: communityResponseSchema,
        body: input,
      }),

    listChannels: (communityId: CommunityId, signal?: AbortSignal) =>
      request({
        method: 'GET',
        path: `/v1/communities/${communityId}/channels`,
        schema: channelListResponseSchema,
        signal,
      }),

    createChannel: (communityId: CommunityId, input: { name: string; topic?: string }) =>
      request({
        method: 'POST',
        path: `/v1/communities/${communityId}/channels`,
        schema: channelResponseSchema,
        body: input,
      }),

    listMembers: (communityId: CommunityId, cursor?: string, signal?: AbortSignal) =>
      request({
        method: 'GET',
        path: `/v1/communities/${communityId}/members${
          cursor !== undefined ? `?cursor=${encodeURIComponent(cursor)}` : ''
        }`,
        schema: memberListResponseSchema,
        signal,
      }),

    /**
     * Categories and channels in one call.
     *
     * The sidebar cannot draw either alone, so this is what it uses rather
     * than `listChannels` plus `listCategories`.
     */
    getChannelTree: (communityId: CommunityId, signal?: AbortSignal) =>
      request({
        method: 'GET',
        path: `/v1/communities/${communityId}/channel-tree`,
        schema: channelTreeResponseSchema,
        signal,
      }),

    // --- Categories -------------------------------------------------------
    listCategories: (communityId: CommunityId, signal?: AbortSignal) =>
      request({
        method: 'GET',
        path: `/v1/communities/${communityId}/categories`,
        schema: categoryListResponseSchema,
        signal,
      }),

    createCategory: (communityId: CommunityId, input: { name: string }) =>
      request({
        method: 'POST',
        path: `/v1/communities/${communityId}/categories`,
        schema: categoryResponseSchema,
        body: input,
      }),

    updateCategory: (
      communityId: CommunityId,
      categoryId: CategoryId,
      input: { name?: string; position?: number },
    ) =>
      request({
        method: 'PATCH',
        path: `/v1/communities/${communityId}/categories/${categoryId}`,
        schema: categoryResponseSchema,
        body: input,
      }),

    deleteCategory: (communityId: CommunityId, categoryId: CategoryId) =>
      request({
        method: 'DELETE',
        path: `/v1/communities/${communityId}/categories/${categoryId}`,
        schema: z.object({ categoryId: z.string() }),
      }),

    reorderCategories: (communityId: CommunityId, categoryIds: readonly CategoryId[]) =>
      request({
        method: 'POST',
        path: `/v1/communities/${communityId}/categories/reorder`,
        // 204, so there is nothing to validate.
        schema: z.undefined(),
        body: { categoryIds },
      }),

    // --- Channel structure ------------------------------------------------
    updateChannel: (
      communityId: CommunityId,
      channelId: ChannelId,
      input: {
        name?: string;
        topic?: string | null;
        categoryId?: CategoryId | null;
        position?: number;
      },
    ) =>
      request({
        method: 'PATCH',
        path: `/v1/communities/${communityId}/channels/${channelId}`,
        schema: channelResponseSchema,
        body: input,
      }),

    deleteChannel: (communityId: CommunityId, channelId: ChannelId) =>
      request({
        method: 'DELETE',
        path: `/v1/communities/${communityId}/channels/${channelId}`,
        schema: z.object({ channelId: z.string() }),
      }),

    reorderChannels: (
      communityId: CommunityId,
      channels: readonly {
        channelId: ChannelId;
        categoryId: CategoryId | null;
        position: number;
      }[],
    ) =>
      request({
        method: 'POST',
        path: `/v1/communities/${communityId}/channels/reorder`,
        schema: z.undefined(),
        body: { channels },
      }),

    // --- Roles and membership ---------------------------------------------
    setMemberRole: (communityId: CommunityId, userId: UserId, role: AssignableRole) =>
      request({
        method: 'PATCH',
        path: `/v1/communities/${communityId}/members/${userId}`,
        schema: memberResponseSchema,
        body: { role },
      }),

    removeMember: (communityId: CommunityId, userId: UserId) =>
      request({
        method: 'DELETE',
        path: `/v1/communities/${communityId}/members/${userId}`,
        schema: removeMemberResponseSchema,
      }),

    // --- Invites -----------------------------------------------------------
    listInvites: (communityId: CommunityId, signal?: AbortSignal) =>
      request({
        method: 'GET',
        path: `/v1/communities/${communityId}/invites`,
        schema: inviteListResponseSchema,
        signal,
      }),

    createInvite: (
      communityId: CommunityId,
      input: { expiresIn: InviteDuration; maxUses?: number },
    ) =>
      request({
        method: 'POST',
        path: `/v1/communities/${communityId}/invites`,
        schema: inviteResponseSchema,
        body: input,
      }),

    revokeInvite: (communityId: CommunityId, inviteId: InviteId) =>
      request({
        method: 'DELETE',
        path: `/v1/communities/${communityId}/invites/${inviteId}`,
        schema: inviteResponseSchema,
      }),

    previewInvite: (code: string, signal?: AbortSignal) =>
      request({
        method: 'GET',
        path: `/v1/invites/${encodeURIComponent(code)}`,
        schema: invitePreviewResponseSchema,
        signal,
      }),

    acceptInvite: (code: string) =>
      request({
        method: 'POST',
        path: '/v1/invites/accept',
        schema: acceptInviteResponseSchema,
        body: { code },
      }),

    // --- Audit log ---------------------------------------------------------
    listAuditLog: (
      communityId: CommunityId,
      params: { cursor?: string; limit?: number; action?: AuditAction; actorId?: string } = {},
      signal?: AbortSignal,
    ) => {
      const query = new URLSearchParams();
      if (params.cursor !== undefined) query.set('cursor', params.cursor);
      if (params.limit !== undefined) query.set('limit', String(params.limit));
      if (params.action !== undefined) query.set('action', params.action);
      if (params.actorId !== undefined) query.set('actorId', params.actorId);

      const suffix = query.size > 0 ? `?${query.toString()}` : '';

      return request({
        method: 'GET',
        path: `/v1/communities/${communityId}/audit-log${suffix}`,
        schema: auditLogResponseSchema,
        signal,
      });
    },

    // --- Read state --------------------------------------------------------
    getUnread: (signal?: AbortSignal) =>
      request({
        method: 'GET',
        path: '/v1/unread',
        schema: unreadSummaryResponseSchema,
        signal,
      }),

    markChannelRead: (channelId: ChannelId, lastReadMessageId: MessageId) =>
      request({
        method: 'POST',
        path: `/v1/channels/${channelId}/read`,
        schema: markReadResponseSchema,
        body: { lastReadMessageId },
      }),

    setChannelMuted: (channelId: ChannelId, muted: boolean) =>
      request({
        method: 'POST',
        path: `/v1/channels/${channelId}/mute`,
        schema: markReadResponseSchema,
        body: { muted },
      }),

    // --- Messages ---------------------------------------------------------
    listMessages: (
      channelId: ChannelId,
      params: { cursor?: string; direction?: PaginationDirection; limit?: number } = {},
      signal?: AbortSignal,
    ) => {
      const query = new URLSearchParams();
      if (params.cursor !== undefined) query.set('cursor', params.cursor);
      if (params.direction !== undefined) query.set('direction', params.direction);
      if (params.limit !== undefined) query.set('limit', String(params.limit));

      const suffix = query.size > 0 ? `?${query.toString()}` : '';

      return request({
        method: 'GET',
        path: `/v1/channels/${channelId}/messages${suffix}`,
        schema: messagePageResponseSchema,
        signal,
      });
    },

    sendMessage: (
      channelId: ChannelId,
      input: { content?: string; attachmentIds?: string[]; idempotencyKey: string },
    ) =>
      request({
        method: 'POST',
        path: `/v1/channels/${channelId}/messages`,
        schema: messageResponseSchema,
        body: input,
      }),

    editMessage: (messageId: MessageId, input: { content: string }) =>
      request({
        method: 'PATCH',
        path: `/v1/messages/${messageId}`,
        schema: messageResponseSchema,
        body: input,
      }),

    deleteMessage: (messageId: MessageId) =>
      request({
        method: 'DELETE',
        path: `/v1/messages/${messageId}`,
        schema: messageResponseSchema.partial(),
      }),

    // --- Media ------------------------------------------------------------
    authorizeUpload: (input: {
      declaredContentType: MediaContentType;
      declaredByteSize: number;
      filename?: string;
    }) =>
      request({
        method: 'POST',
        path: '/v1/media/uploads',
        schema: createUploadResponseSchema,
        body: input,
      }),

    confirmUpload: (assetId: MediaAssetId) =>
      request({
        method: 'POST',
        path: `/v1/media/uploads/${assetId}/confirm`,
        schema: confirmUploadResponseSchema,
      }),

    getMedia: (assetId: MediaAssetId, signal?: AbortSignal) =>
      request({
        method: 'GET',
        path: `/v1/media/${assetId}`,
        schema: mediaAssetResponseSchema,
        signal,
      }),
  };
}

export type ApiClient = ReturnType<typeof createApiClient>;

/**
 * Uploads a file straight to object storage using a presigned URL.
 *
 * Deliberately a plain `fetch` with no Authorization header: the signature in
 * the URL *is* the credential, and attaching our session token would leak it
 * to the storage provider.
 */
export async function uploadToStorage(options: {
  uploadUrl: string;
  requiredHeaders: Record<string, string>;
  file: Blob;
  signal?: AbortSignal;
}): Promise<void> {
  const response = await fetch(options.uploadUrl, {
    method: 'PUT',
    headers: options.requiredHeaders,
    body: options.file,
    ...(options.signal !== undefined ? { signal: options.signal } : {}),
  });

  if (!response.ok) {
    throw new ApiRequestError({
      code: 'internal_error',
      message: `The upload was rejected by storage (${response.status}).`,
      status: response.status,
    });
  }
}
