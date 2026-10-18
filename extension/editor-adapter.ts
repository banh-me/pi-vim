/**
 * Editor adapter: bridges the flat-offset vim core (text-core.ts) onto
 * pi-tui's Editor line/col model.
 *
 * pi-tui's Editor exposes cursor reads publicly; cursor writes and the text
 * buffer are internal. Like pi-vim-keys, we keep that unsafe view contained
 * in this one module.
 */

import type { Editor } from "@earendil-works/pi-tui";
import { CURSOR_MARKER } from "@earendil-works/pi-tui";
import {
  firstNonWhitespace,
  findCharTargetInLine,
  lineEnd,
  lineStart,
  matchingBracketTarget,
  nextParagraphTarget,
  nextWordStart,
  prevWordStart,
  previousParagraphTarget,
  swapCase,
  wordEnd,
  type VimRegister,
  type VimSpan,
  type VimWantedColumn,
} from "./text-core";

/** Unsafe view of pi-tui Editor internals. All fields optional, checked at use. */
export type EditorInternals = {
  state?: { lines: string[]; cursorLine: number; cursorCol: number };
  lastWidth?: number;
  preferredVisualCol?: number | null;
  snappedFromCursorCol?: number | null;
  lastAction?: unknown;
  pastes?: Map<number, string>;
  pasteCounter?: number;
  undoStack?: { push: (s: unknown) => void; pop: () => unknown; clear?: () => void; length?: number };
  pushUndoSnapshot?: () => void;
  cancelAutocomplete?: () => void;
  moveCursor?: (deltaLine: number, deltaCol: number) => void;
  segment?: (text: string, mode: "grapheme" | "word") => Iterable<Intl.SegmentData>;
};

export function editorInternals(editor: Editor): EditorInternals {
  return editor as unknown as EditorInternals;
}

// (snapshot type moved into state.ts: { text, cursor } flat model)

// ---------------------------------------------------------------------------
// Read helpers
// ---------------------------------------------------------------------------

/** The full text as a flat \n-joined string. Note: paste markers in pi's editor are NOT expanded here — vim edits the visible buffer. */
export function getText(editor: Editor): string {
  return editor.getText();
}

export function getCursorOffset(editor: Editor): number {
  const { lines, cursorLine, cursorCol } = stateOf(editor);
  let offset = 0;
  for (let i = 0; i < cursorLine && i < lines.length; i++) offset += (lines[i]?.length ?? 0) + 1;
  return offset + cursorCol;
}

export function offsetToPos(editor: Editor, offset: number): { line: number; col: number } {
  const { lines } = stateOf(editor);
  const text = getText(editor);
  const clamped = Math.max(0, Math.min(offset, text.length));
  let line = 0;
  for (let i = 0; i < clamped; i++) {
    if (text[i] === "\n") line++;
  }
  const lineStartOffset = lineStart(text, clamped);
  return { line: Math.min(line, Math.max(0, lines.length - 1)), col: clamped - lineStartOffset };
}

function stateOf(editor: Editor) {
  const internal = editorInternals(editor).state;
  if (!internal) throw new Error("pi-vim: editor internals unavailable");
  return internal;
}

// ---------------------------------------------------------------------------
// Cursor writes
// ---------------------------------------------------------------------------

export function setCursor(editor: Editor, line: number, col: number) {
  const state = stateOf(editor);
  const clampedLine = Math.max(0, Math.min(Math.floor(line), state.lines.length - 1));
  const lineText = state.lines[clampedLine] ?? "";
  state.cursorLine = clampedLine;
  state.cursorCol = Math.max(0, Math.min(Math.floor(col), lineText.length));
  const internal = editorInternals(editor);
  internal.lastAction = null;
  internal.preferredVisualCol = null;
  internal.snappedFromCursorCol = null;
}

export function setCursorOffset(editor: Editor, offset: number) {
  const pos = offsetToPos(editor, offset);
  setCursor(editor, pos.line, pos.col);
}

export function getLineColumn(editor: Editor): number {
  const text = getText(editor);
  return getCursorOffset(editor) - lineStart(text, getCursorOffset(editor));
}

