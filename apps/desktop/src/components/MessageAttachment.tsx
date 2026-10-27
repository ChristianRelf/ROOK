import { useQuery } from '@tanstack/react-query';
import { AlertTriangle, ImageIcon } from 'lucide-react';
import { Spinner, cn } from '@rook/ui';
import type { MediaAsset } from '@rook/contracts';
import { useServices } from '../lib/services-context.js';
import { queryKeys } from '../lib/queries.js';

/**
 * An image attached to a message.
 *
 * The asset embedded in the message carries metadata but no URLs, because
 * download URLs are presigned and short-lived -- caching them in the message
 * row would mean serving expired links. So the component fetches a fresh URL
 * when it renders, keyed by asset id.
 *
 * It renders four distinct states, which is the point: a thumbnail that is
 * still processing, one that failed, and one that is ready all need to look
 * different, or the user cannot tell a slow upload from a broken one.
 */
export function MessageAttachment({ asset }: { readonly asset: MediaAsset }) {
  const { api } = useServices();

  // Only fetch URLs once the worker has finished. A `media.updated` event
  // invalidates this query, so a thumbnail appears without a manual refresh.
  const ready = asset.status === 'ready';

  const media = useQuery({
    queryKey: queryKeys.media(asset.id),
    queryFn: ({ signal }) => api.getMedia(asset.id, signal).then((result) => result.asset),
    enabled: ready,
    // URLs expire, so this must not be cached indefinitely. Refetched a
    // little before the configured 15-minute lifetime.
    staleTime: 10 * 60 * 1000,
  });

  if (asset.status === 'failed') {
    return (
      <div className="flex items-center gap-2 rounded-panel border border-danger/25 bg-danger-wash px-3 py-2">
        <AlertTriangle className="size-3.5 shrink-0 text-danger" />
        <span className="text-xs text-danger">
          {asset.failureReason ?? 'This image could not be processed.'}
        </span>
      </div>
    );
  }

  if (!ready) {
    return (
      <div className="flex h-28 w-40 flex-col items-center justify-center gap-2 rounded-panel border border-line bg-inset">
        <Spinner className="size-4 text-ink-faint" />
        <span className="text-2xs text-ink-faint">Processing</span>
      </div>
    );
  }

  const thumbnail = media.data?.urls?.thumbnail;
  const preview = media.data?.urls?.preview;

  if (media.isLoading || thumbnail === undefined) {
    return (
      <div className="flex h-28 w-40 items-center justify-center rounded-panel border border-line bg-inset">
        {media.isError ? (
          <ImageIcon className="size-5 text-ink-faint" />
        ) : (
          <Spinner className="size-4 text-ink-faint" />
        )}
      </div>
    );
  }

  // Dimensions come from the recorded variant, so the row reserves the right
  // space before the image loads and the list does not jump.
  const variant = asset.variants.find((item) => item.name === 'thumbnail');

  return (
    <a
      href={preview ?? thumbnail}
      target="_blank"
      rel="noopener noreferrer"
      className={cn(
        'block overflow-hidden rounded-panel border border-line',
        'transition-colors duration-(--duration-fast) hover:border-line-strong',
      )}
    >
      <img
        src={thumbnail}
        width={variant?.width}
        height={variant?.height}
        alt="Attached image"
        loading="lazy"
        draggable={false}
        className="block max-h-64 w-auto object-cover"
      />
    </a>
  );
}
