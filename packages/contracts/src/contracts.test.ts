import { describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import {
  channelNameSchema,
  messageContentSchema,
  passwordSchema,
  usernameSchema,
} from './primitives.js';
import { sendMessageRequestSchema } from './http/messages.js';
import { updateProfileRequestSchema } from './http/auth.js';
import { paginationQuerySchema } from './http/pagination.js';
import { clientFrameSchema, identifyFrameSchema } from './events/client-events.js';
import { durableEventTypes, serverEventSchema } from './events/server-events.js';
import { transportChannelFor } from './events/transport.js';
import { errorStatusByCode, errorCodeSchema } from './errors.js';
import { asChannelId, asCommunityId, asUserId } from './ids.js';
import { PROTOCOL_VERSION } from './events/protocol.js';

describe('usernameSchema', () => {
  it('normalises case so one person cannot shadow another', () => {
    // `Ada` and `ada` must not be two accounts, or mentions become ambiguous.
    expect(usernameSchema.parse('AdaLovelace')).toBe('adalovelace');
    expect(usernameSchema.parse('  ada_l  ')).toBe('ada_l');
  });

  it('accepts the documented character set', () => {
    for (const valid of ['ada', 'ada.l', 'ada_l', 'a1b2c3', 'a_b.c1']) {
      expect(usernameSchema.safeParse(valid).success).toBe(true);
    }
  });

  it('rejects characters that would break mentions or display', () => {
    for (const invalid of ['ad', 'a'.repeat(33), 'ada lovelace', 'ada@l', 'ada-l', 'ada!']) {
      expect(usernameSchema.safeParse(invalid).success).toBe(false);
    }
  });

  it('rejects leading, trailing and doubled periods', () => {
    // These are the shapes that make two distinct names look identical.
    for (const invalid of ['.ada', 'ada.', 'ada..l']) {
      expect(usernameSchema.safeParse(invalid).success).toBe(false);
    }
  });
});

describe('passwordSchema', () => {
  it('requires length but imposes no composition rules', () => {
    expect(passwordSchema.safeParse('correct horse battery staple').success).toBe(true);
    expect(passwordSchema.safeParse('short').success).toBe(false);
  });

  it('caps length so hashing cost stays bounded', () => {
    // Without a maximum, a megabyte-long password turns Argon2 into a
    // denial-of-service vector.
    expect(passwordSchema.safeParse('a'.repeat(257)).success).toBe(false);
  });
});

describe('channelNameSchema', () => {
  it('normalises to the #general convention', () => {
    expect(channelNameSchema.parse('General')).toBe('general');
    expect(channelNameSchema.parse(' Off-Topic ')).toBe('off-topic');
  });

  it('rejects spaces and stray hyphens', () => {
    for (const invalid of ['off topic', '-general', 'general-', 'gen_eral', '']) {
      expect(channelNameSchema.safeParse(invalid).success).toBe(false);
    }
  });
});

describe('messageContentSchema', () => {
  it('trims but preserves inner whitespace and newlines', () => {
    expect(messageContentSchema.parse('  hello\n  world  ')).toBe('hello\n  world');
  });

  it('rejects whitespace-only content', () => {
    // Otherwise this persists as a blank row the client renders as an
    // empty bubble.
    for (const blank of ['', '   ', '\n\n', '\t']) {
      expect(messageContentSchema.safeParse(blank).success).toBe(false);
    }
  });

  it('stores content verbatim rather than escaping it', () => {
    // Escaping server-side would double-escape once the client renders it as
    // text. The client is the only layer that decides presentation.
    const raw = '<script>alert(1)</script> & "quotes"';
    expect(messageContentSchema.parse(raw)).toBe(raw);
  });
});

describe('sendMessageRequestSchema', () => {
  const key = randomUUID();

  it('accepts a text-only message', () => {
    const parsed = sendMessageRequestSchema.parse({ content: 'hi', idempotencyKey: key });
    expect(parsed.content).toBe('hi');
    expect(parsed.attachmentIds).toEqual([]);
  });

  it('accepts an attachment-only message', () => {
    const parsed = sendMessageRequestSchema.parse({
      attachmentIds: [randomUUID()],
      idempotencyKey: key,
    });
    expect(parsed.attachmentIds).toHaveLength(1);
  });

  it('rejects a message with neither text nor attachments', () => {
    expect(sendMessageRequestSchema.safeParse({ idempotencyKey: key }).success).toBe(false);
    expect(
      sendMessageRequestSchema.safeParse({ content: '   ', idempotencyKey: key }).success,
    ).toBe(false);
  });

  it('requires an idempotency key', () => {
    // Required, not optional: a retry after a timeout must not be able to
    // create a second message.
    expect(sendMessageRequestSchema.safeParse({ content: 'hi' }).success).toBe(false);
    expect(
      sendMessageRequestSchema.safeParse({ content: 'hi', idempotencyKey: 'not-a-uuid' }).success,
    ).toBe(false);
  });

  it('bounds the attachment count', () => {
    const tooMany = Array.from({ length: 11 }, () => randomUUID());
    expect(
      sendMessageRequestSchema.safeParse({ attachmentIds: tooMany, idempotencyKey: key }).success,
    ).toBe(false);
  });
});

describe('updateProfileRequestSchema', () => {
  it('distinguishes clearing an avatar from leaving it alone', () => {
    // null clears; absent leaves unchanged. Collapsing these would make it
    // impossible to remove an avatar.
    expect(updateProfileRequestSchema.parse({ avatarAssetId: null }).avatarAssetId).toBeNull();
    expect(updateProfileRequestSchema.parse({ displayName: 'Ada' }).avatarAssetId).toBeUndefined();
  });

  it('rejects an empty update', () => {
    expect(updateProfileRequestSchema.safeParse({}).success).toBe(false);
  });
});

describe('paginationQuerySchema', () => {
  it('defaults to walking backwards through history', () => {
    const parsed = paginationQuerySchema.parse({});
    expect(parsed.direction).toBe('before');
    expect(parsed.limit).toBe(50);
  });

  it('coerces a query-string limit and enforces the ceiling', () => {
    expect(paginationQuerySchema.parse({ limit: '25' }).limit).toBe(25);
    // The cap is what stops `?limit=100000` from becoming an unbounded query.
    expect(paginationQuerySchema.safeParse({ limit: '101' }).success).toBe(false);
    expect(paginationQuerySchema.safeParse({ limit: '0' }).success).toBe(false);
  });
});

describe('client frames', () => {
  it('accepts a well-formed identify frame', () => {
    const frame = identifyFrameSchema.parse({
      type: 'identify',
      protocolVersion: PROTOCOL_VERSION,
      token: 'a-session-token',
    });
    expect(frame.channelIds).toEqual([]);
  });

  it('rejects an unsupported protocol version with a clear reason', () => {
    const result = identifyFrameSchema.safeParse({
      type: 'identify',
      protocolVersion: 99,
      token: 'x',
    });
    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.message).toContain('unsupported protocol version');
  });

  it('rejects an unknown frame type', () => {
    // Inbound frames are a trust boundary: anything unrecognised is refused
    // rather than passed to a handler.
    expect(clientFrameSchema.safeParse({ type: 'sendMessage', content: 'hi' }).success).toBe(false);
  });

  it('bounds how many channels one frame may subscribe to', () => {
    const tooMany = Array.from({ length: 201 }, () => randomUUID());
    expect(clientFrameSchema.safeParse({ type: 'subscribe', channelIds: tooMany }).success).toBe(
      false,
    );
    expect(clientFrameSchema.safeParse({ type: 'subscribe', channelIds: [] }).success).toBe(false);
  });
});

