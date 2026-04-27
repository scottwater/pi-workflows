import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import type { ExtensionAPI, ExtensionCommandContext } from "@mariozechner/pi-coding-agent";

type ContextMode = "fresh" | "fork";
type AgentScope = "user" | "project" | "both";
type ModelPolicy = "agent" | "workflow";
type ForkFallback = "fresh" | "error";

type SequentialStep = {
  agent: string;
  task?: string;
  cwd?: string;
  output?: string | false;
  reads?: string[] | false;
  progress?: boolean;
  skill?: string | string[] | false;
  skills?: string[] | false;
  model?: string;
};

type ParallelTask = SequentialStep & { count?: number };

type ParallelStep = {
  parallel: ParallelTask[];
  concurrency?: number;
  failFast?: boolean;
  worktree?: boolean;
};

type ChainStep = SequentialStep | ParallelStep;

type Workflow = {
  name: string;
  description?: string;
  modelPolicy?: ModelPolicy;
  forkFallback?: ForkFallback;
  context?: ContextMode;
  clarify?: boolean;
  async?: boolean;
  worktree?: boolean;
  cwd?: string;
  chainDir?: string;
  agentScope?: AgentScope;
  model?: string;
  chain?: ChainStep[];
  tasks?: ParallelTask[];
  agent?: string;
  task?: string;
  sourcePath: string;
};

type RuntimeFlags = {
  args: string;
  positional: string[];
  context?: ContextMode;
  clarify?: boolean;
  async?: boolean;
  worktree?: boolean;
  cwd?: string;
  chainDir?: string;
  agentScope?: AgentScope;
};

type SubagentParamsLike = {
  agent?: string;
  task?: string;
  model?: string;
  chain?: ChainStep[];
  tasks?: ParallelTask[];
  context?: ContextMode;
  clarify?: boolean;
  async?: boolean;
  worktree?: boolean;
  cwd?: string;
  chainDir?: string;
  agentScope?: AgentScope;
};

type ProgressEntry = {
  index?: number;
  agent?: string;
  status?: string;
  currentTool?: string;
  currentToolArgs?: string;
  recentOutput?: string[];
  recentTools?: Array<{ tool?: string; args?: string }>;
  toolCount?: number;
  tokens?: number;
  durationMs?: number;
  error?: string;
};

type AgentResultEntry = {
  agent?: string;
  task?: string;
  finalOutput?: string;
  error?: string;
  exitCode?: number;
  model?: string;
  sessionFile?: string;
  savedOutputPath?: string;
  artifactPaths?: {
    inputPath?: string;
    outputPath?: string;
    jsonlPath?: string;
    metadataPath?: string;
  };
};

type WorkflowLoadWarning = {
  path: string;
  error: string;
};

type AgentToolResult = {
  content?: Array<{ type?: string; text?: string }>;
  isError?: boolean;
  details?: {
    mode?: string;
    context?: ContextMode;
    progress?: ProgressEntry[];
    results?: AgentResultEntry[];
    asyncId?: string;
    asyncDir?: string;
    artifacts?: { dir?: string };
  };
};

type SlashSubagentResponse = {
  requestId: string;
  result: AgentToolResult;
  isError: boolean;
  errorText?: string;
};

type SlashSubagentUpdate = {
  requestId: string;
  progress?: ProgressEntry[];
  currentTool?: string;
  toolCount?: number;
};

type SlashSubagentTimeouts = {
  startMs?: number;
  responseMs?: number;
};

const SLASH_SUBAGENT_REQUEST_EVENT = "subagent:slash:request";
const SLASH_SUBAGENT_STARTED_EVENT = "subagent:slash:started";
const SLASH_SUBAGENT_RESPONSE_EVENT = "subagent:slash:response";
const SLASH_SUBAGENT_UPDATE_EVENT = "subagent:slash:update";
const SLASH_SUBAGENT_CANCEL_EVENT = "subagent:slash:cancel";
const WORKFLOW_PROGRESS_MESSAGE_TYPE = "pi-workflows-progress";
const WORKFLOW_RESULT_MESSAGE_TYPE = "pi-workflows-result";

const WORKFLOW_LIVE_STATE_TTL_MS = 10 * 60_000;
const WORKFLOW_LIVE_STATE_MAX_ENTRIES = 50;
const workflowLiveStates = new Map<string, WorkflowLiveState>();
const workflowLiveStateTimers = new Map<string, ReturnType<typeof setTimeout>>();

type WorkflowLiveState = {
  workflow: string;
  requestId: string;
  status: "starting" | "running" | "completed" | "failed";
  startedAt: number;
  updatedAt: number;
  progress: ProgressEntry[];
  currentTool?: string;
  toolCount?: number;
};

type WorkflowMessageDetails = {
  workflow?: string;
  sourcePath?: string;
  requestId?: string;
  params?: SubagentParamsLike;
  retry?: string;
  retriedFromFork?: boolean;
  status?: WorkflowLiveState["status"];
  progress?: ProgressEntry[];
  toolCount?: number;
  currentTool?: string;
  isError?: boolean;
  errorText?: string;
  error?: string;
  result?: AgentToolResult;
};

type RenderOptionsLike = { expanded?: boolean };

type RenderMessageLike = {
  content?: unknown;
  details?: unknown;
};

type SessionSnapshotContext = {
  sessionManager?: {
    getSessionFile?: () => string | undefined;
    _rewriteFile?: () => void;
    flushed?: boolean;
  };
};

type WorkflowOutboundMessage = Parameters<ExtensionAPI["sendMessage"]>[0];

function persistWorkflowSessionSnapshot(ctx: SessionSnapshotContext | undefined): void {
  try {
    const sessionManager = ctx?.sessionManager;
    const sessionFile = sessionManager?.getSessionFile?.();
    if (!sessionFile || typeof sessionManager?._rewriteFile !== "function") return;
    mkdirSync(dirname(sessionFile), { recursive: true });
    sessionManager._rewriteFile();
    sessionManager.flushed = true;
  } catch (error) {
    console.error("Failed to persist workflow session snapshot:", error);
  }
}

function sendWorkflowMessage(pi: ExtensionAPI, ctx: SessionSnapshotContext | undefined, message: WorkflowOutboundMessage): void {
  pi.sendMessage(message);
  persistWorkflowSessionSnapshot(ctx);
}

function deleteWorkflowLiveState(requestId: string): void {
  const timer = workflowLiveStateTimers.get(requestId);
  if (timer) clearTimeout(timer);
  workflowLiveStateTimers.delete(requestId);
  workflowLiveStates.delete(requestId);
}

function pruneWorkflowLiveStates(): void {
  while (workflowLiveStates.size > WORKFLOW_LIVE_STATE_MAX_ENTRIES) {
    const terminal = Array.from(workflowLiveStates.values()).find((state) => state.status === "completed" || state.status === "failed");
    const oldest = terminal ?? workflowLiveStates.values().next().value;
    if (!oldest) return;
    deleteWorkflowLiveState(oldest.requestId);
  }
}

