import { describe, expect, it } from 'vitest';
import type { SessionConfig } from '@rook/config';
import { createPasswordHasher, parsePhcParameters } from './password.js';
import { createSessionTokenService, generateJoinCode, parseBearerToken } from './tokens.js';
import {
  can,
  canDeleteMessage,
  canEditMessage,
  capabilitiesFor,
  hasAtLeastRole,
} from './authorization.js';

/**
 * Argon2 parameters are reduced well below the production defaults so the
 * suite stays fast. Correctness of the wiring is what is under test here, not
 * the cost factor.
 */
const testConfig: SessionConfig = {
  ttlSeconds: 3600,
  tokenPepper: 'test-pepper-at-least-thirty-two-chars-long',
  argon2: { memoryCost: 8192, timeCost: 1, parallelism: 1 },
};

describe('password hashing', () => {
  const hasher = createPasswordHasher(testConfig);

  it('produces an Argon2id PHC string', async () => {
    const hash = await hasher.hash('correct horse battery staple');

    // Pins the algorithm rather than trusting the library default, since the
    // variant is asserted from a literal in password.ts.
    expect(hash.startsWith('$argon2id$')).toBe(true);
    expect(hash).toContain('m=8192,t=1,p=1');
  });

  it('verifies a correct password and rejects a wrong one', async () => {
    const hash = await hasher.hash('correct horse battery staple');

    await expect(hasher.verify('correct horse battery staple', hash)).resolves.toBe(true);
    await expect(hasher.verify('Correct horse battery staple', hash)).resolves.toBe(false);
    await expect(hasher.verify('', hash)).resolves.toBe(false);
  });

  it('salts each hash, so identical passwords differ', async () => {
    const [first, second] = await Promise.all([
      hasher.hash('same password'),
      hasher.hash('same password'),
    ]);

    // Without per-hash salts, identical passwords would be visibly identical
    // in a database dump.
    expect(first).not.toBe(second);
    await expect(hasher.verify('same password', first)).resolves.toBe(true);
    await expect(hasher.verify('same password', second)).resolves.toBe(true);
  });

  it('treats a malformed hash as a failed verification, not an error', async () => {
    // A corrupt row must read as "wrong password". Throwing would surface as a
    // 500 and would also let an attacker distinguish corrupt from incorrect.
    for (const malformed of ['', 'not-a-hash', '$argon2id$garbage']) {
      await expect(hasher.verify('anything', malformed)).resolves.toBe(false);
    }
  });

  it('reports when a stored hash predates the current cost parameters', async () => {
    const weakHasher = createPasswordHasher({
      ...testConfig,
      argon2: { memoryCost: 8192, timeCost: 1, parallelism: 1 },
    });
    const weakHash = await weakHasher.hash('password to upgrade');

    const strongHasher = createPasswordHasher({
      ...testConfig,
      argon2: { memoryCost: 19_456, timeCost: 3, parallelism: 1 },
    });

    expect(strongHasher.needsRehash(weakHash)).toBe(true);
    // And the old hash still verifies, so raising the cost cannot lock
    // existing users out.
    await expect(strongHasher.verify('password to upgrade', weakHash)).resolves.toBe(true);
  });

  it('does not ask for a rehash at the current parameters', async () => {
    const hash = await hasher.hash('current');
    expect(hasher.needsRehash(hash)).toBe(false);
  });

  it('treats an unparseable hash as needing a rehash', () => {
    expect(hasher.needsRehash('nonsense')).toBe(true);
  });
});

describe('parsePhcParameters', () => {
  it('reads cost parameters out of a PHC string', () => {
    const parsed = parsePhcParameters('$argon2id$v=19$m=19456,t=2,p=1$c29tZXNhbHQ$aGFzaA');
    expect(parsed).toEqual({ memoryCost: 19_456, timeCost: 2, parallelism: 1 });
  });

  it('returns undefined for anything else', () => {
    expect(parsePhcParameters('$2b$12$bcrypthash')).toBeUndefined();
  });
});

describe('session tokens', () => {
  const tokens = createSessionTokenService(testConfig);

  it('issues a high-entropy token with its storage hash', () => {
    const { token, tokenHash } = tokens.issue();

    // 32 random bytes, base64url encoded, unpadded.
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/u);
    expect(tokenHash).toHaveLength(32);
  });

  it('never repeats a token', () => {
    const issued = new Set(Array.from({ length: 200 }, () => tokens.issue().token));
    expect(issued.size).toBe(200);
  });

  it('hashes deterministically, so a presented token can be looked up', () => {
    const { token, tokenHash } = tokens.issue();
    expect(tokens.hashToken(token).equals(tokenHash)).toBe(true);
  });

  it('produces a different hash under a different pepper', () => {
    // The property that makes a stolen database dump useless on its own.
    const other = createSessionTokenService({
      ...testConfig,
      tokenPepper: 'a-completely-different-pepper-value-here',
    });

    const { token, tokenHash } = tokens.issue();
    expect(other.hashToken(token).equals(tokenHash)).toBe(false);
  });

  it('does not store the raw token anywhere in the hash', () => {
    const { token, tokenHash } = tokens.issue();
    expect(tokenHash.toString('utf8')).not.toContain(token);
    expect(tokenHash.toString('hex')).not.toContain(Buffer.from(token).toString('hex'));
  });

  it('compares hashes without throwing on a length mismatch', () => {
    const { tokenHash } = tokens.issue();
    expect(tokens.matches(tokenHash, tokenHash)).toBe(true);
    expect(tokens.matches(tokenHash, Buffer.alloc(8))).toBe(false);
  });

  it('computes expiry from the configured TTL', () => {
    const from = new Date('2026-01-01T00:00:00.000Z');
    expect(tokens.expiresAt(from).toISOString()).toBe('2026-01-01T01:00:00.000Z');
  });
});

