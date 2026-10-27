import { useCallback, useMemo, useRef, useState } from 'react';
import {
  Crown,
  FolderPen,
  Hash,
  Link2,
  Scroll,
  Shield,
  UserCog,
  UserMinus,
  UserPlus,
  UserX,
  Users,
} from 'lucide-react';
import {
  Avatar,
  Button,
  EmptyState,
  Menu,
  Select,
  Skeleton,
  Spinner,
  Tooltip,
  cn,
  type MenuItem,
} from '@rook/ui';
import {
  auditActionSchema,
  canManageMember,
  type AuditAction,
  type AuditLogEntry,
  type CommunityId,
  type CommunityMember,
  type CommunityRole,
} from '@rook/contracts';
import {
  useAuditLog,
  useInvites,
  useMemberPages,
  useRemoveMember,
  useSetMemberRole,
} from '../lib/admin-queries.js';
import { useCommunities } from '../lib/queries.js';
import { useSessionStore } from '../stores/session.js';
import { useUiStore, type CommunitySettingsTab } from '../stores/ui.js';
import { Modal } from './Dialogs.jsx';

/**
 * Community administration: members and roles, invites, and the audit log.
 *
 * One dialog with tabs rather than three entries in a menu, because these are
 * the same job — you come here to work out who can do what and what they have
 * done — and splitting them across separate windows means losing your place
 * every time you cross-reference one against another.
 *
 * Only the visible tab's query runs. The audit log is cursor-paginated and the
 * member list is too, so mounting all three would fire three paginated
 * requests to draw one panel.
 */

const tabs: readonly { id: CommunitySettingsTab; label: string; icon: typeof Users }[] = [
  { id: 'members', label: 'Members', icon: Users },
  { id: 'invites', label: 'Invites', icon: Link2 },
  { id: 'audit', label: 'Audit log', icon: Scroll },
];

export function CommunitySettingsDialog({
  communityId,
  initialTab,
  onClose,
}: {
  readonly communityId: CommunityId;
  readonly initialTab: CommunitySettingsTab;
  readonly onClose: () => void;
}) {
  const [tab, setTab] = useState<CommunitySettingsTab>(initialTab);
  const communities = useCommunities();
  const community = communities.data?.find((item) => item.id === communityId);

  return (
    <Modal
      title={community?.name ?? 'Community settings'}
      description="Manage members, invites and review what has changed."
      onClose={onClose}
      width="lg"
    >
      <div className="flex min-h-0 flex-1 flex-col">
        <nav
          aria-label="Settings sections"
          className="flex shrink-0 gap-1 border-b border-line px-5"
        >
          {tabs.map((entry) => {
            const Icon = entry.icon;
            const selected = tab === entry.id;

            return (
              <button
                key={entry.id}
                type="button"
                onClick={() => setTab(entry.id)}
                aria-current={selected ? 'page' : undefined}
                className={cn(
                  'flex items-center gap-2 border-b-2 px-3 py-2.5 text-sm font-medium',
                  'transition-colors duration-(--duration-fast)',
                  selected
                    ? 'border-accent text-ink'
                    : 'border-transparent text-ink-subtle hover:text-ink',
                )}
              >
                <Icon className="size-4" />
                {entry.label}
              </button>
            );
          })}
        </nav>

        <div className="min-h-0 flex-1 overflow-y-auto">
          {tab === 'members' ? (
            <MembersTab communityId={communityId} viewerRole={community?.role} />
          ) : null}
          {tab === 'invites' ? <InvitesTab communityId={communityId} /> : null}
          {tab === 'audit' ? <AuditTab communityId={communityId} /> : null}
        </div>
      </div>
    </Modal>
  );
}

// --------------------------------------------------------------------------
// Members and roles
// --------------------------------------------------------------------------

const roleLabels: Readonly<Record<CommunityRole, string>> = {
  owner: 'Owner',
  admin: 'Admin',
  member: 'Member',
};

/** How close to the bottom triggers loading the next page, in pixels. */
const LOAD_MORE_THRESHOLD = 240;

