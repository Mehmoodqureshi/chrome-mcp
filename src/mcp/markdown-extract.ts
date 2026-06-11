/**
 * src/mcp/markdown-extract.ts — a dependency-free HTML → readable-markdown
 * reducer. Not a full Readability port, but it drops non-content chrome
 * (script/style/nav/header/footer/aside/form), and converts the common block
 * and inline structure (headings, lists, links, emphasis, code, blockquote,
 * hr) to markdown, then collapses whitespace.
 */

/** Convert an HTML string to readable markdown. */
export function htmlToMarkdown(html: string): string {
  let s = html;

  // Drop comments and whole non-content subtrees.
  s = s.replace(/<!--[\s\S]*?-->/g, '');
  s = s.replace(/<(script|style|noscript|head|svg|nav|header|footer|aside|form|template)[\s\S]*?<\/\1>/gi, '');

  // Headings.
  for (let i = 1; i <= 6; i++) {
    const re = new RegExp(`<\\s*h${i}[^>]*>([\\s\\S]*?)<\\/h${i}>`, 'gi');
    s = s.replace(re, (_m, t: string) => `\n\n${'#'.repeat(i)} ${strip(t)}\n\n`);
  }

  // Lists: ordered items get "1.", unordered get "-". (Flat; nesting is lossy.)
  s = s.replace(/<\s*ol[^>]*>([\s\S]*?)<\/ol>/gi, (_m, inner: string) => {
    let n = 0;
    return '\n' + inner.replace(/<\s*li[^>]*>([\s\S]*?)<\/li>/gi, (_x, t: string) => `\n${++n}. ${strip(t)}`) + '\n';
  });
  s = s.replace(/<\s*li[^>]*>([\s\S]*?)<\/li>/gi, (_m, t: string) => `\n- ${strip(t)}`);

  // Blockquote, hr, code.
  s = s.replace(/<\s*blockquote[^>]*>([\s\S]*?)<\/blockquote>/gi, (_m, t: string) => `\n\n> ${strip(t)}\n\n`);
  s = s.replace(/<\s*hr[^>]*\/?\s*>/gi, '\n\n---\n\n');
  s = s.replace(/<\s*(pre|code)[^>]*>([\s\S]*?)<\/\1>/gi, (_m, _tag, t: string) => `\`${strip(t)}\``);

  // Inline emphasis.
  s = s.replace(/<\s*(strong|b)[^>]*>([\s\S]*?)<\/\1>/gi, (_m, _t, t: string) => `**${strip(t)}**`);
  s = s.replace(/<\s*(em|i)[^>]*>([\s\S]*?)<\/\1>/gi, (_m, _t, t: string) => `_${strip(t)}_`);

  // Links.
  s = s.replace(
    /<\s*a[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi,
    (_m, href: string, t: string) => {
      const label = strip(t);
      return label ? `[${label}](${href})` : '';
    },
  );

  // Block boundaries → newlines.
  s = s.replace(/<\s*(p|br|div|section|article|tr|table|ul|ol)[^>]*>/gi, '\n');

  // Remove remaining tags, decode entities, collapse blank runs.
  s = strip(s);
  s = s.replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n');
  return s.trim();
}

function strip(fragment: string): string {
  return decodeEntities(fragment.replace(/<[^>]+>/g, '')).replace(/[ \t]+/g, ' ').trim();
}

function decodeEntities(s: string): string {
  return s
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&mdash;/g, '—')
    .replace(/&hellip;/g, '…');
}