describe('parseBearerToken', () => {
  it('extracts a well-formed bearer token', () => {
    expect(parseBearerToken('Bearer abc123_-')).toBe('abc123_-');
    expect(parseBearerToken('  Bearer abc123  ')).toBe('abc123');
  });

  it('rejects anything that is not exactly a bearer scheme', () => {
    // Guessing at a malformed header is how a token ends up read from the
    // wrong place; these all fail as unauthenticated instead.
    for (const header of [
      undefined,
      '',
      'abc123',
      'bearer abc123',
      'Basic dXNlcjpwYXNz',
      'Bearer',
      'Bearer ',
      'Bearer abc 123',
      'Bearer abc"123',
    ]) {
      expect(parseBearerToken(header)).toBeUndefined();
    }
  });
});

describe('generateJoinCode', () => {
  it('produces a readable adjective-noun-digits code', () => {
    for (let index = 0; index < 50; index += 1) {
      expect(generateJoinCode()).toMatch(/^[a-z]+-[a-z]+-\d{4}$/u);
    }
  });

  it('does not produce the same code repeatedly', () => {
    const codes = new Set(Array.from({ length: 100 }, () => generateJoinCode()));
    // Low-entropy by design, but it must not be constant.
    expect(codes.size).toBeGreaterThan(50);
  });
});

describe('role ranking', () => {
  it('orders member below admin below owner', () => {
    expect(hasAtLeastRole('owner', 'admin')).toBe(true);
    expect(hasAtLeastRole('admin', 'admin')).toBe(true);
    expect(hasAtLeastRole('member', 'admin')).toBe(false);
    expect(hasAtLeastRole('admin', 'owner')).toBe(false);
  });
});

describe('capabilities', () => {
  it('lets any member read and send', () => {
    expect(can({ role: 'member' }, 'message:read')).toBe(true);
    expect(can({ role: 'member' }, 'message:send')).toBe(true);
    expect(can({ role: 'member' }, 'channel:create')).toBe(true);
  });

  it('withholds moderation and administration from plain members', () => {
    expect(can({ role: 'member' }, 'message:delete_any')).toBe(false);
    expect(can({ role: 'member' }, 'channel:update')).toBe(false);
    expect(can({ role: 'member' }, 'community:update')).toBe(false);
    expect(can({ role: 'member' }, 'community:delete')).toBe(false);
  });

  it('reserves community deletion for the owner', () => {
    expect(can({ role: 'admin' }, 'community:delete')).toBe(false);
    expect(can({ role: 'owner' }, 'community:delete')).toBe(true);
  });

  it('gives an owner everything an admin has', () => {
    const adminCaps = capabilitiesFor('admin');
    const ownerCaps = capabilitiesFor('owner');

    for (const capability of adminCaps) {
      expect(ownerCaps).toContain(capability);
    }
  });
});

describe('message editing', () => {
  const author = 'user-1';
  const other = 'user-2';

  it('lets an author edit their own live message', () => {
    expect(
      canEditMessage({ role: 'member' }, { authorId: author, viewerId: author, isDeleted: false }),
    ).toBe(true);
  });

  it('never lets anyone edit a message they did not write, whatever their role', () => {
    // An admin rewriting someone else's words would leave the original
    // author's name on text they did not write. Deletion is the moderation
    // tool instead.
    for (const role of ['member', 'admin', 'owner'] as const) {
      expect(
        canEditMessage({ role }, { authorId: author, viewerId: other, isDeleted: false }),
      ).toBe(false);
    }
  });

  it('refuses to edit a deleted message', () => {
    expect(
      canEditMessage({ role: 'owner' }, { authorId: author, viewerId: author, isDeleted: true }),
    ).toBe(false);
  });
});

describe('message deletion', () => {
  const author = 'user-1';
  const other = 'user-2';

  it('lets an author delete their own message', () => {
    expect(
      canDeleteMessage(
        { role: 'member' },
        { authorId: author, viewerId: author, isDeleted: false },
      ),
    ).toBe(true);
  });

  it('lets a moderator delete a message from another member', () => {
    expect(
      canDeleteMessage({ role: 'admin' }, { authorId: author, viewerId: other, isDeleted: false }),
    ).toBe(true);
  });

  it('does not let a plain member delete a message from another member', () => {
    expect(
      canDeleteMessage({ role: 'member' }, { authorId: author, viewerId: other, isDeleted: false }),
    ).toBe(false);
  });

  it('is a no-op on an already deleted message', () => {
    expect(
      canDeleteMessage({ role: 'admin' }, { authorId: author, viewerId: other, isDeleted: true }),
    ).toBe(false);
  });
});
