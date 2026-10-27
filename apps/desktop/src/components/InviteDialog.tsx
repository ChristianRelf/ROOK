import { useEffect, useMemo, useState } from 'react';
import { Check, Copy, Link2, Loader2, Trash2 } from 'lucide-react';
import { Button, Field, Select, Spinner, cn } from '@rook/ui';
import {
  inviteDurationSchema,
  type CommunityId,
  type CommunityInvite,
  type InviteDuration,
} from '@rook/contracts';
import { ApiRequestError } from '../lib/api-client.js';
import { useCreateInvite, useInvites, useRevokeInvite } from '../lib/admin-queries.js';
import { Modal } from './Dialogs.jsx';

/**
 * Creating and managing invite links.
 *
 * The flow is deliberately "the link is already there". Opening this dialog
 * creates nothing — it shows the most recent usable invite if one exists, with
 * a copy button under the cursor, because the overwhelmingly common case is
 * "I want to send someone a link right now". Generating a fresh one per visit
 * would leave a community accumulating dozens of live links nobody tracks, and
 * each one is a way in.
 *
 * Expiry and use limits are offered up front rather than hidden behind an
 * "advanced" disclosure. They are the difference between a link you can share
 * in a channel and one you can post publicly, which is a decision worth making
 * deliberately, before sending.
 */

/** Labels for the duration options, in the order they are offered. */
const durationLabels: Readonly<Record<InviteDuration, string>> = {
  '30m': '30 minutes',
  '6h': '6 hours',
  '12h': '12 hours',
  '1d': '1 day',
  '7d': '7 days',
  '30d': '30 days',
  never: 'Never',
};

const useLimitOptions = [
  { value: '', label: 'No limit' },
  { value: '1', label: '1 use' },
  { value: '5', label: '5 uses' },
  { value: '10', label: '10 uses' },
  { value: '25', label: '25 uses' },
  { value: '50', label: '50 uses' },
] as const;

/**
 * Builds the shareable form of a code.
 *
 * There is no hosted web front end for Rook, so a "link" is a `rook://` deep
 * link the desktop app can register as a handler for. The bare code is shown
 * underneath regardless, because a deep link is useless to someone who does
 * not have the app yet and the code works either way.
 */
function inviteLink(code: string): string {
  return `rook://invite/${code}`;
}

