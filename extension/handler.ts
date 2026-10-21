/**
 * Vim key dispatch, ported from the opencode-vim-plugin vim core
 * (https://github.com/leohenon/opencode-vim-plugin — MIT, © leohenon).
 *
 * The upstream core talks to an OpenCode TextareaRenderable; this version
 * drives pi's Editor through the editor-adapter. Copy-mode and display-line
 * (wrapped-line) motions from upstream are omitted — pi's editor handles its
 * own scrolling and wraps within logical lines.
 *
 * Undo model (upstream parity): every mutating vim command records one
 * {before, after} snapshot into the vim state history. Insert-mode typing
 * lives outside the handler; entering insert via a vim command opens a
 * session (beginEdit) and Esc/submit commits it, so a whole typing session
 * is one undo unit. u/<C-r> never touch pi's own undo stack. Dot-repeat
 * replays the recorded closure (plain edits) or the text diff (insert
 * sessions) at the current cursor.
 */

import * as ed from "./editor-adapter";
import type { Editor } from "@earendil-works/pi-tui";
import { applyLangmap, keyText } from "./langmap";
import { vimJump, vimScroll, vimWindowNavigation, type VimKeyEvent } from "./keys";
import {
  bracketTextObjectSpan,
  findCharTargetInLine,
  firstNonWhitespace,
  lineEnd,
  lineStart,
  matchingBracketTarget,
  nextParagraphTarget,
  nextWordStart,
  prevWordStart,
  previousParagraphTarget,
  quoteTextObjectSpan,
  swapCase,
  wordEnd,
  wordTextObjectSpan,
  type VimOperator,
  type VimOperatorResult,
  type VimRegister,
  type VimSpan,
  type VimWantedColumn,
} from "./text-core";
import type { VimState } from "./state";

type VimFindOperator = "f" | "F" | "t" | "T";
type VimTextObjectScope = "inner" | "around";

type Snapshot = { text: string; cursor: number };

export type VimHandlerInput = {
  state: VimState;
  editor: () => Editor;
  submit: () => void;
  openCommandPalette: () => void;
  scroll: (action: ReturnType<typeof vimScroll>) => void;
  langmap: () => Record<string, string> | undefined;
  escapeSequence: string | null;
  onModeChanged: () => void;
  onRegisterWrite: (reg: VimRegister, isYank: boolean) => void;
  /** System-clipboard mirror (active unless clipboardMirror is "never"). */
  clipboard?: { enabled(): boolean; get(): VimRegister | null };
};

function hasModifier(event: VimKeyEvent) {
  return event.ctrl || event.meta || event.alt;
}

export type { VimKeyEvent };

export function normalizedKeyName(event: VimKeyEvent): string {
  const text = event.char;
  if (text && (":/?@\"'`()[]{}<>".includes(text) || text.length === 1)) return text;
  return event.name;
}

