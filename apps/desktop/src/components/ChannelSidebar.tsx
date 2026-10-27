import { useMemo, useState } from 'react';
import {
  Bell,
  BellOff,
  Check,
  ChevronDown,
  Copy,
  FolderPlus,
  Hash,
  Pencil,
  Plus,
  Settings,
  Trash2,
  UserPlus,
  Users,
} from 'lucide-react';
import {
  Button,
  EmptyState,
  Menu,
  Skeleton,
  Tooltip,
  UnreadDot,
  UnreadPill,
  cn,
  type MenuItem,
} from '@rook/ui';
import {
  can,
  type Channel,
  type ChannelCategory,
  type ChannelUnread,
  type CommunityMembership,
} from '@rook/contracts';
import { useUiStore } from '../stores/ui.js';
import { useSetChannelMuted } from '../lib/admin-queries.js';

/**
 * The channel list for the selected community.
 *
 * Three things are happening here beyond listing channels, and each one has a
 * reason it is done this way:
 *
 *   * **Grouping.** Channels are bucketed by category, with uncategorised ones
 *     first. The grouping is derived in a `useMemo` from the server's ordering
 *     rather than sorted here — the server already orders by category position
 *     and then channel position, and re-sorting on the client would mean two
 *     implementations of the same rule.
 *
 *   * **Unread state.** An unread channel is promoted from the muted text
 *     weight to full strength, which makes "unread" legible without spending a
 *     colour on it. Mentions get the red pill, which is the only thing on this
 *     surface allowed to use red. A collapsed category still shows its
 *     channels if they are unread, because collapsing a category must not be a
 *     way to silently miss a mention.
 *
 *   * **Permissions.** Every administrative affordance is gated on the
 *     viewer's own role through `can()` — the same resolver the server uses, so
 *     the UI cannot offer an action the API will refuse.
 */

/** Stable empty arrays: a selector or memo must never return a fresh one. */
const NO_CHANNELS: readonly Channel[] = [];
const NO_CATEGORIES: readonly ChannelCategory[] = [];

interface ChannelGroup {
  readonly category: ChannelCategory | undefined;
  readonly channels: Channel[];
}