function MembersTab({
  communityId,
  viewerRole,
}: {
  readonly communityId: CommunityId;
  readonly viewerRole: CommunityRole | undefined;
}) {
  const members = useMemberPages(communityId);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const [search, setSearch] = useState('');

  const allMembers = useMemo<CommunityMember[]>(
    () => (members.data?.pages ?? []).flatMap((page) => page.members),
    [members.data],
  );

  const total = members.data?.pages[0]?.totalCount ?? allMembers.length;
  const { hasNextPage, isFetchingNextPage, fetchNextPage } = members;

  /**
   * Filtering is applied to the pages already loaded, not sent to the server.
   *
   * Stated plainly in the UI below, because a filter that silently searches
   * only part of the data is worse than no filter: the endpoint has no search
   * parameter, and pretending otherwise would hide members who simply have not
   * been paged in yet.
   */
  const filtered = useMemo(() => {
    const needle = search.trim().toLowerCase();
    if (needle.length === 0) return allMembers;

    return allMembers.filter(
      (member) =>
        member.user.displayName.toLowerCase().includes(needle) ||
        member.user.username.includes(needle),
    );
  }, [allMembers, search]);

  const handleScroll = useCallback(() => {
    const element = scrollRef.current;
    if (element === null) return;
    if (!hasNextPage || isFetchingNextPage) return;

    const distanceFromBottom = element.scrollHeight - element.scrollTop - element.clientHeight;
    if (distanceFromBottom < LOAD_MORE_THRESHOLD) void fetchNextPage();
  }, [hasNextPage, isFetchingNextPage, fetchNextPage]);

  return (
    <div ref={scrollRef} onScroll={handleScroll} className="flex h-full flex-col">
      <div className="flex shrink-0 items-center gap-3 px-5 py-4">
        <input
          type="search"
          value={search}
          onChange={(event) => setSearch(event.target.value)}
          placeholder="Filter loaded members"
          aria-label="Filter loaded members"
          className={cn(
            'h-9 flex-1 rounded-control bg-inset px-3 text-sm text-ink',
            'placeholder:text-ink-faint focus:outline-none',
          )}
        />
        <span className="shrink-0 text-xs tabular-nums text-ink-subtle">
          {allMembers.length} of {total} loaded
        </span>
      </div>

      <div className="flex-1 px-5 pb-5">
        {members.isLoading ? (
          <div className="flex flex-col gap-3 py-2">
            {[0, 1, 2, 3, 4].map((index) => (
              <div key={index} className="flex items-center gap-3">
                <Skeleton className="size-9 rounded-pill" />
                <Skeleton className="h-3 w-40" />
              </div>
            ))}
          </div>
        ) : null}

        {members.isError ? (
          <p className="py-6 text-center text-sm text-danger">Could not load members.</p>
        ) : null}

        {!members.isLoading && filtered.length === 0 && search.trim().length > 0 ? (
          <EmptyState
            className="py-10"
            title="No matches in the loaded pages"
            description="Scroll the list to load more members, then filter again."
          />
        ) : null}

        <ul className="flex flex-col">
          {filtered.map((member) => (
            <MemberSettingsRow
              key={member.user.id}
              member={member}
              communityId={communityId}
              viewerRole={viewerRole}
            />
          ))}
        </ul>

        {isFetchingNextPage ? (
          <div className="flex items-center justify-center gap-2 py-4 text-xs text-ink-subtle">
            <Spinner className="size-3" />
            Loading more members
          </div>
        ) : hasNextPage ? (
          <div className="flex justify-center py-4">
            <Button size="sm" variant="ghost" onClick={() => void fetchNextPage()}>
              Load more
            </Button>
          </div>
        ) : null}
      </div>
    </div>
  );
}

