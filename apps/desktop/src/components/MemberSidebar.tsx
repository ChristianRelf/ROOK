import { useCallback, useMemo, useRef } from 'react';
import { Crown, MoreVertical, Shield, UserMinus, UserX } from 'lucide-react';
import { Avatar, Menu, Skeleton, Spinner, cn, type MenuItem } from '@rook/ui';
import {
  canManageMember,
  type CommunityId,
  type CommunityMember,
  type CommunityMembership,
  type CommunityRole,
} from '@rook/contracts';
import { useMemberPages, useRemoveMember, useSetMemberRole } from '../lib/admin-queries.js';
import { useSessionStore } from '../stores/session.js';

/**
 * The member list for the selected community.
 *
 * Grouped by role so the people who can act on the community are visible
 * first, and paginated: the endpoint is cursor-based, and this loads the next
 * page when the list is scrolled near its end rather than fetching every
 * member of a large community up front.
 *
 * The role menu is gated by `canManageMember` — the same function the server
 * authorises with. That matters more than it looks: the rule is not simply
 * "are you an admin", it is "do you outrank this person", so an admin sees no
 * menu on another admin. Deriving that from a bare role check would offer
 * actions the API then refuses, which reads as a bug rather than as a
 * permission boundary.
 */

/** How close to the bottom triggers loading the next page, in pixels. */
const LOAD_MORE_THRESHOLD = 240;

const roleGroups: readonly { role: CommunityRole; label: string }[] = [
  { role: 'owner', label: 'Owner' },
  { role: 'admin', label: 'Admins' },
  { role: 'member', label: 'Members' },
];

const roleIcons: Readonly<Record<CommunityRole, typeof Crown | undefined>> = {
  owner: Crown,
  admin: Shield,
  member: undefined,
};

export function MemberSidebar({
  communityId,
  community,
}: {
  readonly communityId: CommunityId;
  readonly community: CommunityMembership | undefined;
}) {
  const members = useMemberPages(communityId);
  const scrollRef = useRef<HTMLDivElement | null>(null);

  // Flattened across pages. Derived in a memo from the page array so the list
  // identity is stable between renders that did not fetch anything.
  const allMembers = useMemo<CommunityMember[]>(
    () => (members.data?.pages ?? []).flatMap((page) => page.members),
    [members.data],
  );

  const totalCount = members.data?.pages[0]?.totalCount ?? allMembers.length;

  const { hasNextPage, isFetchingNextPage, fetchNextPage } = members;

  const handleScroll = useCallback(() => {
    const element = scrollRef.current;
    if (element === null) return;
    if (!hasNextPage || isFetchingNextPage) return;

    const distanceFromBottom = element.scrollHeight - element.scrollTop - element.clientHeight;
    if (distanceFromBottom < LOAD_MORE_THRESHOLD) {
      // `isFetchingNextPage` above is what keeps a scroll handler firing at
      // 60Hz from queueing a page request per frame.
      void fetchNextPage();
    }
  }, [hasNextPage, isFetchingNextPage, fetchNextPage]);

  const grouped = useMemo(() => {
    const buckets = new Map<CommunityRole, CommunityMember[]>();
    for (const member of allMembers) {
      const bucket = buckets.get(member.role);
      if (bucket === undefined) buckets.set(member.role, [member]);
      else bucket.push(member);
    }
    return buckets;
  }, [allMembers]);

  return (
    <aside aria-label="Members" className="flex w-60 shrink-0 flex-col bg-raised">
      <header className="flex h-12 shrink-0 items-center justify-between border-b border-line px-4">
        <h2 className="text-xs font-semibold uppercase tracking-wide text-ink-subtle">Members</h2>
        {members.data !== undefined ? (
          <span className="text-xs font-medium tabular-nums text-ink-subtle">{totalCount}</span>
        ) : null}
      </header>

      <div
        ref={scrollRef}
        onScroll={handleScroll}
        className="min-h-0 flex-1 overflow-y-auto px-2 pb-4"
      >
        {members.isLoading ? (
          <div className="flex flex-col gap-2 px-1 py-3">
            {[0, 1, 2, 3].map((index) => (
              <div key={index} className="flex items-center gap-2">
                <Skeleton className="size-8 rounded-pill" />
                <Skeleton className="h-3 flex-1" />
              </div>
            ))}
          </div>
        ) : null}

        {members.isError ? (
          <p className="px-1 py-3 text-xs text-danger">Could not load members.</p>
        ) : null}

        {roleGroups.map((group) => {
          const inGroup = grouped.get(group.role) ?? [];
          if (inGroup.length === 0) return null;

          return (
            <div key={group.role}>
              <div className="px-2 pb-1 pt-4 text-2xs font-semibold uppercase tracking-wide text-ink-subtle">
                {group.label} — {inGroup.length}
              </div>
              <ul className="flex flex-col gap-0.5">
                {inGroup.map((member) => (
                  <MemberRow
                    key={member.user.id}
                    member={member}
                    communityId={communityId}
                    community={community}
                  />
                ))}
              </ul>
            </div>
          );
        })}

        {/*
          The paging footer. `hasNextPage` is what the server reported, so this
          says "more exist" rather than guessing from the page size — a list
          whose last page happens to be exactly full would otherwise show a
          spinner for ever.
        */}
        {isFetchingNextPage ? (
          <div className="flex items-center justify-center gap-2 py-4 text-2xs text-ink-subtle">
            <Spinner className="size-3" />
            Loading more members
          </div>
        ) : hasNextPage ? (
          <button
            type="button"
            onClick={() => void fetchNextPage()}
            className="mt-2 w-full rounded-control py-2 text-2xs text-ink-subtle hover:bg-hover hover:text-ink"
          >
            Load more
          </button>
        ) : null}
      </div>
    </aside>
  );
}

