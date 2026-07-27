/** Minimal markdown → HTML for assistant text. Escapes HTML first. */
export function renderMarkdown(source: string): string {
  const escaped = source
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")

  const withCodeBlocks = escaped.replace(/```([\s\S]*?)```/g, (_m, code) => {
    return `<pre><code>${String(code).replace(/^\n/, "")}</code></pre>`
  })

  const withInline = withCodeBlocks
    .replace(/`([^`]+)`/g, "<code>$1</code>")
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/\*([^*]+)\*/g, "<em>$1</em>")

  const paragraphs = withInline
    .split(/\n{2,}/)
    .map((block) => {
      if (block.startsWith("<pre>")) return block
      return `<p>${block.replace(/\n/g, "<br />")}</p>`
    })
    .join("")

  return paragraphs
}
