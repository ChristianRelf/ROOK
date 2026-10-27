import { useState, type KeyboardEvent } from 'react';
import { Pencil, Trash2 } from 'lucide-react';
import { Avatar, Button, Textarea, cn } from '@rook/ui';
import { limits, type ChannelId, type Message } from '@rook/contracts';
import { useDeleteMessage, useEditMessage } from '../lib/queries.js';
import { MessageAttachment } from './MessageAttachment.jsx';
import { MessageContent } from './MessageContent.jsx';
import { useMentionsMe } from '../lib/mentions.js';

/**
 * One confirmed message.
 *
 * Consecutive messages from the same author within a few minutes are grouped:
 * the avatar and name are shown once and subsequent rows are indented under
 * it. That is what keeps a fast back-and-forth readable instead of a wall of
 * repeated names.
 *
 * Content is rendered as plain text, never as HTML. React escapes it, so a
 * message containing markup is displayed literally — there is no sanitiser to
 * get wrong because nothing is ever interpreted. `MessageContent` splits it
 * into mention and text segments, each still rendered as a text child.
 *
 * A message that mentions the reader gets a left bar and a tinted background,
 * so it is findable while scrolling past without having to read every line.
 */

/** Messages closer together than this from one author are grouped. */
const GROUPING_WINDOW_MS = 5 * 60 * 1000;

export function MessageRow({
  message,
  previous,
  isOwn,
  channelId,
}: {
  readonly message: Message;
  readonly previous: Message | undefined;
  readonly isOwn: boolean;
  readonly channelId: ChannelId;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(message.content ?? '');

  const edit = useEditMessage();
  const remove = useDeleteMessage();

  const deleted = message.deletedAt !== null;
  const mentionsMe = useMentionsMe(message);

  const grouped =
    previous !== undefined &&
    previous.author.id === message.author.id &&
    previous.deletedAt === null &&
    !deleted &&
    new Date(message.createdAt).getTime() - new Date(previous.createdAt).getTime() <
      GROUPING_WINDOW_MS;

  function submitEdit(): void {
    const trimmed = draft.trim();

    // An unchanged or emptied edit is treated as a cancel rather than sending
    // a pointless request or an invalid one.
    if (trimmed.length === 0 || trimmed === message.content) {
      setEditing(false);
      setDraft(message.content ?? '');
      return;
    }

    edit.mutate(
      { messageId: message.id, content: trimmed },
      { onSuccess: () => setEditing(false) },
    );
  }

  function handleEditKeys(event: KeyboardEvent<HTMLTextAreaElement>): void {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      submitEdit();
      return;
    }
    if (event.key === 'Escape') {
      event.preventDefault();
      setEditing(false);
      setDraft(message.content ?? '');
    }
  }

  if (deleted) {
    return (
      <div className="px-4 py-1 pl-16">
        <p className="text-xs italic text-ink-faint">This message was deleted.</p>
      </div>
    );
  }

  return (
    <div
      className={cn(
        'group relative px-4 hover:bg-hover/50',
        grouped ? 'py-0.5' : 'mt-3 py-1',
        // The bar is an inset shadow rather than a border so it does not add
        // to the row's width and shift the text by 2px when it appears.
        mentionsMe && 'bg-warning/[0.06] shadow-[inset_2px_0_0_0_var(--color-warning)]',
      )}
    >
      <div className="flex gap-3">
        {grouped ? (
          // Keeps the text aligned with the grouped message above, and shows
          // the timestamp on hover in the gutter where the avatar would be.
          <div className="w-9 shrink-0 text-right">
            <span className="text-2xs text-ink-faint opacity-0 transition-opacity group-hover:opacity-100">
              {formatTime(message.createdAt)}
            </span>
          </div>
        ) : (
          <Avatar name={message.author.displayName} seed={message.author.id} size="md" />
        )}

        <div className="min-w-0 flex-1">
          {grouped ? null : (
            <div className="flex items-baseline gap-2">
              <span className="text-sm font-medium text-ink">{message.author.displayName}</span>
              <span
                className="text-2xs text-ink-faint"
                title={new Date(message.createdAt).toLocaleString()}
              >
                {formatTimestamp(message.createdAt)}
              </span>
            </div>
          )}

          {editing ? (
            <div className="mt-1 flex flex-col gap-2">
              <Textarea
                value={draft}
                onChange={(event) => setDraft(event.target.value)}
                onKeyDown={handleEditKeys}
                maxLength={limits.messageContentMax}
                rows={Math.min(8, draft.split('\n').length + 1)}
                autoFocus
              />
              <div className="flex items-center gap-2">
                <Button size="sm" variant="primary" onClick={submitEdit} loading={edit.isPending}>
                  Save
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => {
                    setEditing(false);
                    setDraft(message.content ?? '');
                  }}
                >
                  Cancel
                </Button>
                <span className="text-2xs text-ink-faint">Enter to save, Escape to cancel</span>
              </div>
              {edit.isError ? (
                <p className="text-2xs text-danger">Could not save that edit.</p>
              ) : null}
            </div>
          ) : (
            <p className="selectable whitespace-pre-wrap break-words text-sm leading-relaxed text-ink">
              <MessageContent content={message.content ?? ''} />
              {message.editedAt !== null ? (
                <span
                  className="ml-1.5 text-2xs text-ink-faint"
                  title={`Edited ${new Date(message.editedAt).toLocaleString()}`}
                >
                  (edited)
                </span>
              ) : null}
            </p>
          )}

          {message.attachments.length > 0 ? (
            <div className="mt-1.5 flex flex-wrap gap-2">
              {message.attachments.map((asset) => (
                <MessageAttachment key={asset.id} asset={asset} />
              ))}
            </div>
          ) : null}
        </div>
      </div>

      {/* Actions appear on hover only, so the list stays quiet at rest. */}
      {isOwn && !editing ? (
        <div className="absolute right-3 top-0 hidden -translate-y-1/2 items-center gap-0.5 rounded-control border border-line bg-overlay p-0.5 shadow-sm group-hover:flex">
          <button
            type="button"
            onClick={() => setEditing(true)}
            title="Edit"
            className="flex size-6 items-center justify-center rounded text-ink-subtle transition-colors hover:bg-hover hover:text-ink"
          >
            <Pencil className="size-3" />
          </button>
          <button
            type="button"
            onClick={() => remove.mutate({ messageId: message.id, channelId })}
            title="Delete"
            className="flex size-6 items-center justify-center rounded text-ink-subtle transition-colors hover:bg-danger-wash hover:text-danger"
          >
            <Trash2 className="size-3" />
          </button>
        </div>
      ) : null}
    </div>
  );
}

/** `14:32` — the time alone, for a grouped row's hover gutter. */
function formatTime(iso: string): string {
  return new Date(iso).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
}

/**
 * A timestamp scaled to how long ago it was.
 *
 * Today shows a time, yesterday is named, and anything older gets a date:
 * "14:32" is useless on a message from last week, and a full date on every
 * message from the last hour is noise.
 */
function formatTimestamp(iso: string): string {
  const date = new Date(iso);
  const now = new Date();

  const sameDay = date.toDateString() === now.toDateString();
  if (sameDay) return `Today at ${formatTime(iso)}`;

  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);
  if (date.toDateString() === yesterday.toDateString()) {
    return `Yesterday at ${formatTime(iso)}`;
  }

  return date.toLocaleDateString(undefined, {
    day: 'numeric',
    month: 'short',
    ...(date.getFullYear() === now.getFullYear() ? {} : { year: 'numeric' }),
  });
}
