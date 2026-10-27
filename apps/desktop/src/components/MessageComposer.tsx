import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ChangeEvent,
  type KeyboardEvent,
} from 'react';
import { ImagePlus, Send, X } from 'lucide-react';
import { Button, Spinner, cn } from '@rook/ui';
import { limits, mediaContentTypeSchema, type Channel, type MediaAssetId } from '@rook/contracts';
import { uploadToStorage } from '../lib/api-client.js';
import { useServices } from '../lib/services-context.js';
import { useSendMessage } from '../lib/queries.js';
import { useUiStore } from '../stores/ui.js';

/**
 * The message composer.
 *
 * Behaviour that makes typing feel right:
 *
 *   * Enter sends, Shift+Enter inserts a newline. The textarea grows with the
 *     content up to a cap, then scrolls.
 *   * Drafts persist per channel in the UI store, so switching channel and
 *     coming back does not discard half-typed text.
 *   * Typing notifications are sent as a side effect of typing, throttled by
 *     the realtime client. The server debounces again.
 *
 * Attachments complete the three-step upload before the message is sent, so a
 * message is only ever created referencing assets that already exist and have
 * been verified. The alternative — sending the message first and attaching
 * later — would need a mutable message and a second event.
 */

/** Rows the textarea may grow to before it starts scrolling. */
const MAX_ROWS = 10;

interface PendingAttachment {
  readonly localId: string;
  readonly file: File;
  readonly previewUrl: string;
  readonly state: 'uploading' | 'ready' | 'failed';
  readonly assetId: MediaAssetId | undefined;
  readonly error: string | undefined;
}

