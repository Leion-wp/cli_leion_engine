# M01 - Run Live (Verticale Utilisable)

Date: 2026-02-26  
Repo: `cli_leion_engine`

## Scope livré
1. Core
- `CoreRuntime.on_event(listener)` exposé publiquement.
- Nouveau `RunSupervisorService` avec:
  - `start_detached`
  - `list_runs`
  - `show_run`
  - `pause_run`
  - `resume_run`
  - `cancel_run`
  - `tail_events`
- Worker detached déplacé dans core:
  - `runSupervisorWorker.ts`
- Événements NDJSON versionnés:
  - `eventVersion: 1`
  - `ts`, `runId`, `type`, `payload`
- Contrat pause checkpoint:
  - `pause` => `run.pause_requested`
  - pause effective au checkpoint => `run.paused_checkpoint`
  - `resume` => `run.resume_requested`

2. CLI
- `run_pipeline --detached` branché sur `RunSupervisorService`.
- `stop_pipeline` et `resume_pipeline` branchés core service.
- Nouvelle commande `cancel_pipeline`.
- Nouvelle commande `reorder_nodes`.
- Nouvelle commande `tui` pour lancer la TUI.

3. TUI (Ink/React)
- Nouveau package `packages/tui`.
- Écrans utilisables:
  - Run Live
  - Pipelines
  - History
  - Triggers
  - HITL Inbox
- Buffering borné (configurable):
  - logs max: `intentRouter.tui.logs.maxLines` (default 2000)
  - events max: `intentRouter.tui.events.maxItems` (default 5000)

## Contrats fixés
1. `events.ndjson` V1 stable tant que `eventVersion=1`.
2. `pause` n'est pas un freeze process OS; c'est une pause checkpoint runtime.
3. Diff non implémenté dans M01 (prévu M04), TUI n'invente aucun diff.

## Validation exécutée
1. `npm install`
2. `npm run build:all`
3. Smoke CLI:
- create/add/run detached
- stop/resume
- vérification `.events.ndjson` (eventVersion=1)
4. Smoke TUI:
- lancement via `leion-roots tui` (via CLI), affichage des écrans et sortie propre.

## Fichiers clés introduits/modifiés
1. `packages/core/src/services/runSupervisorService.ts`
2. `packages/core/src/services/runSupervisorWorker.ts`
3. `packages/core/src/coreRuntime.ts`
4. `packages/cli/src/index.ts`
5. `packages/tui/src/index.tsx`
6. `packages/tui/src/app.tsx`

## Gaps restants pour milestones suivantes
1. M02: pipeline catalog renforcé + CRUD/reorder approfondi côté TUI.
2. M03: editor avancé form + YAML inline.
3. M04: history + diff runtime-first + fallback git read-only.
4. M05: trigger operations avancées.
5. M06: HITL complet avec `approval.request` consolidé.

