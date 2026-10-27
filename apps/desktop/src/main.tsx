import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { App } from './App.jsx';
import { AppServicesProvider } from './lib/app-context.jsx';
import './index.css';

/**
 * Application entry point.
 *
 * Query defaults worth noting:
 *
 *   * `retry` skips 4xx responses. Retrying a 403 or a 404 cannot succeed and
 *     only delays showing the user what went wrong.
 *   * `refetchOnWindowFocus` is off. This is a realtime client: the socket
 *     pushes changes, and refetching everything whenever the window regains
 *     focus is wasted work on a desktop app that is focused constantly.
 */
const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 30_000,
      refetchOnWindowFocus: false,
      retry: (failureCount, error) => {
        const status = (error as { status?: number }).status ?? 0;
        if (status >= 400 && status < 500) return false;
        return failureCount < 2;
      },
    },
    mutations: {
      // A mutation that is retried automatically can duplicate a side effect.
      // Sends have their own idempotency-key retry path instead.
      retry: false,
    },
  },
});

const container = document.getElementById('root');
if (container === null) {
  throw new Error('Root element is missing from index.html');
}

createRoot(container).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <AppServicesProvider>
        <App />
      </AppServicesProvider>
    </QueryClientProvider>
  </StrictMode>,
);