export function MessageComposer({ channel }: { readonly channel: Channel }) {
  const { api, realtime } = useServices();
  const send = useSendMessage(channel.id);

  const draft = useUiStore((state) => state.drafts[channel.id] ?? '');
  const setDraft = useUiStore((state) => state.setDraft);

  const [attachments, setAttachments] = useState<PendingAttachment[]>([]);
  const [sending, setSending] = useState(false);

  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  // Focus the composer when the channel changes: the user almost always wants
  // to type next.
  useEffect(() => {
    textareaRef.current?.focus();
  }, [channel.id]);

  // Object URLs are a memory leak if they are not revoked.
  useEffect(
    () => () => {
      for (const attachment of attachments) URL.revokeObjectURL(attachment.previewUrl);
    },
    [attachments],
  );

  const handleChange = useCallback(
    (event: ChangeEvent<HTMLTextAreaElement>) => {
      setDraft(channel.id, event.target.value);

      // Only announce typing when there is actually content, so clearing the
      // box does not tell everyone you are typing.
      if (event.target.value.trim().length > 0) {
        realtime.sendTyping(channel.id);
      }
    },
    [channel.id, setDraft, realtime],
  );

  async function submit(): Promise<void> {
    const readyIds = attachments
      .filter((attachment) => attachment.state === 'ready' && attachment.assetId !== undefined)
      .map((attachment) => attachment.assetId as MediaAssetId);

    if (draft.trim().length === 0 && readyIds.length === 0) return;

    // An upload still in flight would be dropped from the message, so the
    // send waits rather than silently losing an attachment.
    if (attachments.some((attachment) => attachment.state === 'uploading')) return;

    setSending(true);
    try {
      await send(draft, readyIds);

      for (const attachment of attachments) URL.revokeObjectURL(attachment.previewUrl);
      setAttachments([]);
    } finally {
      setSending(false);
      textareaRef.current?.focus();
    }
  }

  function handleKeyDown(event: KeyboardEvent<HTMLTextAreaElement>): void {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      void submit();
    }
  }

  /** Runs the full authorise -> PUT -> confirm sequence for one file. */
  async function uploadFile(file: File): Promise<void> {
    const localId = crypto.randomUUID();
    const previewUrl = URL.createObjectURL(file);

    // Validated client-side first so an unsupported file is refused
    // immediately instead of after a round trip. The server checks the real
    // bytes regardless.
    const typeResult = mediaContentTypeSchema.safeParse(file.type);
    if (!typeResult.success) {
      setAttachments((current) => [
        ...current,
        {
          localId,
          file,
          previewUrl,
          state: 'failed',
          assetId: undefined,
          error: 'Only PNG, JPEG, WebP and GIF images are supported.',
        },
      ]);
      return;
    }

    setAttachments((current) => [
      ...current,
      { localId, file, previewUrl, state: 'uploading', assetId: undefined, error: undefined },
    ]);

    const fail = (message: string): void => {
      setAttachments((current) =>
        current.map((attachment) =>
          attachment.localId === localId
            ? { ...attachment, state: 'failed', error: message }
            : attachment,
        ),
      );
    };

    try {
      const authorised = await api.authorizeUpload({
        declaredContentType: typeResult.data,
        declaredByteSize: file.size,
        filename: file.name,
      });

      // Straight to object storage: the bytes never pass through the API.
      await uploadToStorage({
        uploadUrl: authorised.uploadUrl,
        requiredHeaders: authorised.requiredHeaders,
        file,
      });

      const confirmed = await api.confirmUpload(authorised.assetId);

      setAttachments((current) =>
        current.map((attachment) =>
          attachment.localId === localId
            ? { ...attachment, state: 'ready', assetId: confirmed.asset.id }
            : attachment,
        ),
      );
    } catch (error) {
      fail(error instanceof Error ? error.message : 'Upload failed.');
    }
  }

  function handleFiles(event: ChangeEvent<HTMLInputElement>): void {
    const files = Array.from(event.target.files ?? []);
    // Reset so selecting the same file twice still fires a change event.
    event.target.value = '';

    for (const file of files.slice(0, 10)) {
      void uploadFile(file);
    }
  }

  function removeAttachment(localId: string): void {
    setAttachments((current) => {
      const target = current.find((attachment) => attachment.localId === localId);
      if (target !== undefined) URL.revokeObjectURL(target.previewUrl);
      return current.filter((attachment) => attachment.localId !== localId);
    });
  }

  const uploading = attachments.some((attachment) => attachment.state === 'uploading');
  const canSend =
    !sending &&
    !uploading &&
    (draft.trim().length > 0 || attachments.some((item) => item.state === 'ready'));

  const rows = Math.min(MAX_ROWS, draft.split('\n').length);
  const nearLimit = draft.length > limits.messageContentMax * 0.9;

  return (
    <div className="shrink-0 px-4 pb-4">
      {attachments.length > 0 ? (
        <div className="mb-2 flex flex-wrap gap-2 rounded-panel border border-line bg-inset p-2">
          {attachments.map((attachment) => (
            <div
              key={attachment.localId}
              className={cn(
                'group relative size-16 overflow-hidden rounded-control border',
                attachment.state === 'failed' ? 'border-danger' : 'border-line',
              )}
            >
              <img
                src={attachment.previewUrl}
                alt=""
                className="size-full object-cover"
                draggable={false}
              />

              {attachment.state === 'uploading' ? (
                <div className="absolute inset-0 flex items-center justify-center bg-base/70">
                  <Spinner className="size-4" />
                </div>
              ) : null}

              {attachment.state === 'failed' ? (
                <div
                  title={attachment.error}
                  className="absolute inset-0 flex items-center justify-center bg-danger-wash text-2xs text-danger"
                >
                  Failed
                </div>
              ) : null}

              <button
                type="button"
                onClick={() => removeAttachment(attachment.localId)}
                title="Remove"
                className="absolute right-0.5 top-0.5 hidden size-4 items-center justify-center rounded-pill bg-base/80 text-ink-muted hover:text-ink group-hover:flex"
              >
                <X className="size-2.5" />
              </button>
            </div>
          ))}
        </div>
      ) : null}

      <div
        className={cn(
          'flex items-end gap-2 rounded-panel border border-line bg-inset px-2 py-1.5',
          'transition-colors duration-(--duration-fast) focus-within:border-line-strong',
        )}
      >
        <input
          ref={fileInputRef}
          type="file"
          accept="image/png,image/jpeg,image/webp,image/gif"
          multiple
          onChange={handleFiles}
          className="hidden"
        />

        <button
          type="button"
          onClick={() => fileInputRef.current?.click()}
          title="Attach an image"
          className="flex size-8 shrink-0 items-center justify-center rounded-control text-ink-subtle transition-colors hover:bg-hover hover:text-ink"
        >
          <ImagePlus className="size-4" />
        </button>

        <textarea
          ref={textareaRef}
          value={draft}
          onChange={handleChange}
          onKeyDown={handleKeyDown}
          rows={rows}
          maxLength={limits.messageContentMax}
          placeholder={`Message #${channel.name}`}
          aria-label={`Message #${channel.name}`}
          className={cn(
            'selectable min-h-8 flex-1 resize-none bg-transparent py-1.5 text-sm text-ink',
            'placeholder:text-ink-faint focus:outline-none',
          )}
        />

        {/* Shown only when close to the cap, so it is information rather than
            a permanent counter nagging at the user. */}
        {nearLimit ? (
          <span className="shrink-0 self-center text-2xs text-ink-subtle">
            {limits.messageContentMax - draft.length}
          </span>
        ) : null}

        <Button
          variant={canSend ? 'primary' : 'ghost'}
          size="sm"
          onClick={() => void submit()}
          disabled={!canSend}
          loading={sending}
          title="Send (Enter)"
          className="shrink-0 self-center"
        >
          {sending ? null : <Send className="size-3.5" />}
        </Button>
      </div>

      <p className="mt-1 px-1 text-2xs text-ink-faint">Enter to send, Shift+Enter for a new line</p>
    </div>
  );
}
