/**
 * Vim modal state, ported from the opencode-vim-plugin vim core
 * (https://github.com/leohenon/opencode-vim-plugin — MIT, © leohenon).
 * solid-js signals replaced with plain closures.
 */

export type VimMode = "normal" | "insert" | "replace" | "visual" | "visual-line";
export type VimPending = "" | "c" | "d" | "g" | "f" | "F" | "t" | "T" | "y" | "w" | "r" | "vr";
export type VimFind = { char: string; forward: boolean; till: boolean } | null;
export type VimSnapshotData = { text: string; cursor: number };
export type VimRepeat = { run: () => boolean };

import type { VimRegister } from "./text-core";

type VimHistory = { before: VimSnapshotData; after: VimSnapshotData };

const VIM_COUNT_MAX = 9999;
const VIM_COUNT_MAX_DIGITS = String(VIM_COUNT_MAX).length;

export function createVimState() {
  let mode: VimMode = "insert";
  let pending: VimPending = "";
  let pendingDisplay = "";
  let count = "";
  let lastFind: VimFind = null;
  let register: VimRegister = null;
  let anchor: number | null = null;
  let replaceAnchor: number | null = null;
  let typed = false;
  let undos: VimHistory[] = [];
  let redos: VimSnapshotData[] = [];
  let edit: VimSnapshotData | null = null;
  let repeat: VimRepeat | null = null;
  let replaying = false;
  const cancelEditCallbacks = new Set<() => void>();

  function setPendingValue(next: VimPending, display = "") {
    pending = next;
    pendingDisplay = display;
  }

  function clearPending() {
    if (pending) setPendingValue("");
    if (pendingDisplay) pendingDisplay = "";
    clearCountValue();
  }

  function clearCountValue() {
    if (count) count = "";
  }

  function appendCountDigit(digit: string) {
    if (count.length < VIM_COUNT_MAX_DIGITS) count += digit;
  }

  function takeCount(defaultValue = 1) {
    const value = count ? Number(count) : defaultValue;
    clearCountValue();
    return Math.max(1, Math.min(Number.isSafeInteger(value) ? value : defaultValue, VIM_COUNT_MAX));
  }

  function clearEdit() {
    edit = null;
  }

  function cancelOpenEdit() {
    cancelEditCallbacks.forEach((callback) => callback());
    clearEdit();
  }

  function clearHistory() {
    cancelOpenEdit();
    undos = [];
    redos = [];
    repeat = null;
  }

  function changeMode(next: VimMode) {
    clearPending();
    clearCountValue();
    if (next !== "visual" && next !== "visual-line") anchor = null;
    if (next !== "replace") {
      replaceAnchor = null;
      typed = false;
    }
    mode = next;
  }

  function push(before: VimSnapshotData, after: VimSnapshotData) {
    clearEdit();
    if (before.text === after.text && before.cursor === after.cursor) return;
    undos = [...undos, { before, after }];
    redos = [];
  }

  return {
    get mode() {
      return mode;
    },
    setMode: changeMode,
    get pending() {
      return pending;
    },
    get pendingDisplay() {
      return pendingDisplay;
    },
    setPending: setPendingValue,
    clearPending,
    get count() {
      return count;
    },
    appendCountDigit,
    clearCountValue,
    takeCount,
    get lastFind() {
      return lastFind;
    },
    setLastFind(next: VimFind) {
      lastFind = next;
    },
    get register() {
      return register;
    },
    setRegister(next: VimRegister) {
      register = next;
    },
    get anchor() {
      return anchor;
    },
    setAnchor(next: number | null) {
      anchor = next;
    },
    get replaceAnchor() {
      return replaceAnchor;
    },
    setReplaceAnchor(next: number | null) {
      replaceAnchor = next;
    },
    get typed() {
      return typed;
    },
    setTyped(next: boolean) {
      typed = next;
    },
    beginEdit(snapshot: VimSnapshotData) {
      edit = snapshot;
    },
    commitEdit(snapshot: VimSnapshotData) {
      const start = edit;
      clearEdit();
      if (!start) return null;
      push(start, snapshot);
      return start;
    },
    cancelEdit: cancelOpenEdit,
    onCancelEdit(callback: () => void) {
      cancelEditCallbacks.add(callback);
      return () => cancelEditCallbacks.delete(callback);
    },
    get repeat() {
      return repeat;
    },
    setRepeat(next: VimRepeat | null) {
      repeat = next;
    },
    get replaying() {
      return replaying;
    },
    setReplaying(next: boolean) {
      replaying = next;
    },
    push,
    undo(snapshot: VimSnapshotData) {
      const item = undos[undos.length - 1];
      if (!item) return null;
      undos = undos.slice(0, -1);
      redos = [...redos, snapshot];
      clearEdit();
      return item.before;
    },
    redo(snapshot: VimSnapshotData) {
      const item = redos[redos.length - 1];
      if (!item) return null;
      redos = redos.slice(0, -1);
      undos = [...undos, { before: snapshot, after: item }];
      clearEdit();
      return item;
    },
    resetHistory: clearHistory,
    reset() {
      clearPending();
      clearCountValue();
      anchor = null;
      replaceAnchor = null;
      typed = false;
      clearHistory();
      mode = "insert";
    },
    canUndo() {
      return undos.length > 0;
    },
    canRedo() {
      return redos.length > 0;
    },
    isInsert() {
      return mode === "insert";
    },
    isReplace() {
      return mode === "replace";
    },
    isVisual() {
      return mode === "visual" || mode === "visual-line";
    },
    isVisualLine() {
      return mode === "visual-line";
    },
  };
}

export type VimState = ReturnType<typeof createVimState>;
