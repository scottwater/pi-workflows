# Workflow Composition Plan

## Context

`pi-workflows` currently turns each workflow file into a single `pi-subagents` request via `buildSubagentParams(...)` and `requestSubagentRun(...)`. This works well for single-agent, top-level parallel task, and chain workflows where every executable item is an agent/subagent step.

The desired capability is to let a workflow compose other workflows alongside ordinary agent steps, for example running `review-agents`, `keystone`, and a security review in parallel, then synthesizing their final outputs in one parent workflow.

Key existing behavior to preserve:

- Workflow files are JSON/JSONC under `~/.pi/agent/workflows/` or `.pi/workflows/`.
- `parseWorkflowFile(...)` validates schemas strictly and rejects unknown fields.
- `defaultAgent` can fill in omitted `agent` fields for agent steps/tasks.
- `skill`/`skills` can be set at workflow or step/task level.
- Model overrides are rejected under `modelPolicy: "agent"`.
- `runWorkflow(...)` handles runtime flags, fork fallback, UI progress/result messages, and final error propagation.
- `requestSubagentRun(...)` is the reusable bridge for launching a `pi-subagents` request and receiving progress/results.

## Approach

Add first-class workflow-composition syntax to the existing `chain` and `parallel` concepts rather than creating a separate `parallelWorkflows` feature.

Recommended mental model:

> A workflow chain is a sequence of runnable steps. A runnable can be an agent step, a workflow step, or a parallel group containing either agents or workflows.

Example target format:

```jsonc
{
  "name": "quality-sweep",
  "context": "fresh",
  "chain": [
    {
      "parallel": [
        { "workflow": "review-agents", "args": "{{args}}" },
        { "workflow": "keystone", "args": "{{args}}" },
        {
          "agent": "skill-delegate",
          "skills": ["security-review"],
          "task": "Run security review for:\n\n{{args}}"
        }
      ],
      "failFast": false
    },
    {
      "agent": "review-synthesizer",
      "task": "Synthesize these review streams into one prioritized report:\n\n{{previous}}"
    }
  ]
}
```

Implementation should split execution into two paths:

1. **Simple workflows**: no nested workflow steps. Continue using the existing `buildSubagentParams(...)` → `requestSubagentRun(...)` path unchanged.
2. **Composite workflows**: contain one or more `workflow` steps. Execute directly inside `pi-workflows` with a small orchestrator that can run agent steps through `requestSubagentRun(...)`, nested workflow steps through the same workflow runner, aggregate outputs, and feed `{{previous}}` into later steps.

This keeps common workflows efficient while allowing composition only when needed.

## Files to modify

- `extensions/index.ts`
  - Add runnable-step types and validation.
  - Add composition detection.
  - Add composite execution helpers.
  - Extend progress/result formatting for nested workflow runs.
- `tests/workflows.test.ts`
  - Add parser, execution, failure, recursion, and aggregation tests.
- `README.md`
  - Document mixed agent/workflow syntax and semantics.
- `examples/workflows/*.jsonc`
  - Add an example `quality-sweep`/meta-review workflow after the feature is implemented.

## Reuse

Existing code and utilities to reuse:

- `parseWorkflowFile(...)` and strict key validation patterns in `extensions/index.ts`.
- `loadWorkflows(...)` for finding nested workflow definitions with project-over-user precedence.
- `renderTemplate(...)` and `renderMaybeString(...)` for `{{args}}`, `{{previous}}`, `{{task}}`, and `{{chain_dir}}` replacement.
- `requestSubagentRun(...)` for all agent/subagent execution.
- `extractSuccessText(...)`, `extractErrorText(...)`, `formatResponseText(...)`, and result-message rendering code for final output extraction.
- Existing `runWorkflow(...)` UI progress/result infrastructure, especially workflow result cards and fork fallback behavior.
- Existing test helpers: `createEvents()`, `createCtx()`, and fake `REQUEST_EVENT` response handlers in `tests/workflows.test.ts`.

