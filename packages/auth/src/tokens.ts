import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import type { SessionConfig } from '@rook/config';

/**
 * Session token generation and hashing.
 *
 * A token is 32 bytes from the CSPRNG, base64url-encoded. There is no
 * structure and nothing encoded in it: it is a lookup key, and all authority
 * lives in the database row it points at. That is what makes revocation
 * immediate, unlike a signed token that stays valid until it expires.
 *
 * What is stored is `SHA-256(pepper || token)`:
 *
 *   * **Hashed**, so a leaked database dump does not hand over live sessions.
 *   * **Peppered** with a secret from the environment, so an attacker with the
 *     dump but not the pepper cannot even brute-force short tokens offline.
 *   * **SHA-256, not Argon2** — deliberately. The input is 256 bits of
 *     uniform randomness, not a guessable human password, so there is nothing
 *     for a slow hash to defend against. A per-request Argon2 verification
 *     would add ~80ms to every authenticated call for no security gain.
 */

/** 32 bytes ≈ 256 bits of entropy. Guessing is not a realistic attack. */
const TOKEN_BYTES = 32;

export interface SessionTokenService {
  /** Issues a new token and the hash to store for it. */
  issue: () => { token: string; tokenHash: Buffer };
  /** Hashes a presented token for lookup. */
  hashToken: (token: string) => Buffer;
  /** Constant-time comparison of two hashes. */
  matches: (a: Buffer, b: Buffer) => boolean;
  expiresAt: (from?: Date) => Date;
}

export function createSessionTokenService(config: SessionConfig): SessionTokenService {
  const pepper = Buffer.from(config.tokenPepper, 'utf8');

  function hashToken(token: string): Buffer {
    // Pepper first, then token: prefixing a fixed-length secret avoids the
    // length-extension and ambiguity concerns of appending it.
    return createHash('sha256').update(pepper).update(token, 'utf8').digest();
  }

  return {
    issue() {
      const token = randomBytes(TOKEN_BYTES).toString('base64url');
      return { token, tokenHash: hashToken(token) };
    },

    hashToken,

    matches(a, b) {
      // timingSafeEqual throws on length mismatch, so guard first.
      if (a.length !== b.length) return false;
      return timingSafeEqual(a, b);
    },

    expiresAt(from = new Date()) {
      return new Date(from.getTime() + config.ttlSeconds * 1000);
    },
  };
}

/**
 * Extracts a bearer token from an Authorization header.
 *
 * Strict about the scheme: anything other than exactly `Bearer <token>` is
 * rejected rather than guessed at, so a malformed header fails as
 * unauthenticated instead of being silently misread.
 */
export function parseBearerToken(header: string | undefined): string | undefined {
  if (header === undefined) return undefined;

  const match = /^Bearer (?<token>[A-Za-z0-9._~+/-]+=*)$/u.exec(header.trim());
  const token = match?.groups?.['token'];

  return token === undefined || token.length === 0 ? undefined : token;
}

/**
 * Generates a community join code, e.g. `quiet-harbour-7421`.
 *
 * Word-based so it can be read aloud and typed without ambiguity, with four
 * random digits for collision resistance. The words carry little entropy, so
 * the code is a convenience for sharing, not a security boundary — anyone with
 * it can join, which is exactly what a join code is for. Real invites with
 * expiry and per-use limits are future work.
 */
const codeAdjectives = [
  'amber',
  'brisk',
  'calm',
  'dusky',
  'eager',
  'faint',
  'gentle',
  'hidden',
  'ivory',
  'jolly',
  'keen',
  'lucid',
  'misty',
  'noble',
  'olive',
  'quiet',
  'rapid',
  'silent',
  'tidal',
  'umber',
  'vivid',
  'warm',
  'young',
  'zesty',
] as const;

const codeNouns = [
  'anchor',
  'beacon',
  'canyon',
  'delta',
  'ember',
  'forest',
  'grove',
  'harbour',
  'island',
  'jetty',
  'kettle',
  'lagoon',
  'meadow',
  'needle',
  'orchard',
  'pillar',
  'quarry',
  'ridge',
  'summit',
  'thicket',
  'valley',
  'willow',
  'yonder',
  'zephyr',
] as const;

export function generateJoinCode(): string {
  // randomInt-style selection from the CSPRNG rather than Math.random: the
  // code is low-entropy by design, but it should not also be predictable.
  const bytes = randomBytes(4);
  const adjective = codeAdjectives[bytes[0]! % codeAdjectives.length]!;
  const noun = codeNouns[bytes[1]! % codeNouns.length]!;
  const digits = (((bytes[2]! << 8) | bytes[3]!) % 10_000).toString().padStart(4, '0');

  return `${adjective}-${noun}-${digits}`;
}
