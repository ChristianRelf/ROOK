import { Plus, Hash, LogIn } from 'lucide-react';
import { Avatar, Spinner, cn } from '@rook/ui';
import type { CommunityMembership } from '@rook/contracts';
import { useUiStore } from '../stores/ui.js';
import { AccountMenu } from './AccountMenu.jsx';

/**
 * The leftmost rail: one button per community, plus create/join and the
 * account menu pinned to the bottom.
 *
 * Identity here is carried by an avatar tint derived from the community id, so
 * communities stay visually distinguishable without needing uploaded icons.
 * The selected one is marked with a left-edge bar rather than a fill, which
 * reads clearly at this size without competing with the avatar itself.
 */
export function CommunityRail({
  communities,
  loading,
  error,
}: {
  readonly communities: readonly CommunityMembership[];
  readonly loading: boolean;
  readonly error: unknown;
}) {
  const selectedCommunityId = useUiStore((state) => state.selectedCommunityId);
  const selectCommunity = useUiStore((state) => state.selectCommunity);
  const openDialog = useUiStore((state) => state.openDialog);

  return (
    <nav
      aria-label="Communities"
      className="flex w-[4.25rem] shrink-0 flex-col items-center gap-1.5 border-r border-line bg-inset py-3"
    >
      <div className="flex min-h-0 flex-1 flex-col items-center gap-1.5 overflow-y-auto">
        {loading ? <Spinner className="mt-2 size-4 text-ink-faint" /> : null}

        {error !== null && error !== undefined && !loading ? (
          <div
            title="Could not load your communities"
            className="flex size-11 items-center justify-center rounded-panel bg-danger-wash text-danger"
          >
            <Hash className="size-4" />
          </div>
        ) : null}

        {communities.map((community) => {
          const selected = community.id === selectedCommunityId;

          return (
            <button
              key={community.id}
              type="button"
              onClick={() => selectCommunity(community.id)}
              title={community.name}
              aria-current={selected ? 'true' : undefined}
              className="group relative flex size-11 items-center justify-center"
            >
              {/* Selection marker: a bar on the window edge, which grows in
                  rather than appearing abruptly. */}
              <span
                className={cn(
                  'absolute -left-3 w-0.5 rounded-r-pill bg-ink transition-all duration-(--duration-fast)',
                  selected ? 'h-6' : 'h-0 group-hover:h-3',
                )}
              />
              <Avatar
                name={community.name}
                seed={community.id}
                size="md"
                className={cn(
                  'rounded-panel transition-all duration-(--duration-fast)',
                  selected ? 'rounded-control' : 'group-hover:rounded-control',
                )}
              />
            </button>
          );
        })}

        <div className="my-1 h-px w-8 bg-line" />

        <button
          type="button"
          onClick={() => openDialog({ kind: 'createCommunity' })}
          title="Create a community"
          className={cn(
            'flex size-11 items-center justify-center rounded-panel border border-line',
            'text-ink-muted transition-colors duration-(--duration-fast)',
            'hover:border-accent hover:bg-accent-wash hover:text-accent',
          )}
        >
          <Plus className="size-4.5" />
        </button>

        <button
          type="button"
          onClick={() => openDialog({ kind: 'joinCommunity' })}
          title="Join with a code"
          className={cn(
            'flex size-11 items-center justify-center rounded-panel border border-line',
            'text-ink-muted transition-colors duration-(--duration-fast)',
            'hover:border-line-strong hover:bg-hover hover:text-ink',
          )}
        >
          <LogIn className="size-4" />
        </button>
      </div>

      <AccountMenu />
    </nav>
  );
}