export function ChannelSidebar({
  channels = NO_CHANNELS,
  categories = NO_CATEGORIES,
  unreadByChannel,
  loading,
  error,
  community,
}: {
  readonly channels?: readonly Channel[];
  readonly categories?: readonly ChannelCategory[];
  readonly unreadByChannel: ReadonlyMap<string, ChannelUnread>;
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

  const role = community?.role;
  const mayCreateChannel = role !== undefined && can({ role }, 'channel:create');
  const mayManageChannels = role !== undefined && can({ role }, 'channel:update');
  const mayManageCategories = role !== undefined && can({ role }, 'category:create');
  const mayInvite = role !== undefined && can({ role }, 'invite:create');
  const mayAdminister = role !== undefined && can({ role }, 'member:manage_roles');

  /**
   * Channels bucketed into their categories.
   *
   * Built from the server's ordering, so a category keeps its place and its
   * channels keep theirs. Empty categories are kept: an admin who has just
   * created one needs to see it in order to drag channels into it.
   */
  const groups = useMemo<ChannelGroup[]>(() => {
    const byCategory = new Map<string, Channel[]>();
    const uncategorised: Channel[] = [];

    for (const channel of channels) {
      if (channel.categoryId === null) {
        uncategorised.push(channel);
        continue;
      }
      const bucket = byCategory.get(channel.categoryId);
      if (bucket === undefined) {
        byCategory.set(channel.categoryId, [channel]);
      } else {
        bucket.push(channel);
      }
    }

    const result: ChannelGroup[] = [];
    // Uncategorised first, matching the server's ordering and what a community
    // looks like before anyone has organised it.
    if (uncategorised.length > 0) {
      result.push({ category: undefined, channels: uncategorised });
    }
    for (const category of categories) {
      result.push({ category, channels: byCategory.get(category.id) ?? [] });
    }

    return result;
  }, [channels, categories]);

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

  const headerMenuItems: (MenuItem | 'separator')[] = [];
  if (mayInvite && community !== undefined) {
    headerMenuItems.push({
      label: 'Invite people',
      icon: <UserPlus className="size-3.5" />,
      onSelect: () => openDialog({ kind: 'invite', communityId: community.id }),
    });
  }
  if (community !== undefined) {
    headerMenuItems.push({
      label: 'Copy join code',
      icon: copied ? <Check className="size-3.5" /> : <Copy className="size-3.5" />,
      onSelect: () => void copyJoinCode(),
    });
  }
  if (mayCreateChannel && community !== undefined) {
    if (headerMenuItems.length > 0) headerMenuItems.push('separator');
    headerMenuItems.push({
      label: 'Create channel',
      icon: <Plus className="size-3.5" />,
      onSelect: () => openDialog({ kind: 'createChannel', communityId: community.id }),
    });
  }
  if (mayManageCategories && community !== undefined) {
    headerMenuItems.push({
      label: 'Create category',
      icon: <FolderPlus className="size-3.5" />,
      onSelect: () => openDialog({ kind: 'createCategory', communityId: community.id }),
    });
  }
  if (mayAdminister && community !== undefined) {
    headerMenuItems.push('separator');
    headerMenuItems.push({
      label: 'Community settings',
      icon: <Settings className="size-3.5" />,
      onSelect: () => openDialog({ kind: 'communitySettings', communityId: community.id }),
    });
  }

  return (
    <aside className="flex w-60 shrink-0 flex-col bg-raised">
      <header className="relative flex h-12 shrink-0 items-center gap-1 border-b border-line px-3 shadow-sm">
        {community === undefined ? (
          <Skeleton className="h-4 w-28" />
        ) : (
          <Menu
            align="left"
            label="Community actions"
            className="min-w-0 flex-1"
            items={headerMenuItems}
            trigger={({ open, toggle }) => (
              <button
                type="button"
                onClick={toggle}
                className={cn(
                  'flex w-full items-center gap-1 rounded-control px-1 py-1 text-left',
                  'transition-colors duration-(--duration-fast) hover:bg-hover',
                  open && 'bg-hover',
                )}
              >
                <h2 className="min-w-0 flex-1 truncate text-[15px] font-semibold text-ink">
                  {community.name}
                </h2>
                <ChevronDown className="size-4 shrink-0 text-ink-muted" />
              </button>
            )}
          />
        )}

        {community !== undefined ? (
          <Tooltip label={showMembers ? 'Hide members' : 'Show members'}>
            <button
              type="button"
              onClick={toggleMembers}
              aria-label={showMembers ? 'Hide members' : 'Show members'}
              className={cn(
                'flex size-7 items-center justify-center rounded-control transition-colors hover:bg-hover',
                showMembers ? 'text-ink' : 'text-ink-subtle hover:text-ink',
              )}
            >
              <Users className="size-4" />
            </button>
          </Tooltip>
        ) : null}
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-6 pt-2">
        {loading ? (
          <div className="flex flex-col gap-1 px-2 py-1">
            {[0, 1, 2].map((index) => (
              <Skeleton key={index} className="h-8 w-full" />
            ))}
          </div>
        ) : null}

        {error !== null && error !== undefined && !loading ? (
          <p className="px-2 py-3 text-xs text-danger">Could not load channels.</p>
        ) : null}

        {!loading && channels.length === 0 && categories.length === 0 && community !== undefined ? (
          <EmptyState
            className="flex-none px-2 py-6"
            title="No channels yet"
            description={
              mayCreateChannel
                ? 'Create one to start the conversation.'
                : 'An admin needs to create one.'
            }
            action={
              mayCreateChannel ? (
                <Button
                  size="sm"
                  variant="primary"
                  onClick={() => openDialog({ kind: 'createChannel', communityId: community.id })}
                >
                  <Plus className="size-3.5" />
                  New channel
                </Button>
              ) : null
            }
          />
        ) : null}

        {groups.map((group) => (
          <ChannelGroupSection
            key={group.category?.id ?? 'uncategorised'}
            group={group}
            community={community}
            selectedChannelId={selectedChannelId}
            unreadByChannel={unreadByChannel}
            onSelect={selectChannel}
            mayCreateChannel={mayCreateChannel}
            mayManageChannels={mayManageChannels}
            mayManageCategories={mayManageCategories}
          />
        ))}
      </div>
    </aside>
  );
}

/**
 * One category and its channels.
 *
 * A collapsed category hides its read channels but keeps the unread ones
 * visible. Hiding everything would make collapsing a category a way to miss a
 * mention without knowing it — the collapse is meant to reduce noise, not to
 * suppress signal.
 */
function ChannelGroupSection({
  group,
  community,
  selectedChannelId,
  unreadByChannel,
  onSelect,
  mayCreateChannel,
  mayManageChannels,
  mayManageCategories,
}: {
  readonly group: ChannelGroup;
  readonly community: CommunityMembership | undefined;
  readonly selectedChannelId: string | undefined;
  readonly unreadByChannel: ReadonlyMap<string, ChannelUnread>;
  readonly onSelect: (channelId: Channel['id']) => void;
  readonly mayCreateChannel: boolean;
  readonly mayManageChannels: boolean;
  readonly mayManageCategories: boolean;
}) {
  const openDialog = useUiStore((state) => state.openDialog);
  const toggleCategory = useUiStore((state) => state.toggleCategory);
  const categoryId = group.category?.id;

  // Subscribed one key at a time. A selector that filtered or mapped the
  // record would return a new value on every render, which React reads as a
  // changed store and re-renders until it throws.
  const collapsed = useUiStore((state) =>
    categoryId === undefined ? false : state.collapsedCategories[categoryId] === true,
  );

  if (group.channels.length === 0 && group.category === undefined) return null;

  // Bound to locals because both the header button and the menu trigger are
  // closures, and TypeScript cannot keep `group.category` narrowed across a
  // callback boundary even though nothing here reassigns it.
  const category = group.category;
  const categoryName = category?.name ?? 'Category';

  const visibleChannels = collapsed
    ? group.channels.filter((channel) => {
        const unread = unreadByChannel.get(channel.id);
        return (
          channel.id === selectedChannelId ||
          (unread !== undefined && (unread.unreadCount > 0 || unread.mentionCount > 0))
        );
      })
    : group.channels;

  const categoryMenuItems: (MenuItem | 'separator')[] = [];
  if (mayCreateChannel && community !== undefined) {
    categoryMenuItems.push({
      label: 'Create channel',
      icon: <Plus className="size-3.5" />,
      onSelect: () =>
        openDialog({
          kind: 'createChannel',
          communityId: community.id,
          ...(categoryId !== undefined ? { categoryId } : {}),
        }),
    });
  }
  if (mayManageCategories && community !== undefined && categoryId !== undefined) {
    categoryMenuItems.push({
      label: 'Rename category',
      icon: <Pencil className="size-3.5" />,
      onSelect: () => openDialog({ kind: 'editCategory', communityId: community.id, categoryId }),
    });
    categoryMenuItems.push('separator');
    categoryMenuItems.push({
      label: 'Delete category',
      icon: <Trash2 className="size-3.5" />,
      destructive: true,
      onSelect: () => openDialog({ kind: 'deleteCategory', communityId: community.id, categoryId }),
    });
  }

  return (
    <div className="mb-1">
      {category !== undefined ? (
        <div className="group/category flex items-center gap-0.5 pr-1 pt-4">
          <button
            type="button"
            onClick={() => toggleCategory(category.id)}
            aria-expanded={!collapsed}
            className={cn(
              'flex min-w-0 flex-1 items-center gap-0.5 rounded px-1 py-0.5 text-left',
              'text-2xs font-semibold uppercase tracking-wide',
              'transition-colors duration-(--duration-fast)',
              'text-ink-subtle hover:text-ink',
            )}
          >
            <ChevronDown
              className={cn(
                'size-3 shrink-0 transition-transform duration-(--duration-fast)',
                collapsed && '-rotate-90',
              )}
            />
            <span className="min-w-0 truncate">{category.name}</span>
          </button>

          {categoryMenuItems.length > 0 ? (
            <Menu
              label={`${categoryName} actions`}
              items={categoryMenuItems}
              trigger={({ open, toggle }) => (
                <button
                  type="button"
                  onClick={toggle}
                  aria-label={`${categoryName} actions`}
                  className={cn(
                    'flex size-4 items-center justify-center rounded text-ink-subtle',
                    'transition-opacity hover:text-ink',
                    // Revealed on hover so the sidebar is not a column of
                    // icons at rest, but kept visible while its menu is open.
                    open ? 'opacity-100' : 'opacity-0 group-hover/category:opacity-100',
                  )}
                >
                  <Plus className="size-3.5" />
                </button>
              )}
            />
          ) : null}
        </div>
      ) : null}

      <ul className="flex flex-col gap-0.5">
        {visibleChannels.map((channel) => (
          <ChannelRow
            key={channel.id}
            channel={channel}
            community={community}
            selected={channel.id === selectedChannelId}
            unread={unreadByChannel.get(channel.id)}
            onSelect={onSelect}
            mayManageChannels={mayManageChannels}
          />
        ))}
      </ul>

      {category !== undefined && group.channels.length === 0 && !collapsed ? (
        <p className="px-2 py-1.5 text-2xs text-ink-faint">No channels in this category</p>
      ) : null}
    </div>
  );
}

function ChannelRow({
  channel,
  community,
  selected,
  unread,
  onSelect,
  mayManageChannels,
}: {
  readonly channel: Channel;
  readonly community: CommunityMembership | undefined;
  readonly selected: boolean;
  readonly unread: ChannelUnread | undefined;
  readonly onSelect: (channelId: Channel['id']) => void;
  readonly mayManageChannels: boolean;
}) {
  const openDialog = useUiStore((state) => state.openDialog);
  const setMuted = useSetChannelMuted();

  const muted = unread?.muted === true;
  // The selected channel is being read right now, so it never renders as
  // unread — the badge would clear a moment later anyway and the flicker is
  // worse than the missing information.
  const hasUnread = !selected && (unread?.unreadCount ?? 0) > 0;
  const mentionCount = selected ? 0 : (unread?.mentionCount ?? 0);

  const items: (MenuItem | 'separator')[] = [
    {
      label: muted ? 'Unmute channel' : 'Mute channel',
      icon: muted ? <Bell className="size-3.5" /> : <BellOff className="size-3.5" />,
      onSelect: () => setMuted.mutate({ channelId: channel.id, muted: !muted }),
    },
  ];

  if (mayManageChannels && community !== undefined) {
    items.push('separator');
    items.push({
      label: 'Edit channel',
      icon: <Pencil className="size-3.5" />,
      onSelect: () =>
        openDialog({ kind: 'editChannel', communityId: community.id, channelId: channel.id }),
    });
    items.push({
      label: 'Delete channel',
      icon: <Trash2 className="size-3.5" />,
      destructive: true,
      onSelect: () =>
        openDialog({ kind: 'deleteChannel', communityId: community.id, channelId: channel.id }),
    });
  }

  return (
    <li className="group/channel relative flex items-center">
      {/* The unread marker sits outside the row's padding, in the gutter, so
          it does not shift the channel name when it appears. */}
      {hasUnread && mentionCount === 0 ? (
        <UnreadDot className="absolute -left-1 top-1/2 size-2 -translate-y-1/2" />
      ) : null}

      <button
        type="button"
        onClick={() => onSelect(channel.id)}
        aria-current={selected ? 'true' : undefined}
        title={channel.topic ?? `#${channel.name}`}
        className={cn(
          'flex min-w-0 flex-1 items-center gap-1.5 rounded-control px-2 py-1.5 text-left',
          'transition-colors duration-(--duration-fast)',
          selected
            ? 'bg-selected text-ink'
            : hasUnread
              ? 'text-ink hover:bg-hover'
              : muted
                ? 'text-ink-faint hover:bg-hover hover:text-ink-muted'
                : 'text-ink-subtle hover:bg-hover hover:text-ink-muted',
        )}
      >
        <Hash className="size-[18px] shrink-0 text-ink-faint" />
        <span
          className={cn(
            'min-w-0 flex-1 truncate text-[15px]',
            // Weight, not colour: an unread channel has to stand out in a
            // long list without adding a second meaning to the accent.
            hasUnread && !selected ? 'font-semibold' : 'font-medium',
          )}
        >
          {channel.name}
        </span>
      </button>

      <div className="absolute right-1.5 flex items-center gap-1">
        <UnreadPill count={mentionCount} capped={unread?.hasMoreThanCount === true} />

        <Menu
          label={`#${channel.name} actions`}
          items={items}
          trigger={({ open, toggle }) => (
            <button
              type="button"
              onClick={toggle}
              aria-label={`#${channel.name} actions`}
              className={cn(
                'flex size-4 items-center justify-center rounded text-ink-subtle hover:text-ink',
                open ? 'opacity-100' : 'opacity-0 group-hover/channel:opacity-100',
              )}
            >
              <Settings className="size-3.5" />
            </button>
          )}
        />
      </div>
    </li>
  );
}
