import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import type {
  AgentRunnable,
  ChainStep,
  ParallelStep,
  Runnable,
  SkillSpec,
  Workflow,
  WorkflowLoadWarning,
  WorkflowRunnable,
} from "./types.ts";

export type WorkflowScope = "user" | "project";

function nextSignificantJsoncChar(input: string, start: number): string | undefined {
  for (let index = start; index < input.length; index += 1) {
    const char = input[index];
    const next = input[index + 1];
    if (/\s/.test(char)) continue;
    if (char === "/" && next === "/") {
      index += 2;
      while (index < input.length && input[index] !== "\n" && input[index] !== "\r") index += 1;
      index -= 1;
      continue;
    }
    if (char === "/" && next === "*") {
      index += 2;
      while (index < input.length && !(input[index] === "*" && input[index + 1] === "/")) index += 1;
      index += 1;
      continue;
    }
    return char;
  }
  return undefined;
}

export function stripJsonComments(input: string): string {
  let output = "";
  let inString = false;
  let quote = "";
  let escaped = false;
  let inLineComment = false;
  let inBlockComment = false;

  for (let index = 0; index < input.length; index += 1) {
    const char = input[index];
    const next = input[index + 1];

    if (inLineComment) {
      if (char === "\n" || char === "\r") {
        inLineComment = false;
        output += char;
      }
      continue;
    }
    if (inBlockComment) {
      if (char === "*" && next === "/") {
        inBlockComment = false;
        index += 1;
      } else if (char === "\n" || char === "\r") {
        output += char;
      }
      continue;
    }
    if (inString) {
      output += char;
      if (escaped) {
        escaped = false;
      } else if (char === "\\") {
        escaped = true;
      } else if (char === quote) {
        inString = false;
        quote = "";
      }
      continue;
    }

    if (char === '"' || char === "'") {
      inString = true;
      quote = char;
      output += char;
      continue;
    }
    if (char === "/" && next === "/") {
      inLineComment = true;
      index += 1;
      continue;
    }
    if (char === "/" && next === "*") {
      inBlockComment = true;
      index += 1;
      continue;
    }
    if (char === ",") {
      const nextChar = nextSignificantJsoncChar(input, index + 1);
      if (nextChar === "}" || nextChar === "]") continue;
    }
    output += char;
  }

  return output;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function describeField(path: string, field: string): string {
  return path.endsWith("]") ? `${path}.${field}` : `${path}.${field}`;
}

function assertKnownKeys(value: Record<string, unknown>, fieldPath: string, allowed: readonly string[]): void {
  const allowedSet = new Set(allowed);
  for (const key of Object.keys(value)) {
    if (!allowedSet.has(key)) throw new Error(`${fieldPath}.${key} is not supported.`);
  }
}

function assertString(value: unknown, fieldPath: string): string {
  if (typeof value !== "string") throw new Error(`${fieldPath} must be a string.`);
  return value;
}

function assertOptionalString(value: unknown, fieldPath: string): string | undefined {
  if (value === undefined) return undefined;
  return assertString(value, fieldPath);
}

function assertOptionalNonEmptyString(value: unknown, fieldPath: string): string | undefined {
  const str = assertOptionalString(value, fieldPath)?.trim();
  if (str === undefined) return undefined;
  if (!str) throw new Error(`${fieldPath} must be a non-empty string.`);
  return str;
}

function assertOptionalBoolean(value: unknown, fieldPath: string): boolean | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "boolean") throw new Error(`${fieldPath} must be a boolean.`);
  return value;
}

function splitSkillString(value: string, fieldPath: string): string[] {
  const tokens = value.split(",").map((entry) => entry.trim());
  if (tokens.length === 0 || tokens.some((entry) => !entry)) {
    throw new Error(`${fieldPath} must include at least one non-empty skill name and must not contain empty comma-separated entries.`);
  }
  return tokens;
}

function assertOptionalSkill(value: unknown, fieldPath: string): SkillSpec | undefined {
  if (value === undefined) return undefined;
  if (value === false) return false;
  if (typeof value === "string") {
    const tokens = splitSkillString(value, fieldPath);
    return tokens.length === 1 ? tokens[0] : tokens;
  }
  if (Array.isArray(value)) {
    if (value.length > 0 && value.every((entry) => typeof entry === "string" && entry.trim())) {
      return value.map((entry) => entry.trim());
    }
    throw new Error(`${fieldPath} must include at least one non-empty skill name.`);
  }
  throw new Error(`${fieldPath} must be false, a non-empty string, or a non-empty array of non-empty strings.`);
}

