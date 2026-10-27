import { useEffect, useRef } from 'react';
import { Hash, MessageSquare, Plus, Settings, UserPlus, Users } from 'lucide-react';
import { Button, EmptyState, ErrorState, Spinner, Tooltip, cn } from '@rook/ui';
import { can, type Channel, type CommunityMembership } from '@rook/contracts';
import { useChannelHistory } from '../lib/queries.js';
import { useMarkRead } from '../lib/admin-queries.js';
import { useMessagesStore } from '../stores/messages.js';
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
 *
 * It also owns marking the channel read, because this is the component that
 * knows a channel is actually on screen. See `ReadTracker` below.
 */
export function ConversationPane({
  channel,
  hasCommunity,
  hasChannels,
  community,
}: {
  readonly channel: Channel | undefined;
  readonly hasCommunity: boolean;
  readonly hasChannels: boolean;
  readonly community: CommunityMembership | undefined;
}) {
  const openDialog = useUiStore((state) => state.openDialog);
  const selectedCommunityId = useUiStore((state) => state.selectedCommunityId);
  const toggleMembers = useUiStore((state) => state.toggleMembers);

  const history = useChannelHistory(channel?.id);

  const role = community?.role;
  const mayCreateChannel = role !== undefined && can({ role }, 'channel:create');
  const mayEditChannel = role !== undefined && can({ role }, 'channel:update');
  const mayInvite = role !== undefined && can({ role }, 'invite:create');

  if (!hasCommunity) {
    return (
      <div className="flex min-w-0 flex-1 flex-col">
        <EmptyState
          icon={<MessageSquare className="size-8" strokeWidth={1.5} />}
          title="No communities yet"
          description="Create a community to start your own space, or join an existing one with a code or invite link someone shared with you."
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
          description={
            mayCreateChannel
              ? 'Channels are where conversations happen. Create the first one.'
              : 'Channels are where conversations happen. An admin needs to create the first one.'
          }
          action={
            mayCreateChannel && selectedCommunityId !== undefined ? (
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
      <header className="flex h-12 shrink-0 items-center gap-2 border-b border-line px-4 shadow-sm">
        <Hash className="size-5 shrink-0 text-ink-faint" />
        <h1 className="shrink-0 text-base font-semibold text-ink">{channel.name}</h1>

        {channel.topic !== null && channel.topic.length > 0 ? (
          <>
            <span className="h-5 w-px shrink-0 bg-line-strong" />
            <p className="min-w-0 truncate text-sm text-ink-subtle" title={channel.topic}>
              {channel.topic}
            </p>
          </>
        ) : null}

        <div className="ml-auto flex shrink-0 items-center gap-0.5">
          {mayEditChannel && selectedCommunityId !== undefined ? (
            <Tooltip label="Edit channel">
              <button
                type="button"
                onClick={() =>
                  openDialog({
                    kind: 'editChannel',
                    communityId: selectedCommunityId,
                    channelId: channel.id,
                  })
                }
                aria-label="Edit channel"
                className={cn(
                  'flex size-7 items-center justify-center rounded-control',
                  'text-ink-subtle transition-colors hover:bg-hover hover:text-ink',
                )}
              >
                <Settings className="size-4" />
              </button>
            </Tooltip>
          ) : null}

          {mayInvite && selectedCommunityId !== undefined ? (
            <Tooltip label="Invite people">
              <button
                type="button"
                onClick={() => openDialog({ kind: 'invite', communityId: selectedCommunityId })}
                aria-label="Invite people"
                className={cn(
                  'flex size-7 items-center justify-center rounded-control',
                  'text-ink-subtle transition-colors hover:bg-hover hover:text-ink',
                )}
              >
                <UserPlus className="size-4" />
              </button>
            </Tooltip>
          ) : null}

          <Tooltip label="Toggle member list">
            <button
              type="button"
              onClick={toggleMembers}
              aria-label="Toggle member list"
              className={cn(
                'flex size-7 items-center justify-center rounded-control',
                'text-ink-subtle transition-colors hover:bg-hover hover:text-ink',
              )}
            >
              <Users className="size-4" />
            </button>
          </Tooltip>
        </div>
      </header>

      <ReadTracker channelId={channel.id} />

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

/**
 * Marks the open channel read as messages arrive.
 *
 * Renders nothing — it exists purely so the effect has somewhere to live that
 * is scoped to one channel being on screen.
 *
 * Two things make this behave rather than fight the user:
 *
 *   * **It tracks the newest message id and only writes when it moves
 *     forward.** The effect re-runs whenever the channel's message map
 *     changes, which includes edits, deletions and optimistic sends — writing
 *     on each would be a request per keystroke's worth of state change.
 *
 *   * **It does not care whether the window is focused.** Read state here
 *     means "this channel is the one open in the app", which is the same
 *     meaning the sidebar badge has. Tying it to focus would leave a channel
 *     you have been staring at marked unread because the window lost focus to
 *     a browser, and the badge would contradict what is on screen.
 */
function ReadTracker({ channelId }: { readonly channelId: Channel['id'] }) {
  const markRead = useMarkRead();

  // Subscribed to the channel's slice, not to a derived list: a selector that
  // built an array would return a fresh value on every render and loop.
  const channelState = useMessagesStore((state) => state.channels[channelId]);

  /** The id last reported, so an unchanged newest message writes nothing. */
  const lastReported = useRef<string | undefined>(undefined);

  // Reset when the channel changes, so switching back to a channel re-reports
  // rather than being suppressed by the previous channel's high-water mark.
  useEffect(() => {
    lastReported.current = undefined;
  }, [channelId]);

  useEffect(() => {
    if (channelState === undefined) return;

    // Ids are UUIDv7, so the lexicographically largest is the newest. Taking
    // a max is cheaper than sorting the whole map, which is what the message
    // list does for rendering but is wasted work here.
    let newest: string | undefined;
    for (const id of channelState.byId.keys()) {
      if (newest === undefined || id > newest) newest = id;
    }

    if (newest === undefined) return;
    if (lastReported.current !== undefined && newest <= lastReported.current) return;

    lastReported.current = newest;
    void markRead(channelId, newest as Parameters<typeof markRead>[1]);
  }, [channelId, channelState, markRead]);

  return null;
}