function setWorkflowLiveState(state: WorkflowLiveState): void {
  const existingTimer = workflowLiveStateTimers.get(state.requestId);
  if (existingTimer) {
    clearTimeout(existingTimer);
    workflowLiveStateTimers.delete(state.requestId);
  }
  workflowLiveStates.delete(state.requestId);
  workflowLiveStates.set(state.requestId, state);
  if (state.status === "completed" || state.status === "failed") {
    const timer = setTimeout(() => deleteWorkflowLiveState(state.requestId), WORKFLOW_LIVE_STATE_TTL_MS);
    timer.unref?.();
    workflowLiveStateTimers.set(state.requestId, timer);
  }
  pruneWorkflowLiveStates();
}

function snapshotParams(params: SubagentParamsLike | undefined): SubagentParamsLike | undefined {
  return params ? structuredClone(params) : undefined;
}

function resultWithProgress(result: AgentToolResult, progress: ProgressEntry[]): AgentToolResult {
  if (result.details?.progress?.length || progress.length === 0) return result;
  return { ...result, details: { ...result.details, progress } };
}

function nextSignificantJsoncChar(input: string, start: number): string | undefined {
  for (let i = start; i < input.length; i++) {
    const ch = input[i]!;
    const next = input[i + 1];
    if (/\s/.test(ch)) continue;
    if (ch === "/" && next === "/") {
      while (i < input.length && input[i] !== "\n") i++;
      continue;
    }
    if (ch === "/" && next === "*") {
      i += 2;
      while (i < input.length && !(input[i] === "*" && input[i + 1] === "/")) i++;
      i++;
      continue;
    }
    return ch;
  }
  return undefined;
}