function normalizeSkillAlias(value: Record<string, unknown>, fieldPath: string): SkillSpec | undefined {
  if (value.skill !== undefined && value.skills !== undefined) {
    throw new Error(`${fieldPath} must not define both skill and skills.`);
  }
  return value.skill !== undefined
    ? assertOptionalSkill(value.skill, `${fieldPath}.skill`)
    : assertOptionalSkill(value.skills, `${fieldPath}.skills`);
}

function stepAgent(value: Record<string, unknown>, fieldPath: string, defaultAgent: string | undefined): string {
  const agent = assertOptionalNonEmptyString(value.agent, `${fieldPath}.agent`);
  if (agent) return agent;
  if (defaultAgent) return defaultAgent;
  throw new Error(`${fieldPath}.agent must be a non-empty string or workflow.defaultAgent must be set.`);
}

const WORKFLOW_KEYS = [
  "name", "description", "defaultAgent", "skill", "skills", "readOnly", "chain", "tasks", "agent", "task", "model",
] as const;
const AGENT_RUNNABLE_KEYS = ["agent", "task", "model", "skill", "skills", "readOnly"] as const;
const WORKFLOW_RUNNABLE_KEYS = ["workflow", "args"] as const;
const PARALLEL_STEP_KEYS = ["parallel", "failFast"] as const;

function stripUndefined<T extends Record<string, unknown>>(value: T): T {
  for (const key of Object.keys(value) as Array<keyof T>) {
    if (value[key] === undefined) delete value[key];
  }
  return value;
}

function validateAgentRunnable(value: unknown, fieldPath: string, defaultAgent?: string): AgentRunnable {
  if (!isRecord(value)) throw new Error(`${fieldPath} must be an object.`);
  assertKnownKeys(value, fieldPath, AGENT_RUNNABLE_KEYS);
  return stripUndefined({
    agent: stepAgent(value, fieldPath, defaultAgent),
    task: assertOptionalString(value.task, `${fieldPath}.task`),
    model: assertOptionalString(value.model, `${fieldPath}.model`),
    skill: normalizeSkillAlias(value, fieldPath),
    readOnly: assertOptionalBoolean(value.readOnly, `${fieldPath}.readOnly`),
  });
}

function validateWorkflowRunnable(value: Record<string, unknown>, fieldPath: string): WorkflowRunnable {
  assertKnownKeys(value, fieldPath, WORKFLOW_RUNNABLE_KEYS);
  const workflow = assertString(value.workflow, `${fieldPath}.workflow`).trim();
  if (!workflow) throw new Error(`${fieldPath}.workflow must be a non-empty string.`);
  return stripUndefined({
    workflow,
    args: assertOptionalString(value.args, `${fieldPath}.args`),
  });
}

function validateRunnable(value: unknown, fieldPath: string, defaultAgent?: string): Runnable {
  if (!isRecord(value)) throw new Error(`${fieldPath} must be an object.`);
  const hasWorkflow = value.workflow !== undefined;
  const hasAgent = value.agent !== undefined;
  if (hasWorkflow && hasAgent) throw new Error(`${fieldPath} must define either agent or workflow, not both.`);
  return hasWorkflow ? validateWorkflowRunnable(value, fieldPath) : validateAgentRunnable(value, fieldPath, defaultAgent);
}

function validateChainStep(value: unknown, fieldPath: string, defaultAgent?: string): ChainStep {
  if (!isRecord(value)) throw new Error(`${fieldPath} must be an object.`);
  if ("parallel" in value) {
    assertKnownKeys(value, fieldPath, PARALLEL_STEP_KEYS);
    if (!Array.isArray(value.parallel)) throw new Error(`${fieldPath}.parallel must be an array.`);
    if (value.parallel.length === 0) throw new Error(`${fieldPath}.parallel must not be empty.`);
    return stripUndefined({
      parallel: value.parallel.map((task, index) => validateRunnable(task, `${fieldPath}.parallel[${index}]`, defaultAgent)),
      failFast: assertOptionalBoolean(value.failFast, `${fieldPath}.failFast`),
    } satisfies ParallelStep);
  }
  return validateRunnable(value, fieldPath, defaultAgent);
}