function MemberSettingsRow({
  member,
  communityId,
  viewerRole,
}: {
  readonly member: CommunityMember;
  readonly communityId: CommunityId;
  readonly viewerRole: CommunityRole | undefined;
}) {
  const viewerId = useSessionStore((state) => state.user?.id);
  const setRole = useSetMemberRole(communityId);
  const removeMember = useRemoveMember(communityId);

  // The same ranking rule the server enforces, so the dropdown is absent
  // rather than present-and-refused for a peer admin or the owner.
  const mayManage =
    viewerRole !== undefined &&
    viewerId !== undefined &&
    canManageMember(
      { role: viewerRole, userId: viewerId },
      { role: member.role, userId: member.user.id },
    );

  const items: (MenuItem | 'separator')[] = [];
  if (mayManage) {
    items.push({
      label: 'Member',
      icon: <Users className="size-3.5" />,
      checked: member.role === 'member',
      disabled: member.role === 'member',
      onSelect: () => setRole.mutate({ userId: member.user.id, role: 'member' }),
    });
    items.push({
      label: 'Admin',
      icon: <Shield className="size-3.5" />,
      checked: member.role === 'admin',
      disabled: member.role === 'admin',
      onSelect: () => setRole.mutate({ userId: member.user.id, role: 'admin' }),
    });
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
    <li
      className={cn(
        'flex items-center gap-3 border-b border-line-soft py-2.5 last:border-b-0',
        pending && 'opacity-50',
      )}
    >
      <Avatar name={member.user.displayName} seed={member.user.id} size="md" />

      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1.5">
          <span className="min-w-0 truncate text-sm font-medium text-ink">
            {member.user.displayName}
          </span>
          {member.role === 'owner' ? (
            <Tooltip label="Owner">
              <Crown className="size-3.5 text-role-owner" />
            </Tooltip>
          ) : member.role === 'admin' ? (
            <Tooltip label="Admin">
              <Shield className="size-3.5 text-role-admin" />
            </Tooltip>
          ) : null}
        </div>
        <p className="truncate text-2xs text-ink-subtle">
          @{member.user.username} · joined {formatDate(member.joinedAt)}
        </p>
      </div>

      {mayManage ? (
        <Menu
          label={`${member.user.displayName} role`}
          items={items}
          trigger={({ open, toggle }) => (
            <button
              type="button"
              onClick={toggle}
              className={cn(
                'flex h-8 items-center gap-1.5 rounded-control px-2.5 text-xs font-medium',
                'transition-colors duration-(--duration-fast)',
                open ? 'bg-active text-ink' : 'bg-inset text-ink-muted hover:text-ink',
              )}
            >
              <UserCog className="size-3.5" />
              {roleLabels[member.role]}
            </button>
          )}
        />
      ) : (
        <span className="px-2.5 text-xs font-medium text-ink-faint">{roleLabels[member.role]}</span>
      )}
    </li>
  );
}

// --------------------------------------------------------------------------
// Invites
// --------------------------------------------------------------------------

/**
 * A read-only summary of invites, with the creation flow left to its own
 * dialog.
 *
 * Deliberately not a second place to generate links: two surfaces that create
 * the same thing with different defaults is how a community ends up with a
 * never-expiring link somebody made without noticing.
 */
