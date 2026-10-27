import { useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { X } from 'lucide-react';
import { Button, Field, Input, cn } from '@rook/ui';
import { channelNameSchema, communityNameSchema, type CommunityId } from '@rook/contracts';
import { ApiRequestError } from '../lib/api-client.js';
import { useCreateChannel, useCreateCommunity, useJoinCommunity } from '../lib/queries.js';
import { useUiStore } from '../stores/ui.js';
import { SettingsDialog } from './SettingsDialog.jsx';

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
      return <CreateChannelDialog communityId={dialog.communityId} onClose={closeDialog} />;
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
  readonly width?: 'sm' | 'md';
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
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 px-6"
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
          'animate-rise w-full overflow-hidden rounded-panel border border-line bg-raised shadow-2xl outline-none',
          width === 'sm' ? 'max-w-sm' : 'max-w-lg',
        )}
      >
        <header className="flex items-start gap-3 border-b border-line px-5 py-3.5">
          <div className="min-w-0 flex-1">
            <h2 className="text-sm font-semibold text-ink">{title}</h2>
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
            <X className="size-3.5" />
          </button>
        </header>
        {children}
      </div>
    </div>
  );
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
        setError(
          mutationError instanceof ApiRequestError
            ? mutationError.message
            : 'Could not create that community.',
        );
      },
    });
  }

  return (
    <Modal
      title="Create a community"
      description="A community holds channels and members. You will be its owner."
      onClose={onClose}
    >
      <form onSubmit={submit} className="flex flex-col gap-4 px-5 py-4">
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

function JoinCommunityDialog({ onClose }: { readonly onClose: () => void }) {
  const join = useJoinCommunity();
  const [code, setCode] = useState('');
  const [error, setError] = useState<string | undefined>(undefined);

  function submit(event: FormEvent): void {
    event.preventDefault();
    setError(undefined);

    const trimmed = code.trim();
    if (trimmed.length < 4) {
      setError('Enter the code someone shared with you.');
      return;
    }

    join.mutate(trimmed, {
      onSuccess: onClose,
      onError: (mutationError) => {
        if (mutationError instanceof ApiRequestError) {
          // These two are expected outcomes rather than faults, so they get
          // specific wording.
          setError(
            mutationError.code === 'invalid_join_code'
              ? 'That code does not match any community.'
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
      description="Paste the join code someone shared with you."
      onClose={onClose}
    >
      <form onSubmit={submit} className="flex flex-col gap-4 px-5 py-4">
        <Field label="Join code" htmlFor="join-code" error={error}>
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
  onClose,
}: {
  readonly communityId: CommunityId;
  readonly onClose: () => void;
}) {
  const create = useCreateChannel(communityId);
  const [name, setName] = useState('');
  const [topic, setTopic] = useState('');
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
      { name: parsed.data, topic: topic.trim() },
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

  return (
    <Modal title="Create a channel" onClose={onClose}>
      <form onSubmit={submit} className="flex flex-col gap-4 px-5 py-4">
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