export function stripJsonComments(input: string): string {
  let output = "";
  let inString = false;
  let quote = "";
  let escaped = false;
  for (let i = 0; i < input.length; i++) {
    const ch = input[i]!;
    const next = input[i + 1];
    if (inString) {
      output += ch;
      if (escaped) {
        escaped = false;
      } else if (ch === "\\") {
        escaped = true;
      } else if (ch === quote) {
        inString = false;
      }
      continue;
    }
    if (ch === '"' || ch === "'") {
      inString = true;
      quote = ch;
      output += ch;
      continue;
    }
    if (ch === "/" && next === "/") {
      while (i < input.length && input[i] !== "\n") i++;
      output += "\n";
      continue;
    }
    if (ch === "/" && next === "*") {
      i += 2;
      while (i < input.length && !(input[i] === "*" && input[i + 1] === "/")) {
        if (input[i] === "\n") output += "\n";
        i++;
      }
      i++;
      continue;
    }
    if (ch === ",") {
      const nextSignificant = nextSignificantJsoncChar(input, i + 1);
      if (nextSignificant === "}" || nextSignificant === "]") continue;
    }
    output += ch;
  }
  return output;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function describeField(path: string, field: string): string {
  return field ? `${path}.${field}` : path;
}

function assertString(value: unknown, fieldPath: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${fieldPath} must be a non-empty string.`);
  return value;
}

function assertOptionalString(value: unknown, fieldPath: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string") throw new Error(`${fieldPath} must be a string.`);
  return value;
}

function assertOptionalBoolean(value: unknown, fieldPath: string): boolean | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "boolean") throw new Error(`${fieldPath} must be a boolean.`);
  return value;
}

function assertOptionalEnum<T extends string>(value: unknown, fieldPath: string, allowed: readonly T[]): T | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !(allowed as readonly string[]).includes(value)) {
    throw new Error(`${fieldPath} must be one of: ${allowed.join(", ")}.`);
  }
  return value as T;
}

function assertOptionalStringArrayOrFalse(value: unknown, fieldPath: string): string[] | false | undefined {
  if (value === undefined) return undefined;
  if (value === false) return false;
  if (!Array.isArray(value) || !value.every((entry) => typeof entry === "string" && entry.trim())) {
    throw new Error(`${fieldPath} must be false or an array of non-empty strings.`);
  }
  return value;
}

function assertOptionalSkill(value: unknown, fieldPath: string): string | string[] | false | undefined {
  if (value === undefined) return undefined;
  if (value === false) return false;
  if (typeof value === "string" && value.trim()) return value;
  if (Array.isArray(value) && value.every((entry) => typeof entry === "string" && entry.trim())) return value;
  throw new Error(`${fieldPath} must be false, a non-empty string, or an array of non-empty strings.`);
}

function assertOptionalPositiveInteger(value: unknown, fieldPath: string): number | undefined {
  if (value === undefined) return undefined;
  if (!Number.isInteger(value) || (value as number) < 1) throw new Error(`${fieldPath} must be a positive integer.`);
  return value as number;
}

function validateSequentialStep(value: unknown, fieldPath: string): SequentialStep {
  if (!isRecord(value)) throw new Error(`${fieldPath} must be an object.`);
  const step: SequentialStep = {
    agent: assertString(value.agent, `${fieldPath}.agent`),
    task: assertOptionalString(value.task, `${fieldPath}.task`),
    cwd: assertOptionalString(value.cwd, `${fieldPath}.cwd`),
    output: value.output === false ? false : assertOptionalString(value.output, `${fieldPath}.output`),
    reads: assertOptionalStringArrayOrFalse(value.reads, `${fieldPath}.reads`),
    progress: assertOptionalBoolean(value.progress, `${fieldPath}.progress`),
    skill: assertOptionalSkill(value.skill, `${fieldPath}.skill`),
    skills: assertOptionalStringArrayOrFalse(value.skills, `${fieldPath}.skills`),
    model: assertOptionalString(value.model, `${fieldPath}.model`),
  };
  for (const key of Object.keys(step) as Array<keyof SequentialStep>) {
    if (step[key] === undefined) delete step[key];
  }
  return step;
}

function validateParallelTask(value: unknown, fieldPath: string): ParallelTask {
  const task = validateSequentialStep(value, fieldPath) as ParallelTask;
  if (!isRecord(value)) return task;
  task.count = assertOptionalPositiveInteger(value.count, `${fieldPath}.count`);
  if (task.count === undefined) delete task.count;
  return task;
}

function validateChainStep(value: unknown, fieldPath: string): ChainStep {
  if (!isRecord(value)) throw new Error(`${fieldPath} must be an object.`);
  if ("parallel" in value) {
    if (!Array.isArray(value.parallel)) throw new Error(`${fieldPath}.parallel must be an array.`);
    if (value.parallel.length === 0) throw new Error(`${fieldPath}.parallel must not be empty.`);
    const step: ParallelStep = {
      parallel: value.parallel.map((task, index) => validateParallelTask(task, `${fieldPath}.parallel[${index}]`)),
      concurrency: assertOptionalPositiveInteger(value.concurrency, `${fieldPath}.concurrency`),
      failFast: assertOptionalBoolean(value.failFast, `${fieldPath}.failFast`),
      worktree: assertOptionalBoolean(value.worktree, `${fieldPath}.worktree`),
    };
    for (const key of Object.keys(step) as Array<keyof ParallelStep>) {
      if (step[key] === undefined) delete step[key];
    }
    return step;
  }
  return validateSequentialStep(value, fieldPath);
}

export function parseWorkflowFile(path: string): Workflow | undefined {
  const raw = readFileSync(path, "utf8");
  const parsed = JSON.parse(stripJsonComments(raw)) as unknown;
  if (!isRecord(parsed)) throw new Error(`Workflow ${path} must be a JSON object.`);

  const name = assertString(parsed.name, `Workflow ${path} name`).trim();
  const workflowPath = `Workflow ${name}`;
  const chain = parsed.chain === undefined
    ? undefined
    : (() => {
      if (!Array.isArray(parsed.chain)) throw new Error(`${workflowPath}.chain must be an array.`);
      if (parsed.chain.length === 0) throw new Error(`${workflowPath}.chain must not be empty.`);
      return parsed.chain.map((step, index) => validateChainStep(step, describeField(workflowPath, `chain[${index}]`)));
    })();
  const tasks = parsed.tasks === undefined
    ? undefined
    : (() => {
      if (!Array.isArray(parsed.tasks)) throw new Error(`${workflowPath}.tasks must be an array.`);
      if (parsed.tasks.length === 0) throw new Error(`${workflowPath}.tasks must not be empty.`);
      return parsed.tasks.map((task, index) => validateParallelTask(task, describeField(workflowPath, `tasks[${index}]`)));
    })();
  const agent = assertOptionalString(parsed.agent, `${workflowPath}.agent`);
  const task = assertOptionalString(parsed.task, `${workflowPath}.task`);
  if (!chain && !tasks && !(agent && task)) {
    throw new Error(`Workflow ${name} must define one of: chain, tasks, or agent+task.`);
  }
  if ((agent && !task) || (!agent && task && !chain && !tasks)) {
    throw new Error(`Workflow ${name} single-task workflows must define both string agent and string task.`);
  }

  const workflow: Workflow = {
    name,
    description: assertOptionalString(parsed.description, `${workflowPath}.description`),
    modelPolicy: assertOptionalEnum(parsed.modelPolicy, `${workflowPath}.modelPolicy`, ["agent", "workflow"] as const) ?? "agent",
    forkFallback: assertOptionalEnum(parsed.forkFallback, `${workflowPath}.forkFallback`, ["fresh", "error"] as const),
    context: assertOptionalEnum(parsed.context, `${workflowPath}.context`, ["fresh", "fork"] as const),
    clarify: assertOptionalBoolean(parsed.clarify, `${workflowPath}.clarify`),
    async: assertOptionalBoolean(parsed.async, `${workflowPath}.async`),
    worktree: assertOptionalBoolean(parsed.worktree, `${workflowPath}.worktree`),
    cwd: assertOptionalString(parsed.cwd, `${workflowPath}.cwd`),
    chainDir: assertOptionalString(parsed.chainDir, `${workflowPath}.chainDir`),
    agentScope: assertOptionalEnum(parsed.agentScope, `${workflowPath}.agentScope`, ["user", "project", "both"] as const),
    model: assertOptionalString(parsed.model, `${workflowPath}.model`),
    chain,
    tasks,
    agent,
    task,
    sourcePath: path,
  };
  for (const key of Object.keys(workflow) as Array<keyof Workflow>) {
    if (workflow[key] === undefined) delete workflow[key];
  }
  return workflow;
}

type WorkflowScope = "user" | "project";

function workflowDirs(cwd: string): Array<{ dir: string; scope: WorkflowScope }> {
  return [
    { dir: join(homedir(), ".pi", "agent", "workflows"), scope: "user" },
    { dir: join(cwd, ".pi", "workflows"), scope: "project" },
  ];
}

function extractWorkflowNameCandidate(path: string): string | undefined {
  try {
    const raw = stripJsonComments(readFileSync(path, "utf8"));
    const match = raw.match(/["']name["']\s*:\s*["']([^"']+)["']/);
    const name = match?.[1]?.trim();
    return name || undefined;
  } catch {
    return undefined;
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

function splitArgs(input: string): string[] {
  const result: string[] = [];
  let current = "";
  let quote: string | undefined;
  let escaped = false;
  let tokenStarted = false;
  for (const ch of input) {
    if (escaped) {
      current += ch;
      escaped = false;
      tokenStarted = true;
      continue;
    }
    if (ch === "\\") {
      escaped = true;
      tokenStarted = true;
      continue;
    }
    if (quote) {
      if (ch === quote) quote = undefined;
      else current += ch;
      tokenStarted = true;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      tokenStarted = true;
      continue;
    }
    if (/\s/.test(ch)) {
      if (tokenStarted) {
        result.push(current);
        current = "";
        tokenStarted = false;
      }
      continue;
    }
    current += ch;
    tokenStarted = true;
  }
  if (escaped) current += "\\";
  if (tokenStarted) result.push(current);
  return result;
}

function extractRuntimeFlags(rawArgs: string): RuntimeFlags {
  const tokens = splitArgs(rawArgs);
  const kept: string[] = [];
  const flags: RuntimeFlags = { args: "", positional: [] };
  for (const token of tokens) {
    if (token === "--bg" || token === "--async") {
      flags.async = true;
      continue;
    }
    if (token === "--fork") {
      flags.context = "fork";
      continue;
    }
    if (token === "--fresh") {
      flags.context = "fresh";
      continue;
    }
    if (token === "--clarify") {
      flags.clarify = true;
      continue;
    }
    if (token === "--no-clarify") {
      flags.clarify = false;
      continue;
    }
    if (token === "--worktree") {
      flags.worktree = true;
      continue;
    }
    if (token.startsWith("--cwd=")) {
      flags.cwd = token.slice("--cwd=".length);
      continue;
    }
    if (token.startsWith("--chain-dir=")) {
      flags.chainDir = token.slice("--chain-dir=".length);
      continue;
    }
    if (token.startsWith("--agent-scope=")) {
      const scope = token.slice("--agent-scope=".length);
      if (scope === "user" || scope === "project" || scope === "both") flags.agentScope = scope;
      continue;
    }
    kept.push(token);
  }
  flags.positional = kept;
  flags.args = kept.join(" ");
  return flags;
}

function renderTemplate(value: string, rawArgs: string, ctx: ExtensionCommandContext, positional = splitArgs(rawArgs)): string {
  return value.replace(/{{\s*([^}]+?)\s*}}/g, (_match, rawKey: string) => {
    const key = rawKey.trim();
    if (key === "args" || key === "$@") return rawArgs;
    if (key === "cwd") return ctx.cwd;
    if (key === "previous") return "{previous}";
    if (key === "task") return "{task}";
    if (key === "chain_dir" || key === "chainDir") return "{chain_dir}";
    if (/^\d+$/.test(key)) return positional[Number(key) - 1] ?? "";
    return _match;
  });
}

function renderMaybeString<T>(value: T, rawArgs: string, ctx: ExtensionCommandContext, positional?: string[]): T {
  return typeof value === "string" ? (renderTemplate(value, rawArgs, ctx, positional) as T) : value;
}

function renderSequentialStep(step: SequentialStep, rawArgs: string, ctx: ExtensionCommandContext, positional?: string[]): SequentialStep {
  return {
    ...step,
    task: step.task ? renderTemplate(step.task, rawArgs, ctx, positional) : undefined,
    cwd: renderMaybeString(step.cwd, rawArgs, ctx, positional),
  };
}

function isParallelStep(step: ChainStep): step is ParallelStep {
  return "parallel" in step && Array.isArray((step as ParallelStep).parallel);
}

function renderChainStep(step: ChainStep, rawArgs: string, ctx: ExtensionCommandContext, positional?: string[]): ChainStep {
  if (isParallelStep(step)) {
    return {
      ...step,
      parallel: step.parallel.map((task) => renderSequentialStep(task, rawArgs, ctx, positional) as ParallelTask),
    };
  }
  return renderSequentialStep(step, rawArgs, ctx, positional);
}

function hasModelOverrideInStep(step: ChainStep): boolean {
  if (isParallelStep(step)) return step.parallel.some((task) => Boolean(task.model));
  return Boolean(step.model);
}

function assertModelPolicy(workflow: Workflow): void {
  if ((workflow.modelPolicy ?? "agent") !== "agent") return;
  if (workflow.model || workflow.chain?.some(hasModelOverrideInStep) || workflow.tasks?.some((task) => Boolean(task.model))) {
    throw new Error(
      `Workflow ${workflow.name} uses modelPolicy=agent but includes a model override. ` +
      `Remove model fields or set \"modelPolicy\": \"workflow\".`,
    );
  }
}

