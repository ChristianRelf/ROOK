/**
 * `@rook/ui` -- reusable frontend components and the design tokens.
 *
 * Frontend-only and deliberately dependency-light: clsx, tailwind-merge and
 * lucide icons. It imports nothing from the rest of the workspace, so it
 * cannot pull server code or a database driver into the client bundle.
 *
 * Consumed as TypeScript source (see this package's `exports`), which Vite
 * compiles directly -- there is no build step and no stale `dist` to go out of
 * sync with the app.
 */

export { cn } from './lib/cn.js';

export {
  Avatar,
  Badge,
  Button,
  EmptyState,
  ErrorState,
  Field,
  Input,
  Panel,
  SectionLabel,
  Skeleton,
  Spinner,
  StatusDot,
  Textarea,
  type AvatarProps,
  type BadgeProps,
  type ButtonProps,
  type ButtonSize,
  type ButtonVariant,
  type EmptyStateProps,
  type ErrorStateProps,
  type FieldProps,
  type InputProps,
  type StatusDotProps,
  type TextareaProps,
} from './components/primitives.js';