function MemberRow({
  member,
  communityId,
  community,
}: {
  readonly member: CommunityMember;
  readonly communityId: CommunityId;
  readonly community: CommunityMembership | undefined;
}) {
  const viewerId = useSessionStore((state) => state.user?.id);
  const setRole = useSetMemberRole(communityId);
  const removeMember = useRemoveMember(communityId);

  const RoleIcon = roleIcons[member.role];
  const isSelf = viewerId === member.user.id;

  // The same check the server runs. See the note at the top of the file: this
  // is a ranking comparison, not a role check, so an admin gets no menu on a
  // peer and nobody gets one on the owner or on themselves.
  const mayManage =
    community !== undefined &&
    viewerId !== undefined &&
    canManageMember(
      { role: community.role, userId: viewerId },
      { role: member.role, userId: member.user.id },
    );

  const items: (MenuItem | 'separator')[] = [];

  if (mayManage) {
    if (member.role === 'member') {
      items.push({
        label: 'Make admin',
        icon: <Shield className="size-3.5" />,
        onSelect: () => setRole.mutate({ userId: member.user.id, role: 'admin' }),
      });
    } else if (member.role === 'admin') {
      items.push({
        label: 'Remove admin',
        icon: <UserMinus className="size-3.5" />,
        onSelect: () => setRole.mutate({ userId: member.user.id, role: 'member' }),
      });
    }

    items.push('separator');
    items.push({
      label: 'Remove from community',
      icon: <UserX className="size-3.5" />,
      destructive: true,
      onSelect: () => removeMember.mutate(member.user.id),
    });
  }

  const pending = setRole.isPending || removeMember.isPending;

  return (
    <li className="group/member relative flex items-center">
      <div
        className={cn(
          'flex min-w-0 flex-1 items-center gap-2.5 rounded-control px-2 py-1 transition-colors',
          'hover:bg-hover',
          pending && 'opacity-50',
        )}
        title={`@${member.user.username}`}
      >
        <Avatar name={member.user.displayName} seed={member.user.id} size="sm" className="size-8" />

        <span className="flex min-w-0 flex-1 items-center gap-1">
          <span
            className={cn(
              'min-w-0 truncate text-[15px] font-medium',
              // Role weight on the name, which is where the eye already is —
              // a separate badge per row would make the list busier than the
              // information justifies. Three descending greys, brightest for
              // the owner, so the list establishes an order without asking
              // anyone to learn what a colour means.
              member.role === 'owner'
                ? 'text-role-owner'
                : member.role === 'admin'
                  ? 'text-role-admin'
                  : 'text-role-member',
            )}
          >
            {member.user.displayName}
          </span>
          {isSelf ? <span className="shrink-0 text-2xs text-ink-faint">(you)</span> : null}
        </span>

        {RoleIcon !== undefined ? (
          <RoleIcon
            aria-label={member.role}
            className={cn(
              'size-3.5 shrink-0',
              member.role === 'owner' ? 'text-role-owner' : 'text-role-admin',
            )}
            strokeWidth={2.25}
          />
        ) : null}
      </div>

      {items.length > 0 ? (
        <Menu
          label={`${member.user.displayName} actions`}
          items={items}
          className="absolute right-1"
          trigger={({ open, toggle }) => (
            <button
              type="button"
              onClick={toggle}
              aria-label={`Manage ${member.user.displayName}`}
              className={cn(
                'flex size-6 items-center justify-center rounded-control',
                'bg-raised text-ink-subtle hover:text-ink',
                open ? 'opacity-100' : 'opacity-0 group-hover/member:opacity-100',
              )}
            >
              <MoreVertical className="size-3.5" />
            </button>
          )}
        />
      ) : null}
    </li>
  );
}
