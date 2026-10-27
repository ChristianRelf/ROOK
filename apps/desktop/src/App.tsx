import { useEffect, useRef, useState } from 'react';
import { Spinner } from '@rook/ui';
import { useServices } from './lib/services-context.js';
import { useSessionStore } from './stores/session.js';
import { AuthScreen } from './screens/AuthScreen.jsx';
import { AppShell } from './screens/AppShell.jsx';

/**
 * The root component, which does exactly one thing: decide which screen to
 * show, based on whether there is a live session.
 *
 * On launch it reads the persisted token and validates it against the API
 * before rendering anything. That round trip is why `restoring` exists as a
 * distinct state: a token on disk is not proof of a live session (it may have
 * been revoked elsewhere), and rendering the sign-in form while we check would
 * flash it at a user who is actually signed in.
 */
export function App() {
  const { api } = useServices();
  const status = useSessionStore((state) => state.status);
  const restore = useSessionStore((state) => state.restore);
  const signIn = useSessionStore((state) => state.signIn);
  const markSignedOut = useSessionStore((state) => state.markSignedOut);

  const [fatalError, setFatalError] = useState<string | undefined>(undefined);
  // StrictMode mounts effects twice in development; this keeps restoration
  // from running two validation requests on every launch.
  const restoreStarted = useRef(false);

  useEffect(() => {
    if (restoreStarted.current) return;
    restoreStarted.current = true;

    let cancelled = false;

    void (async () => {
      try {
        const token = await restore();
        if (token === undefined || cancelled) return;

        // The token has to be in the store before the request, because the
        // API client reads it from there to build the Authorization header.
        useSessionStore.setState({ token });

        const { user } = await api.me();
        if (cancelled) return;

        await signIn(token, user);
      } catch (error) {
        if (cancelled) return;

        const status = (error as { status?: number }).status ?? 0;
        const code = (error as { code?: string }).code;

        if (status === 401 || code === 'unauthenticated' || code === 'session_expired') {
          // Expected: the stored token is no longer valid. Not an error state,
          // just a signed-out one.
          markSignedOut();
          return;
        }

        // The API is unreachable. Distinguished from "signed out", because
        // telling someone to sign in when the server is down is misleading.
        markSignedOut();
        setFatalError(
          code === 'network_error'
            ? 'Could not reach the Rook server. Check that it is running, then try again.'
            : 'Something went wrong while restoring your session.',
        );
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [api, restore, signIn, markSignedOut]);

  if (status === 'restoring') {
    return (
      <div className="flex h-full items-center justify-center bg-base">
        <div className="flex flex-col items-center gap-3 text-ink-subtle">
          <Spinner className="size-5" />
          <p className="text-xs">Restoring your session</p>
        </div>
      </div>
    );
  }

  if (status === 'signedOut') {
    return <AuthScreen initialError={fatalError} />;
  }

  return <AppShell />;
}
