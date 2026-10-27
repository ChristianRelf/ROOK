import { z } from 'zod';
import { currentUserSchema } from '../entities/user.js';
import {
  displayNameSchema,
  isoTimestampSchema,
  passwordSchema,
  usernameSchema,
} from '../primitives.js';

/** Request and response contracts for `/v1/auth/*`. */

export const registerRequestSchema = z.object({
  username: usernameSchema,
  email: z.email().max(254),
  password: passwordSchema,
  /** Defaults to the username when omitted. */
  displayName: displayNameSchema.optional(),
});

export type RegisterRequest = z.infer<typeof registerRequestSchema>;

/**
 * Login accepts either identifier so a user does not have to remember which
 * one they signed up with.
 */
export const loginRequestSchema = z.object({
  identifier: z.string().trim().min(1, 'enter your username or email'),
  password: z.string().min(1, 'enter your password'),
});

export type LoginRequest = z.infer<typeof loginRequestSchema>;

/**
 * The session token is returned in the body rather than set as a cookie.
 *
 * Rook's first client is a desktop app, where cookie handling across the
 * Tauri webview and a separate API origin is awkward and easy to get subtly
 * wrong. A bearer token the client stores deliberately is simpler to reason
 * about, and because sessions are rows in Postgres they stay revocable
 * server-side. See docs/adr/0004-bearer-sessions.md for the trade-offs,
 * including the XSS exposure a cookie with `HttpOnly` would avoid.
 */
export const sessionResponseSchema = z.object({
  token: z.string().min(1),
  expiresAt: isoTimestampSchema,
  user: currentUserSchema,
});

export type SessionResponse = z.infer<typeof sessionResponseSchema>;

export const currentUserResponseSchema = z.object({
  user: currentUserSchema,
});

export type CurrentUserResponse = z.infer<typeof currentUserResponseSchema>;

export const updateProfileRequestSchema = z
  .object({
    displayName: displayNameSchema.optional(),
    /** Explicit null clears the avatar. */
    avatarAssetId: z.uuid().nullable().optional(),
  })
  // Rejects `{}`, which would otherwise be an update that silently does
  // nothing and still returns 200.
  .refine((value) => Object.keys(value).length > 0, {
    error: 'provide at least one field to update',
  });

export type UpdateProfileRequest = z.infer<typeof updateProfileRequestSchema>;
