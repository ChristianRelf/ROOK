import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';

/**
 * Merges class names, with later Tailwind utilities winning.
 *
 * `clsx` flattens conditionals and arrays; `twMerge` then resolves conflicts
 * so `cn('p-2', 'p-4')` yields `p-4` rather than both. That is what makes a
 * `className` prop on a component able to actually override its defaults.
 *
 * Kept in its own module so the components file exports only components, which
 * is what React Fast Refresh needs to update a component without remounting it.
 */
export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}
