# M05 - Triggers (Verticale Utilisable)

Date: 2026-02-26  
Repo: `cli_leion_engine`

## Scope livré
1. Core
- `TriggerService` public:
  - `list()`
  - `start()`
  - `refresh()`
  - `stop()`
- Découverte triggers depuis `pipeline/*.intent.json`.

2. CLI/TUI
- CLI garde `triggers_serve`.
- TUI tab `Triggers`:
  - listing
  - start (`s`)
  - stop (`x`)
  - refresh (`f`)

## Validation exécutée
1. `npm run build:all`
2. `./scripts/m05-triggers-smoke.sh`

## Fichiers clés
1. `packages/core/src/services/triggerService.ts`
2. `packages/tui/src/app.tsx`
3. `scripts/m05-triggers-smoke.sh`

