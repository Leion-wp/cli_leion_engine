# TUI V2 Spec - Leion Pro

## Vision
- UI terminal dense, professionnelle et fluide.
- Priorité run cockpit live, editor intelligent en second pilier.
- Contrat core inchangé, shell V2 découplé et fallback legacy immédiat.

## Architecture
- `packages/tui/src/app.tsx`: shell/orchestration V2 + routing legacy.
- `packages/tui/src/legacyApp.tsx`: UI historique conservée.
- `packages/tui/src/state/*`: config V2, reducer/state machine, keymap, palette ranking.
- `packages/tui/src/ui/*`: design system terminal (`theme`, `primitives`, `palette`, `overlays`).
- `packages/tui/src/screens/*`: écrans modulaires par tab.
- `packages/tui/src/services/*`: YAML editor, formatting, buffering.

## Config V2
- `intentRouter.tui.ui.version`: `v2` (default) | `legacy`
- `intentRouter.tui.theme.name`: `leion-pro`
- `intentRouter.tui.theme.highContrast`: `false` (default)
- `intentRouter.tui.keymap.profile`: `hybrid` (default) | `classic`
- `intentRouter.tui.palette.enabled`: `true` (default)
- `intentRouter.tui.palette.trigger`: `ctrl+k`

## UX
- Navigation hybride: `j/k` + flèches + `Tab/Shift+Tab`.
- Command palette globale: `Ctrl+K` + fuzzy search cross-entities.
- Aide contextuelle: `?`.
- Prompts et confirmations inline pour opérations sensibles.

## Rollback
- CLI: `leion-roots tui --legacy`
- Config: `intentRouter.tui.ui.version = legacy`
