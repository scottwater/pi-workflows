import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";

export type SkillSpec = string | string[] | false;

export type AgentRunnable = {
  agent: string;
  task?: string;
  model?: string;
  skill?: SkillSpec;
  readOnly?: boolean;
};

export type WorkflowRunnable = {
  workflow: string;
  args?: string;
};

export type Runnable = AgentRunnable | WorkflowRunnable;

export type ParallelStep = {
  parallel: Runnable[];
  failFast?: boolean;
};

export type ChainStep = Runnable | ParallelStep;

export type Workflow = {
  name: string;
  description?: string;
  defaultAgent?: string;
  skill?: SkillSpec;
  readOnly?: boolean;
  chain?: ChainStep[];
  tasks?: AgentRunnable[];
  agent?: string;
  task?: string;
  model?: string;
  sourcePath: string;
};

export type RuntimeArgs = {
  args: string;
  positional: string[];
};

export type SubagentParallelStep = {
  parallel: AgentRunnable[];
  failFast?: boolean;
};

export type SubagentChainStep = AgentRunnable | SubagentParallelStep;

export type SubagentParamsLike = {
  agent?: string;
  task?: string;
  model?: string;
  skill?: SkillSpec;
  chain?: SubagentChainStep[];
  tasks?: AgentRunnable[];
};

export type ProgressEntry = {
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

export type AgentResultEntry = {
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
    progressPath?: string;
  };
};

export type WorkflowLoadWarning = {
  path: string;
  error: string;
};

export type AgentToolResult = {
  content?: Array<{ type?: string; text?: string }>;
  isError?: boolean;
  details?: {
    mode?: string;
    params?: Record<string, unknown>;
    context?: string;
    progress?: ProgressEntry[];
    results?: AgentResultEntry[];
    partialFailures?: AgentResultEntry[];
    warnings?: string[];
    [key: string]: unknown;
  };
  [key: string]: unknown;
};

export type SlashSubagentResponse = {
  requestId: string;
  result: AgentToolResult;
  isError: boolean;
  errorText?: string;
};

export type SlashSubagentUpdate = {
  requestId?: string;
  progress?: ProgressEntry[];
  currentTool?: string;
  toolCount?: number;
  status?: string;
};

export type SlashSubagentTimeouts = {
  startMs?: number;
  responseMs?: number;
};

export type WorkflowMessageDetails = {
  workflow?: string;
  sourcePath?: string;
  requestId?: string;
  params?: SubagentParamsLike;
  status?: string;
  progress?: ProgressEntry[];
  isError?: boolean;
  errorText?: string;
  error?: string;
  result?: AgentToolResult;
};

export type RenderOptionsLike = { expanded?: boolean };

export type RenderMessageLike = {
  content?: unknown;
  details?: unknown;
};

export type WorkflowUIContext = ExtensionCommandContext & {
  ui?: ExtensionCommandContext["ui"] & {
    setWidget?: (id: string, component: unknown) => void;
    supportsWorkflowWidgets?: boolean;
    supportsComponentWidgets?: boolean;
    capabilities?: {
      workflowWidgets?: boolean;
      componentWidgets?: boolean;
      tuiWidgets?: boolean;
    };
  };
};
