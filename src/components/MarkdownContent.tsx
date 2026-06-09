import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

interface MarkdownContentProps {
  content: string;
  compact?: boolean;
}

export function MarkdownContent({ content, compact = false }: MarkdownContentProps) {
  return (
    <ReactMarkdown
      remarkPlugins={[remarkGfm]}
      components={{
        a: ({ children, href }) => (
          <a href={href} target="_blank" rel="noreferrer" onClick={compact ? (event) => event.stopPropagation() : undefined}>
            {children}
          </a>
        ),
        code: ({ className, children, ...props }) => {
          if (compact) return <code>{children}</code>;
          const inline = !className;
          return inline ? (
            <code className="md-inline-code" {...props}>
              {children}
            </code>
          ) : (
            <code className={className} {...props}>
              {children}
            </code>
          );
        },
      }}
    >
      {content}
    </ReactMarkdown>
  );
}