function InvitesTab({ communityId }: { readonly communityId: CommunityId }) {
  const invites = useInvites(communityId);
  const openDialog = useUiStore((state) => state.openDialog);

  const active = (invites.data ?? []).filter((invite) => invite.active);
  const expired = (invites.data ?? []).filter((invite) => !invite.active);

  return (
    <div className="flex flex-col gap-4 px-5 py-4">
      <div className="flex items-center justify-between">
        <p className="text-xs text-ink-subtle">
          {active.length === 0
            ? 'No active invite links.'
            : active.length === 1
              ? '1 active invite link.'
              : `${active.length} active invite links.`}
        </p>
        <Button
          size="sm"
          variant="primary"
          onClick={() => openDialog({ kind: 'invite', communityId })}
        >
          <UserPlus className="size-3.5" />
          Manage invites
        </Button>
      </div>

      {invites.isLoading ? (
        <div className="flex flex-col gap-2">
          {[0, 1].map((index) => (
            <Skeleton key={index} className="h-12 w-full" />
          ))}
        </div>
      ) : null}

      {!invites.isLoading && (invites.data ?? []).length === 0 ? (
        <EmptyState
          className="py-10"
          icon={<Link2 className="size-7" strokeWidth={1.5} />}
          title="No invite links yet"
          description="Generate one to let someone join without sharing the permanent join code."
        />
      ) : null}

      <ul className="flex flex-col">
        {[...active, ...expired].map((invite) => (
          <li
            key={invite.id}
            className="flex items-center gap-3 border-b border-line-soft py-3 last:border-b-0"
          >
            <code className="selectable w-32 shrink-0 truncate font-mono text-xs text-ink-muted">
              {invite.code}
            </code>
            <div className="min-w-0 flex-1">
              <p className="truncate text-xs text-ink-muted">
                {invite.uses} {invite.uses === 1 ? 'use' : 'uses'}
                {invite.maxUses !== null ? ` of ${invite.maxUses}` : ''}
              </p>
              <p className="truncate text-2xs text-ink-subtle">
                by {invite.createdBy.displayName} · {formatDate(invite.createdAt)}
              </p>
            </div>
            <span
              className={cn(
                'shrink-0 rounded-pill px-2 py-0.5 text-2xs font-medium',
                // Weight, not hue: an active invite reads as the brighter
                // of the two, which is enough next to the word itself.
                invite.active ? 'bg-ink/15 text-ink' : 'bg-hover text-ink-faint',
              )}
            >
              {invite.active ? 'Active' : invite.revokedAt !== null ? 'Revoked' : 'Expired'}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

// --------------------------------------------------------------------------
// Audit log
// --------------------------------------------------------------------------

/**
 * Renders one entry as a sentence.
 *
 * Built from the action and the metadata rather than stored as text, so the
 * log holds structured facts and the wording can be improved without a
 * migration. Every action in the enum is handled — the switch is exhaustive by
 * construction, so adding one to the contract makes this fail to compile
 * rather than silently rendering a blank row.
 */
function describeEntry(entry: AuditLogEntry): string {
  const target = entry.targetLabel ?? 'something';
  const from = typeof entry.metadata['from'] === 'string' ? entry.metadata['from'] : undefined;
  const to = typeof entry.metadata['to'] === 'string' ? entry.metadata['to'] : undefined;

  switch (entry.action) {
    case 'community.updated':
      return `renamed the community${from !== undefined ? ` from ${from}` : ''}`;
    case 'channel.created':
      return `created #${target}`;
    case 'channel.updated':
      return `edited #${target}`;
    case 'channel.deleted':
      return `deleted #${target}`;
    case 'category.created':
      return `created the category ${target}`;
    case 'category.updated':
      return from !== undefined && to !== undefined
        ? `renamed the category ${from} to ${to}`
        : `edited the category ${target}`;
    case 'category.deleted':
      return `deleted the category ${target}`;
    case 'member.joined':
      return entry.metadata['via'] === 'invite'
        ? 'joined using an invite link'
        : 'joined using the community code';
    case 'member.role_changed':
      return from !== undefined && to !== undefined
        ? `changed ${target} from ${from} to ${to}`
        : `changed ${target}'s role`;
    case 'member.removed':
      return `removed ${target} from the community`;
    case 'invite.created':
      return 'created an invite link';
    case 'invite.revoked':
      return 'revoked an invite link';
  }
}

/** The icon for each action's target, so the log scans vertically. */
function entryIcon(entry: AuditLogEntry) {
  switch (entry.targetType) {
    case 'channel':
      return Hash;
    case 'category':
      return FolderPen;
    case 'member':
      return entry.action === 'member.removed' ? UserMinus : UserCog;
    case 'invite':
      return Link2;
    case 'community':
      return Users;
  }
}

const auditActions = auditActionSchema.options;

function AuditTab({ communityId }: { readonly communityId: CommunityId }) {
  const [action, setAction] = useState<string>('');
  const filters = useMemo(
    () => (action.length > 0 ? { action: action as AuditAction } : {}),
    [action],
  );

  const log = useAuditLog(communityId, filters);
  const scrollRef = useRef<HTMLDivElement | null>(null);

  const entries = useMemo<AuditLogEntry[]>(
    () => (log.data?.pages ?? []).flatMap((page) => page.entries),
    [log.data],
  );

  const { hasNextPage, isFetchingNextPage, fetchNextPage } = log;

  const handleScroll = useCallback(() => {
    const element = scrollRef.current;
    if (element === null) return;
    if (!hasNextPage || isFetchingNextPage) return;

    const distanceFromBottom = element.scrollHeight - element.scrollTop - element.clientHeight;
    if (distanceFromBottom < LOAD_MORE_THRESHOLD) void fetchNextPage();
  }, [hasNextPage, isFetchingNextPage, fetchNextPage]);

  return (
    <div ref={scrollRef} onScroll={handleScroll} className="flex h-full flex-col">
      <div className="flex shrink-0 items-center gap-3 px-5 py-4">
        {/* Filtered in SQL, not on the loaded page: narrowing to a rare action
            has to search the whole log, or it would look empty. */}
        <Select
          value={action}
          onChange={(event) => setAction(event.target.value)}
          aria-label="Filter by action"
          className="max-w-56"
        >
          <option value="">All actions</option>
          {auditActions.map((option) => (
            <option key={option} value={option}>
              {option}
            </option>
          ))}
        </Select>
        <p className="text-2xs text-ink-subtle">Newest first. Entries cannot be edited.</p>
      </div>

      <div className="flex-1 px-5 pb-5">
        {log.isLoading ? (
          <div className="flex flex-col gap-3 py-2">
            {[0, 1, 2, 3, 4].map((index) => (
              <Skeleton key={index} className="h-10 w-full" />
            ))}
          </div>
        ) : null}

        {log.isError ? (
          <p className="py-6 text-center text-sm text-danger">Could not load the audit log.</p>
        ) : null}

        {!log.isLoading && entries.length === 0 ? (
          <EmptyState
            className="py-10"
            icon={<Scroll className="size-7" strokeWidth={1.5} />}
            title="Nothing recorded yet"
            description={
              action.length > 0
                ? 'No entries match that action.'
                : 'Administrative changes will appear here as they happen.'
            }
          />
        ) : null}

        <ul className="flex flex-col">
          {entries.map((entry) => {
            const Icon = entryIcon(entry);

            return (
              <li
                key={entry.id}
                className="flex items-start gap-3 border-b border-line-soft py-2.5 last:border-b-0"
              >
                <span className="mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-pill bg-inset text-ink-subtle">
                  <Icon className="size-3.5" />
                </span>

                <div className="min-w-0 flex-1">
                  <p className="text-sm text-ink-muted">
                    <span className="font-medium text-ink">{entry.actorLabel}</span>{' '}
                    {describeEntry(entry)}
                  </p>
                  <p className="text-2xs text-ink-subtle">{formatDateTime(entry.createdAt)}</p>
                </div>
              </li>
            );
          })}
        </ul>

        {isFetchingNextPage ? (
          <div className="flex items-center justify-center gap-2 py-4 text-xs text-ink-subtle">
            <Spinner className="size-3" />
            Loading more entries
          </div>
        ) : hasNextPage ? (
          <div className="flex justify-center py-4">
            <Button size="sm" variant="ghost" onClick={() => void fetchNextPage()}>
              Load more
            </Button>
          </div>
        ) : null}
      </div>
    </div>
  );
}

// --------------------------------------------------------------------------
// Formatting
// --------------------------------------------------------------------------

/**
 * Dates are formatted with the platform's locale, not a fixed one.
 *
 * `Intl` is created per call rather than cached in a module constant: a cached
 * formatter captures the locale at import time, and this is a desktop app that
 * can outlive a system locale change.
 */
function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  });
}

function formatDateTime(iso: string): string {
  return new Date(iso).toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
}