describe('server events', () => {
  it('validates a message.deleted event carrying only ids', () => {
    const event = serverEventSchema.parse({
      v: PROTOCOL_VERSION,
      ts: new Date().toISOString(),
      type: 'message.deleted',
      channelId: randomUUID(),
      messageId: randomUUID(),
      deletedAt: new Date().toISOString(),
    });
    expect(event.type).toBe('message.deleted');
    // Deleted content must not travel back over the wire.
    expect(event).not.toHaveProperty('content');
  });

  it('rejects an event from a different protocol version', () => {
    const result = serverEventSchema.safeParse({
      v: 999,
      ts: new Date().toISOString(),
      type: 'heartbeat.ack',
    });
    expect(result.success).toBe(false);
  });

  it('excludes ephemeral events from the durable set', () => {
    // Routing typing indicators through the outbox would mean a database
    // write per keystroke.
    expect(durableEventTypes).not.toContain('typing');
    expect(durableEventTypes).not.toContain('heartbeat.ack');
    expect(durableEventTypes).not.toContain('ready');
    expect(durableEventTypes).toContain('message.created');
  });
});

describe('transport routing', () => {
  it('routes each audience scope to its own Redis channel', () => {
    // The `as*` helpers are the documented way to brand a value already known
    // to be an id. A bare string is correctly rejected by the compiler here,
    // which is the whole point of branding.
    const channelId = asChannelId(randomUUID());
    const communityId = asCommunityId(randomUUID());
    const userId = asUserId(randomUUID());

    expect(transportChannelFor({ scope: 'channel', channelId })).toBe(
      `rook:events:channel:${channelId}`,
    );
    expect(transportChannelFor({ scope: 'community', communityId })).toBe(
      `rook:events:community:${communityId}`,
    );
    expect(transportChannelFor({ scope: 'user', userId })).toBe(`rook:events:user:${userId}`);
  });
});

describe('error contract', () => {
  it('maps every error code to an HTTP status', () => {
    // A code with no mapping would fall through to a 500 at runtime.
    for (const code of errorCodeSchema.options) {
      expect(errorStatusByCode[code], `missing status for ${code}`).toBeGreaterThanOrEqual(400);
    }
  });

  it('does not distinguish a missing account from a wrong password', () => {
    // Keeps login from becoming a username oracle.
    const codes: string[] = [...errorCodeSchema.options];
    expect(codes).toContain('invalid_credentials');
    expect(codes).not.toContain('user_not_found');
  });
});
