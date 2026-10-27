import { useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { X } from 'lucide-react';
import { Button, Field, Input, Select, cn } from '@rook/ui';
import {
  categoryNameSchema,
  channelNameSchema,
  communityNameSchema,
  type CategoryId,
  type ChannelId,
  type CommunityId,
} from '@rook/contracts';
import { ApiRequestError } from '../lib/api-client.js';
import { useCreateChannel, useCreateCommunity, useJoinCommunity } from '../lib/queries.js';
import {
  useChannelTree,
  useCreateCategory,
  useDeleteCategory,
  useDeleteChannel,
  useUpdateCategory,
  useUpdateChannel,
} from '../lib/admin-queries.js';
import { extractCode } from '../lib/mentions.js';
import { useUiStore } from '../stores/ui.js';
import { SettingsDialog } from './SettingsDialog.jsx';
import { CommunitySettingsDialog } from './CommunitySettingsDialog.jsx';
import { InviteDialog } from './InviteDialog.jsx';

/**
 * Modal dialogs, driven by the single `dialog` value in the UI store.
 *
 * One state field rather than a boolean per dialog, so two dialogs can never
 * be open at once — a state that is easy to reach with a boolean per dialog
 * and always looks broken.
 */
export function Dialogs() {
  const dialog = useUiStore((state) => state.dialog);
  const closeDialog = useUiStore((state) => state.closeDialog);

  switch (dialog.kind) {
    case 'none':
      return null;
    case 'createCommunity':
      return <CreateCommunityDialog onClose={closeDialog} />;
    case 'joinCommunity':
      return <JoinCommunityDialog onClose={closeDialog} />;
    case 'createChannel':
      return (
        <CreateChannelDialog
          communityId={dialog.communityId}
          initialCategoryId={dialog.categoryId}
          onClose={closeDialog}
        />
      );
    case 'editChannel':
      return (
        <EditChannelDialog
          communityId={dialog.communityId}
          channelId={dialog.channelId}
          onClose={closeDialog}
        />
      );
    case 'deleteChannel':
      return (
        <DeleteChannelDialog
          communityId={dialog.communityId}
          channelId={dialog.channelId}
          onClose={closeDialog}
        />
      );
    case 'createCategory':
      return <CreateCategoryDialog communityId={dialog.communityId} onClose={closeDialog} />;
    case 'editCategory':
      return (
        <EditCategoryDialog
          communityId={dialog.communityId}
          categoryId={dialog.categoryId}
          onClose={closeDialog}
        />
      );
    case 'deleteCategory':
      return (
        <DeleteCategoryDialog
          communityId={dialog.communityId}
          categoryId={dialog.categoryId}
          onClose={closeDialog}
        />
      );
    case 'invite':
      return <InviteDialog communityId={dialog.communityId} onClose={closeDialog} />;
    case 'communitySettings':
      return (
        <CommunitySettingsDialog
          communityId={dialog.communityId}
          initialTab={dialog.tab ?? 'members'}
          onClose={closeDialog}
        />
      );
    case 'settings':
      return <SettingsDialog onClose={closeDialog} />;
  }
}

/**
 * The shared modal frame.
 *
 * Handles the accessibility basics that are easy to skip: Escape closes,
 * clicking the backdrop closes, focus moves into the dialog on open, and the
 * element is marked as a modal dialog for assistive technology.
 */
export function Modal({
  title,
  description,
  onClose,
  children,
  width = 'sm',
}: {
  readonly title: string;
  readonly description?: string;
  readonly onClose: () => void;
  readonly children: ReactNode;
  readonly width?: 'sm' | 'md' | 'lg';
}) {
  const panelRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent): void {
      if (event.key === 'Escape') onClose();
    }
    document.addEventListener('keydown', onKeyDown);

    // Focus the panel so keyboard navigation starts inside the dialog rather
    // than back at the top of the page behind it.
    panelRef.current?.focus();

    return () => document.removeEventListener('keydown', onKeyDown);
  }, [onClose]);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 px-6"
      onMouseDown={(event) => {
        // Only a click on the backdrop itself closes; a drag that ends out
        // here after selecting text inside should not.
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        tabIndex={-1}
        className={cn(
          'animate-rise flex max-h-[85vh] w-full flex-col overflow-hidden rounded-panel',
          'bg-overlay shadow-2xl shadow-black/50 outline-none',
          width === 'sm' ? 'max-w-sm' : width === 'md' ? 'max-w-lg' : 'max-w-3xl',
        )}
      >
        <header className="flex shrink-0 items-start gap-3 px-5 pb-3 pt-4">
          <div className="min-w-0 flex-1">
            <h2 className="text-base font-semibold text-ink">{title}</h2>
            {description !== undefined ? (
              <p className="mt-0.5 text-xs text-ink-subtle">{description}</p>
            ) : null}
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="flex size-7 shrink-0 items-center justify-center rounded-control text-ink-subtle transition-colors hover:bg-hover hover:text-ink"
          >
            <X className="size-4" />
          </button>
        </header>
        {children}
      </div>
    </div>
  );
}

