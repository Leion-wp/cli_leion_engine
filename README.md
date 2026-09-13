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
    "capabilities": ["catalog", "validate_pipeline", "run_pipeline", "route_intent", "run_status", "run_list", "run_logs", "history_list", "history_show", "stop_pipeline", "resume_pipeline", "cancel_pipeline"],
    "contracts": {
      "run_controls": {
        "version": "1",
        "idempotent": true,
        "pauseRequestedState": "pause_requested",
        "pauseAcknowledgedState": "paused",
        "resumePendingState": "paused",
        "resumeAcknowledgedState": "running",
        "cancelRequestedState": "cancel_requested",
        "cancelTerminalState": "cancelled",
        "cancellationDominant": true,
        "terminalProcessExitRequired": true
      },
      "run_logs": {
        "version": "1",
        "cursorFormat": "lr1",
        "cursorMonotone": true,
        "legacyIntegerCursor": true,
        "eventVersion": 1,
        "stableEventIds": true,
        "corruptionPolicy": "projected_event",
        "canonicalFields": ["run_id", "detached_run_id", "correlation_id", "events", "next_cursor", "has_more"],
        "limits": {
          "default": 100,
          "max": 200,
          "maxRecordBytes": 16384,
          "maxResponseBytes": 524288,
          "maxScanBytes": 8388608
        }
      }
    }
  },
  "capabilities": []
}
```

`runtime.version` comes from the CLI package. `runtime.capabilities` advertises
the command subset of this protocol; it is distinct from the top-level array
of intent descriptors. The real response fills that array from shared builtin
provider declarations, plus the runner/router-owned `pipeline.run` container.
`runtime.contracts.run_controls` is the machine-readable acknowledgement and
cancellation contract consumed by control planes; command names alone do not
prove those semantics. `runtime.contracts.run_logs` describes the durable event
page that can be ingested without legacy log fallbacks.
It neither constructs a runtime nor loads workspace configuration, custom
nodes, credential material, history, or mutable provider registrations. It
checks only whether `JULES_API_KEY` is present and structurally valid so the
optional Jules descriptors can be omitted when the provider is unconfigured.

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

## Idempotent detached runs

`run_pipeline --detached --correlation_id <id>` binds one caller-provided key
to the real workspace, resolved pipeline path, SHA-256 of the pipeline bytes,
`from` value and `dry_run` flag. A retry with the same immutable values returns
the original detached run without starting another live worker. A different
value returns the stable `RUN_CORRELATION_CONFLICT` diagnostic. Correlation IDs are limited to 1-128
ASCII letters, numbers, dots, underscores, colons and hyphens; unsafe input
returns `RUN_CORRELATION_INVALID`.

Successful creation and retries return:

```json
{
  "run_id": "run_example",
  "detached_run_id": "run_example",
  "correlation_id": "delivery:42",
  "pid": 1234,
  "status": "starting",
  "reused": false
}
```

Without `correlation_id`, each invocation still creates a new run and preserves
the legacy creation status `"detached"`. `recovered: true` is included when a
retry resumes a `starting` run abandoned before worker handoff or observes its
exclusive execution claim after PID-state persistence failed. `run_status`, `run_logs`, `stop_pipeline`,
`resume_pipeline` and `cancel_pipeline` accept the detached run ID, runtime run
ID or correlation ID through `--run_id`. `run_list` returns `{ "runs": [] }`.
Use `--json` for the versioned error envelope. A missing lookup exits 1 and
returns diagnostic code `RUN_NOT_FOUND`; an invalid log cursor returns
`RUN_CURSOR_INVALID`. Control of a terminal run returns
`RUN_CONTROL_INVALID_STATE`. Worker spawn and PID-state persistence failures use
`RUN_WORKER_SPAWN_FAILED` and `RUN_STATE_PERSIST_FAILED` respectively.
Fresh `starting` states have a five-second handoff grace. After that grace, a
nonterminal state with no live worker or claim becomes `failure` with
`RUN_WORKER_NOT_RUNNING` in the returned projection. Status reads never start a
worker or rewrite run state.
Changing the pipeline after it has been claimed makes a retry conflict; if it
changes between claim and worker startup, the worker exits with
`RUN_PIPELINE_CHANGED` before constructing `CoreRuntime`.

Control responses contain the requested `run_id`, resolved `detached_run_id`,
optional `correlation_id`, and `action`. `stop_pipeline` returns action `pause`;
`resume_pipeline` returns `resume`; `cancel_pipeline` returns `cancel`. Each
persisted control request has a unique internal request ID, so commands created
in the same millisecond remain distinct. A pause first becomes
`pause_requested`; the worker publishes `paused` only after `CoreRuntime`
acknowledges a safe point between nodes. Resume keeps the durable state
`paused` until `pipelineResume` acknowledges that execution has woken, then
publishes `running`. Repeating an already pending or applied pause/resume is
idempotent, including through a new supervisor process.

Cancellation uses a separate write-once marker, so it wins races with later
pause/resume writes and is checked again at the worker's terminal transition.
Once cancellation is durable, pause and resume return
`RUN_CONTROL_INVALID_STATE`; terminal state never regresses. In-flight terminal
processes are stopped as a process tree and their cancellation exit is reported
as `cancelled`. A command that exits unsuccessfully without a cancellation
request remains a pipeline `failure`.

Correlation, spawn and execution claims are published atomically under
`.intent-router/runs`; correlation filenames use SHA-256 rather than caller
input. State replacement is atomic. The worker holds an exclusive execution
claim before pipeline verification and entering `CoreRuntime`, so concurrent callers and crash recovery
cannot invoke two providers for one detached run. Persisted event payloads omit
all fields outside a small metadata allowlist. Log text is stored only as byte
length and SHA-256. Worker state stores a result summary and a stable sanitized
error code/message rather than provider output or exception text.

The public correlation/run contract uses these diagnostic codes:
`RUN_CORRELATION_REQUIRES_DETACHED`, `RUN_CORRELATION_INVALID`,
`RUN_CORRELATION_CONFLICT`, `RUN_CORRELATION_CLAIM_INVALID`,
`RUN_ID_REQUIRED`, `RUN_ID_INVALID`, `RUN_ID_EXHAUSTED`, `RUN_NOT_FOUND`,
`RUN_CURSOR_INVALID`, `RUN_LIMIT_INVALID`, `RUN_LOG_SCAN_LIMIT`,
`RUN_STATE_INVALID`, `RUN_STATE_PERSIST_FAILED`,
`RUN_WORKER_SPAWN_FAILED`, `RUN_WORKER_NOT_RUNNING`,
`RUN_CONTROL_INVALID_STATE`, `RUN_PIPELINE_CHANGED`, `RUN_PIPELINE_INVALID`,
`RUN_SPAWN_CLAIM_TIMEOUT`, `RUN_STORAGE_UNSAFE`, `PIPELINE_REQUIRED`,
`PIPELINE_NOT_FOUND`, and `WORKSPACE_NOT_FOUND`.

## Run log pagination

The control-plane command is:

```sh
node packages/cli/out/index.js run_logs \
  --workspace /absolute/workspace \
  --run_id delivery:42 \
  --cursor lr1.1.178.51d036c304e84c2b \
  --limit 100 \
  --json
