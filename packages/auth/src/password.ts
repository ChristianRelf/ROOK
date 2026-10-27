import { hash, verify, type Algorithm } from '@node-rs/argon2';
import type { SessionConfig } from '@rook/config';

/**
 * `Algorithm.Argon2id`, written as its literal value.
 *
 * @node-rs/argon2 declares `Algorithm` as an ambient const enum, which cannot
 * be read as a value under `verbatimModuleSyntax` — the enum has no runtime
 * representation to import. The type is imported and the value asserted
 * instead, and `password.test.ts` asserts that the produced hash really does
 * carry the `$argon2id$` prefix, so this stays honest if the library ever
 * renumbers the enum.
 */
const ARGON2ID = 2 as Algorithm;

/**
 * Password hashing with Argon2id.
 *
 * Argon2id rather than bcrypt: it is memory-hard, so attacking it with GPUs or
 * ASICs is far more expensive per guess. bcrypt remains acceptable, but there
 * is no reason to pick it for a new system.
 *
 * Parameters come from configuration so they can be raised without a code
 * change, and the defaults in `.env.example` target roughly 50-100ms per hash
 * on a development machine. The output is a PHC-format string that embeds the
 * salt and the parameters it was created with, which means raising the cost
 * later does not invalidate existing hashes — old passwords keep verifying
 * against their original parameters, and `needsRehash` reports which ones are
 * due for an upgrade on next login.
 */

export interface PasswordHasher {
  hash: (plaintext: string) => Promise<string>;
  /** Constant-time comparison, performed inside Argon2. */
  verify: (plaintext: string, phcHash: string) => Promise<boolean>;
  /** True when a stored hash predates the current cost parameters. */
  needsRehash: (phcHash: string) => boolean;
}

export function createPasswordHasher(config: SessionConfig): PasswordHasher {
  const options = {
    algorithm: ARGON2ID,
    memoryCost: config.argon2.memoryCost,
    timeCost: config.argon2.timeCost,
    parallelism: config.argon2.parallelism,
  } as const;

  return {
    hash(plaintext) {
      return hash(plaintext, options);
    },

    async verify(plaintext, phcHash) {
      try {
        return await verify(phcHash, plaintext, options);
      } catch {
        // A malformed or truncated hash must read as "wrong password", not as
        // a 500. Throwing here would also let an attacker distinguish a
        // corrupt record from an incorrect password.
        return false;
      }
    },

    needsRehash(phcHash) {
      const parsed = parsePhcParameters(phcHash);
      if (parsed === undefined) {
        // Unparseable: treat as needing a rehash so it gets replaced on the
        // next successful login.
        return true;
      }

      return (
        parsed.memoryCost < config.argon2.memoryCost ||
        parsed.timeCost < config.argon2.timeCost ||
        parsed.parallelism < config.argon2.parallelism
      );
    },
  };
}

/**
 * Reads the cost parameters out of a PHC string.
 *
 * Format: `$argon2id$v=19$m=19456,t=2,p=1$<salt>$<hash>`
 */
export function parsePhcParameters(
  phcHash: string,
): { memoryCost: number; timeCost: number; parallelism: number } | undefined {
  const match = /\$m=(\d+),t=(\d+),p=(\d+)\$/u.exec(phcHash);
  if (match === null) return undefined;

  const [, memory, time, parallel] = match;
  if (memory === undefined || time === undefined || parallel === undefined) return undefined;

  return {
    memoryCost: Number.parseInt(memory, 10),
    timeCost: Number.parseInt(time, 10),
    parallelism: Number.parseInt(parallel, 10),
  };
}

/**
 * A hash of a fixed dummy password, used to equalise login timing.
 *
 * When no account matches the submitted identifier, the handler still performs
 * a verification against this value. Without it, a failed lookup returns in
 * microseconds while a real account takes ~80ms, and that difference alone
 * tells an attacker which usernames exist — the exact leak that collapsing
 * `user_not_found` into `invalid_credentials` was meant to prevent.
 */
export async function createTimingEqualiserHash(hasher: PasswordHasher): Promise<string> {
  return hasher.hash('rook-timing-equaliser-not-a-real-password');
}