export function buildSubagentParams(workflow: Workflow, rawArgs: string, flags: RuntimeFlags, ctx: ExtensionCommandContext): SubagentParamsLike {
  assertModelPolicy(workflow);
  const positional = flags.positional ?? splitArgs(rawArgs);
  const params: SubagentParamsLike = {
    context: flags.context ?? workflow.context,
    clarify: flags.clarify ?? workflow.clarify ?? false,
    async: flags.async ?? workflow.async,
    worktree: flags.worktree ?? workflow.worktree,
    cwd: flags.cwd ?? renderMaybeString(workflow.cwd, rawArgs, ctx, positional),
    chainDir: flags.chainDir ?? renderMaybeString(workflow.chainDir, rawArgs, ctx, positional),
    agentScope: flags.agentScope ?? workflow.agentScope ?? "both",
  };

  if (workflow.chain) {
    params.chain = workflow.chain.map((step) => renderChainStep(step, rawArgs, ctx, positional));
    params.task = rawArgs;
  } else if (workflow.tasks) {
    params.tasks = workflow.tasks.map((task) => renderSequentialStep(task, rawArgs, ctx, positional) as ParallelTask);
  } else if (workflow.agent && workflow.task) {
    params.agent = workflow.agent;
    params.model = workflow.model;
    params.task = renderTemplate(workflow.task, rawArgs, ctx, positional);
  }

  for (const key of Object.keys(params) as Array<keyof SubagentParamsLike>) {
    if (params[key] === undefined) delete params[key];
  }
  return params;
}

function directText(result: AgentToolResult): string | undefined {
  const direct = result.content
    ?.filter((part) => part.type === "text" && typeof part.text === "string")
    .map((part) => part.text)
    .join("\n")
    .trim();
  return direct || undefined;
}

function extractSuccessText(result: AgentToolResult): string {
  const results = result.details?.results ?? [];
  const lastSuccessfulOutput = [...results]
    .reverse()
    .find((entry) => entry.exitCode === 0 && typeof entry.finalOutput === "string" && entry.finalOutput.trim())
    ?.finalOutput
    ?.trim();
  if (lastSuccessfulOutput) return lastSuccessfulOutput;

  const finalOutputs = results
    .map((entry) => entry.finalOutput || entry.error)
    .filter((text): text is string => Boolean(text && text.trim()));
  if (finalOutputs.length > 0) return finalOutputs.join("\n\n");

  return directText(result) ?? "(workflow completed with no text output)";
}

function extractErrorText(response: SlashSubagentResponse): string {
  if (response.errorText?.trim()) return response.errorText.trim();

  const results = response.result.details?.results ?? [];
  const failedOutputs = results
    .filter((entry) => entry.error || (entry.exitCode !== undefined && entry.exitCode !== 0))
    .map((entry) => entry.error || entry.finalOutput)
    .filter((text): text is string => Boolean(text && text.trim()));
  if (failedOutputs.length > 0) return failedOutputs.join("\n\n");

  const erroredOutputs = results
    .map((entry) => entry.error)
    .filter((text): text is string => Boolean(text && text.trim()));
  if (erroredOutputs.length > 0) return erroredOutputs.join("\n\n");

  return directText(response.result) ?? "(workflow failed with no error output)";
}

function formatResponseText(response: SlashSubagentResponse, retriedFromFork: boolean): string {
  const note = retriedFromFork
    ? "[pi-workflows note: forked context was unavailable, so this run retried with fresh subagent context.]\n\n"
    : "";
  return `${note}${response.isError ? extractErrorText(response) : extractSuccessText(response.result)}`;
}

function messageText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((part): part is { type?: string; text?: string } => Boolean(part && typeof part === "object" && typeof (part as { text?: unknown }).text === "string"))
    .map((part) => part.text ?? "")
    .join("\n");
}

function nonEmptyLines(text: string): string[] {
  return text.split("\n").map((line) => line.trimEnd()).filter((line) => line.trim());
}

function truncateDisplayLine(line: string, width: number): string {
  if (width <= 0) return "";
  if (line.length <= width) return line;
  if (width <= 1) return "…".slice(0, width);
  return `${line.slice(0, width - 1)}…`;
}

function renderLinesComponent(linesFactory: (width: number) => string[]) {
  return {
    invalidate() {},
    render(width: number): string[] {
      const safeWidth = Math.max(1, width || 80);
      return linesFactory(safeWidth).map((line) => truncateDisplayLine(line, safeWidth));
    },
  };
}

function progressStatusIcon(status: string | undefined): string {
  if (status === "completed" || status === "complete") return "✓";
  if (status === "failed") return "✗";
  if (status === "pending") return "◦";
  return "…";
}

function formatProgressStats(entry: ProgressEntry): string {
  return [
    entry.toolCount !== undefined ? `${entry.toolCount} tools` : undefined,
    entry.tokens !== undefined && entry.tokens > 0 ? `${Math.round(entry.tokens / 1000)}k tok` : undefined,
    formatDuration(entry.durationMs) || undefined,
  ].filter(Boolean).join(", ");
}

function progressEntriesForRequest(requestId: string | undefined, details: WorkflowMessageDetails): ProgressEntry[] {
  const terminalProgress = details.result?.details?.progress ?? details.progress;
  if (terminalProgress?.length) return terminalProgress;
  if (requestId) {
    const state = workflowLiveStates.get(requestId);
    if (state?.progress.length) return state.progress;
  }
  return terminalProgress ?? [];
}

