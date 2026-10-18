/**
 * Pure string-level vim primitives, ported from the opencode-vim-plugin vim core
 * (https://github.com/leohenon/opencode-vim-plugin — MIT, © leohenon).
 *
 * The OpenCode core works on a flat string with one absolute cursor offset.
 * This file keeps those functions untouched so future upstream fixes port
 * over with no rewrites. Editor adapters translate between the flat-offset
 * model and pi-tui's line/col model.
 */

export type VimSpan = { start: number; end: number };
export type VimWantedColumn = number | "end";
export type VimRegister = { text: string; linewise: boolean } | null;
export type VimOperator = "d" | "c" | "y";
export type VimOperatorResult = { span: VimSpan | null; register: VimRegister };

const bracketPairs = new Map([
  ["(", ")"],
  ["[", "]"],
  ["{", "}"],
]);
const bracketClosers = new Map(Array.from(bracketPairs, ([open, close]) => [close, open]));

export function lineStart(text: string, offset: number) {
  if (offset <= 0) return 0;
  const index = text.lastIndexOf("\n", offset - 1);
  if (index === -1) return 0;
  return index + 1;
}

export function lineEnd(text: string, offset: number) {
  const index = text.indexOf("\n", offset);
  if (index === -1) return text.length;
  return index;
}

function lineLast(text: string, offset: number) {
  const start = lineStart(text, offset);
  const end = lineEnd(text, offset);
  if (end > start) return end - 1;
  return start;
}

function prevLineStart(text: string, offset: number) {
  const start = lineStart(text, offset);
  if (start === 0) return undefined;
  return lineStart(text, start - 1);
}

function nextLineStart(text: string, offset: number) {
  const end = lineEnd(text, offset);
  if (end >= text.length) return undefined;
  return end + 1;
}

function isBlankLine(text: string, lineStartOffset: number) {
  return lineEnd(text, lineStartOffset) === lineStartOffset;
}

// vim treats a trailing \n as EOL of the last line, not a new empty line.
function paragraphAdvance(text: string, lineOffset: number): number | null {
  const end = lineEnd(text, lineOffset);
  if (end >= text.length - 1) return null;
  return end + 1;
}

function paragraphRetreat(text: string, lineOffset: number): number | null {
  if (lineOffset <= 0) return null;
  return lineStart(text, lineOffset - 1);
}

export function nextParagraphTarget(text: string, cursor: number): number {
  if (text.length === 0) return 0;
  let probe = lineStart(text, cursor);
  while (isBlankLine(text, probe)) {
    const next = paragraphAdvance(text, probe);
    if (next === null) return probe;
    probe = next;
  }
  while (!isBlankLine(text, probe)) {
    const next = paragraphAdvance(text, probe);
    if (next === null) return lineLast(text, text.length - 1);
    probe = next;
  }
  return probe;
}

export function previousParagraphTarget(text: string, cursor: number): number {
  if (text.length === 0 || cursor === 0) return 0;
  let probe = lineStart(text, cursor);
  while (isBlankLine(text, probe)) {
    const previous = paragraphRetreat(text, probe);
    if (previous === null) return 0;
    probe = previous;
  }
  while (probe > 0) {
    const previous = paragraphRetreat(text, probe);
    if (previous === null) return 0;
    if (isBlankLine(text, previous)) return previous;
    probe = previous;
  }
  return 0;
}

function lineColumn(text: string, offset: number) {
  return offset - lineStart(text, offset);
}

function bracketAtOrAfter(text: string, offset: number) {
  const end = lineEnd(text, offset);
  for (let pos = offset; pos < end; pos++) {
    if (bracketPairs.has(text[pos]!) || bracketClosers.has(text[pos]!)) return pos;
  }
  return null;
}

function matchingForward(text: string, offset: number, open: string, close: string) {
  let depth = 1;
  for (let pos = offset + 1; pos < text.length; pos++) {
    if (text[pos] === open) depth++;
    if (text[pos] === close) depth--;
    if (depth === 0) return pos;
  }
  return null;
}

