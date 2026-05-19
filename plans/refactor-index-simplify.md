# Refactor `extensions/index.ts` and simplify workflow execution

## Context

`extensions/index.ts` is currently ~2,895 lines and mixes workflow schema validation, slash-command registration, subagent bridge handling, context/fork fallback behavior, composite workflow execution, live UI rendering, message persistence, and tests-facing helper exports in one file.

The goal is to keep **one Pi extension** and the core ability to run named workflows, while making the implementation substantially smaller, easier to review, and less feature-heavy. The user specifically wants to remove non-essential Pi subagent orchestration features such as worktree execution and custom context handling unless they are crucial to baseline workflow execution.

Initial scan findings:

- Runtime/workflow context knobs are spread through types, schema validation, runtime flag parsing, simple execution, composite execution, docs, examples, and tests.
- Worktree support is only passed through to subagents and has special validation/errors for composite workflows.
- Fork fallback/session-persistence support accounts for a large amount of complexity in both simple and composite paths.
- Composite workflow execution adds its own scheduler, nested workflow lookup, fail-fast semantics, aggregation, recursion limits, and result merging because `pi-subagents` only knows agent runnables, not named workflow runnables.
- README and example workflows currently document/use `context`, `forkFallback`, `agentScope`, and `failFast`.
- The current example workflows use `context: "fresh"`, `clarify: false`, and `agentScope: "both"`; `oracle-review` uses `context: "fork"` and `forkFallback: "error"`, which conflicts with the new simpler/default-context direction.

## Approach

Recommended direction: define a much smaller v2 workflow surface, then remove unsupported fields and code paths before splitting the remaining implementation into focused modules. Based on user feedback, workflows should omit subagent context controls entirely and let `pi-subagents` use its default/current behavior.

Baseline behavior to preserve:

- One extension registration entrypoint.
- Workflow discovery from user and project workflow directories.
- `/workflow <name> ...`, `/workflow --list`, and direct commands for user workflows.
- JSON/JSONC workflow parsing with strict unknown-field validation.
- Core workflow shapes: single `agent` + `task`, top-level `tasks`, and `chain` with optional parallel steps.
- Nested workflow runnables in chains/parallel steps as simple composition: `{ "workflow": "name", "args": "{{args}}" }`.
- Template variables for args/positionals/cwd/previous/task/chain_dir if still supported by the simplified execution model.
- Explicit `model` override support on agent steps; model overrides are an important reason for the project.
- `skill`/`skills` injection as a lightweight agent override, since it does not drive the context/worktree complexity being removed.
- `failFast` for parallel groups.
- Live progress/result rendering, but only if it can be kept modular and low-complexity.

Confirmed removals:

- `context`, `forkFallback`, `--fork`, `--fresh`, fork persistence, and fork retry logic.
- `worktree` and `--worktree`.
- `cwd`, `--cwd`, `chainDir`, and `--chain-dir` as subagent execution overrides. `{{cwd}}` can remain as a template variable for task text.
- `agentScope` and `--agent-scope`; use the extension's normal user+project workflow lookup and subagents' default agent lookup behavior.
- `clarify` and `--clarify`.
- `async`, `--async`, and `--bg`; CI/GitHub Actions should use synchronous default execution.
- Per-step `output`, `reads`, `progress`, and `count`.
- `modelPolicy`; explicit `model` fields are allowed, absent `model` means the agent's default model is used.

Keep/simplify:

- `failFast`, per user preference, with a simple default: parallel groups stop on first failure unless `failFast: false` is set to collect all child output.
- Nested workflow runnables, interpreted as “execute these other workflows and agents,” but strip away per-child context/cwd/scope/worktree/async behavior. The runner should be a simple workflow interpreter rather than a feature-complete subagent orchestration layer.
- Model overrides on agent steps.

After feature removal, split the remaining code into focused files while still exporting a single extension:

- `extensions/index.ts` — small registration entrypoint.
- `extensions/workflow-schema.ts` — types, JSONC stripping, validation, loading/discovery.
- `extensions/templates.ts` — arg splitting and template rendering.
- `extensions/subagent-bridge.ts` — request/update/response event bridge.
- `extensions/workflow-runner.ts` — builds subagent params and executes a workflow.
- `extensions/rendering.ts` — message renderers/widgets/fallback lines.
- `extensions/messages.ts` — send/persist workflow progress/result messages if still needed.