/** Notify pi that content changed, and repaint. */
export function notifyChange(editor: Editor) {
  const anyEditor = editor as unknown as { onChange?: (text: string) => void };
  anyEditor.onChange?.(editor.getText());
  const internal = editorInternals(editor);
  internal.lastAction = null;
  internal.preferredVisualCol = null;
  internal.snappedFromCursorCol = null;
  const tui = (editor as unknown as { tui?: { requestRender(): void } }).tui;
  tui?.requestRender();
}

// ---------------------------------------------------------------------------
// Edit primitives (all operate on the buffer directly, undo via edit sessions)
// ---------------------------------------------------------------------------

/** Replace the whole buffer (flat model: text + absolute cursor offset).
 * Used by undo/redo restore. */
export function applySnapshot(editor: Editor, snapshot: { text: string; cursor: number }) {
  const state = stateOf(editor);
  state.lines = snapshot.text.length ? snapshot.text.split("\n") : [""];
  const pos = offsetToPos(editor, snapshot.cursor);
  setCursor(editor, Math.min(pos.line, state.lines.length - 1), pos.col);
  const internal = editorInternals(editor);
  internal.lastAction = null;
  internal.preferredVisualCol = null;
  internal.snappedFromCursorCol = null;
  notifyChange(editor);
}

export function captureSnapshot(editor: Editor): { text: string; cursor: number } {
  return { text: getText(editor), cursor: getCursorOffset(editor) };
}

/** Insert text at an absolute offset. Caller wraps in an edit session for undo. */
export function insertAt(editor: Editor, offset: number, insert: string) {
  const state = stateOf(editor);
  const pos = offsetToPos(editor, offset);
  const lineText = state.lines[pos.line] ?? "";
  const inserted = insert.split("\n");
  if (inserted.length === 1) {
    state.lines[pos.line] = lineText.slice(0, pos.col) + insert + lineText.slice(pos.col);
    setCursor(editor, pos.line, pos.col + insert.length);
    return;
  }
  const before = lineText.slice(0, pos.col);
  const after = lineText.slice(pos.col);
  const newLines = [
    ...state.lines.slice(0, pos.line),
    before + (inserted[0] ?? ""),
    ...inserted.slice(1, -1),
    (inserted[inserted.length - 1] ?? "") + after,
    ...state.lines.slice(pos.line + 1),
  ];
  state.lines = newLines;
  setCursor(editor, pos.line + inserted.length - 1, (inserted[inserted.length - 1] ?? "").length);
}

/** Delete an absolute span. Caller wraps in an edit session for undo. */
export function deleteSpan(editor: Editor, span: VimSpan) {
  if (!span || span.end <= span.start) return;
  const state = stateOf(editor);
  const startPos = offsetToPos(editor, span.start);
  const endPos = offsetToPos(editor, span.end);
  const startLine = state.lines[startPos.line] ?? "";
  if (startPos.line === endPos.line) {
    state.lines[startPos.line] = startLine.slice(0, startPos.col) + startLine.slice(endPos.col);
  } else {
    const endLine = state.lines[endPos.line] ?? "";
    state.lines[startPos.line] = startLine.slice(0, startPos.col) + endLine.slice(endPos.col);
    state.lines.splice(startPos.line + 1, endPos.line - startPos.line);
  }
  setCursor(editor, startPos.line, startPos.col);
}

// ---------------------------------------------------------------------------
// Flat-offset motion implementations (operate on text + cursorOffset)
// ---------------------------------------------------------------------------

function moveOffsetUp(text: string, offset: number, column: VimWantedColumn): number {
  const start = lineStart(text, offset);
  if (start === 0) return offset;
  const targetStart = lineStart(text, start - 1);
  const targetEnd = lineEnd(text, targetStart);
  const targetLast = targetEnd > targetStart ? targetEnd - 1 : targetStart;
  const col = column === "end" ? targetLast - targetStart : column;
  return Math.min(targetStart + col, targetLast);
}

function moveOffsetDown(text: string, offset: number, column: VimWantedColumn): number {
  const end = lineEnd(text, offset);
  if (end >= text.length) return offset;
  const targetStart = end + 1;
  const targetEnd = lineEnd(text, targetStart);
  const targetLast = targetEnd > targetStart ? targetEnd - 1 : targetStart;
  const col = column === "end" ? targetLast - targetStart : column;
  return Math.min(targetStart + col, targetLast);
}

