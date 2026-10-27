import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
  type SelectHTMLAttributes,
} from 'react';
import { Check, ChevronDown } from 'lucide-react';
import { cn } from '../lib/cn.js';

/**
 * Overlay primitives: the unread pill, dropdown menus, selects and tooltips.
 *
 * Kept out of `primitives.tsx` because these all share one concern that the
 * plain controls do not -- they render *over* the layout, which means they all
 * have to answer the same three questions:
 *
 *   * **How do they close?** Escape, a click outside, and selecting an item.
 *     All three, every time. A menu that only closes on selection is the most
 *     common way a desktop UI starts feeling broken.
 *
 *   * **How do they stay on screen?** A menu opened near the bottom of the
 *     window must flip upwards rather than extend past it. That is measured
 *     after mount, in a layout effect, because it depends on the rendered
 *     height.
 *
 *   * **Where in the DOM do they live?** Inline, positioned absolutely within
 *     a `relative` wrapper -- not in a portal. The panes here all have their
 *     own scroll containers, and a portalled menu would need its position
 *     recomputed on every scroll event to stay attached to its trigger.
 */

// --------------------------------------------------------------------------
// Unread pill
// --------------------------------------------------------------------------

export interface UnreadPillProps {
  readonly count: number;
  /** True when the real count is higher than `count`, rendering as "N+". */
  readonly capped?: boolean;
  readonly className?: string;
}

/**
 * The red mention count.
 *
 * Fixed height with a minimum width equal to that height, so a single digit is
 * a circle and a longer count grows into a pill. Letting it size purely to its
 * content makes a column of badges look ragged.
 *
 * Renders nothing at zero rather than an empty element, so callers can pass a
 * count straight through without guarding.
 */
export function UnreadPill({ count, capped = false, className }: UnreadPillProps) {
  if (count <= 0) return null;

  return (
    <span
      // The number is already visible; the label is what a screen reader needs
      // to know it means mentions rather than, say, a member count.
      aria-label={`${count}${capped ? ' or more' : ''} unread mentions`}
      className={cn(
        'inline-flex h-4 min-w-4 shrink-0 items-center justify-center rounded-pill px-1',
        'bg-danger text-2xs font-bold leading-none text-white tabular-nums',
        className,
      )}
    >
      {count}
      {capped ? '+' : ''}
    </span>
  );
}

/** The small grey dot marking a channel as unread without mentions. */
export function UnreadDot({ className }: { readonly className?: string }) {
  return (
    <span
      aria-label="Unread messages"
      className={cn('size-2 shrink-0 rounded-pill bg-ink', className)}
    />
  );
}

// --------------------------------------------------------------------------
// Dropdown menu
// --------------------------------------------------------------------------

export interface MenuItem {
  readonly label: string;
  readonly icon?: ReactNode;
  readonly onSelect: () => void;
  readonly destructive?: boolean;
  readonly disabled?: boolean;
  /** Shows a tick, for a menu that reports state as well as offering actions. */
  readonly checked?: boolean;
}

export interface MenuProps {
  /** Rendered as the trigger. Receives whether the menu is open. */
  readonly trigger: (props: { open: boolean; toggle: () => void }) => ReactNode;
  readonly items: readonly (MenuItem | 'separator')[];
  /** Which horizontal edge the panel aligns to. */
  readonly align?: 'left' | 'right';
  readonly className?: string;
  readonly label?: string;
}

