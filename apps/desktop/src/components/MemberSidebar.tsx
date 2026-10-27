import { Avatar, Badge, SectionLabel, Skeleton } from '@rook/ui';
import type { CommunityId, CommunityRole } from '@rook/contracts';
import { useMembers } from '../lib/queries.js';

/**
 * The member list for the selected community.
 *
 * Grouped by role so the people who can act on the community are visible
 * first. This renders the first page only; the endpoint is cursor-paginated,
 * and loading more is listed in docs/limitations.md as unfinished -- the
 * sidebar does not yet request further pages.
 */
export function MemberSidebar({ communityId }: { readonly communityId: CommunityId }) {
  const members = useMembers(communityId);

  const groups: { role: CommunityRole; label: string }[] = [
    { role: 'owner', label: 'Owner' },
    { role: 'admin', label: 'Admins' },
    { role: 'member', label: 'Members' },
  ];

  return (
    <aside
      aria-label="Members"
      className="flex w-56 shrink-0 flex-col border-l border-line bg-raised"
    >
      <header className="flex h-12 shrink-0 items-center justify-between border-b border-line px-3">
        <h2 className="text-xs font-semibold text-ink">Members</h2>
        {members.data !== undefined ? <Badge>{members.data.length}</Badge> : null}
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-3">
        {members.isLoading ? (
          <div className="flex flex-col gap-2 px-1 py-3">
            {[0, 1, 2].map((index) => (
              <div key={index} className="flex items-center gap-2">
                <Skeleton className="size-7 rounded-pill" />
                <Skeleton className="h-3 flex-1" />
              </div>
            ))}
          </div>
        ) : null}

        {members.isError ? (
          <p className="px-1 py-3 text-xs text-danger">Could not load members.</p>
        ) : null}

        {groups.map((group) => {
          const inGroup = (members.data ?? []).filter((member) => member.role === group.role);
          if (inGroup.length === 0) return null;

          return (
            <div key={group.role}>
              <SectionLabel>
                {group.label} -- {inGroup.length}
              </SectionLabel>
              <ul className="flex flex-col gap-0.5">
                {inGroup.map((member) => (
                  <li key={member.user.id}>
                    <div
                      className="flex items-center gap-2 rounded-control px-1.5 py-1 hover:bg-hover"
                      title={`@${member.user.username}`}
                    >
                      <Avatar name={member.user.displayName} seed={member.user.id} size="sm" />
                      <span className="min-w-0 flex-1 truncate text-xs text-ink-muted">
                        {member.user.displayName}
                      </span>
                    </div>
                  </li>
                ))}
              </ul>
            </div>
          );
        })}
      </div>
    </aside>
  );
}