function matchingBackward(text: string, offset: number, open: string, close: string) {
  let depth = 1;
  for (let pos = offset - 1; pos >= 0; pos--) {
    if (text[pos] === close) depth++;
    if (text[pos] === open) depth--;
    if (depth === 0) return pos;
  }
  return null;
}

export function matchingBracketTarget(text: string, offset: number) {
  if (!text.length) return null;
  const source = bracketAtOrAfter(text, Math.max(0, Math.min(offset, text.length - 1)));
  if (source === null) return null;
  const char = text[source]!;
  const close = bracketPairs.get(char);
  if (close) return matchingForward(text, source, char, close);
  const open = bracketClosers.get(char);
  if (open) return matchingBackward(text, source, open, char);
  return null;
}

function moveUp(text: string, offset: number, column: VimWantedColumn = lineColumn(text, offset)) {
  const targetStart = prevLineStart(text, offset);
  if (targetStart === undefined) return offset;
  const targetLast = lineLast(text, targetStart);
  const col = column === "end" ? targetLast - targetStart : column;
  return Math.min(targetStart + col, targetLast);
}

function moveDown(text: string, offset: number, column: VimWantedColumn = lineColumn(text, offset)) {
  const targetStart = nextLineStart(text, offset);
  if (targetStart === undefined) return offset;
  const targetLast = lineLast(text, targetStart);
  const col = column === "end" ? targetLast - targetStart : column;
  return Math.min(targetStart + col, targetLast);
}

export function firstNonWhitespace(text: string, offset: number) {
  const start = lineStart(text, offset);
  const end = lineEnd(text, offset);
  let pos = start;
  while (pos < end && /\s/.test(text[pos] ?? "")) pos++;
  return pos;
}

// ---------------------------------------------------------------------------
// Word motions
// ---------------------------------------------------------------------------

function isWord(char: string) {
  return /[A-Za-z0-9_]/.test(char);
}

export function wordClass(char: string | undefined, big: boolean): "blank" | "word" | "punct" {
  if (!char || /\s/.test(char)) return "blank";
  if (big || isWord(char)) return "word";
  return "punct";
}

export function nextWordStart(text: string, offset: number, big: boolean) {
  let pos = offset;
  if (pos >= text.length) return text.length;
  const startClass = wordClass(text[pos]!, big);
  if (startClass !== "blank") {
    while (pos < text.length && wordClass(text[pos]!, big) === startClass) pos++;
  }
  while (pos < text.length && wordClass(text[pos]!, big) === "blank") pos++;
  return pos;
}

export function prevWordStart(text: string, offset: number, big: boolean) {
  let pos = Math.min(offset, text.length);
  if (pos <= 0) return 0;
  pos--;
  while (pos > 0 && wordClass(text[pos]!, big) === "blank") pos--;
  const target = wordClass(text[pos]!, big);
  while (pos > 0 && wordClass(text[pos - 1]!, big) === target) pos--;
  return pos;
}

function wordRunEnd(text: string, offset: number, big: boolean) {
  const target = wordClass(text[offset]!, big);
  let pos = offset;
  while (pos + 1 < text.length && wordClass(text[pos + 1]!, big) === target) pos++;
  return pos;
}

export function wordEnd(text: string, offset: number, big: boolean) {
  if (text.length === 0) return 0;
  let pos = offset;
  if (pos >= text.length) pos = text.length - 1;
  const startClass = wordClass(text[pos]!, big);
  const atRunEnd = startClass === "blank" || pos + 1 >= text.length || wordClass(text[pos + 1]!, big) !== startClass;
  if (atRunEnd) {
    pos++;
    while (pos < text.length && wordClass(text[pos]!, big) === "blank") pos++;
    if (pos >= text.length) return text.length - 1;
  }
  return wordRunEnd(text, pos, big);
}

// ---------------------------------------------------------------------------
// Char find (f/F/t/T)
// ---------------------------------------------------------------------------

