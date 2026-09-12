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

## Runtime protocol v1

```sh
node packages/cli/out/index.js runtime_describe --json
node packages/cli/out/index.js catalog --section capabilities --json
node packages/cli/out/index.js validate_pipeline --pipeline example --workspace /path/to/workspace --json
```

Describe and catalog return the same versioned envelope:

```json
{
  "ok": true,
  "protocolVersion": "1",
  "runtime": {
    "name": "leion-roots",
    "version": "0.1.0",
    "capabilities": ["catalog", "validate_pipeline", "run_pipeline", "route_intent", "history_list", "history_show", "stop_pipeline", "resume_pipeline"]
  },
  "capabilities": []
}
```

`runtime.version` comes from the CLI package. `runtime.capabilities` advertises
the command subset of this protocol; it is distinct from the top-level array
of intent descriptors. The real response fills that array from shared builtin
provider declarations, plus the runner/router-owned `pipeline.run` container.
It neither constructs a runtime nor loads workspace configuration, custom
nodes, credentials, history, or mutable provider registrations.

Each descriptor preserves `capability`, `provider`, `command`, `type`,
`capabilityType`, `determinism`, and `args`. `host` and `executionMode` describe
how the CLI implements the capability. The legacy `type: "vscode"` registry
transport does not mean that an intent needs VS Code: several intents compile
to terminal commands inside pipelines. `git.clone` has no CLI implementation
and is explicitly unavailable. Other external dependencies are not probed, so
availability remains `"unknown"` where executable installation, authentication,
TTY presence, filesystem permissions or connectivity would need verification.
`risk` and `requirements` are conservative descriptive facts, not an approval
or sandbox decision. Unknown facts remain `"unknown"`.

Some legacy argument `type` fields say `string` for runtime array inputs.
Those descriptors retain the original field and add `acceptedTypes` with the
proven JSON types, which the static validator uses. Catalogue consumers should
prefer `acceptedTypes` for JSON input controls when it is present.

JSON mode writes exactly one JSON document to stdout for public finite
commands, including errors; provider-registration logs, verbose output and
interactive prompts go to stderr. `triggers_serve` is a streaming daemon and
rejects `--json`. Unsupported catalogue sections also return a JSON diagnostic
with a non-zero exit code. The new describe/catalog/validation commands return
JSON success responses even without `--json`; pass the flag to also guarantee
JSON responses for command errors.

## Static pipeline validation

Validation reads a `.intent.json` file under `<workspace>/pipeline`. A simple
name resolves to that directory; relative paths resolve from the workspace;
absolute paths are accepted only inside the pipeline directory. Both lexical
paths and filesystem real paths are checked, including symlinks and Windows
junctions. Validation never creates directories, history, worker state or run
memory, and never invokes providers, payload mappers or the pipeline runner.

The response contains `ok`, `protocolVersion`, `valid`, the resolved `path`,
pipeline `name` and top-level `steps` count when available, and `diagnostics`.
Each diagnostic has a stable `code`, `severity`, `message`, and a JSON Pointer
in `path`; file diagnostics include `file`, and step diagnostics include
`stepId` when available. Invalid input exits with status 1 and retains a
directly parsable JSON response. No errors means `valid: true` and status 0;
warnings can still be present.

Checks cover a non-empty name/steps array, step structure, globally unique
non-empty IDs, canonical capability membership, CLI-unavailable intents,
required arguments and basic JSON types/enums, inline composites, and targets
in `onFailure`, `defaultStepId`, `routes`, `doneStepId` and `graphStepIds`.
Targets must exist in their containing steps array; graph loops cannot include
themselves. Graph-segment loops require body IDs instead of a child file.

Runtime templates are not evaluated; their eventual values receive warnings.
Child pipeline files are not recursively read and require separate validation.
Validation does not establish that all branches terminate, that external
requirements are met, or that payloads are authorized. It also does not apply
workspace mappings/custom nodes: those require a future extension to the
versioned contract. A control plane must keep validation distinct from policy
approval and live-runtime preflight.
