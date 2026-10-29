/** Cuts text at `max` characters, never inside a surrogate pair, and says how much was cut. */
export function cutText(text: string, max: number): string {
  if (text.length <= max) return text;
  let end = max;
  const last = text.charCodeAt(end - 1);
  if (last >= 0xd800 && last <= 0xdbff) end -= 1;
  return `${text.slice(0, end)}\n[truncated: ${text.length - end} characters omitted]`;
}
