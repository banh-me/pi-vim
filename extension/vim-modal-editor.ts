/**
 * VimModalEditor — a pi CustomEditor subclass implementing modal vim editing,
 * ported from the opencode-vim-plugin (MIT, © leohenon).
 *
 * Modes: INSERT / NORMAL / REPLACE / VISUAL / VISUAL LINE.
 * Core dispatch comes from handler.ts; this class maps raw terminal input to
 * key events, renders the mode indicator, and owns pi-specific behaviors
 * (submission, history, autocomplete passthrough).
 */

import {
  CustomEditor,
  type KeybindingsManager as KBManager,
} from "@earendil-works/pi-coding-agent";
import type { EditorTheme, TUI } from "@earendil-works/pi-tui";
import {
  CURSOR_MARKER,
  decodeKittyPrintable,
  matchesKey,
  parseKey,
  truncateToWidth,
  visibleWidth,
} from "@earendil-works/pi-tui";
import * as ed from "./editor-adapter";
import {
  createVimHandler,
  normalizedKeyName,
  type VimKeyEvent,
} from "./handler";
import { SHIFTED_SYMBOLS } from "./keys";
import type { VimModeColors, VimConfig } from "./config";
import { computeSelectionRanges, renderSelectionHighlight } from "./visual";
import { createVimState, type VimMode } from "./state";
import { ClipboardMirror } from "./clipboard";
type KeybindingsManager = KBManager;

const MODE_TO_LABEL: Record<VimMode, string> = {
  insert: "INSERT",
  normal: "NORMAL",
  replace: "REPLACE",
  visual: "VISUAL",
  "visual-line": "V-LINE",
};

type LabelKey = "normal" | "insert" | "visual" | "visualLine" | "replace";

/** Built-in mode label palette (Everforest). piVim.colors entries override per mode. */
const LABEL_COLORS: Record<LabelKey, string> = {
  normal: "#83C092",
  insert: "#D3C6AA",
  visual: "#E67E80",
  visualLine: "#E67E80",
  replace: "#E69875",
};

type ModalEditorOptions = {
  config: VimConfig;
  /** Style the visual-mode selection text; typically theme.bg("selectedBg", …). */
  selectionStyle: (text: string) => string;
  /** ui.notify sink for clipboard-latch warnings etc. */
  notify?: (message: string, style: "info" | "warning" | "error") => void;
};

/** Map raw terminal input to a normalized VimKeyEvent. */
function toVimEvent(data: string): VimKeyEvent | undefined {
  const parsed = parseKey(data);
  if (parsed === undefined) {
    if (data.length === 1 && data.codePointAt(0)! >= 32) {
      // Non-ASCII printable (e.g. non-Latin keyboard layouts): parseKey does
      // not handle multi-byte chars, so treat them as plain printable keys.
      return {
        name: data,
        shift: false,
        ctrl: false,
        meta: false,
        alt: false,
        char: data,
      };
    }
    // Multi-char paste or unknown sequence — treat printable runs as text input.
    if (data.length > 1 && data.charCodeAt(0) >= 32) {
      return {
        name: data,
        shift: false,
        ctrl: false,
        meta: false,
        alt: false,
        char: data,
      };
    }
    return undefined;
  }
  let name = parsed;
  let shift = false;
  for (const mod of [
    "ctrl+shift+",
    "shift+ctrl+",
    "ctrl+",
    "shift+",
    "alt+",
    "meta+",
  ]) {
    if (name.startsWith(mod)) {
      if (mod === "shift+") shift = true;
      name = name.slice(mod.length);
    }
  }
  if (name.startsWith("super")) return undefined;
  // Resolve the typed character: kitty CSI-u printable, raw printable byte, or shift-symbol table.
  let char: string | undefined = decodeKittyPrintable(data);
  if (char === undefined && data.length === 1 && data.charCodeAt(0) >= 32) {
    char = data;
    name = char;
    shift = char !== char.toLowerCase();
  } else if (shift && SHIFTED_SYMBOLS[name] !== undefined) {
    char = SHIFTED_SYMBOLS[name]!;
    name = char;
  }
  return {
    name,
    shift,
    ctrl: parsed.startsWith("ctrl+"),
    meta: parsed.startsWith("super+"),
    alt: parsed.startsWith("alt+"),
    char,
  };
}

