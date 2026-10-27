import {
  forwardRef,
  type ButtonHTMLAttributes,
  type HTMLAttributes,
  type InputHTMLAttributes,
  type ReactNode,
  type TextareaHTMLAttributes,
} from 'react';
import { cn } from '../lib/cn.js';

/**
 * Interface primitives.
 *
 * Small and unopinionated on purpose. Each wraps a native element, forwards
 * its ref and spreads the rest of its props, so a caller can always reach the
 * underlying DOM behaviour rather than waiting for a prop to be added here.
 *
 * Class merging lives in `../lib/cn.ts` so this module exports only
 * components, which is what Fast Refresh needs in order to update one without
 * remounting the tree.
 */

// --------------------------------------------------------------------------
// Button
// --------------------------------------------------------------------------

export type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger';
export type ButtonSize = 'sm' | 'md';

const buttonVariants: Record<ButtonVariant, string> = {
  primary: 'bg-accent text-accent-ink hover:bg-accent-hover active:bg-accent-pressed',
  secondary: 'bg-overlay text-ink border border-line hover:bg-active',
  ghost: 'text-ink-muted hover:bg-hover hover:text-ink',
  danger: 'bg-danger/12 text-danger border border-danger/25 hover:bg-danger/20',
};

const buttonSizes: Record<ButtonSize, string> = {
  sm: 'h-7 px-2.5 text-xs gap-1.5',
  md: 'h-9 px-3.5 text-sm gap-2',
};

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  readonly variant?: ButtonVariant;
  readonly size?: ButtonSize;
  /** Shows a spinner and blocks interaction without changing the layout. */
  readonly loading?: boolean;
  readonly fullWidth?: boolean;
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  {
    variant = 'secondary',
    size = 'md',
    loading = false,
    fullWidth = false,
    className,
    children,
    disabled,
    ...rest
  },
  ref,
) {
  return (
    <button
      ref={ref}
      // A loading button must not be clickable, or a slow network produces
      // duplicate submissions.
      disabled={disabled === true || loading}
      className={cn(
        'inline-flex items-center justify-center rounded-control font-medium',
        'transition-colors duration-(--duration-fast)',
        'disabled:cursor-not-allowed disabled:opacity-50',
        buttonVariants[variant],
        buttonSizes[size],
        fullWidth && 'w-full',
        className,
      )}
      {...rest}
    >
      {loading ? <Spinner className="size-3.5" /> : null}
      {children}
    </button>
  );
});

// --------------------------------------------------------------------------
// Inputs
// --------------------------------------------------------------------------

const fieldBase =
  'w-full rounded-control bg-inset border border-line px-2.5 text-sm text-ink ' +
  'placeholder:text-ink-faint transition-colors duration-(--duration-fast) ' +
  'hover:border-line-strong focus:border-accent focus:outline-none ' +
  'disabled:cursor-not-allowed disabled:opacity-50';

export interface InputProps extends InputHTMLAttributes<HTMLInputElement> {
  readonly invalid?: boolean;
}

export const Input = forwardRef<HTMLInputElement, InputProps>(function Input(
  { className, invalid = false, ...rest },
  ref,
) {
  return (
    <input
      ref={ref}
      // Communicates the error to assistive technology, not just visually.
      aria-invalid={invalid || undefined}
      className={cn(fieldBase, 'h-9', invalid && 'border-danger focus:border-danger', className)}
      {...rest}
    />
  );
});

export interface TextareaProps extends TextareaHTMLAttributes<HTMLTextAreaElement> {
  readonly invalid?: boolean;
}

export const Textarea = forwardRef<HTMLTextAreaElement, TextareaProps>(function Textarea(
  { className, invalid = false, ...rest },
  ref,
) {
  return (
    <textarea
      ref={ref}
      aria-invalid={invalid || undefined}
      className={cn(
        fieldBase,
        'resize-none py-2 leading-relaxed',
        invalid && 'border-danger',
        className,
      )}
      {...rest}
    />
  );
});

export interface FieldProps {
  readonly label: string;
  readonly htmlFor?: string;
  readonly hint?: string;
  /** When set, replaces the hint and turns the label red. */
  readonly error?: string | undefined;
  readonly children: ReactNode;
}

/** A labelled form row with room for a hint or an error, but never both. */
export function Field({ label, htmlFor, hint, error, children }: FieldProps) {
  return (
    <div className="flex flex-col gap-1.5">
      <label
        htmlFor={htmlFor}
        className={cn(
          'text-xs font-medium',
          error !== undefined ? 'text-danger' : 'text-ink-muted',
        )}
      >
        {label}
      </label>
      {children}
      {/* The hint slot keeps its height whether or not a message is present,
          so validating a field does not shift the form. */}
      {(error ?? hint) !== undefined ? (
        <p className={cn('text-2xs', error !== undefined ? 'text-danger' : 'text-ink-subtle')}>
          {error ?? hint}
        </p>
      ) : null}
    </div>
  );
}

// --------------------------------------------------------------------------
// Feedback
// --------------------------------------------------------------------------

export function Spinner({ className }: { readonly className?: string }) {
  return (
    <span
      role="status"
      aria-label="Loading"
      className={cn(
        'inline-block size-4 shrink-0 animate-spin rounded-full',
        'border-2 border-current border-t-transparent opacity-70',
        className,
      )}
    />
  );
}

export interface StatusDotProps {
  readonly state: 'online' | 'connecting' | 'offline';
  readonly className?: string;
}