export function moveLeft(editor: Editor) {
  const text = getText(editor);
  const offset = getCursorOffset(editor);
  setCursorOffset(editor, Math.max(lineStart(text, offset), offset - 1));
}

export function moveRight(editor: Editor) {
  const text = getText(editor);
  const offset = getCursorOffset(editor);
  const last = lineEnd(text, offset) > lineStart(text, offset) ? lineEnd(text, offset) - 1 : lineStart(text, offset);
  setCursorOffset(editor, Math.min(last, offset + 1));
}

export function moveLineUp(editor: Editor, column?: VimWantedColumn) {
  const text = getText(editor);
  const offset = getCursorOffset(editor);
  setCursorOffset(editor, moveOffsetUp(text, offset, column ?? offset - lineStart(text, offset)));
}

export function moveLineDown(editor: Editor, column?: VimWantedColumn) {
  const text = getText(editor);
  const offset = getCursorOffset(editor);
  setCursorOffset(editor, moveOffsetDown(text, offset, column ?? offset - lineStart(text, offset)));
}

/** Visual (wrapped) line down/up via pi's native moveCursor which honors sticky columns. */
export function moveVisualLine(editor: Editor, direction: "up" | "down") {
  const internal = editorInternals(editor);
  if (typeof internal.moveCursor === "function") {
    internal.moveCursor(direction === "up" ? -1 : 1, 0);
    return;
  }
  moveLineUp(editor);
}

export function moveLineBeginning(editor: Editor) {
  const text = getText(editor);
  setCursorOffset(editor, lineStart(text, getCursorOffset(editor)));
}

export function moveFirstNonWhitespace(editor: Editor) {
  const text = getText(editor);
  setCursorOffset(editor, firstNonWhitespace(text, getCursorOffset(editor)));
}

export function moveLineEnd(editor: Editor) {
  const text = getText(editor);
  const offset = getCursorOffset(editor);
  const end = lineEnd(text, offset);
  setCursorOffset(editor, end > lineStart(text, offset) ? end - 1 : lineStart(text, offset));
}

export function moveWordNext(editor: Editor, big = false) {
  const text = getText(editor);
  setCursorOffset(editor, nextWordStart(text, getCursorOffset(editor), big));
}

export function moveWordPrev(editor: Editor, big = false) {
  const text = getText(editor);
  setCursorOffset(editor, prevWordStart(text, getCursorOffset(editor), big));
}

export function moveWordEnd(editor: Editor, big = false) {
  const text = getText(editor);
  setCursorOffset(editor, wordEnd(text, getCursorOffset(editor), big));
}

export function moveMatchingBracket(editor: Editor): boolean {
  const text = getText(editor);
  const target = matchingBracketTarget(text, getCursorOffset(editor));
  if (target === null) return false;
  setCursorOffset(editor, target);
  return true;
}

export function movePreviousParagraph(editor: Editor) {
  setCursorOffset(editor, previousParagraphTarget(getText(editor), getCursorOffset(editor)));
}

export function moveNextParagraph(editor: Editor) {
  setCursorOffset(editor, nextParagraphTarget(getText(editor), getCursorOffset(editor)));
}

export function clampCursorToLine(editor: Editor) {
  const text = getText(editor);
  const offset = getCursorOffset(editor);
  const end = lineEnd(text, offset);
  const last = end > lineStart(text, offset) ? end - 1 : lineStart(text, offset);
  if (offset > last) setCursorOffset(editor, last);
}

// ---------------------------------------------------------------------------
// Char find motions
// ---------------------------------------------------------------------------

export function findCharCount(
  editor: Editor,
  char: string,
  forward: boolean,
  till: boolean,
  count: number,
  repeat = false,
) {
  const text = getText(editor);
  const start = getCursorOffset(editor);
  const lineStartOffset = lineStart(text, start);
  const lineEndOffset = lineEnd(text, start);
  const line = text.slice(lineStartOffset, lineEndOffset);
  let target: number | null = start - lineStartOffset;
  for (let i = 0; i < count && target !== null; i++) {
    const skip = till && repeat && i === 0 ? 2 : 1;
    target = findCharTargetInLine(line, target, char, forward, skip);
  }
  if (target === null) return;
  const absolute = lineStartOffset + target;
  setCursorOffset(editor, absolute + (till ? (forward ? -1 : 1) : 0));
}