/**
 * A confirmation prompt for something that cannot be undone.
 *
 * Names the thing being destroyed in the body rather than only in the title,
 * because a title is what people skim past. The confirm button carries the
 * verb ("Delete channel"), never "OK" — a destructive button should say what
 * it does when read on its own.
 */
export function ConfirmDialog({
  title,
  body,
  confirmLabel,
  pending,
  error,
  onConfirm,
  onClose,
}: {
  readonly title: string;
  readonly body: ReactNode;
  readonly confirmLabel: string;
  readonly pending: boolean;
  readonly error: string | undefined;
  readonly onConfirm: () => void;
  readonly onClose: () => void;
}) {
  return (
    <Modal title={title} onClose={onClose}>
      <div className="flex flex-col gap-4 px-5 pb-5">
        <div className="text-sm text-ink-muted">{body}</div>

        {error !== undefined ? (
          <p className="rounded-control bg-danger-wash px-3 py-2 text-xs text-danger">{error}</p>
        ) : null}

        <div className="flex justify-end gap-2">
          <Button type="button" variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button type="button" variant="danger" loading={pending} onClick={onConfirm}>
            {confirmLabel}
          </Button>
        </div>
      </div>
    </Modal>
  );
}

/** Normalises a mutation failure into something worth showing a user. */
function describeError(error: unknown, fallback: string): string {
  if (error instanceof ApiRequestError) return error.message;
  return fallback;
}

function CreateCommunityDialog({ onClose }: { readonly onClose: () => void }) {
  const create = useCreateCommunity();
  const [name, setName] = useState('');
  const [error, setError] = useState<string | undefined>(undefined);

  function submit(event: FormEvent): void {
    event.preventDefault();
    setError(undefined);

    const parsed = communityNameSchema.safeParse(name);
    if (!parsed.success) {
      setError(parsed.error.issues[0]?.message ?? 'Enter a valid name.');
      return;
    }

    create.mutate(parsed.data, {
      onSuccess: onClose,
      onError: (mutationError) => {
        setError(describeError(mutationError, 'Could not create that community.'));
      },
    });
  }

  return (
    <Modal
      title="Create a community"
      description="A community holds channels and members. You will be its owner."
      onClose={onClose}
    >
      <form onSubmit={submit} className="flex flex-col gap-4 px-5 pb-5">
        <Field label="Name" htmlFor="community-name" error={error}>
          <Input
            id="community-name"
            value={name}
            onChange={(event) => setName(event.target.value)}
            placeholder="Design team"
            autoFocus
            invalid={error !== undefined}
          />
        </Field>

        <div className="flex justify-end gap-2">
          <Button type="button" variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" variant="primary" loading={create.isPending}>
            Create
          </Button>
        </div>
      </form>
    </Modal>
  );
}

/**
 * Joining by code or by invite link.
 *
 * One field for both, because to the person pasting something they are the
 * same action — and asking them to classify what they hold before they can use
 * it is a question only the implementation cares about. A pasted invite URL is
 * reduced to its last path segment, so the whole link works as well as the
 * bare code.
 */
function JoinCommunityDialog({ onClose }: { readonly onClose: () => void }) {
  const join = useJoinCommunity();
  const [code, setCode] = useState('');
  const [error, setError] = useState<string | undefined>(undefined);

  function submit(event: FormEvent): void {
    event.preventDefault();
    setError(undefined);

    const trimmed = extractCode(code);
    if (trimmed.length < 4) {
      setError('Enter the code or link someone shared with you.');
      return;
    }

    join.mutate(trimmed, {
      onSuccess: onClose,
      onError: (mutationError) => {
        if (mutationError instanceof ApiRequestError) {
          // These are expected outcomes rather than faults, so they get
          // specific wording.
          setError(
            mutationError.code === 'invalid_join_code'
              ? 'That code or link does not match any community.'
              : mutationError.code === 'already_a_member'
                ? 'You are already a member of that community.'
                : mutationError.message,
          );
          return;
        }
        setError('Could not join that community.');
      },
    });
  }

  return (
    <Modal
      title="Join a community"
      description="Paste the join code or invite link someone shared with you."
      onClose={onClose}
    >
      <form onSubmit={submit} className="flex flex-col gap-4 px-5 pb-5">
        <Field label="Code or invite link" htmlFor="join-code" error={error}>
          <Input
            id="join-code"
            value={code}
            onChange={(event) => setCode(event.target.value)}
            placeholder="quiet-harbour-7421"
            autoFocus
            spellCheck={false}
            invalid={error !== undefined}
            className="font-mono"
          />
        </Field>

        <div className="flex justify-end gap-2">
          <Button type="button" variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" variant="primary" loading={join.isPending}>
            Join
          </Button>
        </div>
      </form>
    </Modal>
  );
}

