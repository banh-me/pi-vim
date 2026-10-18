/**
 * Visual-mode selection rendering for the vim modal editor.
 *
 * Ported from pi-vim-keys' VisualHighlightRenderer and editor compass
 * (https://github.com/0xKahi/pi-vim-keys, MIT) with the paste-marker branches
 * trimmed. The overlay re-renders selection rows wholesale so padding, cursor
 * glyphs, and highlight intervals stay consistent with pi's editor layout.
 */

import { CURSOR_MARKER, type Editor, visibleWidth } from "@earendil-works/pi-tui";
import { editorInternals } from "./editor-adapter";

// grapheme segmenter (paste-marker awareness not needed for the overlay)
const graphemeSegmenter =
  typeof Intl.Segmenter === "function"
    ? new Intl.Segmenter(undefined, { granularity: "grapheme" })
    : undefined;

function segment(text: string): Intl.SegmentData[] {
  if (graphemeSegmenter) return [...graphemeSegmenter.segment(text)];
  const out: Intl.SegmentData[] = [];
  let index = 0;
  for (const s of text) {
    out.push({ segment: s, index, input: text });
    index += s.length;
  }
  return out;
}

const isWhitespaceChar = (c: string) => /\s/.test(c);
const cjkBreakRegex = /[\p{Script_Extensions=Han}\p{Script_Extensions=Hiragana}\p{Script_Extensions=Katakana}\p{Script_Extensions=Hangul}\p{Script_Extensions=Bopomofo}]/u;

/** PI-equivalent of visibleWidth: strip ANSI then count. (ANSI is not present in source text.) */
function lineWidth(text: string) {
  return visibleWidth(text);
}

/** Port of pi-tui's wordWrapLine (simplified: no paste-marker merging). */
export function wordWrapLine(line: string, maxWidth: number): { text: string; startIndex: number; endIndex: number }[] {
  if (!line || maxWidth <= 0) return [{ text: "", startIndex: 0, endIndex: 0 }];
  if (lineWidth(line) <= maxWidth) return [{ text: line, startIndex: 0, endIndex: line.length }];
  const chunks: { text: string; startIndex: number; endIndex: number }[] = [];
  const segments = segment(line);
  let currentWidth = 0;
  let chunkStart = 0;
  let wrapOppIndex = -1;
  let wrapOppWidth = 0;
  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i]!;
    const gWidth = lineWidth(seg.segment);
    const charIndex = seg.index;
    const isWs = isWhitespaceChar(seg.segment);
    if (currentWidth + gWidth > maxWidth) {
      if (wrapOppIndex >= 0 && currentWidth - wrapOppWidth + gWidth <= maxWidth) {
        chunks.push({ text: line.slice(chunkStart, wrapOppIndex), startIndex: chunkStart, endIndex: wrapOppIndex });
        chunkStart = wrapOppIndex;
        currentWidth -= wrapOppWidth;
      } else if (chunkStart < charIndex) {
        chunks.push({ text: line.slice(chunkStart, charIndex), startIndex: chunkStart, endIndex: charIndex });
        chunkStart = charIndex;
        currentWidth = 0;
      }
      wrapOppIndex = -1;
    }
    if (gWidth > maxWidth) {
      const subChunks = wordWrapLine(seg.segment, maxWidth);
      for (let j = 0; j < subChunks.length - 1; j++) {
        const sc = subChunks[j]!;
        chunks.push({ text: line.slice(chunkStart) + sc.text, startIndex: chunkStart, endIndex: chunkStart + sc.text.length });
        chunkStart = chunkStart + sc.text.length;
      }
      currentWidth = 0;
      continue;
    }
    currentWidth += gWidth;
    const next = segments[i + 1];
    if (isWs && next && !isWhitespaceChar(next.segment)) {
      wrapOppIndex = next.index;
      wrapOppWidth = currentWidth;
    } else if (!isWs && next && !isWhitespaceChar(next.segment)) {
      if (cjkBreakRegex.test(seg.segment) || cjkBreakRegex.test(next.segment)) {
        wrapOppIndex = next.index;
        wrapOppWidth = currentWidth;
      }
    }
  }
  chunks.push({ text: line.slice(chunkStart), startIndex: chunkStart, endIndex: line.length });
  return chunks;
}

type Coordinate = { line: number; col: number };
export type LineRange = { line: number; startCol: number; endCol: number };