// ---------------------------------------------------------------------------
// Edits
// ---------------------------------------------------------------------------

export function deleteUnderCursor(editor: Editor): VimRegister {
  const text = getText(editor);
  const start = getCursorOffset(editor);
  const end = lineEnd(text, start);
  if (start >= end) return null;
  const yanked = text[start] ?? "";
  withSession(editor, () => {
    deleteSpan(editor, { start, end: start + 1 });
    const after = getText(editor);
    const lineLastOffset =
      lineEnd(after, start) > lineStart(after, start) ? lineEnd(after, start) - 1 : lineStart(after, start);
    setCursorOffset(editor, Math.min(start, lineLastOffset));
  });
  return { text: yanked, linewise: false };
}

export function deleteLineEnd(editor: Editor): VimRegister {
  const text = getText(editor);
  const start = getCursorOffset(editor);
  const end = lineEnd(text, start);
  if (end <= start) return null;
  const yanked = text.slice(start, end);
  withSession(editor, () => {
    deleteSpan(editor, { start, end });
    const after = getText(editor);
    const last = lineEnd(after, start) > lineStart(after, start) ? lineEnd(after, start) - 1 : lineStart(after, start);
    setCursorOffset(editor, Math.min(start, last));
  });
  return { text: yanked, linewise: false };
}

export function deleteLine(editor: Editor, anchor?: number): VimRegister {
  const text = getText(editor);
  if (!text.length) return null;
  const offset = getCursorOffset(editor);
  const lo = anchor !== undefined ? Math.min(anchor, offset) : offset;
  const hi = anchor !== undefined ? Math.max(anchor, offset) : offset;
  const start = lineStart(text, lo);
  const end = lineEnd(text, hi);
  const yanked = text.slice(start, end);
  const afterText = getText(editor);
  let nextOffset: number;
  if (end < afterText.length) {
    withSession(editor, () => deleteSpan(editor, { start, end: end + 1 }));
    nextOffset = lineStart(getText(editor), start);
  } else if (start > 0) {
    withSession(editor, () => deleteSpan(editor, { start: start - 1, end }));
    nextOffset = lineStart(getText(editor), start - 1);
  } else {
    withSession(editor, () => deleteSpan(editor, { start, end }));
    nextOffset = 0;
  }
  setCursorOffset(editor, nextOffset);
  return { text: yanked, linewise: true };
}

export function substituteLine(editor: Editor, anchor?: number): VimRegister {
  const text = getText(editor);
  const offset = getCursorOffset(editor);
  const lo = anchor !== undefined ? Math.min(anchor, offset) : offset;
  const hi = anchor !== undefined ? Math.max(anchor, offset) : offset;
  const start = lineStart(text, lo);
  const end = lineEnd(text, hi);
  if (end <= start) return null;
  const yanked = text.slice(start, end);
  withSession(editor, () => {
    deleteSpan(editor, { start, end });
  });
  return { text: yanked, linewise: true };
}

/** S (change to start-of-line content) / C (change to end-of-line): content variant of D. */
export function substituteLineEnd(editor: Editor): VimRegister {
  const text = getText(editor);
  const offset = getCursorOffset(editor);
  const end = lineEnd(text, offset);
  if (end <= offset) return null;
  const yanked = text.slice(offset, end);
  withSession(editor, () => {
    deleteSpan(editor, { start: offset, end });
  });
  return { text: yanked, linewise: false };
}

export function appendAfterCursor(editor: Editor) {
  const text = getText(editor);
  const offset = getCursorOffset(editor);
  const end = lineEnd(text, offset);
  setCursorOffset(editor, Math.min(offset + 1, end));
}

export function appendLineEnd(editor: Editor) {
  const text = getText(editor);
  setCursorOffset(editor, lineEnd(text, getCursorOffset(editor)));
}

export function insertLineStart(editor: Editor) {
  const text = getText(editor);
  setCursorOffset(editor, firstNonWhitespace(text, getCursorOffset(editor)));
}

export function openLineBelow(editor: Editor) {
  const text = getText(editor);
  const end = lineEnd(text, getCursorOffset(editor));
  withSession(editor, () => {
    setCursorOffset(editor, end);
    insertAt(editor, end, "\n");
  });
  notifyChange(editor);
}

