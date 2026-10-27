import { Hash, MessageSquare, Plus } from 'lucide-react';
import { Button, EmptyState, ErrorState, Spinner } from '@rook/ui';
import type { Channel } from '@rook/contracts';
import { useChannelHistory } from '../lib/queries.js';
import { useUiStore } from '../stores/ui.js';
import { MessageList } from './MessageList.jsx';
import { MessageComposer } from './MessageComposer.jsx';
import { TypingIndicator } from './TypingIndicator.jsx';

/**
 * The main conversation area: header, message list, typing indicator, composer.
 *
 * Most of this component is the set of states *before* there is a conversation
 * to show. Each one names what is missing and offers the action that fixes it,
 * because an unexplained empty pane is how a new user gets stuck:
 *
 *   no community  -> create or join one
 *   no channels   -> create one
 *   none selected -> pick one
 *   loading       -> a spinner, not a blank area
 *   failed        -> the error, with a retry
 */
export function ConversationPane({
  channel,
  hasCommunity,
  hasChannels,
}: {
  readonly channel: Channel | undefined;
  readonly hasCommunity: boolean;
  readonly hasChannels: boolean;
}) {
  const openDialog = useUiStore((state) => state.openDialog);
  const selectedCommunityId = useUiStore((state) => state.selectedCommunityId);

  const history = useChannelHistory(channel?.id);

  if (!hasCommunity) {
    return (
      <div className="flex min-w-0 flex-1 flex-col">
        <EmptyState
          icon={<MessageSquare className="size-8" strokeWidth={1.5} />}
          title="No communities yet"
          description="Create a community to start your own space, or join an existing one with a code someone shared with you."
          action={
            <div className="flex gap-2">
              <Button variant="primary" onClick={() => openDialog({ kind: 'createCommunity' })}>
                <Plus className="size-3.5" />
                Create a community
              </Button>
              <Button onClick={() => openDialog({ kind: 'joinCommunity' })}>
                Join with a code
              </Button>
            </div>
          }
        />
      </div>
    );
  }

  if (!hasChannels) {
    return (
      <div className="flex min-w-0 flex-1 flex-col">
        <EmptyState
          icon={<Hash className="size-8" strokeWidth={1.5} />}
          title="This community has no channels"
          description="Channels are where conversations happen. Create the first one."
          action={
            selectedCommunityId !== undefined ? (
              <Button
                variant="primary"
                onClick={() =>
                  openDialog({ kind: 'createChannel', communityId: selectedCommunityId })
                }
              >
                <Plus className="size-3.5" />
                Create a channel
              </Button>
            ) : null
          }
        />
      </div>
    );
  }

  if (channel === undefined) {
    return (
      <div className="flex min-w-0 flex-1 flex-col">
        <EmptyState
          icon={<Hash className="size-8" strokeWidth={1.5} />}
          title="Select a channel"
          description="Pick a channel from the sidebar to see its messages."
        />
      </div>
    );
  }

  return (
    <div className="flex min-w-0 flex-1 flex-col">
      <header className="flex h-12 shrink-0 items-center gap-2 border-b border-line px-4">
        <Hash className="size-4 shrink-0 text-ink-faint" />
        <h1 className="shrink-0 text-sm font-semibold text-ink">{channel.name}</h1>
        {channel.topic !== null && channel.topic.length > 0 ? (
          <>
            <span className="h-4 w-px shrink-0 bg-line" />
            <p className="min-w-0 truncate text-xs text-ink-subtle" title={channel.topic}>
              {channel.topic}
            </p>
          </>
        ) : null}
      </header>

      {history.isLoading ? (
        <div className="flex min-h-0 flex-1 items-center justify-center">
          <Spinner className="size-5 text-ink-faint" />
        </div>
      ) : history.isError ? (
        <ErrorState
          title="Could not load messages"
          message={
            history.error instanceof Error
              ? history.error.message
              : 'Something went wrong loading this channel.'
          }
          onRetry={() => void history.refetch()}
        />
      ) : (
        <MessageList channelId={channel.id} />
      )}

      <TypingIndicator channelId={channel.id} />
      <MessageComposer channel={channel} />
    </div>
  );
}