export function StatusDot({ state, className }: StatusDotProps) {
  return (
    <span
      className={cn(
        'inline-block size-2 shrink-0 rounded-full',
        state === 'online' && 'bg-online',
        // Pulsing signals "in progress" without needing a label.
        state === 'connecting' && 'bg-connecting animate-soft-pulse',
        state === 'offline' && 'bg-offline',
        className,
      )}
    />
  );
}

/**
 * Deterministic avatar colour from an id.
 *
 * Stable per user, so someone's placeholder does not change colour between
 * sessions, which would break the visual recognition that makes avatars
 * useful in the first place.
 */
const avatarTints = [
  'bg-[#5b6ef5]',
  'bg-[#7c6cf5]',
  'bg-[#c46cf5]',
  'bg-[#f0616d]',
  'bg-[#e8a33d]',
  'bg-[#3ec98a]',
  'bg-[#3dbfe8]',
] as const;

function tintFor(seed: string): string {
  let hash = 0;
  for (let index = 0; index < seed.length; index += 1) {
    hash = (hash * 31 + seed.charCodeAt(index)) | 0;
  }
  return avatarTints[Math.abs(hash) % avatarTints.length] ?? avatarTints[0];
}

export interface AvatarProps {
  readonly name: string;
  /** Stable identity for the placeholder colour; falls back to the name. */
  readonly seed?: string;
  readonly src?: string | undefined;
  readonly size?: 'xs' | 'sm' | 'md' | 'lg';
  readonly className?: string;
}

const avatarSizes = {
  xs: 'size-5 text-2xs',
  sm: 'size-7 text-xs',
  md: 'size-9 text-sm',
  lg: 'size-16 text-xl',
} as const;

export function Avatar({ name, seed, src, size = 'md', className }: AvatarProps) {
  const initial = name.trim().charAt(0).toUpperCase() || '?';

  return (
    <span
      className={cn(
        'relative inline-flex shrink-0 items-center justify-center overflow-hidden',
        'rounded-pill font-semibold text-white/90 select-none',
        avatarSizes[size],
        src === undefined && tintFor(seed ?? name),
        className,
      )}
      aria-hidden
    >
      {src !== undefined ? (
        <img src={src} alt="" className="size-full object-cover" draggable={false} />
      ) : (
        initial
      )}
    </span>
  );
}

// --------------------------------------------------------------------------
// States
// --------------------------------------------------------------------------

export interface EmptyStateProps {
  readonly icon?: ReactNode;
  readonly title: string;
  readonly description?: string;
  readonly action?: ReactNode;
  readonly className?: string;
}

/**
 * The placeholder for "nothing here yet".
 *
 * Always says what the thing is *for* and offers the action that fills it.
 * An empty pane with no explanation is the most common way a new user gets
 * stuck in an application like this.
 */
export function EmptyState({ icon, title, description, action, className }: EmptyStateProps) {
  return (
    <div
      className={cn(
        'flex min-h-0 flex-1 flex-col items-center justify-center gap-3 px-8 py-12 text-center',
        className,
      )}
    >
      {icon !== undefined ? <div className="text-ink-faint">{icon}</div> : null}
      <div className="space-y-1">
        <p className="text-sm font-medium text-ink">{title}</p>
        {description !== undefined ? (
          <p className="mx-auto max-w-sm text-xs leading-relaxed text-ink-subtle">{description}</p>
        ) : null}
      </div>
      {action}
    </div>
  );
}

export interface ErrorStateProps {
  readonly title?: string;
  readonly message: string;
  readonly onRetry?: () => void;
  readonly className?: string;
}

export function ErrorState({
  title = 'Something went wrong',
  message,
  onRetry,
  className,
}: ErrorStateProps) {
  return (
    <div
      className={cn(
        'flex min-h-0 flex-1 flex-col items-center justify-center gap-3 px-8 py-12 text-center',
        className,
      )}
    >
      <div className="space-y-1">
        <p className="text-sm font-medium text-danger">{title}</p>
        <p className="mx-auto max-w-sm text-xs leading-relaxed text-ink-muted">{message}</p>
      </div>
      {onRetry !== undefined ? (
        <Button size="sm" onClick={onRetry}>
          Try again
        </Button>
      ) : null}
    </div>
  );
}

/** A grey block standing in for content that is still loading. */
export function Skeleton({ className }: { readonly className?: string }) {
  return <div className={cn('animate-soft-pulse rounded bg-hover', className)} />;
}

// --------------------------------------------------------------------------
// Layout
// --------------------------------------------------------------------------

export function Panel({ className, children, ...rest }: HTMLAttributes<HTMLDivElement>) {
  return (
    <div className={cn('rounded-panel border border-line bg-raised', className)} {...rest}>
      {children}
    </div>
  );
}

/** A quiet uppercase heading for grouping rows in a sidebar. */
export function SectionLabel({ className, children, ...rest }: HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cn(
        'px-2 pb-1 pt-3 text-2xs font-semibold uppercase tracking-wider text-ink-faint',
        className,
      )}
      {...rest}
    >
      {children}
    </div>
  );
}

export interface BadgeProps extends HTMLAttributes<HTMLSpanElement> {
  readonly tone?: 'neutral' | 'accent' | 'danger' | 'warning';
}

export function Badge({ tone = 'neutral', className, children, ...rest }: BadgeProps) {
  return (
    <span
      className={cn(
        'inline-flex items-center rounded-pill px-1.5 py-0.5 text-2xs font-medium',
        tone === 'neutral' && 'bg-hover text-ink-muted',
        tone === 'accent' && 'bg-accent-wash text-accent',
        tone === 'danger' && 'bg-danger-wash text-danger',
        tone === 'warning' && 'bg-warning/15 text-warning',
        className,
      )}
      {...rest}
    >
      {children}
    </span>
  );
}
