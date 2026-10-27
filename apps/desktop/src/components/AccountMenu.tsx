import { useEffect, useRef, useState } from 'react';
import { LogOut, Settings } from 'lucide-react';
import { Avatar, StatusDot, cn } from '@rook/ui';
import { useServices } from '../lib/services-context.js';
import { useSessionStore } from '../stores/session.js';
import { useUiStore } from '../stores/ui.js';

/**
 * The account button at the foot of the community rail, with its menu.
 *
 * Signing out calls the API first so the session is actually revoked
 * server-side, then clears local state -- but local state is cleared even if
 * that call fails. A user who clicks "sign out" must end up signed out
 * locally regardless of whether the network cooperated.
 */
export function AccountMenu() {
  const { api } = useServices();
  const user = useSessionStore((state) => state.user);
  const signOut = useSessionStore((state) => state.signOut);
  const openDialog = useUiStore((state) => state.openDialog);
  const connection = useUiStore((state) => state.connection);

  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement | null>(null);

  // Close on an outside click or Escape, which is what people expect from a
  // menu and what keyboard users need.
  useEffect(() => {
    if (!open) return;

    function onPointerDown(event: MouseEvent): void {
      if (containerRef.current?.contains(event.target as Node) === false) setOpen(false);
    }
    function onKeyDown(event: KeyboardEvent): void {
      if (event.key === 'Escape') setOpen(false);
    }

    document.addEventListener('mousedown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('mousedown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [open]);

  async function handleSignOut(): Promise<void> {
    setOpen(false);
    try {
      await api.logout();
    } catch {
      // Revoking server-side is best-effort: the token may already be invalid,
      // or the server unreachable. Either way the local session must end.
    }
    await signOut();
  }

  if (user === undefined) return null;

  const connectionState =
    connection === 'connected' ? 'online' : connection === 'failed' ? 'offline' : 'connecting';

  return (
    <div ref={containerRef} className="relative mt-auto pt-2">
      <button
        type="button"
        onClick={() => setOpen((current) => !current)}
        title={`${user.displayName} (@${user.username})`}
        aria-haspopup="menu"
        aria-expanded={open}
        className="relative flex size-11 items-center justify-center rounded-panel transition-colors hover:bg-hover"
      >
        <Avatar name={user.displayName} seed={user.id} size="sm" />
        {/* The connection dot lives on the avatar, where a user already looks
            to check their own state. */}
        <StatusDot
          state={connectionState}
          className="absolute bottom-1.5 right-1.5 ring-2 ring-inset"
        />
      </button>

      {open ? (
        <div
          role="menu"
          className={cn(
            'absolute bottom-0 left-full z-20 ml-2 w-52 overflow-hidden',
            'animate-rise rounded-panel border border-line bg-overlay shadow-lg',
          )}
        >
          <div className="border-b border-line px-3 py-2.5">
            <p className="truncate text-sm font-medium text-ink">{user.displayName}</p>
            <p className="truncate text-2xs text-ink-subtle">@{user.username}</p>
          </div>

          <button
            type="button"
            role="menuitem"
            onClick={() => {
              setOpen(false);
              openDialog({ kind: 'settings' });
            }}
            className="flex w-full items-center gap-2 px-3 py-2 text-left text-xs text-ink-muted transition-colors hover:bg-hover hover:text-ink"
          >
            <Settings className="size-3.5" />
            Settings
          </button>

          <button
            type="button"
            role="menuitem"
            onClick={() => void handleSignOut()}
            className="flex w-full items-center gap-2 px-3 py-2 text-left text-xs text-danger transition-colors hover:bg-danger-wash"
          >
            <LogOut className="size-3.5" />
            Sign out
          </button>
        </div>
      ) : null}
    </div>
  );
}
