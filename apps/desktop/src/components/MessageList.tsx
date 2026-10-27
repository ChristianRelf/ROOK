import { useCallback, useEffect, useLayoutEffect, useMemo, useRef } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import { AlertTriangle, RotateCcw, X } from 'lucide-react';
import { Avatar, Button, Spinner, cn } from '@rook/ui';
import type { ChannelId } from '@rook/contracts';
import { useMessagesStore, type DisplayMessage } from '../stores/messages.js';
import { useSessionStore } from '../stores/session.js';
import { useLoadOlderMessages, useSendMessage } from '../lib/queries.js';
import { MessageRow } from './MessageRow.jsx';

/**
 * The virtualised message list.
 *
 * Virtualisation is not premature here: a busy channel has tens of thousands
 * of messages, and mounting a DOM node per message makes scrolling unusable
 * long before that. Only the visible window plus a small overscan is rendered.
 *
 * Three behaviours make a virtualised chat list feel right, and each is easy
 * to get wrong:
 *
 *   1. **Stick to the bottom.** New messages should scroll into view, but only
 *      if the user is already at the bottom. Yanking the viewport while
 *      someone is reading history is the single most irritating bug in a chat
 *      client, so the scroll position is checked first.
 *
 *   2. **Measured rows.** Messages vary in height (one line, ten lines, an
 *      attachment). `measureElement` reports real heights, so the scrollbar
 *      does not jump as estimates are corrected.
 *
 *   3. **Load older without losing your place.** Prepending history changes
 *      the scroll height; the offset is restored afterwards so the row you
 *      were reading stays under the cursor.
 */

/** How close to the bottom still counts as "at the bottom", in pixels. */
const STICK_THRESHOLD = 120;

/** Distance from the top that triggers loading older history. */
const LOAD_OLDER_THRESHOLD = 200;

