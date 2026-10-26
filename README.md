# pi-vim

Vim modal editing for [pi](https://github.com/earendil-works/pi) — the prompt becomes a modal editor:
draft in **INSERT**, edit in **NORMAL**, select in **VISUAL / V-LINE**, and fix typos in **REPLACE**.

Counts, operators, text objects, registers, vi-style undo/redo (a whole insert session is one undo
unit), and dot-repeat (`.`). Modes come with color-coded labels; visual selections highlight with the
theme's `selectedBg`.

## Install

```bash
pi install npm:@banh-me/pi-vim
```

Or pin a version / install into the project only:

```bash
pi install npm:@banh-me/pi-vim@0.1.0
pi install npm:@banh-me/pi-vim -l
```

Restart pi after install. Toggle at runtime with `/vim` (or a `toggle_key` shortcut — see below).

## Configuration

Everything lives in the `piVim` section of pi settings — global `~/.pi/agent/settings.json`, or
per-project `<cwd>/.pi/settings.json` (project keys override global). Put only what you want to change
in there; every option has a sensible default.

```jsonc
{
  "piVim": {
    // Master switch.
    "enabled": true,

    // Mode the editor starts in: "insert" (default) or "normal".
    "initial_mode": "insert",

    // Show the color-coded mode label (INSERT/NORMAL/…) on the editor's bottom border.
    "indicator": true,

    // Enter behavior in INSERT mode:
    //   false (default) = newline, vim-style; submit from NORMAL with Enter
    //   true            = Enter submits from INSERT too
    "enter_submit": false,

    // After a prompt submit: return to INSERT (true) or stay NORMAL (false, default).
    // true also opens a fresh undo session for the next prompt.
    "insert_after_submit": false,

    // Optional global shortcut for toggling vim mode, any pi KeyId
    // (e.g. "ctrl+shift+v"). null (default) = none; /vim always works.
    "toggle_key": null,

    // Two-character sequence that leaves INSERT mode (e.g. "jk" — very handy
    // when pi's Esc is bound to interrupt-agent). Type the first char normally;
    // if the seconds follows within 300ms you drop to NORMAL and the first char
    // is removed. null (default) = only Esc exits insert.
    "escape_sequence": null,

    // Map single characters onto vim keys — handy for non-Latin layouts or
    // aliases. Keys and values are single characters; upper-case maps upper-case.
    //   "langmap": { "н": "h", "о": "j", "л": "k", "д": "l" }   // ЙЦУКЕН hjkl
    //   "langmap": { "H": "^", "L": "$" }                       // Home/End aliases
    "langmap": {},

    // Which register writes mirror to the system clipboard (named as in pi-vim —
    // behaves like neovim's `set clipboard+=unnamedplus` when "all"):
    //   "all"   (default) — yank AND delete/cut mirror; p/P paste fresh clipboard content
    //   "yank"            — only yanks copy out; after a delete, p pastes the
    //                       internally-held "shadow" register instead of the clipboard
    //   "never"           — all writes stay internal; no clipboard reads or writes
    // Tools used per platform: wl-copy/wl-paste (Wayland), xclip/xsel (X11),
    // pbcopy/pbpaste (macOS), PowerShell (Windows). If none work you get one
    // warning and vim silently falls back to the internal register.
    "clipboardMirror": "all",

    // Mode-label colors (hex). Defaults below; override per mode as you like.
    "colors": {
      "normal": "#83C092",       // green
      "insert": "#D3C6AA",       // cream
      "visual": "#E67E80",       // red
      "visualLine": "#E67E80",   // red
      "replace": "#E69875"       // orange
    },

    // Terminal cursor shape per mode (DECSCUSR). Requires pi's hardware cursor:
    // set "showHardwareCursor": true in settings.json or PI_HARDWARE_CURSOR=1.
    // Values: "default", "block", "bar" (alias "beam"/"line"), "underline",
    // plus blinking variants "block-blink", "bar-blink", "underline-blink".
    // You can also use the raw DECSCUSR code 0-6. Modes you omit keep the
    // previous shape; set a mode to null/false to unset it in a later layer.
    // Empty (default) = pi-vim never touches the cursor shape.
    "cursor_shape": {
      "normal": "block",
      "insert": "bar",
      "replace": "underline",
      "visual": "block",
      "visualLine": "block"
    }
  }
}
```

> **Cursor shape** only works when pi's hardware cursor is visible (`showHardwareCursor: true`
> in settings or `PI_HARDWARE_CURSOR=1`) and your terminal supports DECSCUSR (iTerm2, kitty,
> WezTerm, foot, Alacritty, …; Apple Terminal does not). On replace/disable/shutdown pi-vim
> restores the terminal default (`CSI 0 SP q`).

## Key reference

Most motions and operators accept counts (`0–9999`): `3dw`, `2f"`, `5j`, `2yy`.

### Normal mode

| | Keys |
|---|---|
| Modes | `i` `I` `a` `A` `o` `O` `R` `v` `V` `:` (palette), `Esc` → NORMAL aborts nothing |
| Motion | `h` `j` `k` `l` `w` `b` `e` `W` `B` `E` `0` `^` `_` `$` `{` `}` `%` `gg` `G` `gj` `gk` `g0` `g^` `g$` |
| Find | `f{c}` `F{c}` `t{c}` `T{c}`, repeat with `;` `,` |
| Operators | `d` `c` `y` + motion or text object: `dw` `db` `de` `d$` `d0` `d^` `dj` `dk` `d}` `d{` `d%` `cq`, text objects below |
| Text objects | `iw aw iW aW` `"" i" a"` `i' a'` `` i\` a\` `` `i( a( i) a) i[ a[ i{ a{ i< a<` |
| Line ops | `dd` `cc` `yy` `D` `C` `S` `J` `x` `X` `r{c}` `~` `s` |
| Paste | `p` `P` (`{count}p`) — linewise register pastes as whole lines |
| Undo | `u` (whole change or insert session), `Ctrl+r` redo, `.` repeat, counts apply |

### Visual modes (`v` char-wise, `V` line-wise)

| | Keys |
|---|---|
| Edit | `d` `x` `c` `y` `p` `~` `D` |
| Cursor | `o` swaps selection ends; all NORMAL motions resize the selection |
| Exit | `v`/`V` switch kind, `Esc` → NORMAL |

### Replace mode (`R`)

Type over characters until `Esc`; the whole replace run is one undo unit and `.`-repeatable.

### Prefs

- `Esc` in NORMAL is passed to pi (default: interrupt the agent), vim-style.
- `:` opens pi's command palette from an empty prompt — run `/model`, `/tree`, `/vim`, …

## Credits

- Vim engine ported from [opencode-vim-plugin](https://github.com/leohenon/opencode-vim-plugin)
  by [leohenon](https://github.com/leohenon) (MIT).
- pi editor integration (custom-editor wiring, visual highlight, undo strategy) follows the
  patterns of [pi-vim-keys](https://github.com/0xKahi/pi-vim-keys) and
  [pi-vim](https://github.com/lajarre/pi-vim) (both MIT).

## License

MIT — see [LICENSE](LICENSE).
