import { z } from 'zod';

/**
 * Environment variables are always strings, so every numeric or boolean
 * setting needs an explicit, strict coercion. These primitives reject
 * ambiguous input instead of silently falling back to a default, which is how
 * a typo like `LOG_PRETTY=yes` ends up disabling pretty logging in silence.
 */

/** Accepts the spellings people actually write in a .env file. */
export const envBoolean = z
  .string()
  .trim()
  .toLowerCase()
  .pipe(z.enum(['true', 'false', '1', '0', 'yes', 'no']))
  .transform((value) => value === 'true' || value === '1' || value === 'yes');

/**
 * An integer, e.g. a port, a pool size or a millisecond duration.
 *
 * Deliberately stricter than `Number()`: a digits-only pattern rejects values
 * like `"8080 "`, `"1e4"` and `"10MB"` outright rather than quietly producing
 * a number nobody intended.
 */
export const envInt = (options: { min?: number; max?: number } = {}) =>
  z
    .string()
    .trim()
    .regex(/^-?\d+$/u, 'must be an integer (digits only, no units or separators)')
    .transform((value) => Number(value))
    .superRefine((value, ctx) => {
      if (!Number.isSafeInteger(value)) {
        ctx.addIssue({ code: 'custom', message: 'is outside the safe integer range' });
        return;
      }
      if (options.min !== undefined && value < options.min) {
        ctx.addIssue({ code: 'custom', message: `must be at least ${options.min}` });
      }
      if (options.max !== undefined && value > options.max) {
        ctx.addIssue({ code: 'custom', message: `must be at most ${options.max}` });
      }
    });

/** A comma-separated list, trimmed, with empty entries dropped. */
export const envList = z
  .string()
  .transform((value) =>
    value
      .split(',')
      .map((entry) => entry.trim())
      .filter((entry) => entry.length > 0),
  )
  .pipe(z.array(z.string()).min(1, 'must contain at least one entry'));

/** A URL, validated for shape and allowed protocols. */
export const envUrl = (protocols: readonly string[]) =>
  z
    .string()
    .trim()
    .min(1)
    .superRefine((value, ctx) => {
      let parsed: URL;
      try {
        parsed = new URL(value);
      } catch {
        ctx.addIssue({ code: 'custom', message: `must be a valid URL, received "${value}"` });
        return;
      }
      if (!protocols.includes(parsed.protocol)) {
        ctx.addIssue({
          code: 'custom',
          message: `must use one of ${protocols.join(', ')}, received "${parsed.protocol}"`,
        });
      }
    });

export const envSecret = (minLength: number) =>
  z
    .string()
    .min(
      minLength,
      `must be at least ${minLength} characters; generate one with \`openssl rand -base64 48\``,
    );
