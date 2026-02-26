# TUI Fallback Guide

## Use legacy UI
- One-shot: `leion-roots tui --legacy`
- Persistent (workspace): set `intentRouter.tui.ui.version` to `legacy` in `.intent-router/config.json`

## Return to V2
- Remove `--legacy`
- Set `intentRouter.tui.ui.version` to `v2` (or remove key)

## Troubleshooting
- Build not found: run `npm run build:tui`
- Rendering issue: test with high-contrast disabled first (`intentRouter.tui.theme.highContrast = false`)
- Keyboard mismatch: set `intentRouter.tui.keymap.profile = classic`
