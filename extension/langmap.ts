/** Single-character langmap, ported from the opencode-vim-plugin (MIT). */

export type VimKeyLike = { name?: string; shift?: boolean; sequence?: string };

/** The printable character a key represents, before langmap. */
export function keyText(event: VimKeyLike): string | undefined {
  return event.sequence?.length === 1 ? event.sequence : undefined;
}

export function applyLangmap(event: VimKeyLike, key: string, langmap: Record<string, string> | undefined) {
  if (key.length !== 1) return key;
  const mapped = langmap?.[key] ?? (event.shift ? langmap?.[key.toLowerCase()]?.toUpperCase() : undefined);
  if (!mapped || mapped.length !== 1) return key;
  return mapped;
}
