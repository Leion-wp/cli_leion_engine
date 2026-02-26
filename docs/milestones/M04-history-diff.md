# M04 - History + Diff (Verticale Utilisable)

Date: 2026-02-26  
Repo: `cli_leion_engine`

## Scope livré
1. Core
- `DiffService` public:
  - priorité `audit` (reviews runtime)
  - fallback `git diff --name-status` read-only
  - source explicite: `audit | git | none`

2. TUI
- Tab `History` active avec détail run.
- Tab `Diff` active, source affichée, rafraîchissement (`f`).
- La TUI affiche uniquement les artefacts fournis par core (`audit`) ou fallback git read-only.

## Validation exécutée
1. `npm run build:all`
2. `./scripts/m04-history-diff-smoke.sh`

## Fichiers clés
1. `packages/core/src/services/diffService.ts`
2. `packages/tui/src/app.tsx`
3. `scripts/m04-history-diff-smoke.sh`