```

`--run_id` accepts a correlation ID, detached run ID or runtime run ID. `--limit`
defaults to 100 and accepts integers from 1 through 200. Omit `--cursor` for the
first page. Consumers must treat the canonical `lr1` cursor as opaque. A
non-negative integer is accepted as a compatibility cursor and means a
zero-based persisted record position.

The canonical response uses snake_case:

```json
{
  "run_id": "delivery:42",
  "detached_run_id": "run_demo_123",
  "correlation_id": "delivery:42",
  "events": [
    {
      "event_id": "evt_965611dd23e2249f958cbd5560f2b343994a34071d87662f666dfbd2156a35fd",
      "type": "run.detached_started",
      "occurred_at": "2026-09-13T11:46:40.000Z",
      "event_version": 1,
      "sequence": 0,
      "run_id": "run_demo_123",
      "detached_run_id": "run_demo_123",
      "correlation_id": "delivery:42",
      "payload": {
        "detachedRunId": "run_demo_123",
        "correlationId": "delivery:42",
        "dryRun": true
      },
      "eventVersion": 1,
      "ts": 1789300000000,
      "runId": "run_demo_123"
    }
  ],
  "next_cursor": "lr1.1.178.51d036c304e84c2b",
  "has_more": false,
  "nextCursor": 1,
  "hasMore": false
}
```

`next_cursor` is always a non-empty string, including on an empty final page.
It advances only after a returned persisted record. Repeating a request with
the same cursor against an unchanged journal returns the same event IDs and
records. `sequence` is a zero-based integer. `event_id` is a SHA-256 identity
derived only from the detached run identity and the record's byte position.
`payload` is always an object projected through a metadata allowlist; raw
pipeline payloads, arguments, outputs, log text and error messages are never
returned. The legacy `eventVersion`, `ts`, `runId`, `nextCursor` and `hasMore`
fields remain additive compatibility aliases.

For pipeline events, `event.run_id` can be the runtime pipeline run ID and can
differ from `event.detached_run_id`; the latter remains the stable supervisor
identity. The worker journals `pipelineEnd`, then `run.worker_finished` or
`run.worker_error`, before publishing a terminal detached-run state.

Malformed JSON records are returned as stable `run.record_corrupt` events with
`{ "code": "RUN_LOG_RECORD_CORRUPT" }`. Records over 16 KiB are returned as
stable `run.record_oversize` events with
`{ "code": "RUN_LOG_RECORD_OVERSIZE" }`; their content is not decoded or
returned, and each advances exactly one sequence. A final record fragment with
no newline remains pending: the cursor does not advance and `has_more` remains
false until a later poll sees the completed record. A record crossing the 8 MiB
scan bound returns `RUN_LOG_SCAN_LIMIT` instead of skipping bytes. Invalid
cursors return `RUN_CURSOR_INVALID`; invalid limits return `RUN_LIMIT_INVALID`.
The complete pretty-printed CLI JSON response, including its final newline, is
bounded to 512 KiB.

## Jules v1alpha provider

The runtime integrates the official Jules REST API at the fixed production
origin `https://jules.googleapis.com/v1alpha`. The API is an experimental alpha
contract. Create an API key in the Jules web application and provide it only
through `JULES_API_KEY`; the provider sends it in the `x-goog-api-key` header.
It is never read from a pipeline payload or workspace configuration. The Jules
intent descriptors appear in `runtime_describe` and `catalog` only while that
environment variable contains a valid key. Advertised descriptors include
`requirements: ["JULES_API_KEY", "jules-account-access"]`.
This configuration check does not make a live request or prove that the key is
authorized; the first provider request still fails closed if authentication or
account access is unavailable.

