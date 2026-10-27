import { create } from 'zustand';
import type { CurrentUser } from '@rook/contracts';
import { tokenStore } from '../lib/platform.js';

/**
 * Authentication state.
 *
 * `status` is an explicit state machine rather than a pair of booleans,
 * because the distinction between "still checking a stored token" and "signed
 * out" decides what the app renders on launch. Collapsing them shows the
 * sign-in form for a moment to a user who is already authenticated, which
 * looks like being logged out at random.
 *
 *   restoring  reading the persisted token (the initial state)
 *   signedOut  no valid session
 *   signedIn   authenticated, `user` and `token` are set
 */
export type SessionStatus = 'restoring' | 'signedOut' | 'signedIn';

export interface SessionState {
  readonly status: SessionStatus;
  readonly token: string | undefined;
  readonly user: CurrentUser | undefined;
  /** Set when a session ends unexpectedly, so the sign-in screen can say why. */
  readonly notice: string | undefined;

  signIn: (token: string, user: CurrentUser) => Promise<void>;
  /** Clears local state and the persisted token. */
  signOut: (notice?: string) => Promise<void>;
  setUser: (user: CurrentUser) => void;
  /** Reads the persisted token. Returns it so the caller can validate it. */
  restore: () => Promise<string | undefined>;
  markSignedOut: (notice?: string) => void;
}

export const useSessionStore = create<SessionState>((set) => ({
  status: 'restoring',
  token: undefined,
  user: undefined,
  notice: undefined,

  async signIn(token, user) {
    // Persisted before the state flips, so a crash immediately after sign-in
    // does not leave the user authenticated in memory but not on disk.
    await tokenStore.write(token);
    set({ status: 'signedIn', token, user, notice: undefined });
  },

  async signOut(notice) {
    await tokenStore.clear();
    set({ status: 'signedOut', token: undefined, user: undefined, notice });
  },

  setUser(user) {
    set({ user });
  },

  async restore() {
    const token = await tokenStore.read();

    if (token === undefined) {
      set({ status: 'signedOut' });
      return undefined;
    }

    // Stays `restoring` until the caller has validated the token against the
    // API: a token on disk is not proof of a live session.
    return token;
  },

  markSignedOut(notice) {
    set({ status: 'signedOut', token: undefined, user: undefined, notice });
  },
}));
