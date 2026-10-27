import { describe, expect, it } from 'vitest';
import { ConfigError, loadApiConfig, loadMigrationConfig } from './index.js';
import { envBoolean, envInt, envList, envUrl } from './primitives.js';

/**
 * A minimal environment that satisfies every section the API validates.
 * Tests clone and mutate this so each case states only what it cares about.
 */
const validApiEnv = {
  NODE_ENV: 'test',
  API_PUBLIC_URL: 'http://127.0.0.1:4000',
  CORS_ALLOWED_ORIGINS: 'http://localhost:1420,tauri://localhost',
  DATABASE_URL: 'postgres://rook:pw@127.0.0.1:5432/rook',
  REDIS_URL: 'redis://127.0.0.1:6379',
  SESSION_TOKEN_PEPPER: 'x'.repeat(32),
  S3_ENDPOINT: 'http://127.0.0.1:4566',
  S3_BUCKET_MEDIA: 'rook-media',
  S3_ACCESS_KEY_ID: 'key',
  S3_SECRET_ACCESS_KEY: 'secret',
} as const;

describe('env primitives', () => {
  it('parses the boolean spellings people actually write', () => {
    for (const truthy of ['true', 'TRUE', '1', 'yes', ' Yes ']) {
      expect(envBoolean.parse(truthy)).toBe(true);
    }
    for (const falsy of ['false', 'FALSE', '0', 'no']) {
      expect(envBoolean.parse(falsy)).toBe(false);
    }
  });

  it('rejects ambiguous booleans rather than defaulting them', () => {
    // The failure mode this guards against: `LOG_PRETTY=on` silently
    // behaving as false.
    for (const ambiguous of ['on', 'off', 'y', '', 'truthy']) {
      expect(envBoolean.safeParse(ambiguous).success).toBe(false);
    }
  });

  it('accepts integers and rejects anything with units or exponents', () => {
    expect(envInt().parse('8080')).toBe(8080);
    expect(envInt().parse(' 42 ')).toBe(42);

    for (const invalid of ['10MB', '1e4', '1_000', '3.5', '', 'eight']) {
      expect(envInt().safeParse(invalid).success).toBe(false);
    }
  });

  it('enforces integer bounds', () => {
    const port = envInt({ min: 1, max: 65_535 });
    expect(port.parse('4000')).toBe(4000);
    expect(port.safeParse('0').success).toBe(false);
    expect(port.safeParse('70000').success).toBe(false);
  });

  it('splits lists and drops blank entries', () => {
    expect(envList.parse('a, b ,,c')).toEqual(['a', 'b', 'c']);
    expect(envList.safeParse('').success).toBe(false);
    expect(envList.safeParse(' , ').success).toBe(false);
  });

  it('constrains URLs to the expected protocols', () => {
    const pg = envUrl(['postgres:', 'postgresql:']);
    expect(pg.parse('postgres://u:p@h:5432/db')).toBe('postgres://u:p@h:5432/db');

    // A Redis URL in DATABASE_URL is a real misconfiguration, not a typo
    // we should tolerate.
    expect(pg.safeParse('redis://127.0.0.1:6379').success).toBe(false);
    expect(pg.safeParse('not-a-url').success).toBe(false);
  });
});

describe('loadApiConfig', () => {
  it('builds a structured config from a valid environment', () => {
    const config = loadApiConfig(validApiEnv);

    expect(config.runtime.nodeEnv).toBe('test');
    expect(config.runtime.isTest).toBe(true);
    expect(config.runtime.isProduction).toBe(false);
    // Seconds in the environment, milliseconds in the application.
    expect(config.runtime.shutdownGraceMs).toBe(15_000);

    expect(config.database.poolMax).toBe(10);
    expect(config.http.corsAllowedOrigins).toEqual(['http://localhost:1420', 'tauri://localhost']);
    expect(config.media.allowedMimeTypes).toContain('image/png');
  });

  it('falls back to the private endpoint when no public one is given', () => {
    const config = loadApiConfig(validApiEnv);
    expect(config.storage.publicEndpoint).toBe(validApiEnv.S3_ENDPOINT);
  });

  it('prefers an explicit public endpoint for presigned URLs', () => {
    const config = loadApiConfig({
      ...validApiEnv,
      S3_PUBLIC_ENDPOINT: 'https://cdn.example.test',
    });
    expect(config.storage.publicEndpoint).toBe('https://cdn.example.test');
    expect(config.storage.endpoint).toBe('http://127.0.0.1:4566');
  });

  it('reports every problem at once instead of only the first', () => {
    let error: unknown;
    try {
      loadApiConfig({
        ...validApiEnv,
        DATABASE_URL: 'not-a-url',
        DATABASE_POOL_MAX: '10MB',
        API_PORT: '0',
      });
    } catch (caught) {
      error = caught;
    }

    expect(error).toBeInstanceOf(ConfigError);
    const { issues } = error as ConfigError;

    // All three bad values appear, each tagged with its section.
    expect(issues.some((i) => i.includes('DATABASE_URL'))).toBe(true);
    expect(issues.some((i) => i.includes('DATABASE_POOL_MAX'))).toBe(true);
    expect(issues.some((i) => i.includes('API_PORT'))).toBe(true);
    expect(issues.some((i) => i.startsWith('[database]'))).toBe(true);
  });

  it('describes an unset required variable as missing', () => {
    const { SESSION_TOKEN_PEPPER: _omitted, ...withoutPepper } = validApiEnv;

    const error = (() => {
      try {
        loadApiConfig(withoutPepper);
        return undefined;
      } catch (caught) {
        return caught as ConfigError;
      }
    })();

    expect(error).toBeInstanceOf(ConfigError);
    expect(error?.issues.some((i) => i.includes('SESSION_TOKEN_PEPPER'))).toBe(true);
  });

  it('refuses a session pepper that is too short to be useful', () => {
    expect(() => loadApiConfig({ ...validApiEnv, SESSION_TOKEN_PEPPER: 'short' })).toThrow(
      ConfigError,
    );
  });
});

describe('loadMigrationConfig', () => {
  it('validates only what migrations need', () => {
    // Deliberately omits S3, Redis and session settings: a migration run must
    // not require credentials it never uses.
    const config = loadMigrationConfig({
      DATABASE_URL: 'postgres://rook:pw@127.0.0.1:5432/rook',
    });

    expect(config.database.url).toContain('postgres://');
    expect(config.database.statementTimeoutMs).toBe(10_000);
  });
});
