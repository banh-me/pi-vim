/**
 * Key classification helpers (scroll, jump, window-nav) and key naming,
 * ported from the opencode-vim-plugin (MIT) and adapted to pi's key ids.
 */

import type { VimState } from "./state";

export type VimKeyEvent = {
  name: string; // pi key id: letter/digit/symbol, or "enter","escape","backspace","delete","up","down","left","right","space"...
  shift: boolean;
  ctrl: boolean;
  meta: boolean;
  alt: boolean;
  /** The literal character typed for printable keys (after shift mapping). */
  char?: string;
};

export type VimScroll = "line-down" | "line-up" | "half-down" | "half-up" | "page-down" | "page-up";

export function vimScroll(event: VimKeyEvent): VimScroll | undefined {
  if (!event.ctrl || event.meta || event.alt) return;
  const key = event.name;
  if (key === "e") return "line-down";
  if (key === "y") return "line-up";
  if (key === "d") return "half-down";
  if (key === "u") return "half-up";
  if (key === "f") return "page-down";
  if (key === "b") return "page-up";
  return undefined;
}

export type VimJump = "top" | "bottom";

export function vimJump(event: VimKeyEvent, state: VimState): { action?: VimJump; handled: boolean } {
  const key = event.name;
  if (event.ctrl || event.meta || event.alt) {
    if (state.pending === "g") state.clearPending();
    return { handled: false };
  }
  if (key === "G" || (key === "g" && event.shift)) {
    state.clearPending();
    return { action: "bottom", handled: true };
  }
  if (key !== "g") {
    if (state.pending === "g") state.clearPending();
    return { handled: false };
  }
  if (state.pending === "g") {
    state.clearPending();
    return { action: "top", handled: true };
  }
  state.setPending("g", state.count + "g");
  return { handled: true };
}

export type VimWindowNav = "up" | "down";

export function vimWindowNavigation(event: VimKeyEvent, state: VimState): { action?: VimWindowNav; handled: boolean } {
  if (state.pending === "w") {
    const key = event.name;
    if (key === "k" || key === "w") {
      state.clearPending();
      return { action: "up", handled: true };
    }
    if (key === "j") {
      state.clearPending();
      return { action: "down", handled: true };
    }
    state.clearPending();
  }
  return { handled: false };
}

/** OpenCode-style shift symbol table: name of the unshifted key -> shifted char. */
export const SHIFTED_SYMBOLS: Record<string, string> = {
  "1": "!",
  "2": "@",
  "3": "#",
  "4": "$",
  "5": "%",
  "6": "^",
  "7": "&",
  "8": "*",
  "9": "(",
  "0": ")",
  "-": "_",
  "=": "+",
  "[": "{",
  "]": "}",
  "\\": "|",
  ";": ":",
  "'": '"',
  ",": "<",
  ".": ">",
  "/": "?",
  "`": "~",
};
