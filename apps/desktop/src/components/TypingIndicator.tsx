import { useMembers } from '../lib/queries.js';
import { useMessagesStore } from '../stores/messages.js';
import { useSessionStore } from '../stores/session.js';
import { useUiStore } from '../stores/ui.js';
import type { ChannelId } from '@rook/contracts';

/**
 * "Ada is typing..."
 *
 * Reserves its own height whether or not anyone is typing, so the message list
 * does not shift up and down as indicators come and go -- a jitter that is
 * very noticeable while reading.
 *
 * Entries expire on their own (a timer in the app context prunes them), which
 * is why there is no "stopped typing" event to handle: a client that closes
 * mid-sentence cannot leave a stuck indicator behind.
 */
export function TypingIndicator({ channelId }: { readonly channelId: ChannelId }) {
  const entries = useMessagesStore((state) => state.typing[channelId] ?? []);
  const currentUserId = useSessionStore((state) => state.user?.id);
  const communityId = useUiStore((state) => state.selectedCommunityId);
  const members = useMembers(communityId);

  // The server already suppresses your own indicator; this guards against a
  // second device signed in as the same user.
  const others = entries.filter((entry) => entry.userId !== currentUserId);

  const names = others.map((entry) => {
    const member = members.data?.find((item) => item.user.id === entry.userId);
    return member?.user.displayName ?? 'Someone';
  });

  const label =
    names.length === 0
      ? ''
      : names.length === 1
        ? `${names[0]} is typing...`
        : names.length === 2
          ? `${names[0]} and ${names[1]} are typing...`
          : `${names.length} people are typing...`;

  return (
    <div className="h-5 shrink-0 px-4">
      {label.length > 0 ? <p className="animate-rise text-2xs text-ink-subtle">{label}</p> : null}
    </div>
  );
}
