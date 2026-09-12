# Leion Roots CLI engine

Build and run the CLI from this checkout:

```sh
npm ci
npm run build:cli
node packages/cli/out/index.js help
```

## Dry-run contract

```sh
node packages/cli/out/index.js run_pipeline --pipeline example --dry_run --workspace /path/to/workspace
```

`--dry_run` previews the pipeline without invoking providers. It applies to
ordinary steps, compiled Git/Docker terminal steps, composite child intents,
switch and failure branches, and graph-segment loop targets. A child with
`meta.dryRun: false` cannot disable a parent preview. Pipeline or step
`meta.dryRun: true` can also opt into preview; `dryRunChild: true` previews a
child pipeline when its parent is executing normally.

Provider payload mapping, interactive variable resolution, command dispatch,
and provider invocation are skipped. Runner-owned forms and persistent memory
save/recall/clear operations are also skipped and logged. No human answer is
selected and no provider output variable is fabricated during preview.

The runner can still update in-memory variables and evaluate routing and loop
structure. Provider-backed sub-pipeline and child-loop steps are previewed as
steps: a parent dry-run does **not** open or recursively validate their child
files. Such files can be previewed separately, or with `dryRunChild: true` in
an otherwise live parent. Output-dependent routes cannot be verified without
real provider results or explicit input fixtures.

Preview success means the reached preview operations passed; it is not proof
that every branch, payload, child file, or live action is valid. Existing
sandbox checks can still reject a preview. Runtime bookkeeping (including run
history and detached worker state) may write local files; provider effects and
persistent pipeline memory operations are prohibited during dry-run.

## Human interaction without a terminal

The CLI requires a TTY on stdin for text input and choices. If stdin is piped,
closed, or ignored by a detached worker, it raises `INTERACTION_REQUIRED`
instead of selecting a default value, the first option, or `Continue`.
Commands exit unsuccessfully, and detached workers persist a failed state with
the interaction error. This is a failure, not a durable approval waiting state.

`INTERACTION_REQUIRED` propagates through composite intents, sub-pipelines,
loops, retry policies, `continueOnError`, and `onFailure`: none can turn a
missing human decision into an approved action. Embedders receive the rejected
promise with `error.code === 'INTERACTION_REQUIRED'`; the pipeline also emits
its normal failure event. Host integrations without interaction handlers
return no selection rather than implicitly choosing an option.

Interactive terminal usage retains explicit user selection. Automated callers
must arrange approval before dispatch or implement a real host interaction
channel. These changes do not add an approval/resume protocol.

## Verification

```sh
npm test
```

This builds the core and CLI, then uses Node's built-in test runner. Sentinels
intercept provider dispatch and payload mapping; tests also cover memory and
input suppression, composite inheritance, branches, graph loops, local child
pipelines, and the compiled CLI/worker with stdin closed. The fixtures use
temporary workspaces and never invoke effectful providers or external APIs.