export function createVimHandler(input: VimHandlerInput) {
  let wantedColumn: VimWantedColumn | undefined;
  let pendingOperatorCount = 1;
  let pendingOperatorFind: { operation: VimOperator; find: VimFindOperator } | undefined;
  let pendingOperatorDisplay: VimOperator | undefined;
  let pendingTextObject: { operation: VimOperator; scope: VimTextObjectScope } | undefined;

  // Two-key escape sequence (e.g. "jk") support. First char types normally
  // when the sequence is configured; on the matching second key the typed
  // char is removed and insert mode exits.
  const escapeSeq = input.escapeSequence;
  const escapeSecond = escapeSeq?.[1];
  let escapePending = false;
  let escapeTimer: ReturnType<typeof setTimeout> | null = null;

  function clearEscapePending() {
    escapePending = false;
    if (escapeTimer) {
      clearTimeout(escapeTimer);
      escapeTimer = null;
    }
  }

  function isPrintable(event: VimKeyEvent) {
    const key = normalizedKeyName(event);
    return key.length === 1 || key === "space";
  }

  function value(event: VimKeyEvent) {
    if (event.char) return event.char;
    const key = event.name;
    if (key === "space") return " ";
    if (event.shift && key.length === 1 && /[a-z]/.test(key)) return key.toUpperCase();
    return key;
  }

  function isShifted(event: VimKeyEvent, key: string) {
    return event.name === key.toUpperCase() || (event.name === key && !!event.shift) || event.char === key.toUpperCase();
  }

  function langmapped(event: VimKeyEvent): VimKeyEvent {
    if (hasModifier(event)) return event;
    if (["r", "vr", "f", "F", "t", "T"].includes(input.state.pending)) return event;
    const raw = keyText(event) ?? event.name;
    const mapped = applyLangmap(event, raw, input.langmap());
    if (mapped === raw) return event;
    return { ...event, name: mapped, char: mapped, shift: /[A-Z]/.test(mapped) };
  }

  function countedRegister(reg: VimRegister, count: number): VimRegister {
    if (!reg || count <= 1) return reg;
    const separator = reg.linewise && !reg.text.endsWith("\n") ? "\n" : "";
    return { ...reg, text: Array.from({ length: count }, () => reg.text).join(separator) };
  }

  function clearWantedColumn() {
    wantedColumn = undefined;
  }

  function cancelPending() {
    clearEscapePending();
    pendingOperatorCount = 1;
    pendingOperatorFind = undefined;
    pendingOperatorDisplay = undefined;
    pendingTextObject = undefined;
    clearWantedColumn();
    input.state.clearPending();
  }

  function repeatCount(count: number, run: () => void) {
    for (let i = 0; i < count; i++) run();
  }

  function takeCount(defaultValue = 1) {
    return input.state.takeCount(defaultValue);
  }

  function takeOperatorCount() {
    const count = takeCount(pendingOperatorCount);
    pendingOperatorCount = 1;
    return count;
  }

  function isCountDigit(event: VimKeyEvent, key: string) {
    return !event.shift && !hasModifier(event) && /^[1-9]$/.test(key);
  }

  function isCountInput(event: VimKeyEvent, key: string) {
    return !input.state.pending && (isCountDigit(event, key) || (key === "0" && input.state.count));
  }

  function isPendingOperatorCountInput(event: VimKeyEvent, key: string) {
    return (
      pendingOperatorCount === 1 &&
      (input.state.pending === "c" || input.state.pending === "d" || input.state.pending === "y") &&
      (isCountDigit(event, key) || (key === "0" && input.state.count))
    );
  }

  function startOperator(operation: VimOperator) {
    const display = input.state.count + operation;
    pendingOperatorCount = takeCount();
    input.state.setPending(operation, display);
  }

  function lineStartForCount(text: string, offset: number, count: number) {
    let current = offset;
    for (let i = 0; i < count - 1; i++) {
      const end = lineEnd(text, current);
      current = end >= text.length ? current : end + 1;
    }
    return current;
  }

  function moveVertical(direction: "up" | "down") {
    const editor = input.editor();
    const column = wantedColumn ?? ed.getLineColumn(editor);
    if (direction === "up") ed.moveLineUp(editor, column);
    else ed.moveLineDown(editor, column);
    wantedColumn = column;
  }

  function preservesWantedColumn(event: VimKeyEvent, key: string) {
    if (key === "g" && !event.shift && !hasModifier(event)) return true;
    if ((key === "j" || key === "k" || key === "down" || key === "up") && !event.shift && !hasModifier(event))
      return true;
    return (key === "v" || isShifted(event, "v")) && !hasModifier(event);
  }

  function snapshot(): Snapshot {
    const editor = input.editor();
    return { text: ed.getText(editor), cursor: ed.getCursorOffset(editor) };
  }

  function restore(next: Snapshot) {
    clearWantedColumn();
    input.state.clearPending();
    input.state.setMode("normal");
    input.state.cancelEdit();
    ed.applySnapshot(input.editor(), { text: next.text, cursor: next.cursor });
    input.onModeChanged();
  }

  // ----- repeat (dot) -----

  function changed(before: Snapshot, after: Snapshot) {
    return before.text !== after.text || before.cursor !== after.cursor;
  }

  function edit(run: () => boolean | void) {
    const before = snapshot();
    const repeatable = !input.state.replaying && !input.state.isVisual();
    const applied = run() === true;
    const after = snapshot();
    input.state.push(before, after);
    if (!repeatable) return;
    if (applied || changed(before, after)) {
      input.state.setRepeat({
        run() {
          const beforeReplay = snapshot();
          input.state.setReplaying(true);
          try {
            run();
          } finally {
            input.state.setReplaying(false);
          }
          const afterReplay = snapshot();
          input.state.push(beforeReplay, afterReplay);
          return true;
        },
      });
    }
  }

  /** Wrap a normal-mode mutation: one vim undo unit + dot-repeat record. */
  function mutate(run: () => boolean | void) {
    edit(run);
    ed.notifyChange(input.editor());
  }

  /**
   * Enter an insert session: begin undo tracking at the current state, run
   * the mutation (if any), then insert typing continues outside the handler.
   * Esc/submit later calls commitInsert() to close the session.
   */
  function beginInsertSession(run?: () => boolean | void) {
    const before = snapshot();
    input.state.beginEdit(before);
    if (run && run() === false) input.state.cancelEdit();
    goInsert();
  }

  function goInsert() {
    input.state.setMode("insert");
    input.onModeChanged();
  }

  // ----- registers -----

  /** Paste source: OS clipboard first when the mirror is enabled, else the internal register. */
  function getRegister(): VimRegister {
    return input.clipboard?.get() ?? input.state.register;
  }

  function setRegister(next: VimRegister, isYank = false) {
    input.state.setRegister(next);
    if (next) input.onRegisterWrite(next, isYank);
  }

  function applyOperatorYank(result: VimOperatorResult) {
    if (result.register) setRegister(result.register, true);
    input.state.clearPending();
  }

  function applyOperatorEdit(result: () => VimOperatorResult, operation: "d" | "c") {
    const apply = () => {
      const next = result();
      if (!next.span && !next.register) {
        input.state.clearPending();
        return false;
      }
      const editor = input.editor();
      if (next.span && next.span.end > next.span.start) ed.deleteSpan(editor, next.span);
      if (next.span && next.span.end === next.span.start) ed.setCursorOffset(editor, next.span.start);
      if (next.register) setRegister(next.register);
      input.state.clearPending();
      if (operation === "c") goInsert();
      return true;
    };
    if (operation === "c") beginInsertSession(apply);
    else mutate(apply);
  }

  function applyOperatorResult(result: () => VimOperatorResult, operation: VimOperator) {
    const initial = result();
    if (!initial.span && !initial.register) {
      input.state.clearPending();
      return;
    }
    if (operation === "y") {
      applyOperatorYank(initial);
      return;
    }
    applyOperatorEdit(result, operation);
  }

  // ----- operator motion results -----

  function charwiseOperation(text: string, span: VimSpan | null): VimOperatorResult {
    if (!span) return { span: null, register: null };
    return { span, register: { text: text.slice(span.start, span.end), linewise: false } };
  }

  function linewiseOperation(text: string, span: VimSpan | null): VimOperatorResult {
    if (!span) return { span: null, register: null };
    const slice = text.slice(span.start, span.end);
    return { span, register: { text: slice.endsWith("\n") ? slice : slice + "\n", linewise: true } };
  }

  function nextWordOperation(text: string, start: number, big: boolean, count = 1) {
    let end = start;
    for (let i = 0; i < count; i++) end = nextWordStart(text, end, big);
    return charwiseOperation(text, end > start ? { start, end } : null);
  }

  function previousWordOperation(text: string, end: number, count = 1) {
    let start = end;
    for (let i = 0; i < count; i++) start = prevWordStart(text, start, false);
    return charwiseOperation(text, start < end ? { start, end } : null);
  }

  function wordEndOperation(text: string, start: number, big: boolean, count = 1) {
    if (start >= text.length) return charwiseOperation(text, null);
    let end = start;
    for (let i = 0; i < count; i++) end = wordEnd(text, end, big) + 1;
    return charwiseOperation(text, end > start ? { start, end } : null);
  }

  function lineSpanCount(text: string, cursor: number, count: number) {
    const start = lineStart(text, cursor);
    const target = lineStartForCount(text, cursor, count);
    return { start, end: lineEnd(text, target) };
  }

  function lineMotionAnchor(direction: "up" | "down", count: number): number | null {
    const editor = input.editor();
    const cursor = ed.getCursorOffset(editor);
    const start = lineStart(ed.getText(editor), cursor);
    repeatCount(count, () => (direction === "down" ? ed.moveLineDown(editor, 0) : ed.moveLineUp(editor, 0)));
    const anchor = ed.getCursorOffset(editor);
    ed.setCursorOffset(editor, cursor);
    return lineStart(ed.getText(editor), anchor) === start ? null : anchor;
  }

  function yankLineCount(text: string, cursor: number, count: number) {
    const span = lineSpanCount(text, cursor, count);
    return { span, register: { text: text.slice(span.start, span.end), linewise: true } };
  }

  function changeWordOperation(text: string, cursor: number, big: boolean, count = 1) {
    const char = text[cursor];
    return char && !/\s/.test(char) ? wordEndOperation(text, cursor, big, count) : nextWordOperation(text, cursor, big, count);
  }

  function wordOperatorEvent(editor: Editor, key: string, operation: VimOperator, event_: VimKeyEvent): boolean {
    const text = ed.getText(editor);
    const cursor = ed.getCursorOffset(editor);
    if ((key === "w" || isShifted(event_, "w")) && !hasModifier(event_)) {
      const big = isShifted(event_, "w");
      const count = takeOperatorCount();
      applyOperatorResult(
        () => (operation === "c" ? changeWordOperation(text, cursor, big, count) : nextWordOperation(text, cursor, big, count)),
        operation,
      );
      return true;
    }
    if (key === "b" && !event_.shift && !hasModifier(event_) && operation !== "y") {
      const count = takeOperatorCount();
      applyOperatorResult(() => previousWordOperation(text, cursor, count), operation);
      return true;
    }
    if ((key === "e" || isShifted(event_, "e")) && !hasModifier(event_)) {
      const count = takeOperatorCount();
      applyOperatorResult(() => wordEndOperation(text, cursor, isShifted(event_, "e"), count), operation);
      return true;
    }
    return false;
  }

  function lineEndCountOperation(text: string, cursor: number, count: number) {
    const end = lineEnd(text, lineStartForCount(text, cursor, count));
    return charwiseOperation(text, end > cursor ? { start: cursor, end } : null);
  }

  function lineBoundaryMotionEvent(editor: Editor, key: string, operation: VimOperator, event_: VimKeyEvent): boolean {
    const text = ed.getText(editor);
    const cursor = ed.getCursorOffset(editor);
    if (key === "$" && !hasModifier(event_)) {
      const count = takeOperatorCount();
      applyOperatorResult(() => lineEndCountOperation(text, cursor, count), operation);
      return true;
    }
    if (key === "0" && !event_.shift && !hasModifier(event_)) {
      pendingOperatorCount = 1;
      const start = lineStart(text, cursor);
      applyOperatorResult(() => charwiseOperation(text, start < cursor ? { start, end: cursor } : null), operation);
      return true;
    }
    if ((key === "^" || key === "_") && !hasModifier(event_)) {
      pendingOperatorCount = 1;
      const target = firstNonWhitespace(text, cursor);
      applyOperatorResult(
        () => charwiseOperation(text, target !== cursor ? { start: Math.min(target, cursor), end: Math.max(target, cursor) } : null),
        operation,
      );
      return true;
    }
    return false;
  }

  function findCharTargetOffset(text: string, cursor: number, char: string, forward: boolean, till: boolean, count: number, repeat = false) {
    const lineStartOffset = lineStart(text, cursor);
    const lineEndOffset = lineEnd(text, cursor);
    const line = text.slice(lineStartOffset, lineEndOffset === -1 ? text.length : lineEndOffset);
    let target: number | null = cursor - lineStartOffset;
    for (let i = 0; i < count && target !== null; i++) {
      const skip = till && repeat && i === 0 ? 2 : 1;
      target = findCharTargetInLine(line, target, char, forward, skip);
    }
    return target === null ? null : lineStartOffset + target;
  }

  function findOperation(text: string, cursor: number, char: string, forward: boolean, till: boolean, count = 1) {
    const offset = findCharTargetOffset(text, cursor, char, forward, till, count);
    if (offset === null) return charwiseOperation(text, null);
    if (forward) {
      const spanEnd = till ? offset : offset + 1;
      return charwiseOperation(text, spanEnd > cursor ? { start: cursor, end: spanEnd } : null);
    }
    const spanStart = till ? offset + 1 : offset;
    return charwiseOperation(text, spanStart < cursor ? { start: spanStart, end: cursor } : null);
  }

  function startOperatorFind(operation: VimOperator, find: VimFindOperator) {
    pendingOperatorFind = { operation, find };
    input.state.setPending(find, (input.state.pendingDisplay || operation) + find);
    return true;
  }

  function operatorFind(event_: VimKeyEvent, key: string, operation: VimOperator): boolean {
    if (key === "f" && !event_.shift && !hasModifier(event_)) return startOperatorFind(operation, "f");
    if (isShifted(event_, "f") && !hasModifier(event_)) return startOperatorFind(operation, "F");
    if (key === "t" && !event_.shift && !hasModifier(event_)) return startOperatorFind(operation, "t");
    if (isShifted(event_, "t") && !hasModifier(event_)) return startOperatorFind(operation, "T");
    return false;
  }

  function startTextObject(operation: VimOperator, scope: VimTextObjectScope) {
    const display = (input.state.pendingDisplay || operation) + (scope === "around" ? "a" : "i");
    takeOperatorCount();
    pendingTextObject = { operation, scope };
    input.state.setPending(operation, display);
    return true;
  }

  function operatorTextObject(event_: VimKeyEvent, key: string, operation: VimOperator): boolean {
    if (key === "i" && !event_.shift && !hasModifier(event_)) return startTextObject(operation, "inner");
    if (key === "a" && !event_.shift && !hasModifier(event_)) return startTextObject(operation, "around");
    return false;
  }

  function resolveTextObject(key: string, scope: VimTextObjectScope, operation: VimOperator, event_: VimKeyEvent) {
    const editor = input.editor();
    const text = ed.getText(editor);
    const cursor = ed.getCursorOffset(editor);
    const noOp = (): VimOperatorResult => ({ span: null, register: null });
    if ((key === "w" || key === "W") && !hasModifier(event_)) {
      return () => {
        const span = wordTextObjectSpan(text, cursor, scope === "around", key === "W");
        return span ? { span, register: { text: text.slice(span.start, span.end), linewise: false } } : noOp();
      };
    }
    if ((key === '"' || key === "'" || key === "`") && !hasModifier(event_)) {
      return () => {
        const span = quoteTextObjectSpan(text, cursor, scope === "around", key);
        return span ? { span, register: { text: text.slice(span.start, span.end), linewise: false } } : noOp();
      };
    }
    if ("()[]{}<>".includes(key) && !hasModifier(event_)) {
      return () => {
        const span = bracketTextObjectSpan(text, cursor, scope === "around", key, operation);
        return span ? { span, register: { text: text.slice(span.start, span.end), linewise: false } } : noOp();
      };
    }
    return undefined;
  }

  function pendingTextObjectOperator(event_: VimKeyEvent, key: string): boolean {
    if (!pendingTextObject) return false;
    if (input.state.pending !== pendingTextObject.operation) {
      pendingTextObject = undefined;
      return false;
    }
    const textObject = pendingTextObject;
    const operation = resolveTextObject(key, textObject.scope, textObject.operation, event_);
    pendingTextObject = undefined;
    if (operation) {
      pendingOperatorCount = 1;
      applyOperatorResult(operation, textObject.operation);
      return true;
    }
    pendingOperatorCount = 1;
    input.state.clearPending();
    return true;
  }

  function pendingFindOperator(event_: VimKeyEvent): boolean {
    if (!pendingOperatorFind) return false;
    if (input.state.pending !== pendingOperatorFind.find) {
      pendingOperatorFind = undefined;
      pendingOperatorCount = 1;
      return false;
    }
    if (isPrintable(event_) && !hasModifier(event_)) {
      const forward = pendingOperatorFind.find === "f" || pendingOperatorFind.find === "t";
      const till = pendingOperatorFind.find === "t" || pendingOperatorFind.find === "T";
      const char = value(event_);
      const operation = pendingOperatorFind.operation;
      const count = takeOperatorCount();
      pendingOperatorFind = undefined;
      applyOperatorResult(() => findOperation(ed.getText(input.editor()), ed.getCursorOffset(input.editor()), char, forward, till, count), operation);
      input.state.setLastFind({ char, forward, till });
      return true;
    }
    pendingOperatorFind = undefined;
    pendingOperatorCount = 1;
    input.state.clearPending();
    return true;
  }

  // ----- paragraph / bracket operators -----

  function paragraphOperator(key: string, operation: VimOperator): boolean {
    if (key !== "{" && key !== "}") return false;
    const count = takeOperatorCount();
    applyOperatorResult(() => {
      const text = ed.getText(input.editor());
      const cursor = ed.getCursorOffset(input.editor());
      if (key === "}") {
        let target = cursor;
        for (let i = 0; i < count; i++) target = nextParagraphTarget(text, target);
        if (target <= cursor) return { span: null, register: null };
        if (cursor === lineStart(text, cursor) || input.state.isVisualLine()) {
          const end = lineEnd(text, cursor) >= text.length - 1 && count === 1 ? text.length : target;
          return linewiseOperation(text, { start: cursor, end });
        }
        return charwiseOperation(text, { start: cursor, end: target + 1 });
      }
      let target = cursor;
      for (let i = 0; i < count; i++) target = previousParagraphTarget(text, target);
      if (target >= cursor) return { span: null, register: null };
      if (cursor === lineStart(text, cursor)) return linewiseOperation(text, { start: target, end: cursor });
      return charwiseOperation(text, { start: target, end: cursor });
    }, operation);
    return true;
  }

  function matchingBracketOperator(key: string, operation: VimOperator): boolean {
    if (key !== "%") return false;
    pendingOperatorCount = 1;
    applyOperatorResult(() => {
      const text = ed.getText(input.editor());
      const cursor = ed.getCursorOffset(input.editor());
      const target = matchingBracketTarget(text, cursor);
      if (target === null) return { span: null, register: null };
      const span = target < cursor ? { start: target, end: cursor + 1 } : { start: cursor, end: target + 1 };
      return { span, register: { text: text.slice(span.start, span.end), linewise: false } };
    }, operation);
    return true;
  }

  function verticalMotionOperator(event_: VimKeyEvent, key: string, operation: VimOperator): boolean {
    const direction = key === "j" || key === "down" ? "down" : key === "k" || key === "up" ? "up" : undefined;
    if (!direction || event_.shift || hasModifier(event_)) return false;
    const count = takeOperatorCount();
    if (operation === "y") {
      const anchor = lineMotionAnchor(direction, count);
      if (anchor === null) {
        input.state.clearPending();
        return true;
      }
      const editor = input.editor();
      const text = ed.getText(editor);
      const cursor = ed.getCursorOffset(editor);
      const start = lineStart(text, Math.min(cursor, anchor));
      const end = lineEnd(text, Math.max(cursor, anchor));
      const slice = end < text.length ? text.slice(start, end) : text.slice(start, end);
      setRegister({ text: slice, linewise: true }, true);
      input.state.clearPending();
      return true;
    }
    if (operation === "d") {
      mutate(() => {
        const anchor = lineMotionAnchor(direction, count);
        const reg = anchor === null ? null : ed.deleteLine(input.editor(), anchor);
        input.state.clearPending();
        if (reg) setRegister(reg);
      });
      return true;
    }
    beginInsertSession(() => {
      const anchor = lineMotionAnchor(direction, count);
      const reg = anchor === null ? null : ed.substituteLine(input.editor(), anchor);
      input.state.clearPending();
      if (reg) setRegister(reg);
    });
    return true;
  }

  function doubledOperator(op: "c" | "d" | "y") {
    if (op === "c") {
      const count = takeOperatorCount();
      beginInsertSession(() => {
        const anchor = countAnchor(count);
        const reg = anchor === null ? null : ed.substituteLine(input.editor(), anchor);
        if (reg) setRegister(reg);
        input.state.clearPending();
      });
      return;
    }
    if (op === "d") {
      const count = takeOperatorCount();
      mutate(() => {
        const anchor = countAnchor(count);
        const reg = anchor === null ? null : ed.deleteLine(input.editor(), anchor);
        if (reg) setRegister(reg);
        input.state.clearPending();
      });
      return;
    }
    const editor = input.editor();
    const result = yankLineCount(ed.getText(editor), ed.getCursorOffset(editor), takeOperatorCount());
    setRegister(result.register, true);
    input.state.clearPending();
  }

  /** Anchor N-1 lines below the cursor, used by dd/cc-style count semantics. */
  function countAnchor(count: number): number | null {
    const editor = input.editor();
    const cursor = ed.getCursorOffset(editor);
    let anchor: number | null = cursor;
    repeatCount(count - 1, () => {
      ed.moveLineDown(editor, 0);
      anchor = ed.getCursorOffset(editor);
    });
    ed.setCursorOffset(editor, cursor);
    return anchor;
  }

  function operatorPending(op: "c" | "d" | "y", event_: VimKeyEvent, key: string): boolean | undefined {
    if (hasModifier(event_)) {
      pendingOperatorCount = 1;
      input.state.clearPending();
      return false;
    }
    if (pendingOperatorCount === 1 && (isCountDigit(event_, key) || (key === "0" && input.state.count))) {
      const before = input.state.count;
      input.state.appendCountDigit(key);
      if (input.state.count !== before)
        input.state.setPending(op, (input.state.pendingDisplay || op) + key);
      return true;
    }
    if (key === op && !event_.shift) {
      doubledOperator(op);
      return true;
    }
    const editor = input.editor();
    if (verticalMotionOperator(event_, key, op)) return true;
    if (wordOperatorEvent(editor, key, op, event_)) return true;
    if (lineBoundaryMotionEvent(editor, key, op, event_)) return true;
    if (operatorTextObject(event_, key, op)) return true;
    if (paragraphOperator(key, op)) return true;
    if (matchingBracketOperator(key, op)) return true;
    if (operatorFind(event_, key, op)) return true;
    pendingOperatorCount = 1;
    pendingTextObject = undefined;
    input.state.clearPending();
    return undefined;
  }

  // ----- undo / redo -----

  function undo() {
    const next = input.state.undo(snapshot());
    if (!next) return false;
    restore(next);
    return true;
  }

  function redo() {
    const next = input.state.redo(snapshot());
    if (!next) return false;
    restore(next);
    return true;
  }

  // ----- visual mode helpers -----

  function selectionRange(anchor: number, linewise: boolean) {
    const text = ed.getText(input.editor());
    const cursor = ed.getCursorOffset(input.editor());
    let start = Math.min(anchor, cursor);
    let end = Math.max(anchor + 1, cursor + 1);
    if (linewise) {
      start = lineStart(text, start);
      end = lineEnd(text, end - 1);
      if (end < text.length) end++;
    }
    return { start, end };
  }

  function deleteSelection(linewise: boolean, anchor: number): VimRegister {
    const text = ed.getText(input.editor());
    const sel = selectionRange(anchor, linewise);
    if (!sel || sel.end <= sel.start) return null;
    const yanked = text.slice(sel.start, sel.end);
    let start = sel.start;
    let end = sel.end;
    if (linewise) {
      const hasTrailingNl = end < text.length && text[end - 1] === "\n";
      const hasLeadingNl = start > 0 && text[start - 1] === "\n";
      if (!hasTrailingNl && end < text.length && text[end] === "\n") {
        end++;
      } else if (!hasTrailingNl && hasLeadingNl) {
        start--;
      }
    }
    ed.deleteSpan(input.editor(), { start, end });
    const after = ed.getText(input.editor());
    if (linewise) {
      ed.setCursorOffset(input.editor(), lineStart(after, Math.min(start, Math.max(after.length - 1, 0))));
    } else {
      ed.setCursorOffset(input.editor(), Math.min(start, Math.max(after.length - 1, 0)));
    }
    return { text: yanked, linewise };
  }

  function yankSelection(linewise: boolean, anchor: number): VimRegister {
    const text = ed.getText(input.editor());
    const sel = selectionRange(anchor, linewise);
    if (!sel || sel.end <= sel.start) return null;
    return { text: text.slice(sel.start, sel.end), linewise };
  }

  function toggleSelectionCase(linewise: boolean, anchor: number) {
    const text = ed.getText(input.editor());
    const sel = selectionRange(anchor, linewise);
    if (!sel) return;
    const slice = text.slice(sel.start, sel.end);
    const next = slice
      .split("")
      .map((char) => (char === "\n" ? char : swapCase(char)))
      .join("");
    if (next !== slice) {
      ed.deleteSpan(input.editor(), sel);
      ed.insertAt(input.editor(), sel.start, next);
    }
    ed.setCursorOffset(input.editor(), sel.start);
  }

  function pasteOverVisualSelection(reg: VimRegister, linewise: boolean, anchor: number): VimRegister {
    if (!reg) return null;
    const text = ed.getText(input.editor());
    if (!linewise) {
      const sel = selectionRange(anchor, false);
      if (!sel || sel.end <= sel.start) return null;
      const slice = text.slice(sel.start, sel.end);
      ed.deleteSpan(input.editor(), sel);
      ed.insertAt(input.editor(), sel.start, reg.text);
      ed.setCursorOffset(input.editor(), Math.max(0, sel.start));
      return { text: slice, linewise: false };
    }
    const cursor = ed.getCursorOffset(input.editor());
    const selectionStart = lineStart(text, Math.min(anchor, cursor));
    const selectionEnd = lineEnd(text, Math.max(anchor, cursor));
    const deleted = text.slice(selectionStart, selectionEnd);
    const prefix = selectionEnd >= text.length && selectionStart > 0 ? "\n" : "";
    const suffix = !prefix && selectionEnd < text.length ? "\n" : "";
    const start = prefix ? selectionStart - 1 : selectionStart;
    const end = suffix ? selectionEnd + 1 : selectionEnd;
    ed.deleteSpan(input.editor(), { start, end });
    ed.insertAt(input.editor(), start, prefix + reg.text + suffix);
    ed.setCursorOffset(input.editor(), start + prefix.length);
    return { text: deleted, linewise: true };
  }

  function replaceSelection(value: string, linewise: boolean, anchor: number) {
    const text = ed.getText(input.editor());
    const sel = selectionRange(anchor, linewise);
    if (!sel) return;
    const next = text
      .slice(sel.start, sel.end)
      .split("")
      .map((char) => (char === "\n" ? char : value))
      .join("");
    ed.deleteSpan(input.editor(), sel);
    ed.insertAt(input.editor(), sel.start, next);
    ed.setCursorOffset(input.editor(), sel.start);
  }

  // ----- insert-session commit & dot-repeat -----

  /** Insert-session replay edit relative to the session-start cursor. */
  function computeInsertReplay(start: Snapshot, after: Snapshot) {
    if (start.text === after.text && start.cursor === after.cursor) return null;
    let commonStart = 0;
    while (
      commonStart < start.text.length &&
      commonStart < after.text.length &&
      start.text[commonStart] === after.text[commonStart]
    )
      commonStart++;
    const at = Math.min(commonStart, start.cursor);
    let baseEnd = start.text.length;
    let afterEnd = after.text.length;
    while (baseEnd > at && afterEnd > at && start.text[baseEnd - 1] === after.text[afterEnd - 1]) {
      baseEnd--;
      afterEnd--;
    }
    const insert = after.text.slice(at, afterEnd);
    if (!insert && baseEnd === at) return null;
    return { startOffset: at, endOffset: baseEnd, insert };
  }

  function commitInsert() {
    const after = snapshot();
    const start = input.state.commitEdit(after);
    if (start) {
      const replay = computeInsertReplay(start, after);
      if (replay) {
        input.state.setRepeat({
          run() {
            const beforeReplay = snapshot();
            input.state.setReplaying(true);
            try {
              const editor = input.editor();
              const beforeText = ed.getText(editor);
              const base = snapshot();
              const s = Math.max(0, Math.min(base.cursor + replay.startOffset, beforeText.length));
              const e = Math.max(s, Math.min(base.cursor + replay.endOffset, beforeText.length));
              if (e > s) ed.deleteSpan(editor, { start: s, end: e });
              ed.insertAt(editor, s, replay.insert);
            } finally {
              input.state.setReplaying(false);
            }
            const afterReplay = snapshot();
            input.state.push(beforeReplay, afterReplay);
            return true;
          },
        });
      }
    }
  }


  // ----- main dispatch -----

  function dispatch(event_: VimKeyEvent, key: string): boolean {
    const hadPending = !!input.state.pending;
    const hadCount = !!input.state.count;
    const editor = input.editor();
    if (!preservesWantedColumn(event_, key)) clearWantedColumn();

    if (input.state.pending === "r") {
      if (hasModifier(event_)) {
        input.state.clearPending();
        return false;
      }
      const next = event_.name === "enter" ? "\n" : isPrintable(event_) ? value(event_) : null;
      if (next !== null) {
        mutate(() => {
          const offset = ed.getCursorOffset(editor);
          const text = ed.getText(editor);
          if (offset < text.length && text[offset] !== "\n") {
            ed.deleteSpan(editor, { start: offset, end: offset + 1 });
            ed.insertAt(editor, offset, next);
            ed.setCursorOffset(editor, offset);
          }
          input.state.clearPending();
        });
        return true;
      }
      input.state.clearPending();
      return true;
    }

    if (pendingFindOperator(event_)) return true;
    if (pendingTextObjectOperator(event_, key)) return true;

    const find = input.state.pending;
    if (find === "f" || find === "F" || find === "t" || find === "T") {
      if (isPrintable(event_) && !hasModifier(event_)) {
        const forward = find === "f" || find === "t";
        const till = find === "t" || find === "T";
        const char = value(event_);
        ed.findCharCount(editor, char, forward, till, takeCount());
        input.state.setLastFind({ char, forward, till });
        input.state.clearPending();
        return true;
      }
      input.state.clearPending();
      return true;
    }

    const scroll = vimScroll(event_);
    if (scroll) {
      input.state.clearPending();
      input.scroll(scroll);
      return true;
    }

    if (input.state.pending === "g" && !hasModifier(event_)) {
      const operation = pendingOperatorDisplay;
      if ((key === "j" || key === "k" || key === "down" || key === "up") && !event_.shift) {
        pendingOperatorDisplay = undefined;
        input.state.clearPending();
        if (operation) {
          // display-line operator motions are omitted in this port
          takeOperatorCount();
          return true;
        }
        const count = takeCount();
        repeatCount(count, () => {
          ed.moveVisualLine(editor, key === "j" || key === "down" ? "down" : "up");
        });
        ed.notifyChange(editor);
        wantedColumn = undefined;
        return true;
      }
      if ((key === "0" && !event_.shift) || key === "^" || key === "$") {
        pendingOperatorDisplay = undefined;
        input.state.clearPending();
        if (key === "0") ed.moveLineBeginning(editor);
        else if (key === "^") ed.moveFirstNonWhitespace(editor);
        else ed.moveLineEnd(editor);
        ed.notifyChange(editor);
        return true;
      }
    }

    if (input.state.pending === "g") pendingOperatorDisplay = undefined;

    const jump = vimJump(event_, input.state);
    if (jump.handled) {
      if (jump.action) {
        input.state.clearPending();
        clearWantedColumn();
        if (jump.action === "top") ed.setCursorOffset(editor, 0);
        else {
          // G: very end of the buffer. When the text ends with \n the final
          // line is empty (\n is a terminator, not a cursor position), so the
          // bottom position is its line start == text.length — using
          // length - 1 would land on the line above it.
          const text = ed.getText(editor);
          ed.setCursorOffset(editor, text.endsWith("\n") ? text.length : Math.max(0, text.length - 1));
        }
        ed.notifyChange(editor);
      }
      return true;
    }

    const navigation = vimWindowNavigation(event_, input.state);
    if (navigation.handled) {
      if (navigation.action) input.state.clearPending();
      return true;
    }

    if (key === "escape") {
      if (input.state.isVisual()) {
        input.state.setMode("normal");
        input.onModeChanged();
        return true;
      }
      if (!input.state.pending && input.state.count) {
        input.state.clearCountValue();
        return true;
      }
      if (!input.state.pending) return false;
      input.state.clearPending();
      return true;
    }

    if (isCountInput(event_, key)) {
      input.state.appendCountDigit(key);
      return true;
    }

    if (key === "." && !event_.shift && !hasModifier(event_) && !input.state.isVisual() && !input.state.pending) {
      const dotRepeat = input.state.repeat;
      if (dotRepeat) dotRepeat.run();
      ed.notifyChange(editor);
      return true;
    }

    if (key === "u" && !event_.shift && !hasModifier(event_) && !input.state.isVisual() && !input.state.pending) {
      undo();
      return true;
    }

    if (
      key === "r" &&
      event_.ctrl &&
      !event_.shift &&
      !event_.meta &&
      !event_.alt &&
      !input.state.isVisual() &&
      !input.state.pending
    ) {
      redo();
      return true;
    }

    if (input.state.isVisual()) {
      const a = input.state.anchor;
      const lw = input.state.isVisualLine();

      if (key === "~" && !hasModifier(event_)) {
        mutate(() => {
          toggleSelectionCase(lw, a ?? 0);
          input.state.setMode("normal");
          input.onModeChanged();
        });
        return true;
      }

      if (key === "r" && !event_.shift && !hasModifier(event_)) {
        input.state.setPending("vr");
        return true;
      }

      if ((key === "i" || key === "a") && !event_.shift && !hasModifier(event_)) {
        return true;
      }

      if (key === "o" && !event_.shift && !hasModifier(event_) && a !== null) {
        const cursor = ed.getCursorOffset(editor);
        ed.setCursorOffset(editor, a);
        input.state.setAnchor(cursor);
        return true;
      }

      if ((key === "d" || key === "x") && !event_.shift && !hasModifier(event_)) {
        mutate(() => {
          const reg = yankSelection(lw, a ?? 0);
          if (reg) setRegister(reg);
          deleteSelection(lw, a ?? 0);
          input.state.setMode("normal");
          input.onModeChanged();
        });
        return true;
      }

      if (isShifted(event_, "d") && !hasModifier(event_)) {
        mutate(() => {
          const reg = ed.deleteLine(editor, a ?? undefined);
          if (reg) setRegister(reg);
          input.state.setMode("normal");
          input.onModeChanged();
        });
        return true;
      }

      if (key === "y" && !event_.shift && !hasModifier(event_)) {
        const reg = yankSelection(lw, a ?? 0);
        if (reg) setRegister(reg, true);
        input.state.setMode("normal");
        input.onModeChanged();
        return true;
      }

      if (key === "c" && !event_.shift && !hasModifier(event_)) {
        beginInsertSession(() => {
          const reg = deleteSelection(lw, a ?? 0);
          if (reg) setRegister(reg);
        });
        return true;
      }

      if (isShifted(event_, "c") && !hasModifier(event_)) {
        beginInsertSession(() => {
          const reg = ed.substituteLine(editor, a ?? undefined);
          if (reg) setRegister(reg);
        });
        return true;
      }

      if (key === "p" && !event_.shift && !hasModifier(event_)) {
        mutate(() => {
          const reg = countedRegister(getRegister(), takeCount());
          const deleted = pasteOverVisualSelection(reg, lw, a ?? 0);
          if (deleted) setRegister(deleted);
          input.state.setMode("normal");
          input.onModeChanged();
        });
        return true;
      }

      if (key === "v" && !event_.shift && !hasModifier(event_)) {
        if (lw) {
          input.state.setMode("visual");
        } else {
          input.state.setMode("normal");
        }
        input.onModeChanged();
        return true;
      }

      if (isShifted(event_, "v") && !hasModifier(event_)) {
        if (lw) {
          input.state.setMode("normal");
        } else {
          input.state.setMode("visual-line");
        }
        input.onModeChanged();
        return true;
      }
    }

    if (key === ":" && !hasModifier(event_) && !hadPending && !hadCount) {
      input.openCommandPalette();
      input.state.clearPending();
      return true;
    }

    const pendingOperator = input.state.pending;
    if (pendingOperator === "c" || pendingOperator === "d" || pendingOperator === "y") {
      const handled = operatorPending(pendingOperator, event_, key);
      if (handled !== undefined) return handled;
    }

    if (key === "enter" && !hasModifier(event_)) {
      input.submit();
      input.state.clearPending();
      return true;
    }

    if (key === "c" && !event_.shift && !hasModifier(event_) && !input.state.pending) {
      startOperator("c");
      return true;
    }
    if (key === "d" && !event_.shift && !hasModifier(event_) && !input.state.pending) {
      startOperator("d");
      return true;
    }
    if (key === "y" && !event_.shift && !hasModifier(event_) && !input.state.pending) {
      startOperator("y");
      return true;
    }

    if (key === "r" && !event_.shift && !hasModifier(event_)) {
      input.state.setPending("r");
      return true;
    }

    if (key === "p" && !event_.shift && !hasModifier(event_)) {
      const reg = countedRegister(getRegister(), takeCount());
      mutate(() => ed.pasteAfter(editor, reg));
      return true;
    }

    if (isShifted(event_, "p") && !hasModifier(event_)) {
      const reg = countedRegister(getRegister(), takeCount());
      mutate(() => ed.pasteBefore(editor, reg));
      return true;
    }

    if ((key === "f" || key === "t") && !event_.shift && !hasModifier(event_)) {
      input.state.setPending(key, input.state.count + key);
      return true;
    }

    if ((isShifted(event_, "f") || isShifted(event_, "t")) && !hasModifier(event_)) {
      const find = isShifted(event_, "f") ? "F" : "T";
      input.state.setPending(find, input.state.count + find);
      return true;
    }

    if (key === ";" && !event_.shift && !hasModifier(event_)) {
      const last = input.state.lastFind;
      if (last) ed.findCharCount(editor, last.char, last.forward, last.till, takeCount(), true);
      return true;
    }

    if (key === "," && !event_.shift && !hasModifier(event_)) {
      const last = input.state.lastFind;
      if (last) ed.findCharCount(editor, last.char, !last.forward, last.till, takeCount(), true);
      return true;
    }

    if (isShifted(event_, "s") && !hasModifier(event_)) {
      beginInsertSession(() => {
        input.state.clearPending();
        const reg = ed.substituteLine(editor);
        if (reg) setRegister(reg);
      });
      return true;
    }

    if (isShifted(event_, "d") && !hasModifier(event_)) {
      mutate(() => {
        const reg = ed.deleteLineEnd(editor);
        if (reg) setRegister(reg);
      });
      return true;
    }

    if (isShifted(event_, "c") && !hasModifier(event_)) {
      beginInsertSession(() => {
        const reg = ed.substituteLineEnd(editor);
        if (reg) setRegister(reg);
      });
      return true;
    }

    if (isShifted(event_, "x") && !hasModifier(event_)) {
      // X: delete the char before the cursor.
      mutate(() => {
        const text = ed.getText(editor);
        const offset = ed.getCursorOffset(editor);
        const start = lineStart(text, offset);
        if (offset > start) {
          ed.deleteSpan(editor, { start: offset - 1, end: offset });
          ed.setCursorOffset(editor, offset - 1);
        }
      });
      return true;
    }

    if (isShifted(event_, "r") && !hasModifier(event_)) {
      // R: replace mode session; typed chars handled outside, Esc commits.
      input.state.beginEdit(snapshot());
      input.state.setReplaceAnchor(ed.getCursorOffset(editor));
      input.state.setTyped(false);
      input.state.setMode("replace");
      input.onModeChanged();
      return true;
    }

    if (key === "v" && !event_.shift && !hasModifier(event_)) {
      input.state.setAnchor(ed.getCursorOffset(editor));
      input.state.setMode("visual");
      input.onModeChanged();
      return true;
    }

    if (isShifted(event_, "v") && !hasModifier(event_)) {
      input.state.setAnchor(ed.getCursorOffset(editor));
      input.state.setMode("visual-line");
      input.onModeChanged();
      return true;
    }

    if (input.state.isReplace()) return false;

    if (key === "i" && !event_.shift && !hasModifier(event_)) {
      beginInsertSession();
      return true;
    }

    if (isShifted(event_, "i") && !hasModifier(event_)) {
      beginInsertSession(() => ed.insertLineStart(editor));
      return true;
    }

    if (key === "a" && !event_.shift && !hasModifier(event_)) {
      beginInsertSession(() => ed.appendAfterCursor(editor));
      return true;
    }

    if (isShifted(event_, "a") && !hasModifier(event_)) {
      beginInsertSession(() => ed.appendLineEnd(editor));
      return true;
    }

    if (key === "o" && !event_.shift && !hasModifier(event_)) {
      beginInsertSession(() => ed.openLineBelow(editor));
      return true;
    }

    if (isShifted(event_, "o") && !hasModifier(event_)) {
      beginInsertSession(() => ed.openLineAbove(editor));
      return true;
    }

    if (key === "h" && !event_.shift && !hasModifier(event_)) {
      repeatCount(takeCount(), () => ed.moveLeft(editor));
      ed.notifyChange(editor);
      return true;
    }

    if (key === "l" && !event_.shift && !hasModifier(event_)) {
      repeatCount(takeCount(), () => ed.moveRight(editor));
      ed.notifyChange(editor);
      return true;
    }

    if (isShifted(event_, "j") && !hasModifier(event_)) {
      mutate(() => {
        input.state.clearPending();
        const count = takeCount();
        repeatCount(count - 1, () => ed.joinLines(editor));
      });
      return true;
    }

    if ((key === "j" || key === "down") && !event_.shift && !hasModifier(event_)) {
      repeatCount(takeCount(), () => moveVertical("down"));
      ed.notifyChange(editor);
      wantedColumn = undefined;
      return true;
    }

    if ((key === "k" || key === "up") && !event_.shift && !hasModifier(event_)) {
      repeatCount(takeCount(), () => moveVertical("up"));
      ed.notifyChange(editor);
      wantedColumn = undefined;
      return true;
    }

    if (key === "0" && !event_.shift && !hasModifier(event_)) {
      ed.moveLineBeginning(editor);
      ed.notifyChange(editor);
      return true;
    }

    if ((key === "^" || key === "_") && !hasModifier(event_)) {
      const count = takeCount();
      ed.moveFirstNonWhitespace(editor);
      void count;
      ed.notifyChange(editor);
      return true;
    }

    if (key === "$" && !hasModifier(event_)) {
      const count = takeCount();
      repeatCount(count - 1, () => ed.moveLineDown(editor, 0));
      ed.moveLineEnd(editor);
      wantedColumn = "end";
      ed.notifyChange(editor);
      return true;
    }

    if (key === "%" && !hasModifier(event_)) {
      ed.moveMatchingBracket(editor);
      ed.notifyChange(editor);
      return true;
    }

    if (key === "{" && !hasModifier(event_)) {
      repeatCount(takeCount(), () => ed.movePreviousParagraph(editor));
      ed.notifyChange(editor);
      return true;
    }

    if (key === "}" && !hasModifier(event_)) {
      repeatCount(takeCount(), () => ed.moveNextParagraph(editor));
      ed.notifyChange(editor);
      return true;
    }

    if (key === "s" && !event_.shift && !hasModifier(event_)) {
      beginInsertSession(() => {
        const reg = ed.deleteUnderCursor(editor);
        if (reg) setRegister(reg);
      });
      return true;
    }

    if (key === "x" && !event_.shift && !hasModifier(event_)) {
      mutate(() => {
        const reg = ed.deleteUnderCursor(editor);
        if (reg) setRegister(reg);
      });
      return true;
    }

    if (key === "~" && !hasModifier(event_)) {
      const count = takeCount();
      mutate(() => {
        for (let index = 0; index < count; index++) {
          const beforeOffset = ed.getCursorOffset(editor);
          const text = ed.getText(editor);
          const offset = ed.getCursorOffset(editor);
          const end = lineEnd(text, offset);
          if (offset >= end) break;
          const char = text[offset] ?? "";
          const next = swapCase(char);
          if (next !== char) {
            ed.deleteSpan(editor, { start: offset, end: offset + 1 });
            ed.insertAt(editor, offset, next);
            ed.setCursorOffset(editor, offset);
          }
          ed.moveRight(editor);
          if (ed.getCursorOffset(editor) === beforeOffset) break;
        }
      });
      return true;
    }

    if (key === "w" && !event_.shift && !hasModifier(event_)) {
      repeatCount(takeCount(), () => ed.moveWordNext(editor));
      ed.notifyChange(editor);
      return true;
    }

    if (key === "b" && !event_.shift && !hasModifier(event_)) {
      repeatCount(takeCount(), () => ed.moveWordPrev(editor));
      ed.notifyChange(editor);
      return true;
    }

    if (key === "e" && !event_.shift && !hasModifier(event_)) {
      repeatCount(takeCount(), () => ed.moveWordEnd(editor));
      ed.notifyChange(editor);
      return true;
    }

    if (isShifted(event_, "w") && !hasModifier(event_)) {
      repeatCount(takeCount(), () => ed.moveWordNext(editor, true));
      ed.notifyChange(editor);
      return true;
    }

    if (isShifted(event_, "b") && !hasModifier(event_)) {
      repeatCount(takeCount(), () => ed.moveWordPrev(editor, true));
      ed.notifyChange(editor);
      return true;
    }

    if (isShifted(event_, "e") && !hasModifier(event_)) {
      repeatCount(takeCount(), () => ed.moveWordEnd(editor, true));
      ed.notifyChange(editor);
      return true;
    }

    if (key === "w" && event_.ctrl && !event_.shift && !event_.meta && !event_.alt) {
      input.state.setPending("w", "^W");
      return true;
    }

    if (key === "backspace" || key === "delete") {
      return true;
    }

    if (isPrintable(event_) && !hasModifier(event_)) {
      return true;
    }

    return false;
  }

  function handleKey(event_: VimKeyEvent): boolean {
    // Keep dot replay atomic.
    if (input.state.replaying) return true;

    if (input.state.isReplace()) {
      if (event_.name === "escape") {
        const replaceStart = input.state.replaceAnchor;
        const typed = input.state.typed;
        input.state.setMode("normal");
        const editor = input.editor();
        if (typed && replaceStart !== null) {
          ed.setCursorOffset(editor, Math.max(replaceStart, ed.getCursorOffset(editor) - 1));
        }
        commitInsert();
        return true;
      }
      if (isPrintable(event_) && !hasModifier(event_)) {
        const next = value(event_);
        const editor = input.editor();
        ed.replaceUnderCursor(editor, next);
        ed.notifyChange(editor);
        input.state.setTyped(true);
        return true;
      }
      return false;
    }

    if (input.state.isInsert()) {
      if (event_.name === "escape") {
        clearEscapePending();
        const editor = input.editor();
        input.state.setMode("normal");
        commitInsert();
        ed.moveLeft(editor);
        ed.notifyChange(editor);
        input.onModeChanged();
        return true;
      }
      if (escapeSeq) {
        const key = normalizedKeyName(event_);
        if (escapePending) {
          clearEscapePending();
          if (key === escapeSecond && !hasModifier(event_)) {
            // Remove the first sequence char that was typed, then escape.
            const editor = input.editor();
            const pos = ed.getCursorOffset(editor);
            if (pos > 0) ed.deleteSpan(editor, { start: pos - 1, end: pos });
            input.state.setMode("normal");
            commitInsert();
            ed.notifyChange(editor);
            ed.moveLeft(editor);
            input.onModeChanged();
            return true;
          }
          // Not the sequence: the first char already typed, let this key through.
          return false;
        }
        if (escapeSeq && key === escapeSeq[0] && !hasModifier(event_)) {
          escapePending = true;
          escapeTimer = setTimeout(clearEscapePending, 300);
          return false; // first char types normally
        }
      }
      clearEscapePending();
      return false;
    }

    clearEscapePending();

    const mapped = langmapped(event_);
    const key = normalizedKeyName(mapped);
    const result = dispatch(mapped, key);

    if (result && input.state.count && !input.state.pending && !isCountInput(mapped, key))
      input.state.clearCountValue();

    return result;
  }

  const handler = {
    cancelPending,
    handleKey,
    commitInsert,
    beginInsertSession,
    get escapePending() {
      return escapePending;
    },
  };
  return handler;
}
