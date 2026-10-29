/**
 * Text from a model, a tool, or a server can hold control characters. A terminal reads them as commands
 * (clear the screen, set the title). Drop them all, except a line break and a tab. A bare carriage
 * return would let text overwrite the line, so it goes too. Text direction marks, zero-width characters,
 * soft hyphens, and Unicode tag characters (which can spell hidden text) go as well: they can make
 * an argument read differently from what runs.
 */
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u00ad\u061c\u200b-\u200f\u2028-\u202e\u2060\u2066-\u2069\ufeff\u{e0000}-\u{e007f}]/gu;
export const printable = (text: string): string => text.replace(CONTROL, "");

/** Cuts text at `max` characters, never inside a surrogate pair, and says how much was cut. */
export function cutText(text: string, max: number): string {
  if (text.length <= max) return text;
  let end = max;
  const last = text.charCodeAt(end - 1);
  if (last >= 0xd800 && last <= 0xdbff) end -= 1;
  return `${text.slice(0, end)}\n[truncated: ${text.length - end} characters omitted]`;
}