Target outcome for `extensions/index.ts`: only imports/registers modules and should be small enough to review at a glance.

## Files to modify

- `extensions/index.ts`
- Potential new module files under `extensions/`
- `tests/workflows.test.ts`
- `README.md`
- `examples/workflows/*.jsonc`

## Reuse

Existing code to preserve or move rather than rewrite:

- `stripJsonComments` from `extensions/index.ts`
- Workflow discovery/loading: `workflowDirs`, `parseWorkflowFile`, `loadWorkflows`
- Strict validation helpers: `assertKnownKeys`, `assertString`, `assertOptional*`
- Arg parsing/template rendering: `splitArgs`, `renderTemplate`, `renderCompositeTemplate` if composite behavior remains
- Slash bridge: `requestSubagentRun`
- Command registration: `registerWorkflowCommand`, default `registerPiWorkflows`
- Rendering fallback safety: `safeComponent`, `safeBuildComponent`, result/progress renderer functions if retained

## Final simplified workflow surface

Top-level workflow fields:

- `name` — required command/workflow name.
- `description` — optional command/list description.
- `defaultAgent` — optional default for agent runnables that omit `agent`.
- `skill` / `skills` — optional workflow-level skill injection/default.
- Exactly one execution shape:
  - `agent` + `task` for a single agent workflow.
  - `tasks` for top-level parallel agent tasks.
  - `chain` for sequential steps.

Agent runnable fields:

- `agent` — required unless `defaultAgent` applies.
- `task` — optional in chain contexts where previous/default task behavior applies; required for single-agent workflows.
- `model` — optional explicit model override.
- `skill` / `skills` — optional per-runnable skill override/addition.

Workflow runnable fields:

- `workflow` — named workflow to execute.
- `args` — optional argument template; defaults to current `{{args}}`.

Parallel step fields:

- `parallel` — non-empty array of agent/workflow runnables.
- `failFast` — optional boolean; default `true`, set `false` to collect failed child output and continue.

Removed fields should be rejected as unknown fields rather than silently ignored because there is no compatibility requirement.

## Steps

- [x] Add the new module layout and move reusable code out of `extensions/index.ts` without changing behavior first where practical.
- [x] Replace workflow types/schema with the simplified surface above and strict unknown-field errors for removed fields.
- [x] Remove runtime flag parsing for unsupported flags; keep only workflow name + args handling and simple positional parsing.
- [x] Simplify subagent param construction so emitted params omit `context`, `worktree`, `cwd`, `chainDir`, `agentScope`, `clarify`, `async`, `output`, `reads`, and `progress`.
- [x] Remove `modelPolicy` validation and allow explicit `model` fields on agent runnables.
- [x] Delete fork fallback/session-persistence code tied only to forked context dispatch/retry.
- [x] Keep nested workflow execution but simplify it to default-context recursive execution with only `args` templating and `failFast` behavior.
- [x] Simplify parallel execution: support `failFast` only; remove `count`, worktree propagation, and per-child context/scope policy.
- [x] Keep or simplify progress/result renderers after the runner API shrinks; avoid preserving fork/context details in displayed params.
- [x] Rewrite tests around the new smaller API and delete tests for removed features.
- [x] Update README and examples to match the reduced workflow schema, including removing `oracle-review` fork-specific guidance or converting/removing that example.

## Verification

- Run `npm test`.
- Manually test `/workflow --list`.
- Manually run a single-agent workflow with and without a `model` override.
- Manually run a chain workflow with a parallel agent step and `failFast: false`.
- Manually run a workflow that invokes another workflow runnable.
- Confirm removed legacy fields fail with clear validation errors.
- Check the rendered progress/result output remains readable in the Pi UI.

## Decisions

- “Runs in existing context” means omit `context` and let `pi-subagents` use its default behavior.
- Breaking schema cleanup is allowed; no deprecation or backward compatibility layer is needed.
- Keep `failFast`.
- Keep model override support on agent steps.
- Remove `modelPolicy`; explicit `model` is allowed, absent `model` uses the agent default.
- Remove `async`/`--bg`; this is interactive background/fire-and-forget behavior and does not help GitHub Actions, which should use synchronous execution.
- Remove `clarify`, `output`, `reads`, `progress`, and `count`.
- Keep nested workflow runnables, but only as simple composition with default execution behavior.