function advanceOneGrapheme(position: Coordinate, lines: string[]): Coordinate {
  const lineText = lines[position.line] ?? "";
  if (position.col >= lineText.length) return position;
  const firstGrapheme = segment(lineText.slice(position.col))[0];
  return { line: position.line, col: position.col + (firstGrapheme?.segment.length ?? 1) };
}

/**
 * Vim selection ranges over the editor buffer.
 * linewise=false: from min(anchor,cursor) to one grapheme past max (inclusive).
 * linewise=true: whole lines, line-wise semantics (0..len).
 */
export function computeSelectionRanges(
  editor: Editor,
  anchor: Coordinate,
  linewise: boolean,
): LineRange[] {
  const lines = editor.getLines().length ? editor.getLines() : [""];
  const normalize = (p: Coordinate): Coordinate => {
    const line = Math.max(0, Math.min(Math.floor(p.line), lines.length - 1));
    const col = Math.max(0, Math.min(Math.floor(p.col), (lines[line] ?? "").length));
    return { line, col };
  };
  const cursor = normalize(editor.getCursor());
  const a = normalize(anchor);
  if (linewise) {
    const startLine = Math.min(a.line, cursor.line);
    const endLine = Math.max(a.line, cursor.line);
    const ranges: LineRange[] = [];
    for (let line = startLine; line <= endLine; line++) {
      ranges.push({ line, startCol: 0, endCol: (lines[line] ?? "").length });
    }
    return ranges;
  }
  const ordered = a.line < cursor.line || (a.line === cursor.line && a.col <= cursor.col) ? { s: a, e: cursor } : { s: cursor, e: a };
  const end = advanceOneGrapheme(ordered.e, lines);
  const ranges: LineRange[] = [];
  if (ordered.s.line === end.line) {
    ranges.push({ line: ordered.s.line, startCol: ordered.s.col, endCol: end.col });
    return ranges;
  }
  ranges.push({ line: ordered.s.line, startCol: ordered.s.col, endCol: (lines[ordered.s.line] ?? "").length });
  for (let line = ordered.s.line + 1; line < end.line; line++) {
    ranges.push({ line, startCol: 0, endCol: (lines[line] ?? "").length });
  }
  ranges.push({ line: end.line, startCol: 0, endCol: end.col });
  return ranges;
}

type LayoutLine = {
  logicalLine: number;
  startCol: number;
  text: string;
  hasCursor: boolean;
  cursorPos?: number;
};