export function findCharTargetInLine(text: string, offset: number, char: string, forward: boolean, skip = 1) {
  if (forward) {
    for (let i = offset + skip; i < text.length; i++) {
      if (text[i] === char) return i;
    }
    return null;
  }
  for (let i = offset - skip; i >= 0; i--) {
    if (text[i] === char) return i;
  }
  return null;
}

export function findCharInLine(
  text: string,
  offset: number,
  char: string,
  forward: boolean,
  till = false,
  repeat = false,
) {
  const target = findCharTargetInLine(text, offset, char, forward, till && repeat ? 2 : 1);
  if (target === null) return offset;
  return till ? target + (forward ? -1 : 1) : target;
}

// ---------------------------------------------------------------------------
// Text objects (pure-string core; the editor layer supplies cursor/text)
// ---------------------------------------------------------------------------

function wordTextObjectInnerSpan(text: string, cursor: number, big: boolean): VimSpan | null {
  const pos = Math.min(cursor, text.length - 1);
  if (text[pos] === "\n") return null;
  const target = wordClass(text[pos]!, big);
  let start = pos;
  while (start > 0 && wordClass(text[start - 1]!, big) === target) start--;
  let end = pos + 1;
  while (end < text.length && wordClass(text[end]!, big) === target) end++;
  return start < end ? { start, end } : null;
}

function wordTextObjectBlankSpan(text: string, cursor: number, big: boolean): VimSpan | null {
  let start = Math.min(cursor, text.length - 1);
  if (wordClass(text[start]!, big) !== "blank" || text[start] === "\n") return null;
  while (start > 0 && text[start - 1] !== "\n" && wordClass(text[start - 1]!, big) === "blank") start--;
  let end = start;
  while (end < text.length && text[end] !== "\n" && wordClass(text[end]!, big) === "blank") end++;
  return start < end ? { start, end } : null;
}

function wordTextObjectAroundBlankSpan(text: string, blank: VimSpan, big: boolean): VimSpan | null {
  let end = blank.end;
  while (end < text.length && text[end] !== "\n" && wordClass(text[end]!, big) === "blank") end++;
  if (end >= text.length || text[end] === "\n") return null;
  const inner = wordTextObjectInnerSpan(text, end, big);
  if (!inner) return null;
  end = inner.end;
  while (end < text.length && text[end] !== "\n" && wordClass(text[end]!, big) === "blank") end++;
  return { start: blank.start, end };
}

/** iw / aw / iW / aW computed against an explicit cursor. */
export function wordTextObjectSpan(text: string, cursor: number, around: boolean, big = false): VimSpan | null {
  if (!text.length) return null;
  const blank = wordTextObjectBlankSpan(text, cursor, big);
  if (blank) {
    if (!around) return blank;
    return wordTextObjectAroundBlankSpan(text, blank, big);
  }
  const inner = wordTextObjectInnerSpan(text, cursor, big);
  if (!inner) return null;
  if (!around) return inner;
  let end = inner.end;
  while (end < text.length && text[end] !== "\n" && wordClass(text[end]!, big) === "blank") end++;
  if (end > inner.end) return { start: inner.start, end };
  let start = inner.start;
  while (start > 0 && text[start - 1] !== "\n" && wordClass(text[start - 1]!, big) === "blank") start--;
  return { start, end: inner.end };
}

function bracketTextObjectPairChars(bracket: string) {
  if (bracket === "(" || bracket === ")") return { open: "(", close: ")" };
  if (bracket === "[" || bracket === "]") return { open: "[", close: "]" };
  if (bracket === "{" || bracket === "}") return { open: "{", close: "}" };
  if (bracket === "<" || bracket === ">") return { open: "<", close: ">" };
  return null;
}

function bracketTextObjectContainingPair(
  text: string,
  cursor: number,
  start: number,
  end: number,
  open: string,
  close: string,
): VimSpan | null {
  const stack: number[] = [];
  let result: VimSpan | null = null;
  for (let index = start; index < end; index++) {
    if (text[index] === open) stack.push(index);
    if (text[index] !== close) continue;
    const pairStart = stack.pop();
    if (pairStart === undefined || pairStart > cursor || index < cursor) continue;
    if (!result || pairStart > result.start) result = { start: pairStart, end: index };
  }
  return result;
}

