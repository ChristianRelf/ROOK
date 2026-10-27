import { z } from 'zod';
import { channelUnreadSchema, unreadSummarySchema } from '../entities/unread.js';
import { messageIdSchema } from '../ids.js';

/** Request and response contracts for read state. */

export const unreadSummaryResponseSchema = unreadSummarySchema;
export type UnreadSummaryResponse = z.infer<typeof unreadSummaryResponseSchema>;

/**
 * Marking a channel read up to a specific message.
 *
 * The message id is required rather than implied as "everything now". The
 * client knows which message is at the bottom of its viewport; the server does
 * not, and "mark everything read as of this instant" would silently clear
 * messages that arrived while the request was in flight but had not yet been
 * rendered.
 */
export const markReadRequestSchema = z.object({
  lastReadMessageId: messageIdSchema,
});

export type MarkReadRequest = z.infer<typeof markReadRequestSchema>;

export const markReadResponseSchema = z.object({
  unread: channelUnreadSchema,
});

export type MarkReadResponse = z.infer<typeof markReadResponseSchema>;

export const muteChannelRequestSchema = z.object({
  muted: z.boolean(),
});

export type MuteChannelRequest = z.infer<typeof muteChannelRequestSchema>;
