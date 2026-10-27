import { useState, type FormEvent } from 'react';
import { Server } from 'lucide-react';
import { Button, Field, Input, Panel } from '@rook/ui';
import { loginRequestSchema, registerRequestSchema } from '@rook/contracts';
import { ApiRequestError } from '../lib/api-client.js';
import { useServices } from '../lib/services-context.js';
import { useSessionStore } from '../stores/session.js';
import { InvalidServerUrlError, useServerStore } from '../lib/server-config.js';

/**
 * Sign-in and registration.
 *
 * Validation runs client-side against the same Zod schemas the API uses, so
 * the user gets immediate feedback on a short password instead of a round
 * trip. That is purely a convenience: the server validates independently and
 * is the only thing that decides.
 *
 * Server-side field errors are mapped back onto the inputs that caused them,
 * so "that username is taken" appears next to the username rather than as a
 * banner the user has to connect to a field themselves.
 *
 * The server address lives here too, collapsed by default. A self-hosted
 * client has to be pointed somewhere, and the sign-in screen is the only place
 * the user can do that before authenticating -- but surfacing it permanently
 * would put infrastructure configuration above the password field, so it is
 * tucked behind a link unless it is already non-default or has just failed.
 */

type Mode = 'signIn' | 'register';

export function AuthScreen({ initialError }: { readonly initialError?: string | undefined }) {
  const { api } = useServices();
  const signIn = useSessionStore((state) => state.signIn);
  const notice = useSessionStore((state) => state.notice);

  const [mode, setMode] = useState<Mode>('signIn');
  const [identifier, setIdentifier] = useState('');
  const [username, setUsername] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [displayName, setDisplayName] = useState('');

  const serverUrl = useServerStore((state) => state.serverUrl);
  const isDefaultServer = useServerStore((state) => state.isDefault);
  const setServerUrl = useServerStore((state) => state.setServerUrl);

  const [submitting, setSubmitting] = useState(false);
  const [formError, setFormError] = useState<string | undefined>(initialError);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});

  // Shown when the address has been changed from the default, or when a
  // connection failed -- the two cases where the user needs to see it.
  const [serverDraft, setServerDraft] = useState(serverUrl);
  const [serverError, setServerError] = useState<string | undefined>(undefined);
  const [serverSaved, setServerSaved] = useState(false);
  const [showServer, setShowServer] = useState(!isDefaultServer || initialError !== undefined);

  async function applyServerUrl(): Promise<void> {
    setServerError(undefined);
    setServerSaved(false);

    try {
      await setServerUrl(serverDraft);
      setServerSaved(true);
      // Clearing it lets the user retry sign-in against the new address
      // without a stale "could not reach the server" still on screen.
      setFormError(undefined);
    } catch (error) {
      setServerError(
        error instanceof InvalidServerUrlError ? error.message : 'Could not use that address.',
      );
    }
  }

  function switchMode(next: Mode): void {
    setMode(next);
    // Errors from the other form would be confusing once the fields change.
    setFormError(undefined);
    setFieldErrors({});
  }

  async function handleSubmit(event: FormEvent): Promise<void> {
    event.preventDefault();
    setFormError(undefined);
    setFieldErrors({});

    // Client-side validation with the shared schema.
    if (mode === 'register') {
      const parsed = registerRequestSchema.safeParse({
        username,
        email,
        password,
        ...(displayName.trim().length > 0 ? { displayName } : {}),
      });

      if (!parsed.success) {
        const errors: Record<string, string> = {};
        for (const issue of parsed.error.issues) {
          const path = issue.path.map(String).join('.');
          errors[path] ??= issue.message;
        }
        setFieldErrors(errors);
        return;
      }
    } else {
      const parsed = loginRequestSchema.safeParse({ identifier, password });
      if (!parsed.success) {
        const errors: Record<string, string> = {};
        for (const issue of parsed.error.issues) {
          errors[issue.path.map(String).join('.')] ??= issue.message;
        }
        setFieldErrors(errors);
        return;
      }
    }

    setSubmitting(true);
    try {
      const result =
        mode === 'register'
          ? await api.register({
              username,
              email,
              password,
              ...(displayName.trim().length > 0 ? { displayName } : {}),
            })
          : await api.login({ identifier, password });

      await signIn(result.token, result.user);
    } catch (error) {
      if (error instanceof ApiRequestError) {
        const perField = error.fieldErrors();

        if (Object.keys(perField).length > 0) {
          setFieldErrors(perField);
        } else if (error.code === 'username_taken') {
          // Mapped onto the field rather than shown as a banner.
          setFieldErrors({ username: 'That username is already taken.' });
        } else if (error.code === 'email_taken') {
          setFieldErrors({ email: 'An account with that email already exists.' });
        } else {
          setFormError(error.message);
        }
      } else {
        setFormError('Something went wrong. Please try again.');
      }
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="flex h-full items-center justify-center bg-base px-6">
      <div className="w-full max-w-sm">
        <div className="mb-6 text-center">
          <h1 className="text-xl font-semibold tracking-tight text-ink">Rook</h1>
          <p className="mt-1 text-xs text-ink-subtle">
            {mode === 'signIn' ? 'Sign in to continue' : 'Create an account to get started'}
          </p>
        </div>

        <Panel className="p-5">
          <form onSubmit={(event) => void handleSubmit(event)} className="flex flex-col gap-4">
            {mode === 'signIn' ? (
              <Field
                label="Username or email"
                htmlFor="identifier"
                error={fieldErrors['identifier']}
              >
                <Input
                  id="identifier"
                  value={identifier}
                  onChange={(event) => setIdentifier(event.target.value)}
                  autoComplete="username"
                  autoFocus
                  invalid={fieldErrors['identifier'] !== undefined}
                  placeholder="ada"
                />
              </Field>
            ) : (
              <>
                <Field
                  label="Username"
                  htmlFor="username"
                  hint="Lowercase letters, digits, underscores and periods."
                  error={fieldErrors['username']}
                >
                  <Input
                    id="username"
                    value={username}
                    onChange={(event) => setUsername(event.target.value)}
                    autoComplete="username"
                    autoFocus
                    invalid={fieldErrors['username'] !== undefined}
                    placeholder="ada"
                  />
                </Field>

                <Field label="Email" htmlFor="email" error={fieldErrors['email']}>
                  <Input
                    id="email"
                    type="email"
                    value={email}
                    onChange={(event) => setEmail(event.target.value)}
                    autoComplete="email"
                    invalid={fieldErrors['email'] !== undefined}
                    placeholder="ada@example.com"
                  />
                </Field>

                <Field
                  label="Display name"
                  htmlFor="displayName"
                  hint="Optional. Defaults to your username."
                  error={fieldErrors['displayName']}
                >
                  <Input
                    id="displayName"
                    value={displayName}
                    onChange={(event) => setDisplayName(event.target.value)}
                    autoComplete="name"
                    invalid={fieldErrors['displayName'] !== undefined}
                    placeholder="Ada Lovelace"
                  />
                </Field>
              </>
            )}

            <Field
              label="Password"
              htmlFor="password"
              hint={mode === 'register' ? 'At least 12 characters.' : undefined}
              error={fieldErrors['password']}
            >
              <Input
                id="password"
                type="password"
                value={password}
                onChange={(event) => setPassword(event.target.value)}
                autoComplete={mode === 'register' ? 'new-password' : 'current-password'}
                invalid={fieldErrors['password'] !== undefined}
              />
            </Field>

            {/* Session notices (e.g. "your session expired") are shown once,
                distinctly from form errors. */}
            {notice !== undefined && formError === undefined ? (
              <p className="rounded-control bg-warning/10 px-3 py-2 text-xs text-warning">
                {notice}
              </p>
            ) : null}

            {formError !== undefined ? (
              <p
                role="alert"
                className="rounded-control bg-danger-wash px-3 py-2 text-xs text-danger"
              >
                {formError}
              </p>
            ) : null}

            <Button type="submit" variant="primary" fullWidth loading={submitting}>
              {mode === 'signIn' ? 'Sign in' : 'Create account'}
            </Button>

            {showServer ? (
              <div className="flex flex-col gap-2 border-t border-line pt-3">
                <Field
                  label="Server"
                  htmlFor="server-url"
                  hint={
                    serverSaved ? 'Saved. Sign in to connect.' : 'The address of your Rook server.'
                  }
                  error={serverError}
                >
                  <Input
                    id="server-url"
                    value={serverDraft}
                    onChange={(event) => {
                      setServerDraft(event.target.value);
                      setServerSaved(false);
                    }}
                    onBlur={() => {
                      if (serverDraft.trim() !== serverUrl) void applyServerUrl();
                    }}
                    placeholder="https://rook.example.com"
                    spellCheck={false}
                    autoCapitalize="none"
                    invalid={serverError !== undefined}
                    className="font-mono text-xs"
                  />
                </Field>
              </div>
            ) : (
              <button
                type="button"
                onClick={() => setShowServer(true)}
                className="inline-flex items-center justify-center gap-1.5 text-2xs text-ink-subtle transition-colors hover:text-ink-muted"
              >
                <Server className="size-3" />
                Change server
              </button>
            )}
          </form>
        </Panel>

        <p className="mt-4 text-center text-xs text-ink-subtle">
          {mode === 'signIn' ? "Don't have an account?" : 'Already have an account?'}{' '}
          <button
            type="button"
            onClick={() => switchMode(mode === 'signIn' ? 'register' : 'signIn')}
            className="font-medium text-accent hover:underline"
          >
            {mode === 'signIn' ? 'Create one' : 'Sign in'}
          </button>
        </p>
      </div>
    </div>
  );
}