function CreateChannelDialog({
  communityId,
  initialCategoryId,
  onClose,
}: {
  readonly communityId: CommunityId;
  readonly initialCategoryId: CategoryId | undefined;
  readonly onClose: () => void;
}) {
  const create = useCreateChannel(communityId);
  const tree = useChannelTree(communityId);
  const [name, setName] = useState('');
  const [topic, setTopic] = useState('');
  const [categoryId, setCategoryId] = useState<string>(initialCategoryId ?? '');
  const [error, setError] = useState<string | undefined>(undefined);

  function submit(event: FormEvent): void {
    event.preventDefault();
    setError(undefined);

    const parsed = channelNameSchema.safeParse(name);
    if (!parsed.success) {
      setError(parsed.error.issues[0]?.message ?? 'Enter a valid channel name.');
      return;
    }

    create.mutate(
      {
        name: parsed.data,
        topic: topic.trim(),
        ...(categoryId.length > 0 ? { categoryId: categoryId as CategoryId } : {}),
      },
      {
        onSuccess: onClose,
        onError: (mutationError) => {
          setError(
            mutationError instanceof ApiRequestError
              ? mutationError.code === 'conflict'
                ? 'A channel with that name already exists.'
                : mutationError.message
              : 'Could not create that channel.',
          );
        },
      },
    );
  }

  // Shows the normalised result as the user types, so the slugging is not a
  // surprise after submitting.
  const preview = channelNameSchema.safeParse(name);
  const categories = tree.data?.categories ?? [];

  return (
    <Modal title="Create a channel" onClose={onClose}>
      <form onSubmit={submit} className="flex flex-col gap-4 px-5 pb-5">
        <Field
          label="Channel name"
          htmlFor="channel-name"
          hint={
            preview.success
              ? `Will appear as #${preview.data}`
              : 'Lowercase, hyphens instead of spaces.'
          }
          error={error}
        >
          <Input
            id="channel-name"
            value={name}
            onChange={(event) => setName(event.target.value)}
            placeholder="general"
            autoFocus
            invalid={error !== undefined}
          />
        </Field>

        {categories.length > 0 ? (
          <Field
            label="Category"
            htmlFor="channel-category"
            hint="Where it appears in the sidebar."
          >
            <Select
              id="channel-category"
              value={categoryId}
              onChange={(event) => setCategoryId(event.target.value)}
            >
              <option value="">No category</option>
              {categories.map((category) => (
                <option key={category.id} value={category.id}>
                  {category.name}
                </option>
              ))}
            </Select>
          </Field>
        ) : null}

        <Field label="Topic" htmlFor="channel-topic" hint="Optional.">
          <Input
            id="channel-topic"
            value={topic}
            onChange={(event) => setTopic(event.target.value)}
            placeholder="What this channel is for"
            maxLength={512}
          />
        </Field>

        <div className="flex justify-end gap-2">
          <Button type="button" variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" variant="primary" loading={create.isPending}>
            Create
          </Button>
        </div>
      </form>
    </Modal>
  );
}

