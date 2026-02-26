# M03 - Editor avancé (Verticale Utilisable)

Date: 2026-02-26  
Repo: `cli_leion_engine`

## Scope livré
1. TUI Editor (form + YAML expert)
- Form mode pour node sélectionné:
  - `i`: éditer intent
  - `m`: éditer description
  - `o`: éditer `on_failure`
  - `c`: éditer `payload.command`
  - `u/j`: reorder
  - `a`: add
  - `x`: delete
- Prompt inline (saisie clavier, Enter/Esc).
- Mode YAML expert:
  - `y`: ouvre `$EDITOR` sur YAML du node puis `replace_node`.

2. Core/CLI support
- `replace_node`, `delete_node`, `reorder_nodes` déjà branchés au core.
- Validation des références conservée.
- Règle suppression `meta.ui` conservée via `DslMutationService`.

## Validation exécutée
1. `npm run build:all`
2. `./scripts/m03-editor-advanced-smoke.sh`
3. Non-régression:
- `./scripts/m01-run-live-smoke.sh`
- `./scripts/m02-pipelines-smoke.sh`

## Fichiers clés
1. `packages/tui/src/app.tsx`
2. `scripts/m03-editor-advanced-smoke.sh`
3. `packages/core/src/dslMutationService.ts`

## Notes
1. Le mode YAML expert dépend de `$EDITOR` (fallback `nano`).
2. Le workflow reste core-driven: la TUI ne modifie pas directement le JSON hors services.

