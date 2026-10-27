import { Button, StatusDot } from '@rook/ui';
import { useUiStore } from '../stores/ui.js';
import { useSessionStore } from '../stores/session.js';

/**
 * The connection status strip.
 *
 * Deliberately absent when connected: a permanent "connected" badge is noise.
 * It appears only when something is wrong, which is the one time the user
 * needs to know, and it distinguishes the two cases that need different
 * responses:
 *
 *   reconnecting  transient; the client is retrying with backoff
 *   failed        terminal; retrying cannot help (expired session, old build)
 */
export function ConnectionBanner() {
  const connection = useUiStore((state) => state.connection);
  const detail = useUiStore((state) => state.connectionDetail);
  const signOut = useSessionStore((state) => state.signOut);

  if (connection === 'connected' || connection === 'idle') return null;

  if (connection === 'failed') {
    return (
      <div
        role="alert"
        className="flex shrink-0 items-center gap-2 border-b border-danger/25 bg-danger-wash px-4 py-2"
      >
        <StatusDot state="offline" />
        <p className="min-w-0 flex-1 text-xs text-danger">
          {detail ?? 'Disconnected. Please sign in again.'}
        </p>
        <Button size="sm" variant="ghost" onClick={() => void signOut()}>
          Sign in again
        </Button>
      </div>
    );
  }

  return (
    <div
      role="status"
      className="flex shrink-0 items-center gap-2 border-b border-warning/25 bg-warning/10 px-4 py-2"
    >
      <StatusDot state="connecting" />
      <p className="text-xs text-warning">
        {connection === 'connecting' ? 'Connecting...' : 'Reconnecting...'}
        {/* Messages still send over HTTP while the socket is down, so the
            banner says so rather than implying the app is unusable. */}
        <span className="ml-1 text-ink-subtle">
          You can still send messages; new ones may be delayed.
        </span>
      </p>
    </div>
  );
}
