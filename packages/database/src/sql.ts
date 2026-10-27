/**
 * A minimal tagged-template builder for parameterised SQL.
 *
 * This is not a query builder and deliberately will not become one. It does
 * exactly one job: let a query be written as readable SQL while guaranteeing
 * that every interpolated value becomes a bind parameter.
 *
 *     sql`select * from users where id = ${userId}`
 *     // → { text: 'select * from users where id = $1', values: [userId] }
 *
 * Why this exists rather than hand-numbered placeholders: cursor pagination
 * needs conditional `where` fragments, and hand-maintaining `$1..$7` across
 * branches is how an off-by-one becomes a wrong-row bug or an injection. Here
 * fragments compose and renumber themselves:
 *
 *     const filter = cursor ? sql`and m.id < ${cursor}` : empty;
 *     sql`select ... where m.channel_id = ${channelId} ${filter} limit ${n}`
 *
 * The one escape hatch, `raw`, exists for identifiers that genuinely cannot be
 * parameterised (a sort direction, a table name during partition maintenance).
 * It is the only way to get unparameterised text into a query, which makes
 * auditing trivial: grep for `raw(`.
 */

/** A composable SQL fragment. */
export class SqlFragment {
  /**
   * Alternating literal strings and placeholders. `strings` always has
   * exactly one more entry than `values`.
   */
  constructor(
    readonly strings: readonly string[],
    readonly values: readonly unknown[],
  ) {}

  /** Renders to a `pg`-compatible query, numbering parameters from $1. */
  toQuery(): { text: string; values: unknown[] } {
    const parts: string[] = [];
    const values: unknown[] = [];

    const walk = (fragment: SqlFragment): void => {
      for (let index = 0; index < fragment.strings.length; index += 1) {
        parts.push(fragment.strings[index] ?? '');

        if (index < fragment.values.length) {
          const value = fragment.values[index];

          if (value instanceof SqlFragment) {
            // Nested fragment: splice it in so its own placeholders are
            // renumbered within the final query.
            walk(value);
          } else if (value instanceof RawSql) {
            parts.push(value.text);
          } else {
            values.push(value);
            parts.push(`$${values.length}`);
          }
        }
      }
    };

    walk(this);

    return { text: parts.join(''), values };
  }
}

/**
 * Unparameterised SQL text.
 *
 * Only ever construct this from a literal or a value validated against a
 * closed allow-list. Never from user input.
 */
export class RawSql {
  constructor(readonly text: string) {}
}

export function sql(strings: TemplateStringsArray, ...values: unknown[]): SqlFragment {
  return new SqlFragment(strings, values);
}

/**
 * Marks text as literal SQL, bypassing parameterisation.
 *
 * Used for identifiers and keywords that the protocol cannot bind, such as
 * `asc`/`desc`. Callers must pick the value from a fixed set in code — see
 * `sortDirection` below for the pattern.
 */
export function raw(text: string): RawSql {
  return new RawSql(text);
}

/** An empty fragment, for the "no extra condition" branch. */
export const empty: SqlFragment = new SqlFragment([''], []);

/**
 * The only sort directions the codebase may use.
 *
 * Returning a `RawSql` from a closed map means a direction can never arrive
 * from a request and reach the query as text.
 */
const sortDirections = {
  asc: new RawSql('asc'),
  desc: new RawSql('desc'),
} as const;

export function sortDirection(direction: 'asc' | 'desc'): RawSql {
  return sortDirections[direction];
}

/** Joins fragments with a separator, skipping empty ones. */
export function join(fragments: readonly SqlFragment[], separator = ' and '): SqlFragment {
  const meaningful = fragments.filter(
    (fragment) => fragment.strings.some((part) => part.trim() !== '') || fragment.values.length > 0,
  );

  if (meaningful.length === 0) return empty;

  // Build a fragment whose literals are the separators and whose values are
  // the nested fragments, which `toQuery` then splices.
  const strings: string[] = [''];
  const values: unknown[] = [];

  meaningful.forEach((fragment, index) => {
    if (index > 0) {
      strings[strings.length - 1] += separator;
    }
    values.push(fragment);
    strings.push('');
  });

  return new SqlFragment(strings, values);
}
