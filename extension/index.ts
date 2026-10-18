/**
 * pi-vim — vim modal editing for pi's prompt editor.
 *
 * Core vim engine ported from opencode-vim-plugin (MIT, © leohenon); pi editor
 * integration guided by pi-vim-keys and pi-vim (both MIT).
 *
 * Options live in the "piVim" section of pi settings (global
 * ~/.pi/agent/settings.json or project <cwd>/.pi/settings.json). See README.md
 * for every option and the full key reference. Toggle with /vim.
 */

import type { ExtensionAPI, ExtensionContext, KeybindingsManager } from "@earendil-works/pi-coding-agent";
import type { EditorTheme, TUI } from "@earendil-works/pi-tui";
import { readVimConfig, type VimConfig } from "./config";
import { VimModalEditor } from "./vim-modal-editor";

type EditorHost = Pick<ExtensionContext["ui"], "theme">;

export default function (pi: ExtensionAPI) {
  let cleanupEditor: () => void = () => {};
  let config: VimConfig = readVimConfig(".");
  const selectionStyleFactory = (ui: EditorHost) => (text: string) => ui.theme.bg("selectedBg", text);

  function installEditor(ctx: ExtensionContext, activeConfig: VimConfig) {
    const style = selectionStyleFactory(ctx.ui);
    const notify = (message: string, style: "info" | "warning" | "error") => ctx.ui.notify(message, style);
    ctx.ui.setEditorComponent((tui: TUI, theme: EditorTheme, kb: KeybindingsManager) => {
      cleanupEditor();
      const editor = new VimModalEditor(tui, theme, kb, {
        config: activeConfig,
        selectionStyle: style,
        notify,
      });
      cleanupEditor = () => {};
      return editor;
    });
  }

  pi.on("session_start", (_event, ctx) => {
    if (ctx.mode !== "tui") return;
    config = readVimConfig(ctx.cwd);
    if (!config.enabled) return;
    installEditor(ctx, config);
  });

  pi.on("session_shutdown", () => {
    cleanupEditor();
    cleanupEditor = () => {};
  });

  async function toggleVim(ctx: ExtensionContext) {
    if (ctx.mode !== "tui" || !ctx.hasUI) {
      ctx.ui.notify("Vim mode requires the interactive TUI.", "warning");
      return;
    }
    config = { ...config, enabled: !config.enabled };
    if (config.enabled) {
      installEditor(ctx, config);
      ctx.ui.notify("Vim mode enabled", "info");
    } else {
      ctx.ui.setEditorComponent(undefined);
      cleanupEditor();
      cleanupEditor = () => {};
      ctx.ui.notify("Vim mode disabled", "info");
    }
  }

  pi.registerCommand("vim", {
    description: "Toggle vim mode for the prompt editor",
    handler: async (_name: string | undefined, ctx: ExtensionContext) => {
      await toggleVim(ctx);
    },
  });

  // Optional global toggle shortcut (toggle_key).
  if (config.toggleKey) {
    try {
      pi.registerShortcut(config.toggleKey as Parameters<typeof pi.registerShortcut>[0], {
        description: "Toggle vim mode",
        handler: (ctx) => toggleVim(ctx),
      });
    } catch {
      // Invalid toggle_key — ignore quietly.
    }
  }

}