function EditChannelDialog({
  communityId,
  channelId,
  onClose,
}: {
  readonly communityId: CommunityId;
  readonly channelId: ChannelId;
  readonly onClose: () => void;
}) {
  const tree = useChannelTree(communityId);
  const update = useUpdateChannel(communityId);
  const channel = tree.data?.channels.find((item) => item.id === channelId);

  const [name, setName] = useState(channel?.name ?? '');
  const [topic, setTopic] = useState(channel?.topic ?? '');
  const [categoryId, setCategoryId] = useState<string>(channel?.categoryId ?? '');
  const [error, setError] = useState<string | undefined>(undefined);
  // The form is seeded from the tree, which may still be loading when the
  // dialog opens. This re-seeds once the channel arrives, but only before the
  // user has touched anything — otherwise a background refetch would discard
  // what they were typing.
  const seeded = useRef(channel !== undefined);

  useEffect(() => {
    if (seeded.current || channel === undefined) return;
    seeded.current = true;
    setName(channel.name);
    setTopic(channel.topic ?? '');
    setCategoryId(channel.categoryId ?? '');
  }, [channel]);

  function submit(event: FormEvent): void {
    event.preventDefault();
    setError(undefined);

    const parsed = channelNameSchema.safeParse(name);
    if (!parsed.success) {
      setError(parsed.error.issues[0]?.message ?? 'Enter a valid channel name.');
      return;
    }

    const nextTopic = topic.trim();

    update.mutate(
      {
        channelId,
        name: parsed.data,
        // An empty box clears the topic rather than leaving the old one: null
        // and absent mean different things to the API, and "I deleted the
        // text" means the former.
        topic: nextTopic.length > 0 ? nextTopic : null,
        categoryId: categoryId.length > 0 ? (categoryId as CategoryId) : null,
      },
      {
        onSuccess: onClose,
        onError: (mutationError) => {
          setError(
            mutationError instanceof ApiRequestError && mutationError.code === 'conflict'
              ? 'A channel with that name already exists.'
              : describeError(mutationError, 'Could not save those changes.'),
          );
        },
      },
    );
  }

  const categories = tree.data?.categories ?? [];

  return (
    <Modal title="Edit channel" onClose={onClose}>
      <form onSubmit={submit} className="flex flex-col gap-4 px-5 pb-5">
        <Field label="Channel name" htmlFor="edit-channel-name" error={error}>
          <Input
            id="edit-channel-name"
            value={name}
            onChange={(event) => setName(event.target.value)}
            autoFocus
            invalid={error !== undefined}
          />
        </Field>

        <Field label="Category" htmlFor="edit-channel-category">
          <Select
            id="edit-channel-category"
            value={categoryId}
            onChange={(event) => setCategoryId(event.target.value)}
          >
            <option value="">No category</option>
            {categories.map((category) => (
              <option key={category.id} value={category.id}>
                {category.name}
              </option>
            ))}
          </Select>
        </Field>

        <Field label="Topic" htmlFor="edit-channel-topic" hint="Leave empty to remove it.">
          <Input
            id="edit-channel-topic"
            value={topic}
            onChange={(event) => setTopic(event.target.value)}
            placeholder="What this channel is for"
            maxLength={512}
          />
        </Field>

        <div className="flex justify-end gap-2">
          <Button type="button" variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" variant="primary" loading={update.isPending}>
            Save
          </Button>
        </div>
      </form>
    </Modal>
  );
}

function DeleteChannelDialog({
  communityId,
  channelId,
  onClose,
}: {
  readonly communityId: CommunityId;
  readonly channelId: ChannelId;
  readonly onClose: () => void;
}) {
  const tree = useChannelTree(communityId);
  const remove = useDeleteChannel(communityId);
  const [error, setError] = useState<string | undefined>(undefined);

  const channel = tree.data?.channels.find((item) => item.id === channelId);

  return (
    <ConfirmDialog
      title="Delete channel"
      confirmLabel="Delete channel"
      pending={remove.isPending}
      error={error}
      onClose={onClose}
      onConfirm={() => {
        setError(undefined);
        remove.mutate(channelId, {
          onSuccess: onClose,
          onError: (mutationError) => {
            setError(describeError(mutationError, 'Could not delete that channel.'));
          },
        });
      }}
      body={
        <>
          <p>
            Delete{' '}
            <span className="font-semibold text-ink">#{channel?.name ?? 'this channel'}</span>?
            Every message in it will be removed.
          </p>
          <p className="mt-2 text-xs text-ink-subtle">This cannot be undone.</p>
        </>
      }
    />
  );
}