const ANSI_RE = /\x1b\[[0-?]*[ -/]*[@-~]|\x1b_pi:[a-z/]*\x07/g;

/** Strip ANSI/terminal markers. */
export function stripAnsi(text: string) {
  return text.replace(ANSI_RE, "");
}

/**
 * Apply selection highlight to the rendered editor output.
 *
 * `lines` is super.render() output. We rebuild the layout (wrapping must match
 * pi's: reuse the editor's recorded lastWidth), slice to the visible window
 * (scroll offset captured via renderTopBorder), and replace each text row with
 * a re-rendered version carrying highlight intervals and the cursor glyph.
 */
export function renderSelectionHighlight(options: {
  editor: Editor;
  lines: string[];
  scrollOffset: number;
  ranges: LineRange[];
  style: (text: string) => string;
}): string[] {
  const { editor, lines, ranges, style } = options;
  if (ranges.length === 0 || lines.length === 0) return lines;

  const internal = editorInternals(editor);
  const lastWidth = internal.lastWidth;
  const paddingX = editor.getPaddingX();
  const width = lines[0] ? lineWidth(stripAnsi(lines[0]!)) : 80;
  const maxPadding = Math.max(0, Math.floor((width - 1) / 2));
  const pad = Math.min(paddingX, maxPadding);
  const contentWidth = Math.max(1, width - pad * 2);
  const layoutWidth = lastWidth && lastWidth > 0 ? lastWidth : Math.max(1, contentWidth - (pad ? 0 : 1));

  // Rebuild the full layout.
  const editorLines = editor.getLines().length ? editor.getLines() : [""];
  const cursor = editor.getCursor();
  const layoutLines: LayoutLine[] = [];
  for (let logicalLine = 0; logicalLine < editorLines.length; logicalLine++) {
    const lineText = editorLines[logicalLine] ?? "";
    if (lineWidth(lineText) <= layoutWidth) {
      layoutLines.push({
        logicalLine,
        startCol: 0,
        text: lineText,
        hasCursor: logicalLine === cursor.line,
        cursorPos: logicalLine === cursor.line ? cursor.col : undefined,
      });
      continue;
    }
    const chunks = wordWrapLine(lineText, layoutWidth);
    for (const chunk of chunks) {
      const hasCursor = logicalLine === cursor.line && cursor.col >= chunk.startIndex && cursor.col <= chunk.endIndex;
      layoutLines.push({
        logicalLine,
        startCol: chunk.startIndex,
        text: chunk.text,
        hasCursor,
        cursorPos: hasCursor ? cursor.col - chunk.startIndex : undefined,
      });
    }
  }

  // Count visible text rows from rendered output (rows between the borders).
  let visibleRows = lines.length - 2;
  for (let index = lines.length - 1; index >= 1; index--) {
    const row = lines[index];
    if (row === undefined) continue;
    if (stripAnsi(row).startsWith("─")) {
      visibleRows = index - 1;
      break;
    }
  }
  const boundedScroll = Math.max(0, Math.min(options.scrollOffset, Math.max(0, layoutLines.length - 1)));
  const visibleLayoutLines = layoutLines.slice(boundedScroll, boundedScroll + Math.max(0, visibleRows));

  const out = [...lines];
  for (const [index, layoutLine] of visibleLayoutLines.entries()) {
    const renderedIndex = index + 1; // row 0 is the top border
    if (renderedIndex >= out.length) break;
    out[renderedIndex] = renderRow({ editor, layoutLine, ranges, style, pad, contentWidth });
  }
  return out;
}

function renderRow(opts: {
  editor: Editor;
  layoutLine: LayoutLine;
  ranges: LineRange[];
  style: (text: string) => string;
  pad: number;
  contentWidth: number;
}): string {
  const { editor, layoutLine, ranges, style, pad, contentWidth } = opts;
  const leftPad = " ".repeat(pad);
  const focused = editor.focused;
  const marker = focused ? CURSOR_MARKER : "";
  const cursorPos = layoutLine.hasCursor ? layoutLine.cursorPos : undefined;
  const cursorAtEnd = cursorPos !== undefined && cursorPos >= layoutLine.text.length;
  let lineVisibleWidth = lineWidth(layoutLine.text);
  let cursorInPadding = false;

  let displayText: string;
  if (cursorPos === undefined || cursorAtEnd) {
    displayText = renderHighlightedSlice(layoutLine, 0, layoutLine.text.length, ranges, style);
  } else {
    const before = renderHighlightedSlice(layoutLine, 0, cursorPos, ranges, style);
    const afterCursor = layoutLine.text.slice(cursorPos);
    const grapheme = segment(afterCursor)[0]?.segment ?? "";
    const cursorEnd = cursorPos + grapheme.length;
    const cursorGlyph = `${marker}\x1b[7m${renderHighlightedSlice(layoutLine, cursorPos, cursorEnd, ranges, style)}\x1b[0m`;
    const after = renderHighlightedSlice(layoutLine, cursorEnd, layoutLine.text.length, ranges, style);
    displayText = `${before}${cursorGlyph}${after}`;
  }

  if (cursorAtEnd) {
    displayText += `${marker}\x1b[7m \x1b[0m`;
    lineVisibleWidth += 1;
    if (lineVisibleWidth > contentWidth && pad > 0) cursorInPadding = true;
  }

  const padding = " ".repeat(Math.max(0, contentWidth - lineVisibleWidth));
  const rightPad = cursorInPadding ? leftPad.slice(1) : leftPad;
  return `${leftPad}${displayText}${padding}${rightPad}`;
}

function renderHighlightedSlice(
  layoutLine: LayoutLine,
  localStart: number,
  localEnd: number,
  ranges: LineRange[],
  style: (text: string) => string,
): string {
  if (localStart >= localEnd) return "";
  const intervals: { start: number; end: number }[] = [];
  for (const range of ranges) {
    if (range.line !== layoutLine.logicalLine) continue;
    const start = Math.max(localStart, range.startCol - layoutLine.startCol);
    const end = Math.min(localEnd, range.endCol - layoutLine.startCol);
    if (start < end) intervals.push({ start, end });
  }
  intervals.sort((a, b) => a.start - b.start);

  let result = "";
  let cursor = localStart;
  for (const interval of intervals) {
    if (interval.start > cursor) result += layoutLine.text.slice(cursor, interval.start);
    result += style(layoutLine.text.slice(interval.start, interval.end));
    cursor = interval.end;
  }
  if (cursor < localEnd) result += layoutLine.text.slice(cursor, localEnd);
  return result;
}
