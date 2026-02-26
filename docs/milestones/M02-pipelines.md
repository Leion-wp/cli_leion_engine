# M02 - Pipelines (Verticale Utilisable)

Date: 2026-02-26  
Repo: `cli_leion_engine`

## Scope livré
1. Core
- `PipelineCatalogService` public utilisé comme résolution centralisée pipelines.
- `DslMutationService.reorder_nodes(...)` disponible et branché CLI/TUI.

2. CLI
- Commande `reorder_nodes` opérationnelle.
- Flux create/add/replace/delete inchangé (non-régression).

3. TUI
- Tab `Pipelines` enrichi:
  - run detached (`Enter` / `r`)
  - dry-run (`d`)
  - create pipeline (`n`)
  - delete pipeline (`x`)
  - bascule editor (`e`)
- Tab `Editor` branché sur pipeline sélectionné.

## Validation exécutée
1. `npm run build:all`
2. `./scripts/m02-pipelines-smoke.sh`
3. Vérification manuelle TUI:
- création/suppression pipeline depuis tab Pipelines
- navigation vers tab Editor

## Fichiers clés
1. `packages/tui/src/app.tsx`
2. `scripts/m02-pipelines-smoke.sh`
3. `packages/core/src/dslMutationService.ts`

## Notes
1. Ce milestone garde l’édition avancée Form + YAML pour M03.
2. Les garanties schema runtime `.intent.json` sont conservées.