function CreateCategoryDialog({
  communityId,
  onClose,
}: {
  readonly communityId: CommunityId;
  readonly onClose: () => void;
}) {
  const create = useCreateCategory(communityId);
  const [name, setName] = useState('');
  const [error, setError] = useState<string | undefined>(undefined);

  function submit(event: FormEvent): void {
    event.preventDefault();
    setError(undefined);

    const parsed = categoryNameSchema.safeParse(name);
    if (!parsed.success) {
      setError(parsed.error.issues[0]?.message ?? 'Enter a valid name.');
      return;
    }

    create.mutate(parsed.data, {
      onSuccess: onClose,
      onError: (mutationError) => {
        setError(
          mutationError instanceof ApiRequestError && mutationError.code === 'conflict'
            ? 'A category with that name already exists.'
            : describeError(mutationError, 'Could not create that category.'),
        );
      },
    });
  }

  return (
    <Modal
      title="Create a category"
      description="Categories group channels in the sidebar. They carry no permissions of their own."
      onClose={onClose}
    >
      <form onSubmit={submit} className="flex flex-col gap-4 px-5 pb-5">
        <Field label="Category name" htmlFor="category-name" error={error}>
          <Input
            id="category-name"
            value={name}
            onChange={(event) => setName(event.target.value)}
            placeholder="Text channels"
            autoFocus
            invalid={error !== undefined}
          />
        </Field>

        <div className="flex justify-end gap-2">
          <Button type="button" variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" variant="primary" loading={create.isPending}>
            Create
          </Button>
        </div>
      </form>
    </Modal>
  );
}

function EditCategoryDialog({
  communityId,
  categoryId,
  onClose,
}: {
  readonly communityId: CommunityId;
  readonly categoryId: CategoryId;
  readonly onClose: () => void;
}) {
  const tree = useChannelTree(communityId);
  const update = useUpdateCategory(communityId);
  const category = tree.data?.categories.find((item) => item.id === categoryId);

  const [name, setName] = useState(category?.name ?? '');
  const [error, setError] = useState<string | undefined>(undefined);
  const seeded = useRef(category !== undefined);

  useEffect(() => {
    if (seeded.current || category === undefined) return;
    seeded.current = true;
    setName(category.name);
  }, [category]);

  function submit(event: FormEvent): void {
    event.preventDefault();
    setError(undefined);

    const parsed = categoryNameSchema.safeParse(name);
    if (!parsed.success) {
      setError(parsed.error.issues[0]?.message ?? 'Enter a valid name.');
      return;
    }

    update.mutate(
      { categoryId, name: parsed.data },
      {
        onSuccess: onClose,
        onError: (mutationError) => {
          setError(
            mutationError instanceof ApiRequestError && mutationError.code === 'conflict'
              ? 'A category with that name already exists.'
              : describeError(mutationError, 'Could not rename that category.'),
          );
        },
      },
    );
  }

  return (
    <Modal title="Rename category" onClose={onClose}>
      <form onSubmit={submit} className="flex flex-col gap-4 px-5 pb-5">
        <Field label="Category name" htmlFor="edit-category-name" error={error}>
          <Input
            id="edit-category-name"
            value={name}
            onChange={(event) => setName(event.target.value)}
            autoFocus
            invalid={error !== undefined}
          />
        </Field>

        <div className="flex justify-end gap-2">
          <Button type="button" variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" variant="primary" loading={update.isPending}>
            Save
          </Button>
        </div>
      </form>
    </Modal>
  );
}

function DeleteCategoryDialog({
  communityId,
  categoryId,
  onClose,
}: {
  readonly communityId: CommunityId;
  readonly categoryId: CategoryId;
  readonly onClose: () => void;
}) {
  const tree = useChannelTree(communityId);
  const remove = useDeleteCategory(communityId);
  const [error, setError] = useState<string | undefined>(undefined);

  const category = tree.data?.categories.find((item) => item.id === categoryId);
  const affected = (tree.data?.channels ?? []).filter(
    (channel) => channel.categoryId === categoryId,
  ).length;

  return (
    <ConfirmDialog
      title="Delete category"
      confirmLabel="Delete category"
      pending={remove.isPending}
      error={error}
      onClose={onClose}
      onConfirm={() => {
        setError(undefined);
        remove.mutate(categoryId, {
          onSuccess: onClose,
          onError: (mutationError) => {
            setError(describeError(mutationError, 'Could not delete that category.'));
          },
        });
      }}
      body={
        <>
          <p>
            Delete{' '}
            <span className="font-semibold text-ink">{category?.name ?? 'this category'}</span>?
          </p>
          {/* Stated explicitly, because "delete category" sounds like it
              deletes the conversations inside it. It does not. */}
          <p className="mt-2 text-xs text-ink-subtle">
            {affected === 0
              ? 'It has no channels in it.'
              : affected === 1
                ? 'Its channel will be kept and moved to the top of the sidebar.'
                : `Its ${affected} channels will be kept and moved to the top of the sidebar.`}
          </p>
        </>
      }
    />
  );
}