function ansiFg(hex: string): string {
  const r = Number.parseInt(hex.slice(1, 3), 16);
  const g = Number.parseInt(hex.slice(3, 5), 16);
  const b = Number.parseInt(hex.slice(5, 7), 16);
  return `\x1b[38;2;${r};${g};${b}m`;
}

export class VimModalEditor extends CustomEditor {
  private readonly vimConfig: VimConfig;
  private readonly selectionStyle: (text: string) => string;
  private readonly clipboard: ClipboardMirror;
  private readonly vimState = createVimState();
  private handler!: ReturnType<typeof createVimHandler>;
  private topHiddenLineCount = 0;

  constructor(
    tui: TUI,
    theme: EditorTheme,
    keybindings: KeybindingsManager,
    options: ModalEditorOptions,
  ) {
    super(tui, theme, keybindings);
    this.vimConfig = options.config;
    this.selectionStyle = options.selectionStyle;
    this.clipboard = new ClipboardMirror(
      () => this.vimConfig.clipboardPolicy,
      options.notify,
    );
    this.handler = createVimHandler({
      state: this.vimState,
      editor: () => this,
      submit: () => this.doSubmit(),
      openCommandPalette: () => super.handleInput("/"),
      scroll: () => {},
      langmap: () => this.vimConfig.langmap,
      escapeSequence: options.config.escapeSequence,
      onModeChanged: () => {
        const t = (this as unknown as { tui?: { requestRender(): void } }).tui;
        t?.requestRender();
      },
      onRegisterWrite: (reg, isYank) => this.clipboard.mirror(reg, isYank),
      clipboard: { enabled: () => this.vimConfig.clipboardPolicy !== "never", get: () => this.clipboard.get() },
    });
    if (this.vimConfig.initialMode === "normal") {
      this.vimState.setMode("normal");
    } else {
      // Implicit insert session: typing before any vim command is undoable too
      // (pi-vim semantics). The session closes on Esc/submit.
      this.handler.beginInsertSession();
    }
  }

  get mode(): VimMode {
    return this.vimState.mode;
  }

  get modeLabel(): string {
    let label = MODE_TO_LABEL[this.vimState.mode];
    if (this.vimState.pending) {
      label += ` ${this.vimState.pendingDisplay || this.vimState.pending}_`;
    } else if (this.vimState.count) {
      label += ` ${this.vimState.count}_`;
    }
    return ` ${label} `;
  }

  private doSubmit() {
    this.handler.commitInsert();
    // Route through pi-tui's own submit path (tui.input.submit -> submitValue -> onSubmit).
    super.handleInput("\r");
    // After submit, upstream semantics: insert_after_submit=true returns to a
    // fresh insert session; otherwise normal mode.
    if (this.vimConfig.insertAfterSubmit) {
      this.vimState.setMode("insert");
      this.handler.beginInsertSession();
    } else {
      this.vimState.setMode("normal");
    }
    this.vimState.resetHistory();
    this.tui.requestRender();
  }

  override handleInput(data: string): void {
    // While pi's autocomplete (slash palette etc.) is showing, keys go to it.
    if (this.isShowingAutocomplete()) {
      super.handleInput(data);
      return;
    }
    switch (this.vimState.mode) {
      case "insert":
        this.handleInsertInput(data);
        return;
      case "replace":
        this.handleReplaceInput(data);
        return;
      default:
        this.handleModalInput(data);
        return;
    }
  }

  private handleInsertInput(data: string): void {
    // Escape always wins and never reaches pi (so Esc exits to normal instead of aborting).
    if (matchesKey(data, "escape")) {
      const event = toVimEvent(data);
      if (event) this.handler.handleKey(event);
      return;
    }
    // Escape-sequence (e.g. jk) interception, upstream-style: the first char
    // types normally; on the matching second key the handler deletes it and
    // exits to normal. Non-matching keys pass through so nothing is lost.
    if (this.vimConfig.escapeSequence) {
      const event = toVimEvent(data);
      if (event) {
        const plain = !event.ctrl && !event.meta && !event.alt;
        const key = normalizedKeyName(event);
        if (this.handler.escapePending) {
          const handled = this.handler.handleKey(event);
          if (handled || this.vimState.mode !== "insert") return; // sequence completed
          // Not the second key: pending was cleared; fall through to this key's normal handling.
        } else if (plain && key === this.vimConfig.escapeSequence[0]) {
          this.handler.handleKey(event); // sets escapePending
          if (this.handler.escapePending) {
            super.handleInput(data); // first sequence char types immediately
            return;
          }
        }
      }
    }
    // Enter: newline or submit depending on config.
    if (matchesKey(data, "enter") || data === "\r" || data === "\n") {
      this.handler.commitInsert();
      if (this.vimConfig.enterSubmit) {
        this.doSubmit();
      } else {
        // Newline via pi-tui's own path (matches its tui.input.newLine handling).
        super.handleInput("\n");
      }
      return;
    }
    super.handleInput(data);
  }