function summarizeParams(params: SubagentParamsLike | undefined): string {
  if (!params) return "";
  if (params.chain?.length) return `chain · ${params.chain.length} steps · ${params.context ?? "fresh"}`;
  if (params.tasks?.length) return `parallel · ${params.tasks.length} agents · ${params.context ?? "fresh"}`;
  if (params.agent) return `single · ${params.agent} · ${params.context ?? "fresh"}`;
  return params.context ?? "";
}

function formatProgressDetailLines(progress: ProgressEntry[], expanded: boolean): string[] {
  if (progress.length === 0) return ["  no agent progress yet"];
  const limit = expanded ? progress.length : Math.min(progress.length, 4);
  const lines: string[] = [];
  for (const entry of progress.slice(0, limit)) {
    const stats = formatProgressStats(entry);
    const tool = entry.currentTool ? ` · ${entry.currentTool}${entry.currentToolArgs ? ` ${entry.currentToolArgs}` : ""}` : "";
    lines.push(`  ${progressStatusIcon(entry.status)} ${entry.agent ?? "agent"}: ${entry.status ?? "running"}${stats ? ` (${stats})` : ""}${tool}`);
    const recentTools = expanded ? (entry.recentTools ?? []).slice(-5) : [];
    for (const recentTool of recentTools) {
      lines.push(`      tool: ${recentTool.tool ?? "tool"}${recentTool.args ? ` ${recentTool.args}` : ""}`);
    }
    const recent = expanded ? entry.recentOutput ?? [] : entry.recentOutput?.slice(-1) ?? [];
    for (const output of recent.filter((line) => line.trim())) {
      lines.push(`      ${output.trim()}`);
    }
    if (entry.error) lines.push(`      error: ${entry.error}`);
  }
  if (!expanded && progress.length > limit) lines.push(`  … ${progress.length - limit} more agents — Ctrl+O for details`);
  return lines;
}

function renderWorkflowProgressMessage(message: RenderMessageLike, options: RenderOptionsLike = {}) {
  const details = (message.details && typeof message.details === "object" ? message.details : {}) as WorkflowMessageDetails;
  const requestId = details.requestId;
  const expanded = options.expanded === true;
  const content = messageText(message.content);
  return renderLinesComponent(() => {
    const state = requestId ? workflowLiveStates.get(requestId) : undefined;
    const workflow = details.workflow ?? state?.workflow ?? "workflow";
    const status = state?.status ?? details.status ?? "running";
    const progress = state?.progress ?? details.progress ?? [];
    if (!expanded && progress.length === 0 && !state) return [content || `▶ workflow /${workflow} starting…`];
    const toolCount = state?.toolCount ?? details.toolCount;
    const tools = toolCount !== undefined ? ` · ${toolCount} tools` : "";
    const header = `▶ workflow /${workflow} · ${status}${tools}${expanded ? "" : " · Ctrl+O details"}`;
    if (!expanded) return [header, ...formatProgressDetailLines(progress, false)];
    return [
      header,
      details.sourcePath ? `source: ${details.sourcePath}` : "",
      requestId ? `request: ${requestId}` : "",
      details.params ? `params: ${summarizeParams(details.params)}` : "",
      "",
      "Agents",
      ...formatProgressDetailLines(progress, true),
    ].filter((line) => line !== "");
  });
}

function resultEntryText(entry: AgentResultEntry): string | undefined {
  return (entry.error || entry.finalOutput)?.trim() || undefined;
}

function resultEntryFailed(entry: AgentResultEntry): boolean {
  return Boolean(entry.error || (entry.exitCode !== undefined && entry.exitCode !== 0));
}

function formatResultEntryLines(entry: AgentResultEntry, index: number, expanded: boolean): string[] {
  const failed = resultEntryFailed(entry);
  const status = failed ? "failed" : "done";
  const lines = [`  ${failed ? "✗" : "✓"} ${entry.agent ?? `agent-${index + 1}`} · ${status}${entry.model ? ` · ${entry.model}` : ""}`];
  if (expanded && entry.task) lines.push(`      task: ${entry.task}`);
  if (entry.sessionFile) lines.push(`      session: ${entry.sessionFile}`);
  if (entry.savedOutputPath) lines.push(`      saved output: ${entry.savedOutputPath}`);
  if (entry.artifactPaths?.inputPath) lines.push(`      artifact input: ${entry.artifactPaths.inputPath}`);
  if (entry.artifactPaths?.outputPath) lines.push(`      artifact output: ${entry.artifactPaths.outputPath}`);
  if (entry.artifactPaths?.jsonlPath) lines.push(`      artifact jsonl: ${entry.artifactPaths.jsonlPath}`);
  if (entry.artifactPaths?.metadataPath) lines.push(`      artifact metadata: ${entry.artifactPaths.metadataPath}`);
  const text = resultEntryText(entry);
  if (text) {
    const outputLines = nonEmptyLines(text);
    const visible = expanded ? outputLines : outputLines.slice(0, 2);
    for (const line of visible) lines.push(`      ${line}`);
    if (!expanded && outputLines.length > visible.length) lines.push(`      … ${outputLines.length - visible.length} more lines — Ctrl+O details`);
  }
  return lines;
}

function renderWorkflowResultMessage(message: RenderMessageLike, options: RenderOptionsLike = {}) {
  const details = (message.details && typeof message.details === "object" ? message.details : {}) as WorkflowMessageDetails;
  const workflow = details.workflow ?? "workflow";
  const expanded = options.expanded === true;
  const isError = details.isError === true;
  const content = messageText(message.content) || details.errorText || details.error || "";
  const contentLines = nonEmptyLines(content);
  const result = details.result;
  const resultEntries = result?.details?.results ?? [];
  const progress = progressEntriesForRequest(details.requestId, details);
  return renderLinesComponent(() => {
    const header = `${isError ? "✗" : "✓"} workflow /${workflow} ${isError ? "failed" : "completed"}${expanded ? "" : " · Ctrl+O details"}`;
    if (!expanded) {
      const visible = contentLines.slice(0, 6);
      return [
        header,
        ...(details.retriedFromFork ? ["  note: forked context unavailable; retried fresh"] : []),
        ...visible.map((line) => `  ${line}`),
        ...(contentLines.length > visible.length || resultEntries.length > 0 ? [`  … Ctrl+O for ${resultEntries.length || "more"} agent details`] : []),
      ];
    }

    const lines: string[] = [header];
    if (details.sourcePath) lines.push(`source: ${details.sourcePath}`);
    if (details.requestId) lines.push(`request: ${details.requestId}`);
    if (details.params) lines.push(`params: ${summarizeParams(details.params)}`);
    if (details.retriedFromFork) lines.push("note: forked context unavailable; retried with fresh context");
    if (result?.details?.asyncId) lines.push(`async: ${result.details.asyncId}`);
    if (result?.details?.asyncDir) lines.push(`async dir: ${result.details.asyncDir}`);
    if (result?.details?.artifacts?.dir) lines.push(`artifacts: ${result.details.artifacts.dir}`);
    lines.push("");
    lines.push(isError ? "Error/output" : "Output");
    if (contentLines.length === 0) lines.push("  (no text output)");
    else for (const line of contentLines) lines.push(`  ${line}`);
    if (resultEntries.length > 0) {
      lines.push("");
      lines.push("Agent details");
      resultEntries.forEach((entry, index) => lines.push(...formatResultEntryLines(entry, index, true)));
    }
    if (progress.length > 0) {
      lines.push("");
      lines.push("Progress summary");
      lines.push(...formatProgressDetailLines(progress, true));
    }
    return lines;
  });
}

