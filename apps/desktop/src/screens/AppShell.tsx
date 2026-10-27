import { useEffect } from 'react';
import { useChannels, useCommunities } from '../lib/queries.js';
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
 *   rail      communities, fixed width
 *   sidebar   channels in the selected community
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
 */
export function AppShell() {
  const communities = useCommunities();
  const selectedCommunityId = useUiStore((state) => state.selectedCommunityId);
  const selectedChannelId = useUiStore((state) => state.selectedChannelId);
  const selectCommunity = useUiStore((state) => state.selectCommunity);
  const selectChannel = useUiStore((state) => state.selectChannel);
  const showMembers = useUiStore((state) => state.showMembers);

  const channels = useChannels(selectedCommunityId);

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
    const list = channels.data;
    if (list === undefined || list.length === 0) return;

    const stillValid =
      selectedChannelId !== undefined && list.some((channel) => channel.id === selectedChannelId);

    if (!stillValid) selectChannel(list[0]?.id);
  }, [channels.data, selectedChannelId, selectChannel]);

  return (
    <div className="flex h-full overflow-hidden bg-base">
      <CommunityRail
        communities={communities.data ?? []}
        loading={communities.isLoading}
        error={communities.error}
      />

      <ChannelSidebar
        channels={channels.data ?? []}
        loading={channels.isLoading}
        error={channels.error}
        community={communities.data?.find((item) => item.id === selectedCommunityId)}
      />

      <main className="flex min-w-0 flex-1 flex-col">
        <ConnectionBanner />
        <div className="flex min-h-0 flex-1">
          <ConversationPane
            channel={channels.data?.find((item) => item.id === selectedChannelId)}
            hasCommunity={selectedCommunityId !== undefined}
            hasChannels={(channels.data?.length ?? 0) > 0}
          />
          {showMembers && selectedCommunityId !== undefined ? (
            <MemberSidebar communityId={selectedCommunityId} />
          ) : null}
        </div>
      </main>

      <Dialogs />
    </div>
  );
}
