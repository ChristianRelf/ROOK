import { useEffect, useMemo } from 'react';
import type { ChannelUnread, UnreadSummary } from '@rook/contracts';
import { useCommunities } from '../lib/queries.js';
import { useChannelTree, useUnread } from '../lib/admin-queries.js';
import { useUiStore } from '../stores/ui.js';
import { CommunityRail } from '../components/CommunityRail.jsx';
import { ChannelSidebar } from '../components/ChannelSidebar.jsx';
import { ConversationPane } from '../components/ConversationPane.jsx';
import { MemberSidebar } from '../components/MemberSidebar.jsx';
import { ConnectionBanner } from '../components/ConnectionBanner.jsx';
import { Dialogs } from '../components/Dialogs.jsx';

/**
 * The three-pane application shell.
 *
 *   rail      communities, with unread and mention indicators
 *   sidebar   categories and channels in the selected community
 *   main      the conversation, plus an optional member list
 *
 * Layout notes that matter for a window that is resized constantly:
 *
 *   * The outer element is `h-full overflow-hidden`, and every pane scrolls
 *     independently. Letting the page itself scroll in a desktop app produces
 *     a window whose chrome drifts out of view.
 *   * Panes that scroll are `min-h-0`/`min-w-0`. Without that, a flex child
 *     refuses to shrink below its content and the scroll container silently
 *     grows past the viewport instead of scrolling.
 *
 * Unread state is fetched once here and handed down as lookup maps rather than
 * being queried in each row. The rail and the sidebar both need it, and a
 * per-row query would be one request per channel on every render of a sidebar
 * that can hold hundreds.
 */

/** Stable empty maps, so a render that has no data does not build new ones. */
const NO_CHANNEL_UNREAD: ReadonlyMap<string, ChannelUnread> = new Map();
const NO_COMMUNITY_UNREAD: ReadonlyMap<string, UnreadSummary['communities'][number]> = new Map();

export function AppShell() {
  const communities = useCommunities();
  const selectedCommunityId = useUiStore((state) => state.selectedCommunityId);
  const selectedChannelId = useUiStore((state) => state.selectedChannelId);
  const selectCommunity = useUiStore((state) => state.selectCommunity);
  const selectChannel = useUiStore((state) => state.selectChannel);
  const showMembers = useUiStore((state) => state.showMembers);

  const tree = useChannelTree(selectedCommunityId);
  const unread = useUnread();

  // Indexed once per fetch rather than scanned per row: a linear search inside
  // a channel row turns drawing the sidebar into O(channels x channels).
  const unreadByChannel = useMemo(() => {
    if (unread.data === undefined) return NO_CHANNEL_UNREAD;
    return new Map(unread.data.channels.map((entry) => [entry.channelId as string, entry]));
  }, [unread.data]);

  const unreadByCommunity = useMemo(() => {
    if (unread.data === undefined) return NO_COMMUNITY_UNREAD;
    return new Map(unread.data.communities.map((entry) => [entry.communityId as string, entry]));
  }, [unread.data]);

  const channels = tree.data?.channels;
  const categories = tree.data?.categories;

  const community = communities.data?.find((item) => item.id === selectedCommunityId);

  // Select the first community once they load, so the app does not open on an
  // empty pane when the user is already a member of something.
  useEffect(() => {
    if (selectedCommunityId !== undefined) return;

    const first = communities.data?.[0];
    if (first !== undefined) selectCommunity(first.id);
  }, [communities.data, selectedCommunityId, selectCommunity]);

  // Same for channels. Also corrects a stale selection: if the selected
  // channel is not in this community's list (it was deleted, or belonged to a
  // community we just switched away from), fall back to the first.
  useEffect(() => {
    const list = channels;
    if (list === undefined || list.length === 0) return;

    const stillValid =
      selectedChannelId !== undefined && list.some((channel) => channel.id === selectedChannelId);

    if (!stillValid) selectChannel(list[0]?.id);
  }, [channels, selectedChannelId, selectChannel]);

  const selectedChannel = channels?.find((item) => item.id === selectedChannelId);

  return (
    <div className="flex h-full overflow-hidden bg-base">
      <CommunityRail
        communities={communities.data ?? []}
        loading={communities.isLoading}
        error={communities.error}
        unreadByCommunity={unreadByCommunity}
      />

      <ChannelSidebar
        channels={channels}
        categories={categories}
        unreadByChannel={unreadByChannel}
        loading={tree.isLoading}
        error={tree.error}
        community={community}
      />

      <main className="flex min-w-0 flex-1 flex-col">
        <ConnectionBanner />
        <div className="flex min-h-0 flex-1">
          <ConversationPane
            channel={selectedChannel}
            hasCommunity={selectedCommunityId !== undefined}
            hasChannels={(channels?.length ?? 0) > 0}
            community={community}
          />
          {showMembers && selectedCommunityId !== undefined ? (
            <MemberSidebar communityId={selectedCommunityId} community={community} />
          ) : null}
        </div>
      </main>

      <Dialogs />
    </div>
  );
}
