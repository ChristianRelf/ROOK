import { Component, type ErrorInfo, type ReactNode } from 'react';

/**
 * The last line of defence against a blank window.
 *
 * Without a boundary, a single thrown render turns a Tauri webview into an
 * empty grey rectangle with no message, no way back and nothing to report —
 * which from the outside is indistinguishable from the application crashing.
 * This catches it and shows what happened, with a reload.
 *
 * Deliberately a class component. Error boundaries have no hook equivalent:
 * `componentDidCatch` and `getDerivedStateFromError` are the only way React
 * exposes this, so the class is required rather than a style choice.
 *
 * It does not try to recover automatically. A render that threw once will
 * usually throw again on the same state, and a boundary that retries silently
 * produces a flickering loop instead of a message — so the retry is the
 * person's decision.
 */

interface ErrorBoundaryState {
  readonly error: Error | undefined;
  readonly componentStack: string | undefined;
}

export class ErrorBoundary extends Component<{ readonly children: ReactNode }, ErrorBoundaryState> {
  override state: ErrorBoundaryState = { error: undefined, componentStack: undefined };

  static getDerivedStateFromError(error: Error): Partial<ErrorBoundaryState> {
    return { error };
  }

  override componentDidCatch(error: Error, info: ErrorInfo): void {
    // Logged as well as displayed. The component stack is the part that
    // actually locates the fault, and it is not in `error.stack` — so without
    // this it would be lost even though React computed it.
    console.error('Unhandled render error', error, info.componentStack);
    this.setState({ componentStack: info.componentStack ?? undefined });
  }

  override render(): ReactNode {
    const { error, componentStack } = this.state;
    if (error === undefined) return this.props.children;

    return (
      <div className="flex h-full items-center justify-center bg-base px-6">
        <div className="flex w-full max-w-lg flex-col gap-4">
          <div>
            <h1 className="text-lg font-semibold text-ink">Something went wrong</h1>
            <p className="mt-1 text-sm text-ink-muted">
              Rook hit an error it could not recover from. Reloading usually fixes it; if it keeps
              happening, the detail below is what to report.
            </p>
          </div>

          {/* Selectable, because the whole point is that someone can copy it
              into a bug report. */}
          <pre className="selectable max-h-56 overflow-auto rounded-panel bg-inset p-3 text-2xs leading-relaxed text-ink-muted">
            {error.message}
            {componentStack !== undefined ? `\n${componentStack}` : ''}
          </pre>

          <div className="flex gap-2">
            <button
              type="button"
              onClick={() => window.location.reload()}
              className="h-9 rounded-control bg-accent px-4 text-sm font-medium text-accent-ink hover:bg-accent-hover"
            >
              Reload Rook
            </button>
            <button
              type="button"
              onClick={() => {
                // Clearing the error retries the same render. Offered because
                // a transient fault — a failed lazy chunk, say — does recover
                // this way, and it is cheaper than a full reload.
                this.setState({ error: undefined, componentStack: undefined });
              }}
              className="h-9 rounded-control bg-inset px-4 text-sm font-medium text-ink-muted hover:bg-active hover:text-ink"
            >
              Try again
            </button>
          </div>
        </div>
      </div>
    );
  }
}