  private handleReplaceInput(data: string): void {
    const event = toVimEvent(data);
    if (event && this.handler.handleKey(event)) return;
    // Unhandled in replace mode: fall through to editor defaults.
    super.handleInput(data);
  }

  private handleModalInput(data: string): void {
    const event = toVimEvent(data);
    if (!event) {
      super.handleInput(data);
      return;
    }

    // Enter in normal mode submits (vim Ex behavior) unless pending count.
    if (event.name === "enter" && !event.ctrl && !event.meta && !event.alt) {
      if (this.vimState.isVisual()) {
        this.vimState.setMode("normal");
        this.tui.requestRender();
        return;
      }
      if (!this.vimState.pending && !this.vimState.count) {
        this.handler.commitInsert();
        this.doSubmit();
        return;
      }
    }

    const handled = this.handler.handleKey(event);
    if (handled) {
      this.tui.requestRender();
      return;
    }

    // Unhandled keys: ctrl/meta/alt combos and navigation keys go to pi's app keybindings.
    if (
      event.ctrl ||
      event.meta ||
      event.alt ||
      [
        "up",
        "down",
        "left",
        "right",
        "home",
        "end",
        "pageUp",
        "pageDown",
        "tab",
        "backspace",
        "delete",
      ].includes(event.name)
    ) {
      super.handleInput(data);
      return;
    }

    // Plain printable chars in normal mode were unhandled — swallow (vim behavior).
    if (event.name.length === 1 || event.name === "space") return;
    super.handleInput(data);
  }

  // ----- rendering -----

  /** Capture pi's scroll offset for the selection overlay. */
  protected override renderTopBorder(
    width: number,
    hiddenLineCount: number,
  ): string {
    this.topHiddenLineCount = hiddenLineCount;
    return super.renderTopBorder(width, hiddenLineCount);
  }

  override render(width: number): string[] {
    let lines = super.render(width);
    // Visual-mode selection highlight (replaces text rows wholesale).
    if (this.vimState.isVisual() && this.vimState.anchor !== null) {
      const anchorCoord = ed.offsetToPos(this, this.vimState.anchor);
      lines = renderSelectionHighlight({
        editor: this,
        lines,
        scrollOffset: this.topHiddenLineCount,
        ranges: computeSelectionRanges(
          this,
          anchorCoord,
          this.vimState.isVisualLine(),
        ),
        style: this.selectionStyle,
      });
    }
    if (!this.vimConfig.indicator || lines.length === 0) return lines;
    const label = this.renderModeLabel();
    if (!label) return lines;
    const last = lines.length - 1;
    const labelWidth = visibleWidth(label);
    if (visibleWidth(lines[last]!) >= labelWidth + 1) {
      lines[last] =
        truncateToWidth(lines[last]!, width - labelWidth, "", true) + label;
    }
    return lines;
  }

  private renderModeLabel(): string | undefined {
    const text = this.modeLabel;
    const mode = this.vimState.mode;
    const key = mode === "visual-line" ? "visualLine" : (mode as LabelKey);
    // piVim.colors hex override wins; otherwise the built-in Everforest palette.
    const hex = this.vimConfig.colors[key] ?? LABEL_COLORS[key];
    if (ansiHex(hex)) {
      return `\x1b[7m${ansiFg(hex)}${text}\x1b[27m\x1b[39m`;
    }
    return ` ${text} `;
  }
}

function ansiHex(color: string | undefined): string | undefined {
  if (!color) return undefined;
  return /^#[0-9a-fA-F]{6}$/.test(color) ? color : undefined;
}
