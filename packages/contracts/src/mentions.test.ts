import { describe, expect, it } from 'vitest';
import { limits } from './primitives.js';
import { parseMentions, resolveMentionNames, segmentContent } from './mentions.js';

/**
 * Mention parsing.
 *
 * This tokeniser decides who gets notified *and* what the client highlights,
 * so the cases below are not style checks — each one is a way the two could
 * disagree, or a way a message could notify someone it does not visibly
 * mention.
 */

describe('parseMentions', () => {
  it('finds a plain mention', () => {
    const tokens = parseMentions('hello @ada');

    expect(tokens).toHaveLength(1);
    expect(tokens[0]).toMatchObject({ name: 'ada', kind: 'user', raw: '@ada' });
  });

  it('reports offsets that slice back to the matched text', () => {
    const content = 'hey @ada look';
    const token = parseMentions(content)[0];

    expect(token).toBeDefined();
    // The renderer slices around these, so an off-by-one here shows up as a
    // highlight covering the wrong characters.
    expect(content.slice(token?.start, token?.end)).toBe('@ada');
  });

  it('recognises @everyone as its own kind', () => {
    expect(parseMentions('@everyone standup')[0]).toMatchObject({
      name: 'everyone',
      kind: 'everyone',
    });
  });

  it('does not treat an email address as a mention', () => {
    // The guard before the `@` is the whole reason this does not match: a
    // message containing someone's email must not notify the user whose
    // username happens to be the domain.
    expect(parseMentions('write to ada@example.com')).toHaveLength(0);
  });

  it('finds two adjacent mentions', () => {
    // The scan has to resume at the end of the name rather than the end of the
    // whole match, or the second mention is swallowed by the first's guard.
    const names = parseMentions('@ada@grace').map((token) => token.name);
    expect(names).toEqual(['ada', 'grace']);
  });

  it('leaves a trailing full stop as punctuation', () => {
    const token = parseMentions('ask @ada.')[0];
    expect(token?.name).toBe('ada');
    expect(token?.raw).toBe('@ada');
  });

  it('keeps an interior period, which is a legal username character', () => {
    expect(parseMentions('@ada.lovelace hi')[0]?.name).toBe('ada.lovelace');
  });

  it('finds a mention at the very start of the message', () => {
    expect(parseMentions('@ada hi')[0]?.name).toBe('ada');
  });

  it('matches case-insensitively and reports the lowercased name', () => {
    // Usernames are stored lowercased, so a mention typed in mixed case has to
    // resolve to the same person.
    expect(parseMentions('@Ada hi')[0]?.name).toBe('ada');
  });

  it('ignores a bare @ with no name', () => {
    expect(parseMentions('what @ ?')).toHaveLength(0);
  });

  it('returns each occurrence, so a renderer can highlight all of them', () => {
    expect(parseMentions('@ada and @ada again')).toHaveLength(2);
  });
});

describe('resolveMentionNames', () => {
  it('de-duplicates names', () => {
    // The server writes one row per mentioned user, so duplicates in the text
    // must collapse before the insert.
    expect(resolveMentionNames('@ada @ada @grace')).toEqual({
      usernames: ['ada', 'grace'],
      everyone: false,
    });
  });

  it('reports @everyone separately from named mentions', () => {
    expect(resolveMentionNames('@everyone and @ada')).toEqual({
      usernames: ['ada'],
      everyone: true,
    });
  });

  it('handles null content, which is what a deleted message holds', () => {
    expect(resolveMentionNames(null)).toEqual({ usernames: [], everyone: false });
  });

  it('caps the number of distinct mentions', () => {
    // Without the cap, one message could write a mention row per member of a
    // large community and badge everyone at once.
    const many = Array.from({ length: limits.mentionsPerMessage + 10 }, (_, index) => `@u${index}`);
    const resolved = resolveMentionNames(many.join(' '));

    expect(resolved.usernames).toHaveLength(limits.mentionsPerMessage);
  });

  it('still reports @everyone when the named cap is reached', () => {
    // `@everyone` does not consume a slot, because it writes no mention rows —
    // dropping it because the message also named 20 people would silently
    // change what the message does.
    const many = Array.from({ length: limits.mentionsPerMessage + 5 }, (_, index) => `@u${index}`);
    const resolved = resolveMentionNames(`${many.join(' ')} @everyone`);

    expect(resolved.everyone).toBe(true);
  });
});

describe('segmentContent', () => {
  it('returns one text segment when there are no mentions', () => {
    expect(segmentContent('just text')).toEqual([{ kind: 'text', text: 'just text' }]);
  });

  it('alternates text and mention segments', () => {
    expect(segmentContent('hi @ada bye')).toEqual([
      { kind: 'text', text: 'hi ' },
      { kind: 'mention', text: '@ada', name: 'ada', everyone: false },
      { kind: 'text', text: ' bye' },
    ]);
  });

  it('reassembles to exactly the original content', () => {
    // The invariant that matters: rendering segments must never add, drop or
    // reorder a character of what the user typed.
    const samples = [
      'hi @ada bye',
      '@ada',
      '@ada@grace',
      'mail ada@example.com and @grace',
      '@everyone\nsecond line @ada.',
      'no mentions at all',
    ];

    for (const sample of samples) {
      const rebuilt = segmentContent(sample)
        .map((segment) => segment.text)
        .join('');
      expect(rebuilt).toBe(sample);
    }
  });

  it('marks @everyone segments', () => {
    const segments = segmentContent('@everyone');
    expect(segments[0]).toMatchObject({ kind: 'mention', everyone: true });
  });
});
