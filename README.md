# pi-workflows

Named slash-command workflows for launching [`pi-subagents`](https://github.com/nicobailon/pi-subagents) agents and simple workflow compositions.

`pi-workflows` intentionally keeps the workflow surface small: define named workflows, run agents in sequence or parallel, optionally call another workflow, and let `pi-subagents` use its default execution context.

## Install

```bash
pi install https://github.com/scottwater/pi-workflows.git
```

Restart Pi or run `/reload`.

> Requires `pi-subagents` to be installed and loaded.

## Where workflows live

Workflows are JSON/JSONC files ending in `.json` or `.jsonc`.

| Scope | Directory |
|---|---|
| Global/user | `~/.pi/agent/workflows/` |
| Project | `<repo>/.pi/workflows/` |

Project workflows override global workflows with the same `name`.

Direct slash commands are registered for global/user workflows. Project workflows are discovered through `/workflow <name> ...` and also override a same-named global command when that command is invoked from the project cwd.

## Usage

```text
/review-agents current git diff
/review-deep changes since main
/quality-sweep current branch
```

Generic runner:

```text
/workflow review-agents current git diff
/workflow --list
```

Workflow arguments are passed through as normal task text. There are no runtime context/worktree flags; values like `--fork` or `--worktree` are treated as ordinary arguments.

While a workflow runs in the TUI, `pi-workflows` shows a compact live widget with current agents/tools when Pi's widget surface is available. Final result cards can be expanded with Pi's normal message expansion keybinding to inspect per-agent output and failures.

## Workflow format

Minimal multi-agent review workflow:

```jsonc
{
  "name": "review-agents",
  "description": "Multi-agent code review",
  "readOnly": true,
  "chain": [
    {
      "parallel": [
        {
          "agent": "skeptical-engineer",
          "task": "Review skeptically. Scope: {{args}}"
        },
        {
          "agent": "code-reviewer",
          "task": "Review correctness and guidelines. Scope: {{args}}"
        }
      ],
      "failFast": false
    },
    {
      "agent": "review-synthesizer",
      "task": "Synthesize these outputs:\n\n{{previous}}"
    }
  ]
}
```

Supported top-level fields:

- `name` — required workflow/command name.
- `description` — optional text shown in command help and `/workflow --list`.
- `defaultAgent` — optional default agent for agent runnables that omit `agent`.
- `skill` / `skills` — optional workflow-level skill injection/default.
- `readOnly` — optional boolean. When `true`, agent tasks in this workflow and nested child workflows are prefixed with an explicit review-only/no-edit instruction before delegation. Use this for audit/review/report workflows whose child output may include words like “fix”, “add tests”, or “update code”; it prevents pi-subagents' completion guard from treating synthesis/report tasks as failed implementation tasks.
- Exactly one execution shape:
  - `agent` + `task` — single-agent workflow.
  - `tasks` — top-level parallel agent tasks.
  - `chain` — sequential workflow steps.

Agent runnable fields:

- `agent` — agent name; optional only when `defaultAgent` is set.
- `task` — task template.
- `model` — optional explicit model override. If omitted, the agent's own configured model is used.
- `skill` / `skills` — optional per-runnable skill override/addition. `skill: false` disables a workflow-level skill default for that runnable.
- `readOnly` — optional per-runnable override. Set `false` to opt an agent runnable out of its own workflow's `readOnly: true` default. Inherited read-only policy from a parent workflow cannot be weakened by child workflow settings.

Workflow runnable fields:

- `workflow` — named workflow to run.
- `args` — optional argument template; defaults to the current `{{args}}`.

Parallel step fields:

- `parallel` — non-empty array of agent or workflow runnables.
- `failFast` — optional boolean. Default is `true`, which stops the chain after a failed parallel group. Set `false` to collect failed child output and continue to later synthesis steps.

Unknown workflow, step, or task fields are rejected so typos and removed legacy options fail loudly.

Removed fields include `context`, `forkFallback`, `worktree`, `cwd`, `chainDir`, `agentScope`, `clarify`, `async`, `output`, `reads`, `progress`, `count`, and `modelPolicy`.

## Nested workflow composition

A workflow can execute other workflows alongside normal agents:

```jsonc
{
  "name": "quality-sweep",
  "readOnly": true,
  "chain": [
    {
      "parallel": [
        { "workflow": "review-agents", "args": "{{args}}" },
        { "workflow": "review-deep", "args": "{{args}}" },
        {
          "agent": "skill-delegate",
          "skills": ["security-review"],
          "task": "Run a focused security review for:\n\n{{args}}"
        }
      ],
      "failFast": false
    },
    {
      "agent": "review-synthesizer",
      "task": "Synthesize these review streams:\n\n{{previous}}"
    }
  ]
}
```

Nested workflow execution is deliberately simple: child workflows receive rendered `args` and otherwise use the same default `pi-subagents` behavior as any other workflow. If a parent workflow is `readOnly: true`, that policy is inherited by nested workflows and cannot be weakened by the child workflow or child agent runnable settings.

## Template variables

Supported in task and nested-workflow `args` strings:

- `{{args}}` or `{{$@}}` — full slash-command args.
- `{{1}}`, `{{2}}`, ... — positional args with simple shell-style quoting.
- `{{cwd}}` — invocation cwd.
- `{{previous}}` — previous step/parallel output in composed workflows, or `{previous}` when delegated directly to `pi-subagents`.
- `{{task}}` — original task placeholder for direct `pi-subagents` delegation.

## Examples

Example workflows and agents live under `examples/` only:

```text
examples/workflows/review-agents.jsonc
examples/workflows/review-deep.jsonc
examples/workflows/quality-sweep.jsonc
examples/workflows/oracle-review.jsonc
examples/agents/review-synthesizer.md
examples/agents/skill-delegate.md
```

Install all examples globally:

```bash
./scripts/install-review-examples.sh
```

Or install only the example agents:

```bash
./scripts/install-example-agents.sh
```

Then reload Pi.

## Notes

- Workflows run through the `pi-subagents` slash bridge event protocol, so `pi-subagents` must be loaded in the same Pi session.
- This project intentionally omits worktree and context-management controls. If you need a separate context, use Pi's normal terminal/window/session controls.
- CI/GitHub Actions should use the default synchronous behavior; background/async workflow execution is not part of this reduced API.