export function InviteDialog({
  communityId,
  onClose,
}: {
  readonly communityId: CommunityId;
  readonly onClose: () => void;
}) {
  const invites = useInvites(communityId);
  const createInvite = useCreateInvite(communityId);
  const revokeInvite = useRevokeInvite(communityId);

  const [expiresIn, setExpiresIn] = useState<InviteDuration>('7d');
  const [maxUses, setMaxUses] = useState<string>('');
  const [error, setError] = useState<string | undefined>(undefined);
  const [copiedCode, setCopiedCode] = useState<string | undefined>(undefined);

  const active = useMemo(
    () => (invites.data ?? []).filter((invite) => invite.active),
    [invites.data],
  );
  const inactive = useMemo(
    () => (invites.data ?? []).filter((invite) => !invite.active),
    [invites.data],
  );

  // The newest usable invite gets the prominent copy field. `active` is
  // resolved by the server, which is the only place that can weigh expiry,
  // use count and revocation against the current time at once.
  const featured = active[0];

  async function copy(code: string): Promise<void> {
    try {
      await navigator.clipboard.writeText(inviteLink(code));
      setCopiedCode(code);
    } catch {
      // Clipboard access can be refused. The code is on screen either way, so
      // there is nothing to recover from and nothing worth interrupting for.
    }
  }

  // Resets the tick on a timer so the button does not stay in a success state.
  useEffect(() => {
    if (copiedCode === undefined) return;
    const timer = window.setTimeout(() => setCopiedCode(undefined), 1600);
    return () => window.clearTimeout(timer);
  }, [copiedCode]);

  function generate(): void {
    setError(undefined);

    const parsedDuration = inviteDurationSchema.safeParse(expiresIn);
    if (!parsedDuration.success) {
      setError('Pick how long the link should last.');
      return;
    }

    const uses = maxUses.length > 0 ? Number.parseInt(maxUses, 10) : undefined;

    createInvite.mutate(
      {
        expiresIn: parsedDuration.data,
        ...(uses !== undefined && Number.isFinite(uses) ? { maxUses: uses } : {}),
      },
      {
        onSuccess: (result) => {
          // Copied immediately: generating a link is almost always followed by
          // pasting it, and making that a second deliberate click is friction
          // for no benefit.
          void copy(result.invite.code);
        },
        onError: (mutationError) => {
          setError(
            mutationError instanceof ApiRequestError
              ? mutationError.message
              : 'Could not create an invite link.',
          );
        },
      },
    );
  }

  return (
    <Modal
      title="Invite people"
      description="Share a link so someone can join this community."
      onClose={onClose}
      width="md"
    >
      <div className="flex min-h-0 flex-col gap-5 overflow-y-auto px-5 pb-5">
        {/* --- The link itself --------------------------------------- */}
        <div>
          {invites.isLoading ? (
            <div className="flex h-11 items-center gap-2 rounded-control bg-inset px-3 text-xs text-ink-subtle">
              <Spinner className="size-3" />
              Loading invites
            </div>
          ) : featured !== undefined ? (
            <div className="flex items-center gap-2">
              <div className="flex h-11 min-w-0 flex-1 items-center gap-2 rounded-control bg-inset px-3">
                <Link2 className="size-4 shrink-0 text-ink-faint" />
                <code className="selectable min-w-0 flex-1 truncate font-mono text-sm text-ink">
                  {inviteLink(featured.code)}
                </code>
              </div>
              <Button
                variant="primary"
                onClick={() => void copy(featured.code)}
                className="h-11 shrink-0 px-4"
              >
                {copiedCode === featured.code ? (
                  <>
                    <Check className="size-3.5" />
                    Copied
                  </>
                ) : (
                  <>
                    <Copy className="size-3.5" />
                    Copy
                  </>
                )}
              </Button>
            </div>
          ) : (
            <p className="rounded-control bg-inset px-3 py-3 text-xs text-ink-subtle">
              There is no active invite link. Generate one below.
            </p>
          )}

          {featured !== undefined ? (
            <p className="mt-2 text-2xs text-ink-subtle">
              {describeInvite(featured)} · Code <span className="font-mono">{featured.code}</span>
            </p>
          ) : null}
        </div>

        {/* --- Generating a new one ----------------------------------- */}
        <div className="flex flex-col gap-3 rounded-panel bg-inset/60 p-4">
          <h3 className="text-xs font-semibold uppercase tracking-wide text-ink-subtle">
            Generate a new link
          </h3>

          <div className="grid grid-cols-2 gap-3">
            <Field label="Expires after" htmlFor="invite-expiry">
              <Select
                id="invite-expiry"
                value={expiresIn}
                onChange={(event) => setExpiresIn(event.target.value as InviteDuration)}
              >
                {(Object.keys(durationLabels) as InviteDuration[]).map((option) => (
                  <option key={option} value={option}>
                    {durationLabels[option]}
                  </option>
                ))}
              </Select>
            </Field>

            <Field label="Maximum uses" htmlFor="invite-uses">
              <Select
                id="invite-uses"
                value={maxUses}
                onChange={(event) => setMaxUses(event.target.value)}
              >
                {useLimitOptions.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </Select>
            </Field>
          </div>

          {expiresIn === 'never' && maxUses.length === 0 ? (
            // Said plainly rather than refused. An unlimited link is a
            // legitimate choice for a small private community, and the person
            // making it should know what they are making.
            <p className="text-2xs text-warning">
              This link will never expire and can be used any number of times. Anyone who sees it
              can join.
            </p>
          ) : null}

          {error !== undefined ? <p className="text-2xs text-danger">{error}</p> : null}

          <div className="flex justify-end">
            <Button variant="secondary" loading={createInvite.isPending} onClick={generate}>
              Generate link
            </Button>
          </div>
        </div>

        {/* --- Existing links ----------------------------------------- */}
        {active.length > 1 || inactive.length > 0 ? (
          <div className="flex flex-col gap-1">
            <h3 className="mb-1 text-xs font-semibold uppercase tracking-wide text-ink-subtle">
              All links
            </h3>

            {[...active, ...inactive].map((invite) => (
              <div
                key={invite.id}
                className={cn(
                  'flex items-center gap-3 rounded-control px-2 py-2 hover:bg-hover',
                  !invite.active && 'opacity-60',
                )}
              >
                <code className="selectable w-28 shrink-0 truncate font-mono text-xs text-ink-muted">
                  {invite.code}
                </code>
                <span className="min-w-0 flex-1 truncate text-2xs text-ink-subtle">
                  {describeInvite(invite)} · by {invite.createdBy.displayName}
                </span>

                {invite.active ? (
                  <>
                    <button
                      type="button"
                      onClick={() => void copy(invite.code)}
                      aria-label={`Copy invite ${invite.code}`}
                      className="flex size-7 shrink-0 items-center justify-center rounded-control text-ink-subtle hover:bg-active hover:text-ink"
                    >
                      {copiedCode === invite.code ? (
                        <Check className="size-3.5 text-ink" />
                      ) : (
                        <Copy className="size-3.5" />
                      )}
                    </button>
                    <button
                      type="button"
                      onClick={() => revokeInvite.mutate(invite.id)}
                      disabled={revokeInvite.isPending}
                      aria-label={`Revoke invite ${invite.code}`}
                      className="flex size-7 shrink-0 items-center justify-center rounded-control text-ink-subtle hover:bg-danger hover:text-white"
                    >
                      {revokeInvite.isPending && revokeInvite.variables === invite.id ? (
                        <Loader2 className="size-3.5 animate-spin" />
                      ) : (
                        <Trash2 className="size-3.5" />
                      )}
                    </button>
                  </>
                ) : (
                  <span className="shrink-0 text-2xs font-medium text-ink-faint">
                    {invite.revokedAt !== null ? 'Revoked' : 'Expired'}
                  </span>
                )}
              </div>
            ))}
          </div>
        ) : null}
      </div>
    </Modal>
  );
}

/**
 * A one-line summary of an invite's terms.
 *
 * Phrased as remaining capacity rather than as configuration ("3 of 5 uses
 * left", not "max uses: 5"), because the question being asked of this line is
 * always "can I still send this to someone".
 */
function describeInvite(invite: CommunityInvite): string {
  const parts: string[] = [];

  if (invite.revokedAt !== null) {
    parts.push('Revoked');
  } else if (invite.expiresAt === null) {
    parts.push('Never expires');
  } else {
    const remainingMs = new Date(invite.expiresAt).getTime() - Date.now();
    parts.push(remainingMs <= 0 ? 'Expired' : `Expires in ${formatDuration(remainingMs)}`);
  }

  if (invite.maxUses === null) {
    parts.push(invite.uses === 1 ? '1 use' : `${invite.uses} uses`);
  } else {
    const left = Math.max(0, invite.maxUses - invite.uses);
    parts.push(left === 0 ? 'No uses left' : `${left} of ${invite.maxUses} uses left`);
  }

  return parts.join(' · ');
}

/** Coarse duration, to the largest useful unit. Precision is not the point here. */
function formatDuration(milliseconds: number): string {
  const minutes = Math.round(milliseconds / 60_000);
  if (minutes < 60) return `${Math.max(1, minutes)}m`;

  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h`;

  return `${Math.round(hours / 24)}d`;
}
