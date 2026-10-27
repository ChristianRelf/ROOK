import { useRef, useState, type ChangeEvent } from 'react';
import { Upload } from 'lucide-react';
import { Avatar, Button, Field, Input, Spinner } from '@rook/ui';
import { displayNameSchema, mediaContentTypeSchema } from '@rook/contracts';
import { uploadToStorage } from '../lib/api-client.js';
import { useServices } from '../lib/services-context.js';
import { useSessionStore } from '../stores/session.js';
import { platform } from '../lib/platform.js';
import { useServerStore } from '../lib/server-config.js';
import { Modal } from './Dialogs.jsx';

/**
 * Account settings: display name and avatar.
 *
 * The avatar flow exercises the full media pipeline from the client side:
 * authorise, upload directly to storage, confirm, then poll until the worker
 * reports the asset ready, and only then attach it to the profile. The poll is
 * necessary because processing is asynchronous — setting the avatar before the
 * variants exist would reference an asset with nothing to serve.
 */
export function SettingsDialog({ onClose }: { readonly onClose: () => void }) {
  const { api } = useServices();
  const user = useSessionStore((state) => state.user);
  const setUser = useSessionStore((state) => state.setUser);

  const endpoints = useServerStore((state) => state.endpoints);

  const [displayName, setDisplayName] = useState(user?.displayName ?? '');
  const [saving, setSaving] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [avatarUrl, setAvatarUrl] = useState<string | undefined>(undefined);
  const [error, setError] = useState<string | undefined>(undefined);
  const [saved, setSaved] = useState(false);

  const fileInputRef = useRef<HTMLInputElement | null>(null);

  async function saveProfile(): Promise<void> {
    setError(undefined);
    setSaved(false);

    const parsed = displayNameSchema.safeParse(displayName);
    if (!parsed.success) {
      setError(parsed.error.issues[0]?.message ?? 'Enter a valid display name.');
      return;
    }

    if (parsed.data === user?.displayName) {
      onClose();
      return;
    }

    setSaving(true);
    try {
      const result = await api.updateProfile({ displayName: parsed.data });
      setUser(result.user);
      setSaved(true);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Could not save your profile.');
    } finally {
      setSaving(false);
    }
  }

  async function handleAvatar(event: ChangeEvent<HTMLInputElement>): Promise<void> {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (file === undefined) return;

    setError(undefined);

    const typeResult = mediaContentTypeSchema.safeParse(file.type);
    if (!typeResult.success) {
      setError('Choose a PNG, JPEG, WebP or GIF image.');
      return;
    }

    setUploading(true);
    const localPreview = URL.createObjectURL(file);
    setAvatarUrl(localPreview);

    try {
      const authorised = await api.authorizeUpload({
        declaredContentType: typeResult.data,
        declaredByteSize: file.size,
        filename: file.name,
      });

      await uploadToStorage({
        uploadUrl: authorised.uploadUrl,
        requiredHeaders: authorised.requiredHeaders,
        file,
      });

      await api.confirmUpload(authorised.assetId);

      // Processing is asynchronous, so wait for the worker before attaching
      // it. Bounded, so a stuck worker surfaces as an error rather than an
      // indefinite spinner.
      const ready = await waitForProcessing(authorised.assetId);
      if (!ready.ok) {
        setError(ready.reason);
        URL.revokeObjectURL(localPreview);
        setAvatarUrl(undefined);
        return;
      }

      const result = await api.updateProfile({ avatarAssetId: authorised.assetId });
      setUser(result.user);

      // Swap the local blob preview for the processed thumbnail.
      const media = await api.getMedia(authorised.assetId);
      URL.revokeObjectURL(localPreview);
      setAvatarUrl(media.asset.urls.thumbnail);
      setSaved(true);
    } catch (caught) {
      URL.revokeObjectURL(localPreview);
      setAvatarUrl(undefined);
      setError(caught instanceof Error ? caught.message : 'Could not upload that image.');
    } finally {
      setUploading(false);
    }
  }

  /** Polls the asset until it is ready or has failed. */
  async function waitForProcessing(
    assetId: Parameters<typeof api.getMedia>[0],
  ): Promise<{ ok: true } | { ok: false; reason: string }> {
    const deadline = Date.now() + 30_000;

    while (Date.now() < deadline) {
      const { asset } = await api.getMedia(assetId);

      if (asset.status === 'ready') return { ok: true };
      if (asset.status === 'failed') {
        return { ok: false, reason: asset.failureReason ?? 'That image could not be processed.' };
      }

      await new Promise((resolve) => setTimeout(resolve, 500));
    }

    return { ok: false, reason: 'That image is taking too long to process. Try again.' };
  }

  if (user === undefined) return null;

  return (
    <Modal title="Settings" onClose={onClose} width="md">
      <div className="flex flex-col gap-6 px-5 py-5">
        <section className="flex flex-col gap-3">
          <h3 className="text-xs font-semibold uppercase tracking-wider text-ink-faint">Profile</h3>

          <div className="flex items-center gap-4">
            <div className="relative">
              <Avatar name={user.displayName} seed={user.id} src={avatarUrl} size="lg" />
              {uploading ? (
                <div className="absolute inset-0 flex items-center justify-center rounded-pill bg-base/70">
                  <Spinner className="size-5" />
                </div>
              ) : null}
            </div>

            <div className="flex flex-col gap-1.5">
              <input
                ref={fileInputRef}
                type="file"
                accept="image/png,image/jpeg,image/webp,image/gif"
                onChange={(event) => void handleAvatar(event)}
                className="hidden"
              />
              <Button size="sm" onClick={() => fileInputRef.current?.click()} disabled={uploading}>
                <Upload className="size-3.5" />
                Change avatar
              </Button>
              <p className="text-2xs text-ink-subtle">PNG, JPEG, WebP or GIF, up to 10 MB.</p>
            </div>
          </div>

          <Field label="Display name" htmlFor="display-name" error={error}>
            <Input
              id="display-name"
              value={displayName}
              onChange={(event) => {
                setDisplayName(event.target.value);
                setSaved(false);
              }}
              invalid={error !== undefined}
            />
          </Field>

          <div className="flex flex-col gap-1">
            <p className="text-2xs text-ink-subtle">
              Username <span className="font-mono text-ink-muted">@{user.username}</span> cannot be
              changed.
            </p>
            <p className="text-2xs text-ink-subtle">
              Email <span className="text-ink-muted">{user.email}</span>
            </p>
          </div>
        </section>

        <section className="flex flex-col gap-2 border-t border-line pt-4">
          <h3 className="text-xs font-semibold uppercase tracking-wider text-ink-faint">
            Connection
          </h3>
          <p className="font-mono text-2xs text-ink-muted">{endpoints.apiUrl}</p>
          <p className="text-2xs text-ink-subtle">
            To connect to a different server, sign out and change the address on the sign-in screen.
          </p>
        </section>

        <section className="flex flex-col gap-2 border-t border-line pt-4">
          <h3 className="text-xs font-semibold uppercase tracking-wider text-ink-faint">About</h3>
          <p className="text-2xs text-ink-subtle">
            Running {platform.isDesktop ? 'as a desktop app' : 'in a browser'}.
            {platform.isDesktop
              ? ' Your session is stored in the application data directory.'
              : ' Your session is stored in browser storage.'}
          </p>
        </section>

        <div className="flex items-center justify-end gap-2 border-t border-line pt-4">
          {saved ? <span className="mr-auto text-2xs text-success">Saved</span> : null}
          <Button variant="ghost" onClick={onClose}>
            Close
          </Button>
          <Button variant="primary" onClick={() => void saveProfile()} loading={saving}>
            Save changes
          </Button>
        </div>
      </div>
    </Modal>
  );
}
