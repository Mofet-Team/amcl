/**
 * Text from source files and the point database, shown literally in Markdown: a descriptor such
 * as `*AUTO*` stays as written, and a comment cannot make a link or fetch an image: with `[`
 * escaped, `(` and `!` are plain text.
 */
export function escapeMarkdown(text: string): string {
  return (
    text
      .replace(/[\\`*[\]<>#|~&]/g, '\\$&')
      // Inside a word, as in a tag such as `TANK_LVL`, an underscore never emphasises.
      .replace(/(?<![\p{L}\p{N}])_|_(?![\p{L}\p{N}])/gu, '\\_')
      // A list item, heading underline or rule at the start of a line.
      .replace(/^(\s*)([+=-]|\d+[.)])/gm, (_, space: string, mark: string) => `${space}${mark.replace(/[+=.)-]/, '\\$&')}`)
  );
}

/** Inline code that a backtick in the text cannot end early. */
export function markdownCode(text: string): string {
  const longest = Math.max(0, ...[...text.matchAll(/`+/g)].map((m) => m[0].length));
  const fence = '`'.repeat(longest + 1);
  const pad = longest ? ' ' : '';
  return `${fence}${pad}${text}${pad}${fence}`;
}
