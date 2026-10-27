import { Plus, Hash, LogIn } from 'lucide-react';
import { Avatar, Spinner, Tooltip, UnreadPill, cn } from '@rook/ui';
import type { CommunityMembership, UnreadSummary } from '@rook/contracts';
import { useUiStore } from '../stores/ui.js';
import { AccountMenu } from './AccountMenu.jsx';

/**
 * The leftmost rail: one button per community, plus create/join and the
 * account menu pinned to the bottom.
 *
 * Identity here is carried by an avatar tint derived from the community id, so
 * communities stay visually distinguishable without needing uploaded icons.
 *
 * The left-edge pill does three jobs at once, which is why it is a single
 * element with three heights rather than three separate indicators: nothing
 * for a community that is read, a short stub when something is unread, and a
 * full bar for the one you are looking at. A mention adds a red count badge,
 * because an unread *mention* has to be distinguishable from unread chatter
 * without opening the community to find out.
 */

type CommunityRollup = UnreadSummary['communities'][number];

/** Stable empty map: never build one inside a selector or a memo. */
const NO_ROLLUPS: ReadonlyMap<string, CommunityRollup> = new Map();

export function CommunityRail({
  communities,
  loading,
  error,
  unreadByCommunity = NO_ROLLUPS,
}: {
  readonly communities: readonly CommunityMembership[];
  readonly loading: boolean;
  readonly error: unknown;
  readonly unreadByCommunity?: ReadonlyMap<string, CommunityRollup>;
}) {
  const selectedCommunityId = useUiStore((state) => state.selectedCommunityId);
  const selectCommunity = useUiStore((state) => state.selectCommunity);
  const openDialog = useUiStore((state) => state.openDialog);

  return (
    <nav
      aria-label="Communities"
      className="flex w-[4.5rem] shrink-0 flex-col items-center gap-2 bg-sunken py-3"
    >
      <div className="flex min-h-0 flex-1 flex-col items-center gap-2 overflow-y-auto">
        {loading ? <Spinner className="mt-2 size-4 text-ink-faint" /> : null}

        {error !== null && error !== undefined && !loading ? (
          <div
            title="Could not load your communities"
            className="flex size-12 items-center justify-center rounded-panel bg-danger-wash text-danger"
          >
            <Hash className="size-4" />
          </div>
        ) : null}

        {communities.map((community) => {
          const selected = community.id === selectedCommunityId;
          const rollup = unreadByCommunity.get(community.id);
          const mentionCount = rollup?.mentionCount ?? 0;
          // The selected community is open, so its unread stub is suppressed:
          // the full selection bar already occupies that space.
          const hasUnread = !selected && rollup?.hasUnread === true;

          return (
            <Tooltip key={community.id} label={community.name} side="right">
              <button
                type="button"
                onClick={() => selectCommunity(community.id)}
                aria-current={selected ? 'true' : undefined}
                aria-label={
                  mentionCount > 0
                    ? `${community.name}, ${mentionCount} mentions`
                    : hasUnread
                      ? `${community.name}, unread messages`
                      : community.name
                }
                className="group relative flex size-12 items-center justify-center"
              >
                {/* One pill, three heights. Driven by a CSS variable so the
                    transition is a single animated property rather than a
                    class swap that cannot tween. */}
                <span
                  className="rail-pill pointer-events-none absolute inset-0"
                  style={{
                    ['--rail-pill-height' as string]: selected
                      ? '2.5rem'
                      : hasUnread
                        ? '0.5rem'
                        : '0rem',
                  }}
                />

                <Avatar
                  name={community.name}
                  seed={community.id}
                  size="lg"
                  className={cn(
                    'size-12 text-base transition-[border-radius] duration-(--duration-fast)',
                    selected ? 'rounded-control' : 'rounded-panel group-hover:rounded-control',
                  )}
                />

                {/* Overlapping the avatar's bottom-right corner, where it
                    cannot be mistaken for part of the community's identity. */}
                <UnreadPill
                  count={mentionCount}
                  capped={false}
                  className="absolute -bottom-0.5 -right-0.5 h-[18px] min-w-[18px] border-2 border-sunken"
                />
              </button>
            </Tooltip>
          );
        })}

        <div className="my-1 h-px w-8 bg-line-strong" />

        <Tooltip label="Create a community" side="right">
          <button
            type="button"
            onClick={() => openDialog({ kind: 'createCommunity' })}
            aria-label="Create a community"
            className={cn(
              'flex size-12 items-center justify-center rounded-panel bg-raised',
              'text-success transition-all duration-(--duration-fast)',
              'hover:rounded-control hover:bg-success hover:text-white',
            )}
          >
            <Plus className="size-5" />
          </button>
        </Tooltip>

        <Tooltip label="Join with a code or link" side="right">
          <button
            type="button"
            onClick={() => openDialog({ kind: 'joinCommunity' })}
            aria-label="Join with a code or link"
            className={cn(
              'flex size-12 items-center justify-center rounded-panel bg-raised',
              'text-ink-muted transition-all duration-(--duration-fast)',
              'hover:rounded-control hover:bg-hover hover:text-ink',
            )}
          >
            <LogIn className="size-4.5" />
          </button>
        </Tooltip>
      </div>

      <AccountMenu />
    </nav>
  );
}