export function MessageList({ channelId }: { readonly channelId: ChannelId }) {
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const currentUserId = useSessionStore((state) => state.user?.id);

  // Subscribe to this channel's slice specifically, then derive the ordered
  // list from it. Deriving inside useMemo from the subscribed value (rather
  // than calling getState() and listing the slice as a dependency) keeps the
  // computation and its inputs honestly connected.
  const channelState = useMessagesStore((state) => state.channels[channelId]);

  const items = useMemo<DisplayMessage[]>(() => {
    if (channelState === undefined) return [];

    // UUIDv7 ids sort chronologically, so this is creation order.
    const confirmed = [...channelState.byId.values()]
      .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
      .map((message): DisplayMessage => ({ kind: 'confirmed', message }));

    // Pending last: they have no server id, and they are what the user just
    // typed, so they belong at the bottom.
    const pending = [...channelState.pending.values()]
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
      .map((item): DisplayMessage => ({ kind: 'pending', pending: item }));

    return [...confirmed, ...pending];
  }, [channelState]);
  const loadOlder = useLoadOlderMessages(channelId);
  const send = useSendMessage(channelId);

  /** Tracks whether the user is pinned to the bottom. */
  const stuckToBottom = useRef(true);
  /** Scroll height before a prepend, so the offset can be restored. */
  const prependAnchor = useRef<{ height: number; offset: number } | undefined>(undefined);

  const virtualizer = useVirtualizer({
    count: items.length,
    getScrollElement: () => scrollRef.current,
    // A one-line message with its header. Corrected by measureElement.
    estimateSize: () => 56,
    // Enough to cover a fast scroll without rendering the whole history.
    overscan: 12,
    // Keyed by message id so React reuses the right nodes when rows shift,
    // rather than by index, which would remount everything on a prepend.
    getItemKey: (index) => {
      const item = items[index];
      if (item === undefined) return index;
      return item.kind === 'confirmed' ? item.message.id : item.pending.idempotencyKey;
    },
  });

  const handleScroll = useCallback(() => {
    const element = scrollRef.current;
    if (element === null) return;

    const distanceFromBottom = element.scrollHeight - element.scrollTop - element.clientHeight;
    stuckToBottom.current = distanceFromBottom < STICK_THRESHOLD;

    if (element.scrollTop < LOAD_OLDER_THRESHOLD) {
      // Record where we are so the position can be restored once the older
      // page has been prepended and the scroll height has grown.
      prependAnchor.current = { height: element.scrollHeight, offset: element.scrollTop };
      void loadOlder().catch(() => {
        // Surfaced by the banner below; the list stays usable.
        prependAnchor.current = undefined;
      });
    }
  }, [loadOlder]);

  // Restore the scroll offset after older messages are prepended. Layout
  // effect, so it runs before the browser paints the shifted content.
  useLayoutEffect(() => {
    const element = scrollRef.current;
    const anchor = prependAnchor.current;
    if (element === null || anchor === undefined) return;

    const growth = element.scrollHeight - anchor.height;
    if (growth > 0) {
      element.scrollTop = anchor.offset + growth;
      prependAnchor.current = undefined;
    }
  }, [items.length]);

  // Follow new messages, but only when already at the bottom.
  useEffect(() => {
    if (!stuckToBottom.current || items.length === 0) return;
    virtualizer.scrollToIndex(items.length - 1, { align: 'end' });
  }, [items.length, virtualizer]);

  // Jump to the bottom when the channel changes. `instant` because animating
  // a scroll on channel switch just looks like lag.
  useEffect(() => {
    stuckToBottom.current = true;
    if (items.length > 0) {
      virtualizer.scrollToIndex(items.length - 1, { align: 'end', behavior: 'auto' });
    }
  }, [channelId, virtualizer, items.length]);

  const retry = useCallback(
    (idempotencyKey: string, content: string, attachmentIds: readonly string[]) => {
      // The same key is reused, so the server treats this as the same send
      // rather than creating a second message.
      void send(content, [...attachmentIds], idempotencyKey);
    },
    [send],
  );

  const discard = useCallback(
    (idempotencyKey: string) => {
      useMessagesStore.getState().removePending(channelId, idempotencyKey);
    },
    [channelId],
  );

  const virtualItems = virtualizer.getVirtualItems();

  return (
    <div
      ref={scrollRef}
      onScroll={handleScroll}
      className="min-h-0 flex-1 overflow-y-auto overscroll-contain"
    >
      {channelState?.loadingOlder === true ? (
        <div className="flex items-center justify-center gap-2 py-3 text-xs text-ink-subtle">
          <Spinner className="size-3" />
          Loading earlier messages
        </div>
      ) : null}

      {channelState?.hasMore === false && items.length > 0 ? (
        <p className="px-4 py-4 text-center text-2xs text-ink-faint">
          This is the beginning of the channel.
        </p>
      ) : null}

      {/* The spacer carries the full virtual height so the scrollbar is
          accurate, while only the visible rows are mounted inside it. */}
      <div style={{ height: virtualizer.getTotalSize(), position: 'relative' }}>
        {virtualItems.map((virtualItem) => {
          const item = items[virtualItem.index];
          if (item === undefined) return null;

          const previous = items[virtualItem.index - 1];

          return (
            <div
              key={virtualItem.key}
              // Reports the real rendered height back to the virtualizer.
              ref={virtualizer.measureElement}
              data-index={virtualItem.index}
              style={{
                position: 'absolute',
                top: 0,
                left: 0,
                width: '100%',
                transform: `translateY(${virtualItem.start}px)`,
              }}
            >
              {item.kind === 'confirmed' ? (
                <MessageRow
                  message={item.message}
                  previous={previous?.kind === 'confirmed' ? previous.message : undefined}
                  isOwn={item.message.author.id === currentUserId}
                  channelId={channelId}
                />
              ) : (
                <PendingRow pending={item.pending} onRetry={retry} onDiscard={discard} />
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

/**
 * An unconfirmed message.
 *
 * Pending is shown at reduced opacity; failed is shown with its reason and the
 * two actions that make sense. A failed send is never silently dropped and
 * never retried behind the user's back — the spec asks for delivery failures
 * to be visible, and this is where that happens.
 */
function PendingRow({
  pending,
  onRetry,
  onDiscard,
}: {
  readonly pending: {
    readonly idempotencyKey: string;
    readonly content: string;
    readonly attachmentIds: readonly string[];
    readonly state: 'pending' | 'failed';
    readonly failureReason: string | undefined;
  };
  readonly onRetry: (key: string, content: string, attachmentIds: readonly string[]) => void;
  readonly onDiscard: (key: string) => void;
}) {
  const user = useSessionStore((state) => state.user);
  const failed = pending.state === 'failed';

  return (
    <div className={cn('group px-4 py-1', failed ? 'bg-danger-wash/30' : undefined)}>
      <div className="flex gap-3">
        <Avatar
          name={user?.displayName ?? '?'}
          seed={user?.id ?? ''}
          size="md"
          className={failed ? 'opacity-60' : 'opacity-70'}
        />
        <div className="min-w-0 flex-1">
          <div className="flex items-baseline gap-2">
            <span className="text-sm font-medium text-ink">{user?.displayName}</span>
            <span className="text-2xs text-ink-faint">{failed ? 'Not sent' : 'Sending...'}</span>
          </div>

          <p
            className={cn(
              'selectable whitespace-pre-wrap break-words text-sm',
              failed ? 'text-ink-muted' : 'text-ink-muted opacity-70',
            )}
          >
            {pending.content}
          </p>

          {failed ? (
            <div className="mt-1.5 flex items-center gap-2">
              <AlertTriangle className="size-3.5 shrink-0 text-danger" />
              <span className="min-w-0 flex-1 truncate text-2xs text-danger">
                {pending.failureReason ?? 'Could not send.'}
              </span>
              <Button
                size="sm"
                variant="ghost"
                onClick={() =>
                  onRetry(pending.idempotencyKey, pending.content, pending.attachmentIds)
                }
              >
                <RotateCcw className="size-3" />
                Retry
              </Button>
              <Button
                size="sm"
                variant="ghost"
                onClick={() => onDiscard(pending.idempotencyKey)}
                title="Discard this message"
              >
                <X className="size-3" />
              </Button>
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
}
