import { useMemo } from 'react';
import { segmentContent } from '@rook/contracts';
import { cn } from '@rook/ui';
import { useSessionStore } from '../stores/session.js';

/**
 * Message text with mentions highlighted.
 *
 * Content is split into plain and mention segments by `segmentContent` in
 * `@rook/contracts` — the same tokeniser the server uses to decide who gets a
 * mention badge. Sharing it is the point: if the client highlighted on its own
 * rules, a message could show a highlight for someone who was never notified,
 * or notify someone whose name is not visibly marked.
 *
 * Every segment is rendered as a text child of a React element, never as HTML.
 * React escapes it, so a message containing markup is displayed literally and
 * there is no sanitiser to get wrong — nothing is ever interpreted.
 *
 * A mention of *you* is rendered differently from a mention of someone else.
 * Without that distinction a busy channel is a wall of identical blue chips
 * and the one that matters is no easier to find than the rest.
 */
export function MessageContent({
  content,
  className,
}: {
  readonly content: string;
  readonly className?: string;
}) {
  const username = useSessionStore((state) => state.user?.username);

  // Tokenising is a regex scan over the message, and this renders inside a
  // virtualised list that re-renders rows on scroll. Memoised on the content
  // so scrolling does not re-parse every visible message.
  const segments = useMemo(() => segmentContent(content), [content]);

  return (
    <span className={className}>
      {segments.map((segment, index) => {
        if (segment.kind === 'text') {
          // Keyed by index, which is safe here: segments are derived from the
          // content, so the array only changes when the content does, and the
          // whole span re-renders when it does.
          return <span key={index}>{segment.text}</span>;
        }

        // `@everyone` always counts as mentioning the reader, which is what
        // makes it worth having — and worth being visibly louder.
        const mentionsMe = segment.everyone || segment.name === username;

        return (
          <span
            key={index}
            className={cn(
              'rounded px-0.5 font-medium',
              mentionsMe
                ? 'bg-accent/30 text-ink'
                : 'bg-accent-wash text-accent hover:bg-accent/25',
            )}
          >
            {segment.text}
          </span>
        );
      })}
    </span>
  );
}
