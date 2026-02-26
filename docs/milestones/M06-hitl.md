# M06 - HITL (Verticale Utilisable)

Date: 2026-02-26  
Repo: `cli_leion_engine`

## Scope livré
1. Core
- Event `approval.request` ajouté au bus runtime.
- `ApprovalInboxService` persistant (`.intent-router/approvals.json`):
  - `list_pending()`
  - `resolve(...)`
  - `ack(...)`

2. TUI
- Tab `HITL`:
  - listing pending approvals
  - approve (`a`)
  - reject (`r`)

3. Runtime bridge
- `pipelineRunner` émet `approval.request` pour steps d’approbation.

## Validation exécutée
1. `npm run build:all`
2. `./scripts/m06-hitl-smoke.sh`

## Fichiers clés
1. `packages/core/src/services/approvalInboxService.ts`
2. `packages/core/src/eventBus.ts`
3. `packages/core/src/pipelineRunner.ts`
4. `packages/tui/src/app.tsx`
5. `scripts/m06-hitl-smoke.sh`

