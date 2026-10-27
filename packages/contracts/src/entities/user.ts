import { z } from 'zod';
import { mediaAssetIdSchema, userIdSchema } from '../ids.js';
import { displayNameSchema, isoTimestampSchema, usernameSchema } from '../primitives.js';

/**
 * How a user appears on the wire.
 *
 * Two shapes, and the distinction is a security boundary rather than a
 * convenience:
 *
 *   publicUser   what any member of a shared community may see
 *   currentUser  additionally includes the viewer's own private fields
 *
 * The email address lives only on `currentUser`. Returning it inside a member
 * list would leak every member's email to every other member, which is the
 * kind of thing that is easy to do by accident when one type serves both.
 */

export const publicUserSchema = z.object({
  id: userIdSchema,
  username: usernameSchema,
  displayName: displayNameSchema,
  /** Null until the user uploads one; resolved to a URL by the media layer. */
  avatarAssetId: mediaAssetIdSchema.nullable(),
  createdAt: isoTimestampSchema,
});

export type PublicUser = z.infer<typeof publicUserSchema>;

export const currentUserSchema = publicUserSchema.extend({
  email: z.email(),
  updatedAt: isoTimestampSchema,
});

export type CurrentUser = z.infer<typeof currentUserSchema>;