function formatDuration(ms: number | undefined): string {
  if (!ms || !Number.isFinite(ms) || ms < 0) return "";
  const total = Math.floor(ms / 1000);
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  return minutes > 0 ? `${minutes}m${seconds.toString().padStart(2, "0")}s` : `${seconds}s`;
}

function formatLiveWidgetProgressLines(workflowName: string, update: SlashSubagentUpdate): string[] {
  const progress = update.progress ?? [];
  const count = update.toolCount ?? progress.reduce((sum, entry) => sum + (entry.toolCount ?? 0), 0);
  const tool = update.currentTool ? ` · ${update.currentTool}` : "";
  const lines = [`▶ workflow /${workflowName} · running${count ? ` · ${count} tools` : ""}${tool}`];
  if (progress.length === 0) {
    lines.push("  starting subagents...");
    return lines;
  }

  for (const entry of progress.slice(0, 6)) {
    const stats = formatProgressStats(entry);
    const activeTool = entry.currentTool ? ` · ${entry.currentTool}${entry.currentToolArgs ? ` ${entry.currentToolArgs}` : ""}` : "";
    lines.push(`  ${progressStatusIcon(entry.status)} ${entry.agent ?? "agent"}: ${entry.status ?? "running"}${stats ? ` (${stats})` : ""}${activeTool}`);

    for (const recentTool of (entry.recentTools ?? []).slice(-2)) {
      lines.push(`      tool: ${recentTool.tool ?? "tool"}${recentTool.args ? ` ${recentTool.args}` : ""}`);
    }

    for (const output of (entry.recentOutput ?? []).slice(-3).filter((line) => line.trim())) {
      lines.push(`      ${output.trim()}`);
    }

    if (entry.error) lines.push(`      error: ${entry.error}`);
  }

  if (progress.length > 6) lines.push(`  … ${progress.length - 6} more agents`);
  return lines;
}

function resultHasFailure(result: AgentToolResult): boolean {
  if (result.isError === true) return true;
  return (result.details?.results ?? []).some(resultEntryFailed);
}

function validateAgentToolResult(value: unknown, workflowName: string, requestId: string): AgentToolResult {
  const prefix = `Workflow /${workflowName} request ${requestId}: malformed pi-subagents response`;
  if (!isRecord(value)) throw new Error(`${prefix}: result must be an object.`);
  if (value.isError !== undefined && typeof value.isError !== "boolean") {
    throw new Error(`${prefix}: result.isError must be a boolean.`);
  }
  if (value.content !== undefined) {
    if (!Array.isArray(value.content)) throw new Error(`${prefix}: result.content must be an array.`);
    for (const [index, part] of value.content.entries()) {
      if (!isRecord(part)) throw new Error(`${prefix}: result.content[${index}] must be an object.`);
      if (part.type !== undefined && typeof part.type !== "string") throw new Error(`${prefix}: result.content[${index}].type must be a string.`);
      if (part.text !== undefined && typeof part.text !== "string") throw new Error(`${prefix}: result.content[${index}].text must be a string.`);
    }
  }
  if (value.details !== undefined) {
    if (!isRecord(value.details)) throw new Error(`${prefix}: result.details must be an object.`);
    if (value.details.results !== undefined) {
      if (!Array.isArray(value.details.results)) throw new Error(`${prefix}: result.details.results must be an array.`);
      for (const [index, entry] of value.details.results.entries()) {
        if (!isRecord(entry)) throw new Error(`${prefix}: result.details.results[${index}] must be an object.`);
        for (const field of ["agent", "finalOutput", "error"] as const) {
          if (entry[field] !== undefined && typeof entry[field] !== "string") {
            throw new Error(`${prefix}: result.details.results[${index}].${field} must be a string.`);
          }
        }
        if (entry.exitCode !== undefined && typeof entry.exitCode !== "number") {
          throw new Error(`${prefix}: result.details.results[${index}].exitCode must be a number.`);
        }
      }
    }
  }
  return value as AgentToolResult;
}

function normalizeSubagentResponse(data: unknown, workflowName: string, requestId: string): SlashSubagentResponse {
  const prefix = `Workflow /${workflowName} request ${requestId}: malformed pi-subagents response`;
  if (!isRecord(data)) throw new Error(`${prefix}: response must be an object.`);
  if (data.requestId !== requestId) throw new Error(`${prefix}: response requestId did not match.`);
  if (data.isError !== undefined && typeof data.isError !== "boolean") throw new Error(`${prefix}: isError must be a boolean.`);
  if (data.errorText !== undefined && typeof data.errorText !== "string") throw new Error(`${prefix}: errorText must be a string.`);
  const result = validateAgentToolResult(data.result, workflowName, requestId);
  return {
    requestId,
    result,
    isError: data.isError === true || resultHasFailure(result),
    errorText: data.errorText,
  };
}