function bracketTextObjectPair(text: string, cursor: number, bracket: string): VimSpan | null {
  const pair = bracketTextObjectPairChars(bracket);
  if (!pair) return null;
  const containing = bracketTextObjectContainingPair(text, cursor, 0, text.length, pair.open, pair.close);
  if (containing) return containing;
  const pairStart = text.indexOf(pair.open, cursor);
  if (pairStart === -1) return null;
  let depth = 0;
  for (let index = pairStart; index < text.length; index++) {
    if (text[index] === pair.open) depth++;
    if (text[index] === pair.close) {
      depth--;
      if (depth === 0) return { start: pairStart, end: index };
    }
  }
  return null;
}

/** ib( / ab( / i[ / a{ … computed against an explicit cursor. */
export function bracketTextObjectSpan(
  text: string,
  cursor: number,
  around: boolean,
  bracket: string,
  operation: VimOperator,
): VimSpan | null {
  if (!text.length) return null;
  const pair = bracketTextObjectPair(text, cursor, bracket);
  if (!pair) return null;
  let span: VimSpan;
  if (around) {
    span = { start: pair.start, end: pair.end + 1 };
  } else {
    const start = pair.start + 1;
    const end = pair.end;
    if (text[start] === "\n" && text[end - 1] === "\n") {
      span = { start: start + 1, end: operation === "c" ? end - 1 : end };
    } else {
      span = { start, end };
    }
  }
  if (span.start < span.end) return span;
  return { start: span.start, end: span.start };
}

function isHorizontalWhitespace(char: string | undefined) {
  return char === " " || char === "\t";
}

function isEscaped(text: string, position: number) {
  let backslashes = 0;
  for (let index = position - 1; index >= 0 && text[index] === "\\"; index--) backslashes++;
  return backslashes % 2 === 1;
}

function quoteTextObjectPair(text: string, cursor: number, quote: string): VimSpan | null {
  const start = lineStart(text, cursor);
  const end = lineEnd(text, cursor);
  const positions: number[] = [];
  for (let position = start; position < end; position++) {
    if (text[position] === quote && !isEscaped(text, position)) positions.push(position);
  }
  if (positions.length < 2) return null;
  const index = positions.findIndex((position) => position >= cursor);
  if (index === -1) return null;
  if (positions[index] === cursor) {
    const pairIndex = index % 2 === 0 ? index : index - 1;
    const pairEnd = positions[pairIndex + 1];
    return pairEnd === undefined ? null : { start: positions[pairIndex]!, end: pairEnd };
  }
  const previous = positions[index - 1];
  if (previous === undefined) {
    const pairEnd = positions[1];
    return pairEnd === undefined ? null : { start: positions[0]!, end: pairEnd };
  }
  return { start: previous, end: positions[index]! };
}

/** iq / aq computed against an explicit cursor. */
export function quoteTextObjectSpan(text: string, cursor: number, around: boolean, quote: string): VimSpan | null {
  if (!text.length) return null;
  const pair = quoteTextObjectPair(text, cursor, quote);
  if (!pair) return null;
  let span: VimSpan;
  if (around) {
    let end = pair.end + 1;
    while (end < text.length && text[end] !== "\n" && isHorizontalWhitespace(text[end])) end++;
    if (end > pair.end + 1) {
      span = { start: pair.start, end };
    } else {
      let start = pair.start;
      while (start > 0 && text[start - 1] !== "\n" && isHorizontalWhitespace(text[start - 1])) start--;
      span = { start, end: pair.end + 1 };
    }
  } else {
    span = { start: pair.start + 1, end: pair.end };
  }
  if (span.start < span.end) return span;
  return { start: span.start, end: span.start };
}

export function swapCase(char: string) {
  const low = char.toLowerCase();
  const up = char.toUpperCase();
  if (char === low && char !== up) return up;
  if (char === up && char !== low) return low;
  return char;
}
