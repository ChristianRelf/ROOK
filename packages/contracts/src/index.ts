/**
 * `@rook/contracts` — the single source of truth for everything that crosses a
 * process boundary: HTTP request and response bodies, realtime events, and the
 * internal event envelope between the API and the gateways.
 *
 * This package has exactly one runtime dependency (Zod) and imports nothing
 * from the rest of the workspace. That is what makes it safe for the desktop
 * client to depend on: pulling in contracts can never drag server code,
 * database drivers or credentials into the frontend bundle.
 */

export * from './ids.js';
export * from './primitives.js';
export * from './errors.js';

export * from './entities/user.js';
export * from './entities/community.js';
export * from './entities/channel.js';
export * from './entities/message.js';
export * from './entities/media.js';

export * from './http/auth.js';
export * from './http/pagination.js';
export * from './http/communities.js';
export * from './http/messages.js';
export * from './http/media.js';

export * from './events/protocol.js';
export * from './events/client-events.js';
export * from './events/server-events.js';
export * from './events/transport.js';