export async function requestSubagentRun(
  pi: ExtensionAPI,
  ctx: ExtensionCommandContext,
  requestId: string,
  params: SubagentParamsLike,
  workflowName: string,
  timeouts: SlashSubagentTimeouts = {},
): Promise<SlashSubagentResponse> {
  const startTimeoutMs = timeouts.startMs ?? 15_000;
  const responseTimeoutMs = timeouts.responseMs ?? 60 * 60_000;
  return new Promise((resolvePromise, reject) => {
    let done = false;
    let responseTimeout: ReturnType<typeof setTimeout> | undefined;
    const emitCancel = (reason: string) => {
      try {
        pi.events.emit(SLASH_SUBAGENT_CANCEL_EVENT, { requestId, workflowName, reason });
      } catch {
        // Cancellation is best-effort; preserve the original timeout/error path.
      }
    };
    const startTimeout = setTimeout(() => {
      finish(() => {
        emitCancel("pi-subagents did not respond before startup timeout");
        reject(new Error(
          `Workflow /${workflowName} request ${requestId}: pi-subagents did not respond. ` +
          "Is the pi-subagents extension installed and loaded?",
        ));
      });
    }, startTimeoutMs);

    const armResponseTimeout = () => {
      if (responseTimeout) clearTimeout(responseTimeout);
      responseTimeout = setTimeout(() => {
        finish(() => {
          emitCancel("pi-subagents started but did not send a terminal response before timeout");
          reject(new Error(
            `Workflow /${workflowName} request ${requestId}: pi-subagents started but did not send a terminal response ` +
            `within ${Math.round(responseTimeoutMs / 1000)}s.`,
          ));
        });
      }, responseTimeoutMs);
    };

    const finish = (next: () => void) => {
      if (done) return;
      done = true;
      clearTimeout(startTimeout);
      if (responseTimeout) clearTimeout(responseTimeout);
      unsubStarted();
      unsubResponse();
      unsubUpdate();
      next();
    };

    const onStarted = (data: unknown) => {
      if (done || !data || typeof data !== "object") return;
      if ((data as { requestId?: unknown }).requestId !== requestId) return;
      clearTimeout(startTimeout);
      armResponseTimeout();
      const now = Date.now();
      const existing = workflowLiveStates.get(requestId);
      setWorkflowLiveState({
        workflow: workflowName,
        requestId,
        status: "running",
        startedAt: existing?.startedAt ?? now,
        updatedAt: now,
        progress: existing?.progress ?? [],
        currentTool: existing?.currentTool,
        toolCount: existing?.toolCount,
      });
      if (ctx.hasUI) {
        ctx.ui.setStatus("pi-workflows", "running workflow... · live details above editor");
        ctx.ui.setWidget("pi-workflows", formatLiveWidgetProgressLines(workflowName, { requestId, progress: [] }));
      }
    };

    const onResponse = (data: unknown) => {
      if (done || !data || typeof data !== "object") return;
      const response = data as { requestId?: unknown };
      if (response.requestId !== requestId) return;
      finish(() => {
        try {
          resolvePromise(normalizeSubagentResponse(data, workflowName, requestId));
        } catch (error) {
          reject(error);
        }
      });
    };

    const onUpdate = (data: unknown) => {
      if (done || !data || typeof data !== "object") return;
      const update = data as SlashSubagentUpdate;
      if (update.requestId !== requestId) return;
      const first = update.progress?.[0];
      const tool = update.currentTool ?? first?.currentTool;
      const count = update.toolCount ?? first?.toolCount ?? 0;
      const label = first?.agent ? `${first.agent} ` : "";
      const existing = workflowLiveStates.get(requestId);
      setWorkflowLiveState({
        workflow: workflowName,
        requestId,
        status: "running",
        startedAt: existing?.startedAt ?? Date.now(),
        updatedAt: Date.now(),
        progress: update.progress ?? existing?.progress ?? [],
        currentTool: tool,
        toolCount: count,
      });
      if (ctx.hasUI) {
        ctx.ui.setStatus("pi-workflows", `${label}${count} tools${tool ? ` · ${tool}` : ""} · live details above editor`);
        ctx.ui.setWidget("pi-workflows", formatLiveWidgetProgressLines(workflowName, update));
      }
    };

    const unsubStarted = pi.events.on(SLASH_SUBAGENT_STARTED_EVENT, onStarted) as () => void;
    const unsubResponse = pi.events.on(SLASH_SUBAGENT_RESPONSE_EVENT, onResponse) as () => void;
    const unsubUpdate = pi.events.on(SLASH_SUBAGENT_UPDATE_EVENT, onUpdate) as () => void;

    pi.events.emit(SLASH_SUBAGENT_REQUEST_EVENT, { requestId, params });
  });
}

function isForkCreationFailure(response: SlashSubagentResponse): boolean {
  const text = `${response.errorText ?? ""}\n${extractErrorText(response)}`;
  return /Failed to create forked subagent session|Forked subagent context requires/i.test(text);
}