export function openLineAbove(editor: Editor) {
  const text = getText(editor);
  const start = lineStart(text, getCursorOffset(editor));
  withSession(editor, () => {
    setCursorOffset(editor, start);
    insertAt(editor, start, "\n");
    setCursorOffset(editor, start);
  });
  notifyChange(editor);
}

export function joinLines(editor: Editor) {
  const text = getText(editor);
  const end = lineEnd(text, getCursorOffset(editor));
  if (end >= text.length) return;
  let next = end + 1;
  while (next < text.length && (text[next] === " " || text[next] === "\t")) next++;
  const trailing = end > 0 && /[ \t]/.test(text[end - 1]!);
  const paren = next < text.length && text[next] === ")";
  withSession(editor, () => {
    deleteSpan(editor, { start: end, end: next });
    if (!trailing && !paren) {
      insertAt(editor, end, " ");
      setCursorOffset(editor, end);
    }
  });
  notifyChange(editor);
}

export function toggleCaseAtCursor(editor: Editor) {
  const text = getText(editor);
  const start = getCursorOffset(editor);
  const end = lineEnd(text, start);
  if (start >= end) return false;
  const char = text[start] ?? "";
  const next = swapCase(char);
  if (next !== char) {
    withSession(editor, () => {
      deleteSpan(editor, { start, end: start + 1 });
      insertAt(editor, start, next);
      setCursorOffset(editor, start);
    });
    notifyChange(editor);
  }
  moveRight(editor);
  return true;
}

export function replaceUnderCursor(editor: Editor, value: string) {
  const text = getText(editor);
  const offset = getCursorOffset(editor);
  if (offset >= text.length || text[offset] === "\n") {
    insertAt(editor, offset, value);
    return;
  }
  deleteSpan(editor, { start: offset, end: offset + 1 });
  insertAt(editor, offset, value);
}

// ---------------------------------------------------------------------------
// Paste
// ---------------------------------------------------------------------------

export function pasteAfter(editor: Editor, reg: VimRegister) {
  if (!reg) return;
  withSession(editor, () => {
    if (reg.linewise) {
      const text = getText(editor);
      const end = lineEnd(text, getCursorOffset(editor));
      const value = reg.text.endsWith("\n") ? reg.text.slice(0, -1) : reg.text;
      insertAt(editor, end, "\n" + value);
      setCursorOffset(editor, end + 1);
      return;
    }
    const offset = getCursorOffset(editor);
    const at = Math.min(offset + 1, getText(editor).length);
    insertAt(editor, at, reg.text);
    setCursorOffset(editor, at);
  });
  notifyChange(editor);
}

export function pasteBefore(editor: Editor, reg: VimRegister) {
  if (!reg) return;
  withSession(editor, () => {
    if (reg.linewise) {
      const text = getText(editor);
      const start = lineStart(text, getCursorOffset(editor));
      const value = reg.text.endsWith("\n") ? reg.text.slice(0, -1) : reg.text;
      insertAt(editor, start, value + "\n");
      setCursorOffset(editor, start);
      return;
    }
    const offset = getCursorOffset(editor);
    insertAt(editor, offset, reg.text);
    setCursorOffset(editor, offset);
  });
  notifyChange(editor);
}

// ---------------------------------------------------------------------------
// Undo integration with pi's own UndoStack
// ---------------------------------------------------------------------------

/** Push the current state onto pi's undo stack (call before a mutation).
 *
 * pi's `u` pops the last snapshot and applies it, so exactly one push before
 * the mutation records one whole change.
 */
export function pushUndo(editor: Editor) {
  const internal = editorInternals(editor);
  if (typeof internal.pushUndoSnapshot === "function") {
    internal.pushUndoSnapshot();
    return;
  }
  const st = internal.state;
  if (st && internal.undoStack) {
    internal.undoStack.push({ lines: [...st.lines], cursorLine: st.cursorLine, cursorCol: st.cursorCol });
  }
}

/**
 * Run a mutation as one atomic undoable edit: one snapshot before the change,
 * so pi's `u` reverts exactly this change.
 */
export function withSession(editor: Editor, run: () => void) {
  pushUndo(editor);
  const internal = editorInternals(editor);
  internal.cancelAutocomplete?.();
  run();
}
