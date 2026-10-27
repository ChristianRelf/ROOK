import { createContext, useContext } from 'react';
import type { ApiClient } from './api-client.js';
import type { RealtimeClient } from './realtime-client.js';

/**
 * The service container and its hook.
 *
 * Kept apart from the provider component so that module exports only
 * components: React Fast Refresh can then update the provider without
 * remounting the tree and losing all application state on every edit.
 */

export interface AppServices {
  readonly api: ApiClient;
  readonly realtime: RealtimeClient;
}

export const AppServicesContext = createContext<AppServices | undefined>(undefined);

export function useServices(): AppServices {
  const services = useContext(AppServicesContext);
  if (services === undefined) {
    throw new Error('useServices must be used inside <AppServicesProvider>');
  }
  return services;
}