export async function runWorkflow(pi: ExtensionAPI, ctx: ExtensionCommandContext, workflow: Workflow, args: string): Promise<void> {
  const flags = extractRuntimeFlags(args);
  let requestId = randomUUID();
  let params: SubagentParamsLike | undefined;
  let responseFailure: Error | undefined;
  if (ctx.hasUI) ctx.ui.notify(`Running workflow /${workflow.name}`, "info");
  try {
    params = buildSubagentParams(workflow, flags.args, flags, ctx);
    setWorkflowLiveState({
      workflow: workflow.name,
      requestId,
      status: "starting",
      startedAt: Date.now(),
      updatedAt: Date.now(),
      progress: [],
    });
    sendWorkflowMessage(pi, ctx, {
      customType: WORKFLOW_PROGRESS_MESSAGE_TYPE,
      content: `▶ Running workflow /${workflow.name}...`,
      display: true,
      details: { workflow: workflow.name, sourcePath: workflow.sourcePath, requestId, params: snapshotParams(params), status: "starting", progress: [] },
    });
    let response = await requestSubagentRun(pi, ctx, requestId, params, workflow.name);
    let retriedFromFork = false;
    if (
      response.isError &&
      params.context === "fork" &&
      workflow.forkFallback !== "error" &&
      isForkCreationFailure(response)
    ) {
      retriedFromFork = true;
      const forkFailureState = workflowLiveStates.get(requestId);
      if (forkFailureState) {
        setWorkflowLiveState({
          ...forkFailureState,
          status: "failed",
          updatedAt: Date.now(),
          progress: response.result.details?.progress ?? forkFailureState.progress,
        });
      }
      requestId = randomUUID();
      params = { ...params, context: "fresh" };
      if (ctx.hasUI) {
        ctx.ui.notify(
          `Workflow /${workflow.name}: forked context was unavailable; retrying with fresh context.`,
          "warning",
        );
      }
      setWorkflowLiveState({
        workflow: workflow.name,
        requestId,
        status: "starting",
        startedAt: Date.now(),
        updatedAt: Date.now(),
        progress: [],
      });
      sendWorkflowMessage(pi, ctx, {
        customType: WORKFLOW_PROGRESS_MESSAGE_TYPE,
        content: `↻ Workflow /${workflow.name}: forked context unavailable; retrying with fresh context...`,
        display: true,
        details: { workflow: workflow.name, sourcePath: workflow.sourcePath, requestId, params: snapshotParams(params), retry: "fresh", status: "starting", progress: [] },
      });
      response = await requestSubagentRun(pi, ctx, requestId, params, workflow.name);
    }

    const text = formatResponseText(response, retriedFromFork);
    const errorText = response.isError ? extractErrorText(response) : undefined;
    try {
      const existingState = workflowLiveStates.get(requestId);
      const finalProgress = response.result.details?.progress?.length ? response.result.details.progress : existingState?.progress ?? [];
      const finalResult = resultWithProgress(response.result, finalProgress);
      if (existingState) {
        setWorkflowLiveState({
          ...existingState,
          status: response.isError ? "failed" : "completed",
          updatedAt: Date.now(),
          progress: finalProgress,
        });
      }
      sendWorkflowMessage(pi, ctx, {
        customType: WORKFLOW_RESULT_MESSAGE_TYPE,
        content: text,
        display: true,
        details: {
          workflow: workflow.name,
          sourcePath: workflow.sourcePath,
          requestId,
          params: snapshotParams(params),
          retriedFromFork,
          isError: response.isError,
          errorText,
          result: finalResult,
        },
      });
    } catch (error) {
      if (!response.isError) throw error;
      // Preserve the original subagent failure; result-rendering failures are secondary.
    }
    if (response.isError) {
      responseFailure = new Error(`Workflow /${workflow.name} failed: ${errorText}`);
      if (ctx.hasUI) ctx.ui.notify(errorText ?? "Workflow failed", "error");
    } else if (ctx.hasUI) {
      ctx.ui.notify(`Workflow /${workflow.name} completed`, "success");
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    try {
      const existingState = workflowLiveStates.get(requestId);
      if (existingState) setWorkflowLiveState({ ...existingState, status: "failed", updatedAt: Date.now() });
      sendWorkflowMessage(pi, ctx, {
        customType: WORKFLOW_RESULT_MESSAGE_TYPE,
        content: `Workflow /${workflow.name} failed: ${message}`,
        display: true,
        details: { workflow: workflow.name, sourcePath: workflow.sourcePath, requestId, params: snapshotParams(params), isError: true, error: message },
      });
    } catch {
      // Preserve the original workflow failure; reporting failures are secondary.
    }
    if (ctx.hasUI) {
      try {
        ctx.ui.notify(message, "error");
      } catch {
        // Preserve the original workflow failure; UI notification failures are secondary.
      }
    }
    throw error;
  } finally {
    if (ctx.hasUI) {
      ctx.ui.setStatus("pi-workflows", undefined);
      ctx.ui.setWidget("pi-workflows", undefined);
    }
  }
  if (responseFailure) throw responseFailure;
}

function listWorkflowText(workflows: Workflow[], warnings: WorkflowLoadWarning[] = []): string {
  const workflowText = workflows.length === 0
    ? "No workflows found."
    : workflows
      .map((workflow) => `/${workflow.name}${workflow.description ? ` — ${workflow.description}` : ""}\n  ${workflow.sourcePath}`)
      .join("\n");
  if (warnings.length === 0) return workflowText;
  const warningText = warnings
    .map((warning) => `- ${warning.path}: ${warning.error}`)
    .join("\n");
  return `${workflowText}\n\nSkipped invalid workflow file(s):\n${warningText}`;
}

function workflowLoadSummary(workflows: Workflow[], warnings: WorkflowLoadWarning[]): string {
  return `pi-workflows loaded ${workflows.length} workflow(s)${warnings.length ? `, skipped ${warnings.length} invalid file(s)` : ""}`;
}

function registerWorkflowCommand(pi: ExtensionAPI, workflow: Workflow): void {
  const workflowName = workflow.name;
  pi.registerCommand(workflowName, {
    description: workflow.description ? `Workflow: ${workflow.description}` : `Workflow: ${workflowName}`,
    handler: async (args, ctx) => {
      const warnings: WorkflowLoadWarning[] = [];
      const workflows = loadWorkflows(ctx.cwd, warnings);
      const workflow = workflows.find((candidate) => candidate.name === workflowName);
      if (!workflow) {
        ctx.ui.notify(`Workflow not found: ${workflowName}. Try /workflow --list or /reload.`, "error");
        sendWorkflowMessage(pi, ctx, {
          customType: "pi-workflows-list",
          content: `Workflow not found: ${workflowName}\n\n${listWorkflowText(workflows, warnings)}`,
          display: true,
          details: { workflows, warnings },
        });
        return;
      }
      await runWorkflow(pi, ctx, workflow, args);
    },
  });
}

export default function registerPiWorkflows(pi: ExtensionAPI): void {
  let activeCwd = resolve(process.cwd());
  const registeredWorkflowCommands = new Set<string>(["workflow"]);
  const discoverWorkflows = (cwd: string): { workflows: Workflow[]; warnings: WorkflowLoadWarning[] } => {
    const warnings: WorkflowLoadWarning[] = [];
    const workflows = loadWorkflows(cwd, warnings);
    return { workflows, warnings };
  };
  const registerUserWorkflowCommands = (cwd: string): void => {
    const workflows = loadWorkflows(cwd, [], true, ["user"]);
    for (const workflow of workflows) {
      if (registeredWorkflowCommands.has(workflow.name)) continue;
      registerWorkflowCommand(pi, workflow);
      registeredWorkflowCommands.add(workflow.name);
    }
  };

  const rendererApi = pi as ExtensionAPI & {
    registerMessageRenderer?: (customType: string, renderer: (message: RenderMessageLike, options: RenderOptionsLike) => unknown) => void;
  };
  rendererApi.registerMessageRenderer?.(WORKFLOW_PROGRESS_MESSAGE_TYPE, (message, options) => renderWorkflowProgressMessage(message, options));
  rendererApi.registerMessageRenderer?.(WORKFLOW_RESULT_MESSAGE_TYPE, (message, options) => renderWorkflowResultMessage(message, options));

  registerUserWorkflowCommands(activeCwd);

  pi.registerCommand("workflow", {
    description: "Run a named pi-workflows workflow: /workflow <name> [args]",
    getArgumentCompletions: (prefix: string) => {
      const tokens = splitArgs(prefix);
      if (tokens.length > 1 || (tokens.length === 1 && prefix.endsWith(" "))) return null;
      const needle = tokens[0] ?? "";
      return loadWorkflows(activeCwd, [], false)
        .filter((workflow) => workflow.name.startsWith(needle))
        .map((workflow) => ({ value: workflow.name, label: workflow.name, description: workflow.description }));
    },
    handler: async (args, ctx) => {
      activeCwd = resolve(ctx.cwd);
      const trimmed = args.trim();
      registerUserWorkflowCommands(activeCwd);
      const { workflows, warnings } = discoverWorkflows(activeCwd);
      if (!trimmed || trimmed === "--list" || trimmed === "list") {
        sendWorkflowMessage(pi, ctx, {
          customType: "pi-workflows-list",
          content: listWorkflowText(workflows, warnings),
          display: true,
          details: { workflows, warnings },
        });
        return;
      }
      const firstSpace = trimmed.search(/\s/);
      const name = firstSpace === -1 ? trimmed : trimmed.slice(0, firstSpace);
      const rest = firstSpace === -1 ? "" : trimmed.slice(firstSpace + 1).trim();
      const workflow = workflows.find((candidate) => candidate.name === name);
      if (!workflow) {
        ctx.ui.notify(`Workflow not found: ${name}`, "error");
        sendWorkflowMessage(pi, ctx, {
          customType: "pi-workflows-list",
          content: `Workflow not found: ${name}\n\n${listWorkflowText(workflows, warnings)}`,
          display: true,
          details: { workflows, warnings },
        });
        return;
      }
      await runWorkflow(pi, ctx, workflow, rest);
    },
  });

  pi.on("session_start", (_event, ctx) => {
    activeCwd = resolve(ctx.cwd);
    registerUserWorkflowCommands(activeCwd);
    const { workflows, warnings } = discoverWorkflows(activeCwd);
    if (ctx.hasUI) {
      ctx.ui.notify(workflowLoadSummary(workflows, warnings), warnings.length ? "warning" : "info");
    }
  });
}
