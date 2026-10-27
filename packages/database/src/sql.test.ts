import { describe, expect, it } from 'vitest';
import { empty, join, raw, sortDirection, sql } from './sql.js';

describe('sql template', () => {
  it('turns every interpolated value into a bind parameter', () => {
    const { text, values } = sql`select * from users where id = ${'u1'}`.toQuery();

    expect(text).toBe('select * from users where id = $1');
    expect(values).toEqual(['u1']);
  });

  it('numbers multiple parameters in order', () => {
    const { text, values } = sql`
      insert into channels (id, name, position) values (${'c1'}, ${'general'}, ${0})
    `.toQuery();

    expect(text).toContain('values ($1, $2, $3)');
    expect(values).toEqual(['c1', 'general', 0]);
  });

  it('parameterises a value that looks like SQL injection', () => {
    // The payload must land in `values`, never in `text`.
    const hostile = "'; drop table messages; --";
    const { text, values } = sql`select * from users where username = ${hostile}`.toQuery();

    expect(text).toBe('select * from users where username = $1');
    expect(text).not.toContain('drop table');
    expect(values).toEqual([hostile]);
  });

  it('renumbers parameters when fragments are nested', () => {
    // The behaviour that makes conditional pagination filters safe: the
    // nested fragment's parameter becomes $2, not a second $1.
    const filter = sql`and m.id < ${'cursor-1'}`;
    const query = sql`select * from messages m where m.channel_id = ${'c1'} ${filter} limit ${50}`;
    const { text, values } = query.toQuery();

    expect(text).toBe('select * from messages m where m.channel_id = $1 and m.id < $2 limit $3');
    expect(values).toEqual(['c1', 'cursor-1', 50]);
  });

  it('nests fragments several levels deep', () => {
    const inner = sql`and a = ${1}`;
    const middle = sql`${inner} and b = ${2}`;
    const outer = sql`where z = ${0} ${middle}`;
    const { text, values } = outer.toQuery();

    expect(text).toBe('where z = $1 and a = $2 and b = $3');
    expect(values).toEqual([0, 1, 2]);
  });

  it('contributes nothing for an empty fragment', () => {
    const { text, values } = sql`select 1 ${empty}`.toQuery();

    expect(text.trim()).toBe('select 1');
    expect(values).toEqual([]);
  });

  it('handles null and undefined as parameters rather than inlining them', () => {
    const { text, values } = sql`update users set avatar_asset_id = ${null}`.toQuery();

    expect(text).toBe('update users set avatar_asset_id = $1');
    expect(values).toEqual([null]);
  });

  it('passes arrays through as a single parameter', () => {
    // Postgres arrays bind as one value; splitting them would break `= any()`.
    const ids = ['a', 'b', 'c'];
    const { text, values } = sql`select * from channels where id = any(${ids})`.toQuery();

    expect(text).toBe('select * from channels where id = any($1)');
    expect(values).toEqual([ids]);
  });
});

describe('raw', () => {
  it('inlines text without parameterising it', () => {
    const { text, values } = sql`select * from m order by id ${raw('desc')}`.toQuery();

    expect(text).toBe('select * from m order by id desc');
    expect(values).toEqual([]);
  });

  it('only yields directions from the closed set', () => {
    expect(sortDirection('asc').text).toBe('asc');
    expect(sortDirection('desc').text).toBe('desc');

    const { text } = sql`order by id ${sortDirection('desc')}`.toQuery();
    expect(text).toBe('order by id desc');
  });
});

describe('join', () => {
  it('combines conditions with a separator', () => {
    const { text, values } = join([sql`a = ${1}`, sql`b = ${2}`]).toQuery();

    expect(text).toBe('a = $1 and b = $2');
    expect(values).toEqual([1, 2]);
  });

  it('skips empty fragments so no dangling separator is produced', () => {
    // The conditional-filter case: `join([always, maybe])` where `maybe` is
    // empty must not emit `a = $1 and`.
    const { text, values } = join([sql`a = ${1}`, empty, sql`c = ${3}`]).toQuery();

    expect(text).toBe('a = $1 and c = $3'.replace('$3', '$2'));
    expect(values).toEqual([1, 3]);
  });

  it('returns an empty fragment when everything is empty', () => {
    const { text, values } = join([empty, empty]).toQuery();

    expect(text.trim()).toBe('');
    expect(values).toEqual([]);
  });

  it('supports a custom separator', () => {
    const { text } = join([sql`a = ${1}`, sql`b = ${2}`], ', ').toQuery();
    expect(text).toBe('a = $1, b = $2');
  });
});
