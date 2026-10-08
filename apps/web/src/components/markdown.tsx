import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";

/** Renders user-written Markdown. Raw HTML is not rendered, so specs can't inject scripts. */
export function MarkdownView({ children }: { children: string }) {
  return (
    <div className="prose-hbe text-sm leading-relaxed">
      <Markdown remarkPlugins={[remarkGfm]}>{children}</Markdown>
    </div>
  );
}
