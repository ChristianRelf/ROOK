import { useSessionStore } from '../stores/session.js';

/**
 * Mention helpers that are hooks or plain functions rather than components.
 *
 * Kept out of the components that use them so each component file exports only
 * components — which is what lets fast refresh replace them in place during
 * development instead of remounting the tree and losing the open channel.
 */

/**
 * Whether a message mentions the current user.
 *
 * Read from the server's resolved `mentionedUserIds` rather than from the
 * text: the ids are pinned at write time, so this stays correct after someone
 * changes their username — which is exactly the case where re-parsing the text
 * would get it wrong.
 */
export function useMentionsMe(message: {
  mentionedUserIds: readonly string[];
  mentionsEveryone: boolean;
  author: { id: string };
}): boolean {
  const userId = useSessionStore((state) => state.user?.id);
  if (userId === undefined) return false;

  // Your own `@everyone` does not highlight your own message back at you.
  if (message.author.id === userId) return false;

  return message.mentionsEveryone || message.mentionedUserIds.includes(userId);
}

/**
 * Reduces a pasted invite link to the code it contains.
 *
 * Deliberately string manipulation rather than `new URL()`: people paste
 * things that are not valid URLs ("rook.gg/x/ABC", a code with a trailing
 * space), and the last non-empty path segment is the right answer for all of
 * them. A plain code has no slashes and falls through unchanged.
 */
export function extractCode(input: string): string {
  const trimmed = input.trim();
  if (!trimmed.includes('/')) return trimmed;

  const segments = trimmed.split(/[/?#]/u).filter((segment) => segment.length > 0);
  return segments[segments.length - 1] ?? trimmed;
}