export function Menu({ trigger, items, align = 'right', className, label }: MenuProps) {
  const [open, setOpen] = useState(false);
  const [flipUp, setFlipUp] = useState(false);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const panelRef = useRef<HTMLDivElement | null>(null);

  const close = useCallback(() => setOpen(false), []);
  const toggle = useCallback(() => setOpen((current) => !current), []);

  useEffect(() => {
    if (!open) return;

    function onKeyDown(event: KeyboardEvent): void {
      if (event.key === 'Escape') {
        event.stopPropagation();
        close();
      }
    }

    function onPointerDown(event: PointerEvent): void {
      const container = containerRef.current;
      if (container !== null && !container.contains(event.target as Node)) close();
    }

    document.addEventListener('keydown', onKeyDown);
    // `pointerdown` rather than `click`: a click fires after mouseup, so a
    // menu would still be open during the press and could visibly flicker.
    document.addEventListener('pointerdown', onPointerDown);

    return () => {
      document.removeEventListener('keydown', onKeyDown);
      document.removeEventListener('pointerdown', onPointerDown);
    };
  }, [open, close]);

  // Measured after mount, before paint, so a menu near the bottom of the
  // window opens upwards instead of being clipped.
  useLayoutEffect(() => {
    if (!open) return;

    const panel = panelRef.current;
    if (panel === null) return;

    const rect = panel.getBoundingClientRect();
    setFlipUp(rect.bottom > window.innerHeight - 8);
  }, [open]);

  return (
    <div ref={containerRef} className={cn('relative', className)}>
      {trigger({ open, toggle })}

      {open ? (
        <div
          ref={panelRef}
          role="menu"
          aria-label={label}
          className={cn(
            'animate-rise absolute z-40 min-w-44 overflow-hidden rounded-panel',
            'border border-line bg-raised p-1 shadow-xl shadow-black/40',
            align === 'right' ? 'right-0' : 'left-0',
            flipUp ? 'bottom-full mb-1' : 'top-full mt-1',
          )}
        >
          {items.map((item, index) =>
            item === 'separator' ? (
              <div key={`separator-${index}`} className="my-1 h-px bg-line-soft" />
            ) : (
              <button
                key={item.label}
                type="button"
                role="menuitem"
                disabled={item.disabled === true}
                onClick={() => {
                  // Closed before the handler runs, so an action that opens a
                  // dialog does not leave the menu sitting behind it.
                  close();
                  item.onSelect();
                }}
                className={cn(
                  'flex w-full items-center gap-2 rounded-control px-2 py-1.5 text-left text-sm',
                  'transition-colors duration-(--duration-fast)',
                  item.disabled === true
                    ? 'cursor-not-allowed text-ink-faint'
                    : item.destructive === true
                      ? 'text-danger hover:bg-danger hover:text-white'
                      : // Not the accent fill: a light row with dark text
                        // would invert on hover, which in a greyscale interface
                        // reads as the item being selected rather than hovered.
                        'text-ink-muted hover:bg-active hover:text-ink',
                )}
              >
                {item.icon !== undefined ? (
                  <span className="flex size-4 shrink-0 items-center justify-center">
                    {item.icon}
                  </span>
                ) : null}
                <span className="min-w-0 flex-1 truncate">{item.label}</span>
                {item.checked === true ? <Check className="size-3.5 shrink-0" /> : null}
              </button>
            ),
          )}
        </div>
      ) : null}
    </div>
  );
}

// --------------------------------------------------------------------------
// Select
// --------------------------------------------------------------------------

export interface SelectProps extends SelectHTMLAttributes<HTMLSelectElement> {
  readonly invalid?: boolean;
}

/**
 * A native `<select>`, restyled.
 *
 * Native rather than a custom listbox, and that is a deliberate choice rather
 * than a shortcut: the native control gets keyboard behaviour, type-ahead and
 * the platform's own touch and accessibility handling for free, and all of
 * that is laborious to reimplement and easy to get subtly wrong. The only cost
 * is that the open list is drawn by the OS, which for a settings form is not
 * worth replacing.
 */
export function Select({ invalid = false, className, children, ...rest }: SelectProps) {
  return (
    <div className="relative">
      <select
        className={cn(
          'h-9 w-full appearance-none rounded-control bg-inset pl-2.5 pr-8 text-sm text-ink',
          'border transition-colors duration-(--duration-fast)',
          'focus:border-accent focus:outline-none',
          invalid ? 'border-danger' : 'border-transparent',
          className,
        )}
        {...rest}
      >
        {children}
      </select>
      <ChevronDown className="pointer-events-none absolute right-2.5 top-1/2 size-3.5 -translate-y-1/2 text-ink-subtle" />
    </div>
  );
}

// --------------------------------------------------------------------------
// Tooltip
// --------------------------------------------------------------------------

export interface TooltipProps {
  readonly label: string;
  readonly side?: 'top' | 'right';
  readonly children: ReactNode;
  readonly className?: string;
}

/**
 * A hover label.
 *
 * Shown on focus as well as hover, so it is reachable by keyboard, and marked
 * `aria-hidden` because the trigger carries its own accessible name -- without
 * that, a screen reader announces the label twice.
 */
export function Tooltip({ label, side = 'top', children, className }: TooltipProps) {
  return (
    <div className={cn('group/tooltip relative flex', className)}>
      {children}
      <span
        aria-hidden
        className={cn(
          'pointer-events-none absolute z-50 whitespace-nowrap rounded-control',
          'bg-sunken px-2 py-1 text-2xs font-semibold text-ink shadow-lg shadow-black/40',
          'opacity-0 transition-opacity duration-(--duration-fast)',
          'group-hover/tooltip:opacity-100 group-focus-within/tooltip:opacity-100',
          side === 'top'
            ? 'bottom-full left-1/2 mb-1.5 -translate-x-1/2'
            : 'left-full top-1/2 ml-2 -translate-y-1/2',
        )}
      >
        {label}
      </span>
    </div>
  );
}
