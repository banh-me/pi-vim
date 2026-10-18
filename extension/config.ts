/**
 * pi-vim configuration.
 *
 * Read from the `piVim` section of pi settings files:
 *   global : ~/.pi/agent/settings.json
 *   project: <cwd>/.pi/settings.json   (overrides global per-key)
 */

import { SettingsManager } from "@earendil-works/pi-coding-agent";

export type VimInitialMode = "normal" | "insert";

export type VimModeColors = {
  normal?: string;
  insert?: string;
  visual?: string;
  visualLine?: string;
  replace?: string;
};

export type VimClipboardPolicy = "all" | "yank" | "never";

export type VimConfig = {
  enabled: boolean;
  initialMode: VimInitialMode;
  indicator: boolean;
  enterSubmit: boolean;
  insertAfterSubmit: boolean;
  /** Nvim-clipboard+=unnamedplus-like mirror policy: all (default) | yank | never. */
  clipboardPolicy: VimClipboardPolicy;
  /** Map non-English keys (or simple aliases) onto vim command keys. Single chars only. */
  langmap: Record<string, string>;
  /** Two-character sequence that leaves insert mode (e.g. "jk"). null = disabled. */
  escapeSequence: string | null;
  /** Global pi shortcut that toggles vim mode. null = none (use /vim). */
  toggleKey: string | null;
  colors: VimModeColors;
};

export const DEFAULT_VIM_CONFIG: VimConfig = {
  enabled: true,
  initialMode: "insert",
  indicator: true,
  enterSubmit: false,
  insertAfterSubmit: false,
  clipboardPolicy: "all",
  langmap: {},
  escapeSequence: null,
  toggleKey: null,
  colors: {},
};

const HEX_RE = /^#[0-9a-fA-F]{6}$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function pick(sourced: Record<string, unknown>, ...names: string[]): unknown {
  for (const name of names) {
    if (Object.hasOwn(sourced, name)) return sourced[name];
  }
  return undefined;
}

function readBool(value: unknown, dflt: boolean): boolean {
  if (typeof value === "boolean") return value;
  if (value === "true") return true;
  if (value === "false") return false;
  return dflt;
}

function readInitialMode(value: unknown, dflt: VimInitialMode): VimInitialMode {
  return value === "normal" || value === "insert" ? value : dflt;
}

function readNonEmptyString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  return value.trim() ? value : null;
}

function readLangmap(value: unknown): Record<string, string> {
  if (!isRecord(value)) return {};
  const out: Record<string, string> = {};
  for (const [key, raw] of Object.entries(value)) {
    if (typeof raw !== "string") continue;
    // Keys and values must be single characters.
    if ([...key].length !== 1 || [...raw].length !== 1) continue;
    out[key] = raw;
  }
  return out;
}

function readEscapeSequence(value: unknown): string | null {
  const s = readNonEmptyString(value);
  return s && [...s].length === 2 ? s : null;
}

function readClipboardPolicy(value: unknown): VimClipboardPolicy | null {
  if (value === undefined) return null;
  const p = typeof value === "string" ? value.trim().toLowerCase() : "";
  if (p === "all" || p === "yank" || p === "never") return p;
  return null; // invalid → falls back to the default policy
}

function readColors(value: unknown): VimModeColors {
  if (!isRecord(value)) return {};
  const out: VimModeColors = {};
  const keys: (keyof VimModeColors)[] = ["normal", "insert", "visual", "visualLine", "replace"];
  for (const key of keys) {
    const raw = value[key];
    if (typeof raw === "string" && HEX_RE.test(raw.trim())) out[key] = raw.trim();
  }
  return out;
}

/** Merge one settings object (project over global) into the config. */
function applyLayer(base: VimConfig, layer: Record<string, unknown>): VimConfig {
  const cfg: VimConfig = { ...base };
  const enabled = pick(layer, "enabled");
  if (enabled !== undefined) cfg.enabled = readBool(enabled, cfg.enabled);
  const initialMode = pick(layer, "initial_mode");
  if (initialMode !== undefined) cfg.initialMode = readInitialMode(initialMode, cfg.initialMode);
  const indicator = pick(layer, "indicator");
  if (indicator !== undefined) cfg.indicator = readBool(indicator, cfg.indicator) || indicator === "on";
  const enterSubmit = pick(layer, "enter_submit");
  if (enterSubmit !== undefined) cfg.enterSubmit = readBool(enterSubmit, cfg.enterSubmit);
  const insertAfterSubmit = pick(layer, "insert_after_submit");
  if (insertAfterSubmit !== undefined) cfg.insertAfterSubmit = readBool(insertAfterSubmit, cfg.insertAfterSubmit);
  // Which register writes mirror to the system clipboard (pi-vim's policy):
  // "all" (default, neovim clipboard+=unnamedplus-like) | "yank" (yanks only) | "never" (internal).
  const policy = readClipboardPolicy(pick(layer, "clipboardMirror"));
  if (policy !== null) cfg.clipboardPolicy = policy;
  const langmap = pick(layer, "langmap");
  if (langmap !== undefined) cfg.langmap = readLangmap(langmap);
  const escapeSequence = pick(layer, "escape_sequence");
  if (escapeSequence !== undefined) cfg.escapeSequence = readEscapeSequence(escapeSequence);
  const toggleKey = pick(layer, "toggle_key");
  if (toggleKey !== undefined) cfg.toggleKey = readNonEmptyString(toggleKey);
  const colors = pick(layer, "colors");
  if (colors !== undefined) cfg.colors = { ...cfg.colors, ...readColors(colors) };
  return cfg;
}

export function readVimConfig(cwd: string): VimConfig {
  let config = DEFAULT_VIM_CONFIG;
  try {
    const manager = SettingsManager.create(cwd);
    const globalSettings = manager.getGlobalSettings();
    const projectSettings = manager.getProjectSettings();
    if (isRecord((globalSettings as Record<string, unknown>).piVim)) {
      config = applyLayer(config, (globalSettings as Record<string, unknown>).piVim as Record<string, unknown>);
    }
    if (isRecord((projectSettings as Record<string, unknown>).piVim)) {
      config = applyLayer(config, (projectSettings as Record<string, unknown>).piVim as Record<string, unknown>);
    }
  } catch {
    // Settings unreadable — run on defaults.
  }
  return config;
}
