# 0005 -- Hand-written SQL, no ORM

**Status:** accepted
**Date:** 2026-10-27

## Context

The data layer needed a query approach. The candidates were an ORM (Prisma,
TypeORM), a typed query builder (Drizzle, Kysely), or SQL written by hand
behind a repository layer.

## Decision

Hand-written SQL in repository modules, composed through a small
tagged-template helper, with plain `.sql` migration files applied by an
in-repo migrator.

```ts
sql`select ${raw(columns.user)} from users u where u.id = ${id}`;
// -> { text: 'select u.id, ... from users u where u.id = $1', values: [id] }
```

## Why

**The query shapes are the design.** The decisions that make this schema work
are expressed in SQL and nowhere else:

- `(channel_id, id desc)` serving cursor pagination with a backwards index
  scan that seeks straight to the cursor.
- Attachments aggregated in a `LATERAL` so they cannot fan out and duplicate
  message rows -- the fix for what would otherwise be an N+1.
- `on conflict do nothing ... returning id` making a send idempotent in one
  statement, with no read-then-write race.
- `for update skip locked` letting several outbox relays share work rather
  than contend.
- Status guards (`where status = 'uploaded'`) acting as the concurrency control
  for media processing.

Most of those are awkward or impossible to express through an ORM, and when one
does emit them it is behind an abstraction that hides what the index is doing.
The spec asks for explicit indexes, no N+1 queries, and short transactions --
all easier to guarantee when the SQL is the thing being reviewed.

**Migrations stay reviewable.** A `.sql` file is the DDL that will run. A
generated migration has to be read back out of a diff to confirm what it does.

**No hidden cost.** There is no lazy loading to trigger accidentally inside a
loop, and no query the framework decides to issue on your behalf.

## Consequences

**No compile-time check that a query matches the schema.** A renamed column
fails at runtime, not at `tsc`. Mitigated by:

- Row types declared beside their mappers in one file, so the expected shape is
  explicit and mapping is a deliberate edit rather than a spread.
- Column lists named once and reused instead of `select *` -- which would also
  pull `password_hash` into memory on every user read.
- Integration tests running every query against a real PostgreSQL, which is
  what actually catches a mismatch. This is where the safety comes from.

**More code.** Each repository method is a few lines of SQL rather than a
chained builder call. Acceptable: those lines are the part worth reading.

**A helper of our own to maintain.** `sql` is about a hundred lines and does
one thing: guarantee that every interpolated value becomes a bind parameter. It
is unit tested for injection safety and for the parameter renumbering that
makes nested fragments safe -- conditional `where` clauses with hand-numbered
`$1..$7` is exactly how an off-by-one becomes a wrong-row bug. `raw()` is the
only route for unparameterised text, which reduces auditing to one grep.

## Alternatives considered

- **Drizzle** -- the closest call. Good inference, SQL-like API, types derived
  from the schema. Rejected because the interesting queries here (`LATERAL`
  aggregates, `skip locked`) would drop to its escape hatch anyway, leaving two
  styles in one codebase.
- **Kysely** -- a builder without schema generation, so it solves less than
  Drizzle while adding the same indirection.
- **Prisma** -- its own schema language and generated client, and historically
  weak at the query shapes above. The strongest objection is that it would own
  the schema, and the schema is where this design lives.
