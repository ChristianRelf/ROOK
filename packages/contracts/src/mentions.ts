import { limits } from './primitives.js';

/**
 * Mention parsing.
 *
 * Lives in contracts, not in the API or the client, because both sides have to
 * agree on it exactly. The server uses it to decide who gets a mention badge;
 * the client uses it to decide which spans to highlight. If those two
 * tokenisers drift, a message renders a highlight nobody was notified about —
 * or notifies someone whose name is not visibly mentioned.
 *
 * The format is the plain `@username` convention rather than an encoded id
 * (`<@01a1...>`). The trade is deliberate:
 *
 *   * **For:** message content stays exactly what the user typed. It is stored
 *     and returned verbatim, is readable in a database dump, and survives a
 *     client that knows nothing about mentions.
 *   * **Against:** a mention does not follow a rename. That is why the message
 *     also carries resolved `mentionedUserIds` — the *notification* is pinned
 *     to the id at write time, and only the rendered text goes stale.
 *
 * Usernames are already constrained to `[a-z0-9._]` with no leading, trailing
 * or doubled periods (see `usernameSchema`), which is what makes a bare
 * `@name` unambiguous to scan for.
 */

/** Mentions everyone in the channel's community. */
export const EVERYONE_MENTION = 'everyone';

/**
 * One mention found in message content.
 *
 * Offsets are into the original string so a renderer can slice around them
 * without re-scanning, and are in UTF-16 code units — the same units
 * `String.prototype.slice` uses.
 */
export interface MentionToken {
  /** The matched text including the `@`, e.g. `@ada`. */
  readonly raw: string;
  /** The name alone, lowercased: a username, or `everyone`. */
  readonly name: string;
  readonly kind: 'user' | 'everyone';
  readonly start: number;
  readonly end: number;
}

/**
 * Matches `@` followed by a username-shaped run.
 *
 * Case-insensitive because usernames are *stored* lowercased, so `@Ada` has to
 * resolve to the same person as `@ada`. The matched name is lowercased below,
 * which is what makes the client's highlight and the server's lookup agree.
 *
 * The pattern itself has no guard against email addresses. That decision is
 * made per candidate in `parseMentions`, because whether a preceding word
 * character disqualifies a match depends on *what* that character belongs to —
 * see the note there.
 */
const MENTION_PATTERN = /@([a-z0-9._]{1,32})/giu;

/** True when `character` could be part of a word, and so of an email address. */
function isWordCharacter(character: string | undefined): boolean {
  return character !== undefined && /[\w]/u.test(character);
}

/**
 * Finds every mention in message content.
 *
 * Returns tokens in the order they appear, with duplicates preserved — a
 * renderer needs each occurrence, while callers that want a set (the server,
 * resolving who to notify) de-duplicate by name themselves.
 *
 * The one subtle rule is which `@` counts. An `@` preceded by a word character
 * is normally part of an email address (`ada@example.com`) and is skipped —
 * otherwise quoting someone's address would notify whoever is named after the
 * domain. But `@ada@grace` is two mentions, and there the second `@` is also
 * preceded by a word character. The two are distinguished by *what* that
 * character belongs to: if the preceding run is a mention this scan just
 * accepted, the `@` starts a new one.
 */
export function parseMentions(content: string): MentionToken[] {
  const tokens: MentionToken[] = [];

  // A fresh RegExp per call: `lastIndex` is mutable state, and sharing one
  // instance across calls would make the second call start mid-string.
  const pattern = new RegExp(MENTION_PATTERN.source, MENTION_PATTERN.flags);
  let match: RegExpExecArray | null;
  /** Where the previously accepted token ended, for the adjacency rule. */
  let previousEnd = -1;

  while ((match = pattern.exec(content)) !== null) {
    const captured = match[1];
    if (captured === undefined) continue;

    const start = match.index;
    const precededByWord = isWordCharacter(content[start - 1]);

    // Part of an email address rather than a mention — unless the word
    // characters before it are the mention we just matched.
    if (precededByWord && start !== previousEnd) continue;

    // Trailing periods belong to the sentence, not the name. `usernameSchema`
    // forbids a username ending in one, so this cannot truncate a real name.
    const name = captured.replace(/\.+$/u, '').toLowerCase();
    if (name.length === 0) continue;

    const end = start + 1 + name.length;

    tokens.push({
      raw: content.slice(start, end),
      name,
      kind: name === EVERYONE_MENTION ? 'everyone' : 'user',
      start,
      end,
    });

    previousEnd = end;
    // Resume at the end of the *name*, not the end of the match: a trimmed
    // trailing period has to be available to the next scan position.
    pattern.lastIndex = end;
  }

  return tokens;
}

/**
 * The distinct usernames a message mentions, plus whether it mentions everyone.
 *
 * Capped at `limits.mentionsPerMessage`. Without a cap, one message listing
 * every member of a large community would write a mention row per member and
 * light up everyone's sidebar — the cheapest available way to make a community
 * unusable, so it is bounded at the parse step rather than at the insert.
 */
export function resolveMentionNames(content: string | null): {
  usernames: string[];
  everyone: boolean;
} {
  if (content === null || content.length === 0) {
    return { usernames: [], everyone: false };
  }

  const seen = new Set<string>();
  let everyone = false;

  for (const token of parseMentions(content)) {
    if (token.kind === 'everyone') {
      everyone = true;
      continue;
    }
    // `continue`, not `break`: the scan has to keep going so an `@everyone`
    // *after* the cap is still seen. Stopping here would silently change what
    // a long message does, which is the worst way to enforce a limit.
    if (seen.size >= limits.mentionsPerMessage) continue;
    seen.add(token.name);
  }

  return { usernames: [...seen], everyone };
}

/**
 * Splits content into alternating plain and mention segments, for rendering.
 *
 * Returning segments rather than HTML keeps this package free of any rendering
 * concern — and keeps the client from ever building markup from message text,
 * which is what makes injection structurally impossible here rather than
 * merely escaped.
 */
export type ContentSegment =
  | { readonly kind: 'text'; readonly text: string }
  | {
      readonly kind: 'mention';
      readonly text: string;
      readonly name: string;
      readonly everyone: boolean;
    };

export function segmentContent(content: string): ContentSegment[] {
  const tokens = parseMentions(content);
  if (tokens.length === 0) {
    return [{ kind: 'text', text: content }];
  }

  const segments: ContentSegment[] = [];
  let cursor = 0;

  for (const token of tokens) {
    if (token.start > cursor) {
      segments.push({ kind: 'text', text: content.slice(cursor, token.start) });
    }
    segments.push({
      kind: 'mention',
      text: token.raw,
      name: token.name,
      everyone: token.kind === 'everyone',
    });
    cursor = token.end;
  }

  if (cursor < content.length) {
    segments.push({ kind: 'text', text: content.slice(cursor) });
  }

  return segments;
}
