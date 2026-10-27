import { z } from 'zod';
import { mediaAssetIdSchema } from '../ids.js';
import { messageSchema } from '../entities/message.js';
import { idempotencyKeySchema, messageContentSchema } from '../primitives.js';

/** Request and response contracts for `/v1/channels/:channelId/messages`. */

/** Attachments per message. Bounded so one send cannot fan out arbitrarily. */
export const maxAttachmentsPerMessage = 10;

export const sendMessageRequestSchema = z
  .object({
    content: messageContentSchema.optional(),
    attachmentIds: z.array(mediaAssetIdSchema).max(maxAttachmentsPerMessage).default([]),
    /**
     * Required, not optional.
     *
     * Making the client always supply a key means a retry after a timeout can
     * never create a second message — and a timeout is precisely when the
     * client does not know whether the first attempt landed. Leaving this
     * optional would make the safe path the one callers forget.
     */
    idempotencyKey: idempotencyKeySchema,
  })
  // A message must carry something. Without this, an empty body plus an empty
  // attachment list would persist a blank row.
  .refine(
    (value) =>
      (value.content !== undefined && value.content.length > 0) || value.attachmentIds.length > 0,
    { error: 'a message needs text, an attachment, or both' },
  );

export type SendMessageRequest = z.infer<typeof sendMessageRequestSchema>;

export const editMessageRequestSchema = z.object({
  content: messageContentSchema,
});

export type EditMessageRequest = z.infer<typeof editMessageRequestSchema>;

export const messageResponseSchema = z.object({
  message: messageSchema,
});

export type MessageResponse = z.infer<typeof messageResponseSchema>;

/**
 * A page of history.
 *
 * Items are returned oldest-first regardless of paging direction, so the
 * client can append or prepend without reversing. `nextCursor` continues in
 * the direction that was requested.
 */
export const messagePageResponseSchema = z.object({
  messages: z.array(messageSchema),
  nextCursor: z.string().nullable(),
  hasMore: z.boolean(),
});

export type MessagePageResponse = z.infer<typeof messagePageResponseSchema>;