## Proposed design details

### 1. Types and schema

Introduce a union like:

```ts
type AgentRunnable = SequentialStep;

type WorkflowRunnable = {
  workflow: string;
  args?: string;
};

type Runnable = AgentRunnable | WorkflowRunnable;

type ParallelStep = {
  parallel: Runnable[];
  concurrency?: number;
  failFast?: boolean;
  worktree?: boolean; // applies only to agent runnables or rejected when workflows are present
};

type ChainStep = Runnable | ParallelStep;
```

Validation rules:

- A runnable must define exactly one of `agent` or `workflow`.
- `workflow` must be a non-empty string.
- `args` defaults to `{{args}}` for workflow steps.
- `defaultAgent` applies only to agent runnables, not workflow runnables.
- Unknown fields remain rejected.
- Do not support per-nested-workflow overrides for `context`, `cwd`, `agentScope`, `clarify`, or `async` in v1; parent workflow settings and parent runtime flags control the whole composition.
- Reject nested `async: true` workflow behavior in v1 by not including an `async` field on workflow runnables; nested workflows must complete inline so their final text can be aggregated.
- Reject `worktree: true` on a parallel group that includes workflow runnables in v1. Worktree isolation is valuable, but mixed nested workflow semantics would be ambiguous because each child workflow may launch multiple subagents.

### 2. Composition detection

Add `workflowContainsNestedWorkflow(workflow)`.

- If false, existing `runWorkflow(...)` behavior stays the same.
- If true, `runWorkflow(...)` calls a new composite executor.

### 3. Composite executor

Add a helper such as:

```ts
async function executeWorkflowComposite(ctx, workflow, args, options): Promise<WorkflowExecutionResult>
```

It should:

- Track a workflow stack to prevent recursion.
- Render runtime args once using existing `extractRuntimeFlags(...)` at the top-level call.
- For each chain step:
  - Agent runnable: convert to a one-step `SubagentParamsLike` and call `requestSubagentRun(...)`.
  - Workflow runnable: load the named workflow via `loadWorkflows(effectiveCwd, ..., scopes)`, execute it recursively, and return only its final meaningful text.
  - Parallel group: run all runnables concurrently up to `concurrency`, then aggregate outputs.
- Build labeled `previous` text in deterministic order, e.g.:

```text
=== Workflow: review-agents ===
...

=== Workflow: keystone ===
...

=== Agent: skill-delegate ===
...
```

- Apply `failFast`:
  - `true`: abort on first failed runnable.
  - `false`: include failed runnable output/error in the aggregate and allow a later synthesizer to report it.

### 4. Template behavior

For composite execution, `{{previous}}` should be resolved by the `pi-workflows` executor before launching the next runnable, because `pi-subagents` will not own the whole mixed chain.

Need to distinguish two template modes:

- Existing simple mode: `{{previous}}` converts to `{previous}` for `pi-subagents` chain execution.
- Composite mode: `{{previous}}` becomes the actual aggregate text from prior step(s).

### 5. Nested workflow lookup and runtime flags

Nested workflow steps should use existing workflow discovery precedence:

- project `.pi/workflows/` overrides user `~/.pi/agent/workflows/`.
- respect parent `--cwd` / workflow `cwd` when resolving project workflows.

Parent settings and runtime flags win for the whole composition:

- `--cwd`, `--agent-scope`, and top-level `--fresh`/`--fork` apply to all nested workflow launches.
- Nested workflow steps do not accept per-step overrides for `context`, `cwd`, `agentScope`, or `clarify` in v1. This avoids conflicting execution modes between child workflows in the same parent sweep.
- Nested workflow file defaults apply only where the parent has not already selected a value.

### 6. UI/progress

V1 should keep progress simple:

- Parent workflow result card shows the final composite output.
- Nested agent/workflow runs can reuse existing `requestSubagentRun(...)` progress updates, but request IDs should include enough context in labels/messages to make debugging possible.
- Avoid dumping every nested child progress event into `{{previous}}`; only final text is aggregated.