export function parseWorkflowFile(path: string): Workflow | undefined {
  const raw = readFileSync(path, "utf8");
  const parsed = JSON.parse(stripJsonComments(raw)) as unknown;
  if (!isRecord(parsed)) throw new Error(`Workflow ${path} must be a JSON object.`);
  assertKnownKeys(parsed, `Workflow ${path}`, WORKFLOW_KEYS);

  const name = assertString(parsed.name, `Workflow ${path} name`).trim();
  if (!name) throw new Error(`Workflow ${path} name must be a non-empty string.`);
  const workflowPath = `Workflow ${name}`;
  const defaultAgent = assertOptionalNonEmptyString(parsed.defaultAgent, `${workflowPath}.defaultAgent`);

  const chain = parsed.chain === undefined
    ? undefined
    : (() => {
      if (!Array.isArray(parsed.chain)) throw new Error(`${workflowPath}.chain must be an array.`);
      if (parsed.chain.length === 0) throw new Error(`${workflowPath}.chain must not be empty.`);
      return parsed.chain.map((step, index) => validateChainStep(step, describeField(workflowPath, `chain[${index}]`), defaultAgent));
    })();

  const tasks = parsed.tasks === undefined
    ? undefined
    : (() => {
      if (!Array.isArray(parsed.tasks)) throw new Error(`${workflowPath}.tasks must be an array.`);
      if (parsed.tasks.length === 0) throw new Error(`${workflowPath}.tasks must not be empty.`);
      return parsed.tasks.map((task, index) => validateAgentRunnable(task, describeField(workflowPath, `tasks[${index}]`), defaultAgent));
    })();

  const agent = assertOptionalNonEmptyString(parsed.agent, `${workflowPath}.agent`);
  const task = assertOptionalString(parsed.task, `${workflowPath}.task`);
  const executionShapeCount = Number(Boolean(chain)) + Number(Boolean(tasks)) + Number(Boolean(agent || task));
  if (executionShapeCount !== 1) throw new Error(`Workflow ${name} must define exactly one of: chain, tasks, or agent+task.`);
  if ((agent && task === undefined) || (!agent && task !== undefined)) {
    throw new Error(`Workflow ${name} single-task workflows must define both string agent and string task.`);
  }
  if ((chain || tasks) && parsed.model !== undefined) {
    throw new Error(`${workflowPath}.model is only supported for single-agent workflows. Put model on individual agent runnables in chain/tasks workflows.`);
  }

  return stripUndefined({
    name,
    description: assertOptionalString(parsed.description, `${workflowPath}.description`),
    defaultAgent,
    skill: normalizeSkillAlias(parsed, workflowPath),
    readOnly: assertOptionalBoolean(parsed.readOnly, `${workflowPath}.readOnly`),
    chain,
    tasks,
    agent,
    task,
    model: assertOptionalString(parsed.model, `${workflowPath}.model`),
    sourcePath: path,
  });
}

function workflowHome(): string {
  return process.env.HOME || process.env.USERPROFILE || homedir();
}

function workflowDirs(cwd: string): Array<{ dir: string; scope: WorkflowScope }> {
  return [
    { dir: join(workflowHome(), ".pi", "agent", "workflows"), scope: "user" },
    { dir: join(cwd, ".pi", "workflows"), scope: "project" },
  ];
}

function workflowNameFromFilename(path: string): string | undefined {
  const file = basename(path);
  const name = file
    .replace(/\.workflow\.json$/i, "")
    .replace(/\.jsonc?$/i, "")
    .trim();
  return name || undefined;
}

function extractWorkflowNameCandidate(path: string): string | undefined {
  try {
    const raw = stripJsonComments(readFileSync(path, "utf8"));
    const match = raw.match(/["']name["']\s*:\s*["']([^"']+)["']/);
    const name = match?.[1]?.trim();
    return name || workflowNameFromFilename(path);
  } catch {
    return workflowNameFromFilename(path);
  }
}

export function loadWorkflows(
  cwd: string,
  warnings: WorkflowLoadWarning[] = [],
  logWarnings = true,
  scopes: WorkflowScope[] = ["user", "project"],
): Workflow[] {
  const byName = new Map<string, Workflow>();
  const includedScopes = new Set<WorkflowScope>(scopes);
  const validProjectNames = new Set<string>();

  for (const { dir, scope } of workflowDirs(cwd)) {
    if (!includedScopes.has(scope) || !existsSync(dir)) continue;
    let files: string[];
    try {
      if (!statSync(dir).isDirectory()) throw new Error("workflow path exists but is not a directory");
      files = readdirSync(dir).sort();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      warnings.push({ path: dir, error: `${scope} workflow directory could not be read: ${message}` });
      if (logWarnings) console.warn(`pi-workflows: skipped workflow directory ${dir}: ${message}`);
      continue;
    }

    for (const file of files) {
      if (!file.endsWith(".json") && !file.endsWith(".jsonc") && !file.endsWith(".workflow.json")) continue;
      const path = join(dir, file);
      try {
        const workflow = parseWorkflowFile(path);
        if (!workflow) continue;
        if (scope === "project") validProjectNames.add(workflow.name);
        byName.set(workflow.name, workflow);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        warnings.push({ path, error: message });
        if (scope === "project") {
          const shadowedName = extractWorkflowNameCandidate(path);
          if (shadowedName && !validProjectNames.has(shadowedName)) byName.delete(shadowedName);
        }
        if (logWarnings) console.warn(`pi-workflows: skipped invalid workflow ${path}: ${message}`);
      }
    }
  }

  return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
}
