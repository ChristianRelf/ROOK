import { useState } from 'react';
import { Check, Copy, Hash, Plus, Users } from 'lucide-react';
import { Button, EmptyState, SectionLabel, Skeleton, cn } from '@rook/ui';
import type { Channel, CommunityMembership } from '@rook/contracts';
import { useUiStore } from '../stores/ui.js';

/**
 * The channel list for the selected community.
 *
 * The header doubles as the place to share the join code, because that is the
 * only way to invite anyone in this release — burying it in a settings screen
 * would make a two-person community hard to start. Clicking it copies.
 */
export function ChannelSidebar({
  channels,
  loading,
  error,
  community,
}: {
  readonly channels: readonly Channel[];
  readonly loading: boolean;
  readonly error: unknown;
  readonly community: CommunityMembership | undefined;
}) {
  const selectedChannelId = useUiStore((state) => state.selectedChannelId);
  const selectChannel = useUiStore((state) => state.selectChannel);
  const openDialog = useUiStore((state) => state.openDialog);
  const toggleMembers = useUiStore((state) => state.toggleMembers);
  const showMembers = useUiStore((state) => state.showMembers);

  const [copied, setCopied] = useState(false);

  async function copyJoinCode(): Promise<void> {
    if (community === undefined) return;

    try {
      await navigator.clipboard.writeText(community.joinCode);
      setCopied(true);
      // Reverts on a timer so the button does not stay in a success state.
      window.setTimeout(() => setCopied(false), 1600);
    } catch {
      // Clipboard access can be refused; the code is visible either way.
    }
  }

  return (
    <aside className="flex w-60 shrink-0 flex-col border-r border-line bg-raised">
      <header className="flex h-12 shrink-0 items-center gap-2 border-b border-line px-3">
        {community === undefined ? (
          <Skeleton className="h-4 w-28" />
        ) : (
          <>
            <h2 className="min-w-0 flex-1 truncate text-sm font-semibold text-ink">
              {community.name}
            </h2>
            <button
              type="button"
              onClick={() => void copyJoinCode()}
              title={`Copy join code: ${community.joinCode}`}
              className="flex size-7 items-center justify-center rounded-control text-ink-subtle transition-colors hover:bg-hover hover:text-ink"
            >
              {copied ? <Check className="size-3.5 text-success" /> : <Copy className="size-3.5" />}
            </button>
            <button
              type="button"
              onClick={toggleMembers}
              title={showMembers ? 'Hide members' : 'Show members'}
              className={cn(
                'flex size-7 items-center justify-center rounded-control transition-colors hover:bg-hover',
                showMembers ? 'text-ink' : 'text-ink-subtle hover:text-ink',
              )}
            >
              <Users className="size-3.5" />
            </button>
          </>
        )}
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-2">
        {community === undefined ? null : (
          <div className="flex items-center justify-between">
            <SectionLabel>Text channels</SectionLabel>
            <button
              type="button"
              onClick={() => openDialog({ kind: 'createChannel', communityId: community.id })}
              title="Create a channel"
              className="mt-2 flex size-5 items-center justify-center rounded text-ink-faint transition-colors hover:bg-hover hover:text-ink"
            >
              <Plus className="size-3.5" />
            </button>
          </div>
        )}

        {loading ? (
          <div className="flex flex-col gap-1 px-2 py-1">
            {[0, 1, 2].map((index) => (
              <Skeleton key={index} className="h-7 w-full" />
            ))}
          </div>
        ) : null}

        {error !== null && error !== undefined && !loading ? (
          <p className="px-2 py-3 text-xs text-danger">Could not load channels.</p>
        ) : null}

        {!loading && channels.length === 0 && community !== undefined ? (
          <EmptyState
            className="flex-none px-2 py-6"
            title="No channels yet"
            description="Create one to start the conversation."
            action={
              <Button
                size="sm"
                onClick={() => openDialog({ kind: 'createChannel', communityId: community.id })}
              >
                <Plus className="size-3.5" />
                New channel
              </Button>
            }
          />
        ) : null}

        <ul className="flex flex-col gap-0.5">
          {channels.map((channel) => {
            const selected = channel.id === selectedChannelId;

            return (
              <li key={channel.id}>
                <button
                  type="button"
                  onClick={() => selectChannel(channel.id)}
                  aria-current={selected ? 'true' : undefined}
                  title={channel.topic ?? `#${channel.name}`}
                  className={cn(
                    'flex w-full items-center gap-1.5 rounded-control px-2 py-1.5 text-left',
                    'transition-colors duration-(--duration-fast)',
                    selected
                      ? 'bg-accent-wash text-ink'
                      : 'text-ink-muted hover:bg-hover hover:text-ink',
                  )}
                >
                  <Hash
                    className={cn('size-3.5 shrink-0', selected ? 'text-accent' : 'text-ink-faint')}
                  />
                  <span className="min-w-0 flex-1 truncate text-sm">{channel.name}</span>
                </button>
              </li>
            );
          })}
        </ul>
      </div>
    </aside>
  );
}
