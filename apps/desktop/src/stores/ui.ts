import { create } from 'zustand';
import type { ChannelId, CommunityId } from '@rook/contracts';
import type { ConnectionState } from '../lib/realtime-client.js';

/**
 * Local UI state: what is selected, what is open, and the connection banner.
 *
 * Deliberately separate from server state, which lives in TanStack Query and
 * the message store. Mixing the two is how you end up with a selection that
 * resets whenever a query refetches.
 *
 * Composer drafts are kept here too, so switching channel and coming back does
 * not discard half-typed text — a small thing that is extremely noticeable
 * when it is missing.
 */

export type DialogKind =
  | { readonly kind: 'none' }
  | { readonly kind: 'createCommunity' }
  | { readonly kind: 'joinCommunity' }
  | { readonly kind: 'createChannel'; readonly communityId: CommunityId }
  | { readonly kind: 'settings' };

export interface UiState {
  readonly selectedCommunityId: CommunityId | undefined;
  readonly selectedChannelId: ChannelId | undefined;
  readonly dialog: DialogKind;
  readonly connection: ConnectionState;
  readonly connectionDetail: string | undefined;
  readonly showMembers: boolean;
  /** Draft composer text, keyed by channel. */
  readonly drafts: Record<string, string>;

  selectCommunity: (communityId: CommunityId | undefined) => void;
  selectChannel: (channelId: ChannelId | undefined) => void;
  openDialog: (dialog: DialogKind) => void;
  closeDialog: () => void;
  setConnection: (state: ConnectionState, detail?: string) => void;
  toggleMembers: () => void;
  setDraft: (channelId: ChannelId, text: string) => void;
  clearDraft: (channelId: ChannelId) => void;
}

export const useUiStore = create<UiState>((set) => ({
  selectedCommunityId: undefined,
  selectedChannelId: undefined,
  dialog: { kind: 'none' },
  connection: 'idle',
  connectionDetail: undefined,
  showMembers: true,
  drafts: {},

  selectCommunity(communityId) {
    // Clearing the channel is required: a channel id from the previous
    // community would otherwise stay selected and render an empty pane.
    set({ selectedCommunityId: communityId, selectedChannelId: undefined });
  },

  selectChannel(channelId) {
    set({ selectedChannelId: channelId });
  },

  openDialog(dialog) {
    set({ dialog });
  },

  closeDialog() {
    set({ dialog: { kind: 'none' } });
  },

  setConnection(state, detail) {
    set({ connection: state, connectionDetail: detail });
  },

  toggleMembers() {
    set((current) => ({ showMembers: !current.showMembers }));
  },

  setDraft(channelId, text) {
    set((current) => ({ drafts: { ...current.drafts, [channelId]: text } }));
  },

  clearDraft(channelId) {
    set((current) => {
      const { [channelId]: _removed, ...rest } = current.drafts;
      return { drafts: rest };
    });
  },
}));