The implemented intent capabilities are:

- `jules.sources.list`: optional `pageSize` (default 30, range 1-100) and the
  opaque `pageToken`. Sources must already be connected through the Jules web
  application. The result contains bounded source IDs and GitHub repository
  identity only.
- `jules.session.create`: required `prompt`; optional `title`, paired `source`
  and `startingBranch`, and `autoCreatePr`. The provider always sends
  `requirePlanApproval: true` and rejects an explicit false value. Omitting the
  source pair creates the repoless session supported by the official API.
- `jules.session.get`: required `sessionId`, accepting either the ID or
  `sessions/<id>`. The result contains the session ID, documented state, safe
  Jules URL, timestamps, and validated GitHub pull request identities. Prompt,
  title, source context, PR text and unknown upstream fields are omitted.
- `jules.activities.list`: required `sessionId`, optional `pageSize` (default
  50, range 1-100), and opaque `pageToken`. Results contain activity ID, type,
  originator and timestamp. User or agent messages, descriptions, patches,
  media, shell output and all artifact bodies are omitted.
- `jules.plan.approve`: required `sessionId`. The registered command opens a
  modal choice and sends the request only after the human selects `Approve
  plan`. A detached or noninteractive host fails with `INTERACTION_REQUIRED`.

Requests time out after 30 seconds and responses are capped at 512 KiB before
JSON parsing. Input and projected output fields have independent byte and item
limits. Redirects are rejected. The provider makes one upstream request and
does not retry automatically. In particular, Jules documents no create-session
idempotency key: a lost response is ambiguous, and retrying creation can create
a second Jules session. Runtime `correlation_id` prevents concurrent workers
and ordinary duplicate dispatch for one detached runtime run. A worker crash
after Jules accepts creation but before the runtime persists completion remains
ambiguous; recovery may invoke creation again. The provider therefore makes no
exact-once claim for the external Jules effect.

Successful create/get operations journal `jules.session_created` or
`jules.session_observed` with only `sessionId`, documented `state`, and an
optional canonical Jules URL. Each validated PR produces
`jules.pull_request_observed` with its canonical GitHub URL, owner, repository
and number. Approval produces `jules.plan_approved`. Stable provider failures
produce `jules.request_failed` with the operation and error code, plus the
optional `sessionId` only when it was already validated. Normal run, intent and
step identifiers may also be present. These closed per-event projections pass
through `run_logs`; their event IDs and cursors inherit the normal stable
run-log contract.

Provider errors expose only stable codes and fixed messages:
`JULES_NOT_CONFIGURED`, `JULES_REQUEST_INVALID`,
`JULES_PLAN_APPROVAL_REQUIRED`, `JULES_AUTH_FAILED`, `JULES_NOT_FOUND`,
`JULES_RATE_LIMITED`, `JULES_INVALID_STATE`, `JULES_UNAVAILABLE`,
`JULES_UPSTREAM_ERROR`, `JULES_RESPONSE_INVALID`,
`JULES_RESPONSE_TOO_LARGE`, and `JULES_TIMEOUT`. Upstream response bodies are
never copied into errors. The official API documents session deletion but no
cancel operation, so this provider does not expose deletion as cancellation.

Official contract references: [quickstart](https://jules.google/docs/api/reference/),
[authentication](https://jules.google/docs/api/reference/authentication/),
[sessions](https://jules.google/docs/api/reference/sessions),
[activities](https://jules.google/docs/api/reference/activities), and
[sources](https://jules.google/docs/api/reference/sources).

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