Potential later improvement: a tree-style live widget for composite workflows.

### 7. Recursion guard

Track workflow names/source paths in a stack:

- Support only one nested workflow level in v1: a top-level workflow may call child workflows, but child workflows may not call additional workflows.
- Reject direct recursion: `quality-sweep` calls `quality-sweep`.
- Reject indirect recursion defensively even though one nested level should prevent it.
- Keep deeper nesting as a future enhancement only if real usage needs it.

### 8. Example workflow

Add an example once the implementation is complete:

```jsonc
{
  "name": "quality-sweep",
  "description": "Run code review, Keystone behavior-risk review, and security review, then synthesize",
  "context": "fresh",
  "chain": [
    {
      "parallel": [
        { "workflow": "review-agents", "args": "{{args}}" },
        { "workflow": "keystone", "args": "{{args}}" },
        { "workflow": "security-review", "args": "{{args}}" }
      ],
      "failFast": false
    },
    {
      "agent": "review-synthesizer",
      "task": "Synthesize these review workflows into one prioritized report:\n\n{{previous}}"
    }
  ]
}
```

## Steps

- [x] Finalize syntax and semantics with the user.
- [x] Refactor workflow types to support `AgentRunnable | WorkflowRunnable | ParallelStep`.
- [x] Update schema validation with strict field checks for workflow runnables.
- [x] Add composition detection so simple workflows keep the existing fast path.
- [x] Add result extraction helper returning `{ ok, text, errorText, details }` without immediately sending the final workflow card for nested calls.
- [x] Implement sequential composite execution with agent runnables and workflow runnables.
- [x] Implement parallel composite execution with deterministic aggregation and `failFast` behavior.
- [x] Add recursion/depth guard.
- [x] Integrate composite execution into `runWorkflow(...)` while preserving existing UI result/error behavior.
- [x] Document mixed agent/workflow syntax in `README.md`.
- [x] Add at least one example meta-workflow.

## Verification

Automated tests:

- Parser accepts `workflow` runnables in `chain` and `parallel` groups.
- Parser rejects steps with both `agent` and `workflow`.
- Parser rejects unknown fields on workflow runnables.
- Simple existing workflows still build identical `SubagentParamsLike` output.
- A composite workflow can run an agent step followed by another agent step using actual `{{previous}}` text.
- A composite workflow can run a nested workflow and aggregate its final output.
- A parallel mixed group runs agent and workflow runnables and preserves deterministic aggregate order.
- `failFast: true` aborts on first failure; `failFast: false` aggregates failures for synthesis.
- Direct and indirect recursive workflow references are rejected.
- A child workflow that itself contains workflow runnables is rejected in v1.
- Parent runtime flags (`--cwd`, `--fresh`, `--fork`, `--agent-scope`) control nested workflow execution.
- Workflow runnables reject unsupported override fields such as `context`, `cwd`, `agentScope`, `clarify`, `async`, and `worktree`.

Manual checks:

- Install example workflows and run a simple meta-workflow via `/workflow quality-sweep current diff`.
- Confirm live UI does not become noisy or misleading.
- Confirm final result card contains only the synthesized output, not raw progress logs.
- Confirm failures are visible and actionable when one child workflow fails.

## Decisions

- Parent workflow settings and parent runtime flags win for the whole composition. Nested workflow steps do not override `context`, `cwd`, `agentScope`, or `clarify` in v1.
- `failFast: false` passes failed child workflow text/errors into the aggregate so the synthesizer can still produce a useful report.
- Nested workflows run inline in v1; do not support nested/background `async` workflow execution until lifecycle semantics are explicitly designed.
- Reject `worktree: true` on parallel groups that include workflow runnables in v1. This avoids ambiguous isolation semantics for child workflows that may launch multiple subagents.
- Support one nested workflow level in v1.
