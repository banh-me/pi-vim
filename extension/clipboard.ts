/**
 * System clipboard as the vim register — ported from the opencode-vim-plugin
 * prompt-vim.ts (MIT, © leohenon), adapted to pi.
 *
 * Uses pi-tui's getNativeClipboard where available (macOS/Windows native
 * modules), falling back to wl-copy/xclip/xsel or PowerShell on Linux/Windows,
 * matching the upstream tool chain. All calls are synchronous with a short
 * timeout so the vim dispatch stays simple; a fail-fast latch stops shelling
 * out once the clipboard tooling is known to be dead.
 */

import { spawnSync } from "node:child_process";
import type { VimRegister } from "./text-core";

const CLIPBOARD_TIMEOUT_MS = 300;
const CLIPBOARD_MAX_FAILURES = 3;

/** Read the system clipboard; undefined = unavailable (no tool / failed). */
export function readSystemClipboard(): string | undefined {
  const command =
    process.platform === "darwin"
      ? ["pbpaste"]
      : process.platform === "win32"
        ? ["powershell.exe", "-NoProfile", "-Command", "Get-Clipboard -Raw"]
        : ["sh", "-c", "wl-paste -n 2>/dev/null || xclip -selection clipboard -out 2>/dev/null || xsel --clipboard --output 2>/dev/null"];
  const result = spawnSync(command[0]!, command.slice(1), {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
    timeout: CLIPBOARD_TIMEOUT_MS,
    windowsHide: true,
  });
  if (result.error) return undefined;
  // An empty Wayland clipboard exits non-zero without being an error.
  if (result.status !== 0) {
    return result.stdout?.length ? result.stdout : undefined;
  }
  return result.stdout;
}

/** Write the system clipboard. "ok" | "missing" | "failed". */
export function writeSystemClipboard(text: string): "ok" | "missing" | "failed" {
  const command =
    process.platform === "darwin"
      ? ["pbcopy"]
      : process.platform === "win32"
        ? ["powershell.exe", "-NoProfile", "-Command", "[Console]::In.ReadToEnd() | Set-Clipboard"]
        : ["sh", "-c", "wl-copy 2>/dev/null || xclip -selection clipboard -in 2>/dev/null || xsel --clipboard --input 2>/dev/null"];
  const result = spawnSync(command[0]!, command.slice(1), {
    input: text,
    encoding: "utf8",
    stdio: ["pipe", "ignore", "ignore"],
    timeout: CLIPBOARD_TIMEOUT_MS,
    windowsHide: true,
  });
  if (result.error) return (result.error as NodeJS.ErrnoException).code === "ENOENT" ? "missing" : "failed";
  return result.status === 0 ? "ok" : "failed";
}

/**
 * The clipboard mirror: tracks the last register mirrored to the OS clipboard,
 * serves paste reads (fresh clipboard text wins; a read equal to the last
 * mirror keeps the mirrored linewise register; failures fall back to the
 * internal vim register), and latches off after repeated failures.
 */
export class ClipboardMirror {
  private unavailable = false;
  private failures = 0;
  private lastMirror: VimRegister = null;
  /** true after a successfully mirrored write; false after policy-skipped/failed writes; null initially. */
  private lastWriteMirrored: boolean | null = null;

  constructor(
    private readonly policy: () => "all" | "yank" | "never",
    private readonly notify: ((message: string, style: "info" | "warning" | "error") => void) | undefined,
  ) {}

  /** Paste source: null → use the internal vim register instead. */
  get(): VimRegister {
    if (this.policy() === "never" || this.unavailable) return null;
    // Shadow-register rule: when the latest register write was policy-skipped
    // ("yank" policy delete) or the mirror failed, the internal register is
    // fresher than the clipboard — p uses it instead.
    if (this.lastWriteMirrored === false) return null;
    const text = readSystemClipboard();
    if (text === undefined) return this.lastMirror;
    if (this.lastMirror && text === this.lastMirror.text) return this.lastMirror;
    return { text, linewise: false };
  }

  /** Mirror a register write per policy. */
  mirror(next: VimRegister, isYank: boolean): void {
    if (!next) return;
    const policy = this.policy();
    if (policy === "never") {
      this.lastWriteMirrored = false;
      return;
    }
    if (policy === "yank" && !isYank) {
      // Policy-skipped write: p falls back to the internal register (pi-vim).
      this.lastWriteMirrored = false;
      return;
    }
    this.lastMirror = { ...next };
    const result = writeSystemClipboard(next.text);
    this.lastWriteMirrored = result === "ok";
    if (result !== "ok") {
      this.failures = result === "missing" ? CLIPBOARD_MAX_FAILURES : this.failures + 1;
      if (this.failures >= CLIPBOARD_MAX_FAILURES && !this.unavailable) {
        this.unavailable = true;
        this.notify?.("System clipboard unavailable, using the internal vim register", "warning");
      }
      return;
    }
    this.failures = 0;
  }
}
