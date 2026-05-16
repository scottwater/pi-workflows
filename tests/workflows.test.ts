import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import registerPiWorkflows, {
  buildSubagentParams,
  loadWorkflows,
  parseWorkflowFile,
  requestSubagentRun,
  runWorkflow,
  splitArgs,
  stripJsonComments,
} from "../extensions/index.ts";

const REQUEST_EVENT = "subagent:slash:request";
const STARTED_EVENT = "subagent:slash:started";
const RESPONSE_EVENT = "subagent:slash:response";
const CANCEL_EVENT = "subagent:slash:cancel";

type Listener = (data: unknown) => void;

const testTheme = {
  fg: (_name: string, text: string) => text,
  bg: (_name: string, text: string) => text,
  bold: (text: string) => text,
};

function withTempHome<T>(fn: (home: string) => T): T {
  const previousHome = process.env.HOME;
  const previousUserProfile = process.env.USERPROFILE;
  const home = mkdtempSync(join(tmpdir(), "pi-workflows-home-"));
  const restore = () => {
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    if (previousUserProfile === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = previousUserProfile;
  };
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  try {
    const result = fn(home);
    if (result && typeof (result as PromiseLike<unknown>).then === "function") {
      return Promise.resolve(result).finally(restore) as T;
    }
    restore();
    return result;
  } catch (error) {
    restore();
    throw error;
  }
}

function createEvents() {
  const listeners = new Map<string, Set<Listener>>();
  return {
    on(event: string, listener: Listener) {
      const set = listeners.get(event) ?? new Set<Listener>();
      set.add(listener);
      listeners.set(event, set);
      return () => set.delete(listener);
    },
    emit(event: string, data: unknown) {
      for (const listener of listeners.get(event) ?? []) listener(data);
    },
  };
}

function createCtx(cwd = process.cwd(), hasUI = false) {
  return {
    cwd,
    hasUI,
    ui: {
      notifications: [] as Array<{ message: string; level?: string }>,
      notify(message: string, level?: string) {
        this.notifications.push({ message, level });
      },
      setStatus() {},
      setWidget(_id: string, content?: unknown) {
        if (content !== undefined && !Array.isArray(content) && typeof content !== "function") {
          throw new TypeError("content is not a function");
        }
      },
    },
  };
}

function createPi() {
  const events = createEvents();
  const messages: any[] = [];
  const commands = new Map<string, any>();
  const renderers = new Map<string, any>();
  return {
    events,
    messages,
    commands,
    renderers,
    sendMessage(message: any) {
      messages.push(message);
    },
    registerCommand(name: string, command: any) {
      commands.set(name, command);
    },
    registerMessageRenderer(type: string, renderer: any) {
      renderers.set(type, renderer);
    },
    on() {},
  };
}

function respondToRequests(pi: ReturnType<typeof createPi>, handler: (params: any) => { text?: string; isError?: boolean; errorText?: string; result?: any }) {
  pi.events.on(REQUEST_EVENT, (data) => {
    const request = data as { requestId: string; params: any };
    const response = handler(request.params);
    setTimeout(() => {
      pi.events.emit(STARTED_EVENT, { requestId: request.requestId });
      pi.events.emit(RESPONSE_EVENT, {
        requestId: request.requestId,
        isError: response.isError === true,
        errorText: response.errorText,
        result: response.result ?? { content: [{ type: "text", text: response.text ?? "ok" }] },
      });
    }, 0);
  });
}

function writeWorkflow(dir: string, name: string, content: string) {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${name}.jsonc`), content);
}

test("slash bridge waits for matching asynchronous started and response events", async () => {
  const events = createEvents();
  const pi = { events };

  events.on(REQUEST_EVENT, (data) => {
    const request = data as { requestId: string };
    setTimeout(() => {
      events.emit(STARTED_EVENT, { requestId: "unrelated" });
      events.emit(RESPONSE_EVENT, { requestId: "unrelated", isError: false, result: { content: [{ type: "text", text: "wrong" }] } });
      events.emit(STARTED_EVENT, { requestId: request.requestId });
      events.emit(RESPONSE_EVENT, { requestId: request.requestId, isError: false, result: { content: [{ type: "text", text: "ok" }] } });
    }, 0);
  });

  const response = await requestSubagentRun(pi as any, createCtx() as any, "req-1", { agent: "a", task: "t" }, "wf");
  assert.equal(response.requestId, "req-1");
  assert.equal(response.isError, false);
  assert.equal(response.result.content?.[0]?.text, "ok");
});

test("slash bridge rejects and cancels when pi-subagents never starts", async () => {
  const events = createEvents();
  const pi = { events };
  const cancellations: any[] = [];
  events.on(CANCEL_EVENT, (data) => cancellations.push(data));

  await assert.rejects(
    requestSubagentRun(pi as any, createCtx() as any, "req-no-start", { agent: "a", task: "t" }, "timeout-wf", { startMs: 10, responseMs: 50 }),
    /pi-subagents did not respond/,
  );
  assert.equal(cancellations.length, 1);
  assert.equal(cancellations[0].requestId, "req-no-start");
});

test("slash bridge rejects and cancels when a started run never finishes", async () => {
  const events = createEvents();
  const pi = { events };
  const cancellations: any[] = [];
  events.on(CANCEL_EVENT, (data) => cancellations.push(data));
  events.on(REQUEST_EVENT, (data) => {
    const request = data as { requestId: string };
    setTimeout(() => events.emit(STARTED_EVENT, { requestId: request.requestId }), 0);
  });

  await assert.rejects(
    requestSubagentRun(pi as any, createCtx() as any, "req-timeout", { agent: "a", task: "t" }, "timeout-wf", { startMs: 50, responseMs: 10 }),
    /started but did not send a terminal response/,
  );
  assert.equal(cancellations.length, 1);
});

test("JSONC parsing preserves strings and handles comments after trailing commas", () => {
  const raw = `{
    // comment
    "name": "jsonc",
    "agent": "reviewer",
    "task": "Keep // and /* markers */ inside strings", // trailing note
  }`;
  const parsed = JSON.parse(stripJsonComments(raw));
  assert.equal(parsed.task, "Keep // and /* markers */ inside strings");

  const blockComment = `{
    "name": "jsonc-block",
    "tasks": [
      { "agent": "a", "task": "t" }, /* trailing note */
    ],
  }`;
  const parsedBlock = JSON.parse(stripJsonComments(blockComment));
  assert.equal(parsedBlock.tasks.length, 1);
});

test("workflow schema allows model overrides and rejects removed fields", () => withTempHome(() => {
  const dir = mkdtempSync(join(tmpdir(), "pi-workflows-schema-"));
  const valid = join(dir, "valid.jsonc");
  writeFileSync(valid, `{ "name": "model-ok", "agent": "reviewer", "model": "anthropic/claude-sonnet-4", "task": "Review {{args}}" }`);
  assert.equal(parseWorkflowFile(valid)?.model, "anthropic/claude-sonnet-4");

  for (const [file, body, pattern] of [
    ["policy.jsonc", `{ "name": "bad", "modelPolicy": "agent", "agent": "a", "task": "t" }`, /modelPolicy is not supported/],
    ["context.jsonc", `{ "name": "bad", "context": "fork", "agent": "a", "task": "t" }`, /context is not supported/],
    ["async.jsonc", `{ "name": "bad", "async": true, "agent": "a", "task": "t" }`, /async is not supported/],
    ["step-output.jsonc", `{ "name": "bad", "chain": [{ "agent": "a", "task": "t", "output": "x" }] }`, /output is not supported/],
    ["count.jsonc", `{ "name": "bad", "chain": [{ "parallel": [{ "agent": "a", "task": "t", "count": 2 }] }] }`, /count is not supported/],
    ["worktree.jsonc", `{ "name": "bad", "chain": [{ "parallel": [{ "agent": "a", "task": "t" }], "worktree": true }] }`, /worktree is not supported/],
  ] as const) {
    const path = join(dir, file);
    writeFileSync(path, body);
    assert.throws(() => parseWorkflowFile(path), pattern);
  }
}));

test("workflow defaultAgent, skills, model, and failFast are parsed into subagent params", () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-workflows-params-"));
  const file = join(dir, "wf.jsonc");
  writeFileSync(file, `{
    "name": "params",
    "defaultAgent": "skill-delegate",
    "skills": ["security-review"],
    "chain": [
      { "task": "first {{1}} {{args}}", "model": "m1" },
      { "parallel": [
        { "task": "parallel", "model": "m2" },
        { "agent": "custom", "task": "custom", "skills": ["docs"] }
      ], "failFast": false }
    ]
  }`);
  const params = buildSubagentParams(parseWorkflowFile(file)!, '"two words" rest', { args: '"two words" rest', positional: ["two words", "rest"] }, createCtx() as any);
  assert.deepEqual(params.skill, ["security-review"]);
  assert.equal((params.chain?.[0] as any).agent, "skill-delegate");
  assert.equal((params.chain?.[0] as any).model, "m1");
  assert.equal((params.chain?.[0] as any).task, 'first two words "two words" rest');
  assert.equal((params.chain?.[1] as any).failFast, false);
  assert.equal((params.chain?.[1] as any).parallel[0].model, "m2");
  assert.equal((params.chain?.[1] as any).parallel[1].agent, "custom");
  for (const removed of ["context", "worktree", "cwd", "chainDir", "agentScope", "clarify", "async", "output", "reads", "progress"]) {
    assert.equal((params as any)[removed], undefined);
  }
});

test("top-level tasks receive workflow skill defaults without unsupported params", () => {
  const workflow = {
    name: "tasks",
    sourcePath: "tasks.jsonc",
    skill: ["security"],
    tasks: [
      { agent: "a", task: "A {{args}}" },
      { agent: "b", task: "B", skill: false },
    ],
  };
  const params = buildSubagentParams(workflow as any, "scope", { args: "scope", positional: ["scope"] }, createCtx() as any);
  assert.deepEqual(params.tasks?.[0].skill, ["security"]);
  assert.equal(params.tasks?.[1].skill, false);
  assert.equal(params.tasks?.[0].task, "A scope");
  assert.equal((params as any).agentScope, undefined);
});

test("nested workflow runnables are kept for the composite runner, not emitted to pi-subagents", () => {
  const workflow = { name: "parent", sourcePath: "parent.jsonc", chain: [{ workflow: "child" }] } as any;
  assert.throws(
    () => buildSubagentParams(workflow, "scope", { args: "scope", positional: ["scope"] }, createCtx() as any),
    /nested workflow steps/,
  );
});

test("malformed pi-subagents responses fail instead of becoming successful workflows", async () => {
  const events = createEvents();
  const pi = { events };
  events.on(REQUEST_EVENT, (data) => {
    const request = data as { requestId: string };
    setTimeout(() => {
      events.emit(STARTED_EVENT, { requestId: request.requestId });
      events.emit(RESPONSE_EVENT, {
        requestId: request.requestId,
        isError: "true",
        result: { content: [{ type: "text", text: "bad" }] },
      });
    }, 0);
  });

  await assert.rejects(
    requestSubagentRun(pi as any, createCtx() as any, "bad-response", { agent: "a", task: "t" }, "wf"),
    /isError must be a boolean/,
  );
});

test("successful workflow output prefers final agent output over summary content", async () => withTempHome(async () => {
  const pi = createPi();
  respondToRequests(pi, () => ({
    result: {
      content: [{ type: "text", text: "Parallel: 2/2 succeeded" }],
      details: { results: [{ agent: "synth", exitCode: 0, finalOutput: "## Real review\n\nFinding details." }] },
    },
  }));

  await runWorkflow(pi as any, createCtx() as any, { name: "review", sourcePath: "review.jsonc", agent: "synth", task: "t" } as any, "scope");
  const result = pi.messages.find((message) => message.customType === "pi-workflows-result");
  assert.match(result.content, /## Real review/);
  assert.doesNotMatch(result.content, /Parallel: 2\/2 succeeded/);
}));

test("simple subagent partialFailures make the workflow fail", async () => withTempHome(async () => {
  const pi = createPi();
  respondToRequests(pi, () => ({
    result: {
      content: [{ type: "text", text: "summary says done" }],
      details: { partialFailures: [{ agent: "worker", exitCode: 1, error: "worker failed" }] },
    },
  }));

  await assert.rejects(
    runWorkflow(pi as any, createCtx() as any, { name: "partial", sourcePath: "partial.jsonc", agent: "a", task: "t" } as any, "scope"),
    /worker failed/,
  );
  const result = pi.messages.find((message) => message.customType === "pi-workflows-result");
  assert.equal(result.details.isError, true);
  assert.match(result.content, /worker failed/);
}));

test("agent-only chains without failFast false use native subagent chain fast path", async () => withTempHome(async () => {
  const pi = createPi();
  const requests: any[] = [];
  respondToRequests(pi, (params) => {
    requests.push(params);
    return { text: "chain ok" };
  });

  await runWorkflow(pi as any, createCtx() as any, {
    name: "native-chain",
    sourcePath: "native-chain.jsonc",
    chain: [
      { agent: "first", task: "first {{args}}" },
      { agent: "second", task: "second {{previous}}" },
    ],
  } as any, "scope");

  assert.equal(requests.length, 1);
  assert.equal(requests[0].agent, undefined);
  assert.equal(requests[0].chain.length, 2);
  assert.equal(requests[0].chain[0].agent, "first");
}));

test("runWorkflow keeps runtime-looking flags as normal args", async () => {
  const pi = createPi();
  const requests: any[] = [];
  pi.events.on(REQUEST_EVENT, (data) => {
    const request = data as { requestId: string; params: any };
    requests.push(request.params);
    setTimeout(() => {
      pi.events.emit(STARTED_EVENT, { requestId: request.requestId });
      pi.events.emit(RESPONSE_EVENT, { requestId: request.requestId, isError: false, result: { content: [{ type: "text", text: "ok" }] } });
    }, 0);
  });

  await runWorkflow(pi as any, createCtx() as any, {
    name: "flags",
    sourcePath: "flags.jsonc",
    agent: "a",
    task: "one={{1}} two={{2}} args={{args}}",
  } as any, '"two words" --fork next --clarify');

  assert.equal(requests[0].task, 'one=two words two=--fork args="two words" --fork next --clarify');
  assert.equal(requests[0].context, undefined);
  assert.equal(requests[0].clarify, undefined);
});

test("UI workflow widgets use Pi-supported component factories", async () => withTempHome(async () => {
  const pi = createPi();
  const widgetPayloads: unknown[] = [];
  pi.events.on(REQUEST_EVENT, (data) => {
    const request = data as { requestId: string; params: any };
    setTimeout(() => {
      pi.events.emit(STARTED_EVENT, { requestId: request.requestId });
      pi.events.emit("subagent:slash:update", {
        requestId: request.requestId,
        progress: [{ agent: request.params.agent, status: "running", currentTool: "grep", toolCount: 2 }],
        currentTool: "grep",
        toolCount: 2,
      });
      pi.events.emit(RESPONSE_EVENT, { requestId: request.requestId, isError: false, result: { content: [{ type: "text", text: "ok" }] } });
    }, 0);
  });
  const ctx = createCtx(process.cwd(), true) as any;
  ctx.ui.setWidget = (_id: string, content?: unknown) => {
    if (content !== undefined && !Array.isArray(content) && typeof content !== "function") {
      throw new TypeError("content is not a function");
    }
    widgetPayloads.push(content);
  };

  await runWorkflow(pi as any, ctx, { name: "ui", sourcePath: "ui.jsonc", agent: "a", task: "t" } as any, "scope");
  const renderedWidgets = widgetPayloads
    .filter((payload): payload is Function => typeof payload === "function")
    .map((factory) => factory(null, testTheme).render(120).join("\n"));
  assert.ok(renderedWidgets.some((rendered) => /workflow \/ui \| starting/.test(rendered)));
  assert.ok(renderedWidgets.some((rendered) => /a: running \(2 tools\)/.test(rendered) && /grep/.test(rendered)));
  assert.equal(widgetPayloads.at(-1), undefined);
}));

test("UI side-effect failures do not mask workflow success", async () => withTempHome(async () => {
  const previousConsoleError = console.error;
  console.error = () => {};
  try {
    const pi = createPi();
    respondToRequests(pi, () => ({ text: "ok" }));
    const ctx = createCtx(process.cwd(), true) as any;
    ctx.ui.notify = () => { throw new Error("notify failed"); };
    ctx.ui.setStatus = () => { throw new Error("status failed"); };
    ctx.ui.setWidget = () => { throw new Error("widget failed"); };

    await runWorkflow(pi as any, ctx, { name: "ui-side-effects", sourcePath: "ui.jsonc", agent: "a", task: "t" } as any, "scope");
    const result = pi.messages.find((message) => message.customType === "pi-workflows-result");
    assert.equal(result.details.isError, false);
    assert.match(result.content, /ok/);
  } finally {
    console.error = previousConsoleError;
  }
}));

test("plain chain failFast false continues to synthesis after a parallel child failure", async () => withTempHome(async () => {
  const pi = createPi();
  const requests: any[] = [];
  respondToRequests(pi, (params) => {
    requests.push(params);
    if (params.agent === "b") return { isError: true, errorText: "b websocket closed", text: "b websocket closed" };
    if (params.agent === "synth") return { text: `synth saw:\n${params.task}` };
    return { text: `${params.agent} output` };
  });

  await runWorkflow(pi as any, createCtx() as any, {
    name: "review-agents",
    sourcePath: "review-agents.jsonc",
    chain: [
      { parallel: [{ agent: "a", task: "A" }, { agent: "b", task: "B" }], failFast: false },
      { agent: "synth", task: "Synthesize:\n{{previous}}" },
    ],
  } as any, "scope");

  assert.deepEqual(requests.map((request) => request.agent), ["a", "b", "synth"]);
  assert.match(requests[2].task, /b websocket closed/);
  const result = pi.messages.find((message) => message.customType === "pi-workflows-result");
  assert.equal(result.details.isError, true);
  assert.match(result.content, /synth saw/);
}));

test("failFast false converts thrown parallel child errors into synthesizer input", async () => withTempHome(async () => {
  const cwd = mkdtempSync(join(tmpdir(), "pi-workflows-thrown-child-"));
  mkdirSync(join(cwd, ".pi", "workflows"), { recursive: true });
  const pi = createPi();
  const requests: any[] = [];
  respondToRequests(pi, (params) => {
    requests.push(params);
    if (params.agent === "synth") return { text: `synth saw:\n${params.task}` };
    return { text: `${params.agent} ok` };
  });

  await runWorkflow(pi as any, createCtx(cwd) as any, {
    name: "parent",
    sourcePath: "parent.jsonc",
    chain: [
      { parallel: [{ workflow: "missing-child" }, { agent: "security", task: "security" }], failFast: false },
      { agent: "synth", task: "Synthesize:\n{{previous}}" },
    ],
  } as any, "scope");

  assert.deepEqual(requests.map((request) => request.agent), ["security", "synth"]);
  assert.match(requests[1].task, /Nested workflow not found: missing-child/);
  const result = pi.messages.find((message) => message.customType === "pi-workflows-result");
  assert.equal(result.details.isError, true);
  assert.match(result.content, /synth saw/);
}));

test("nested workflow partial failures are preserved through parent parallel synthesis", async () => withTempHome(async () => {
  const cwd = mkdtempSync(join(tmpdir(), "pi-workflows-nested-partial-"));
  writeWorkflow(join(cwd, ".pi", "workflows"), "child-sweep", `{
    "name": "child-sweep",
    "chain": [
      { "parallel": [{ "agent": "child-a", "task": "A" }, { "agent": "child-b", "task": "B" }], "failFast": false },
      { "agent": "child-synth", "task": "child synth {{previous}}" }
    ]
  }`);
  const pi = createPi();
  const requests: any[] = [];
  respondToRequests(pi, (params) => {
    requests.push(params);
    if (params.agent === "child-b") return { isError: true, errorText: "child b failed", text: "child b failed" };
    if (params.agent === "child-synth") return { text: `child synthesized:\n${params.task}` };
    if (params.agent === "parent-synth") return { text: `parent synthesized:\n${params.task}` };
    return { text: `${params.agent} ok` };
  });

  await runWorkflow(pi as any, createCtx(cwd) as any, {
    name: "parent",
    sourcePath: "parent.jsonc",
    chain: [
      { parallel: [{ workflow: "child-sweep" }, { agent: "parent-other", task: "other" }], failFast: false },
      { agent: "parent-synth", task: "parent synth {{previous}}" },
    ],
  } as any, "scope");

  assert.ok(requests.some((request) => request.agent === "child-synth"));
  assert.ok(requests.some((request) => request.agent === "parent-synth"));
  const parentSynth = requests.find((request) => request.agent === "parent-synth");
  assert.match(parentSynth.task, /child b failed/);
  const result = pi.messages.find((message) => message.customType === "pi-workflows-result");
  assert.equal(result.details.isError, true);
  assert.ok(result.details.result.details.partialFailures.length >= 1);
}));

test("nested workflows and agents compose with failFast false", async () => withTempHome(async () => {
  const cwd = mkdtempSync(join(tmpdir(), "pi-workflows-composite-"));
  writeWorkflow(join(cwd, ".pi", "workflows"), "child-review", `{ "name": "child-review", "agent": "child-agent", "task": "child {{args}}" }`);
  const pi = createPi();
  const requests: any[] = [];
  respondToRequests(pi, (params) => {
    requests.push(params);
    if (params.agent === "security") return { isError: true, errorText: "security failed", text: "security failed" };
    if (params.agent === "synth") return { text: `synth saw:\n${params.task}` };
    return { text: `${params.agent} output:\n${params.task}` };
  });

  await runWorkflow(pi as any, createCtx(cwd) as any, {
    name: "parent",
    sourcePath: "parent.jsonc",
    chain: [
      { parallel: [{ workflow: "child-review", args: "nested {{args}}" }, { agent: "security", task: "security {{args}}" }], failFast: false },
      { agent: "synth", task: "synthesize {{previous}}" },
    ],
  } as any, "scope");

  assert.deepEqual(requests.map((request) => request.agent), ["child-agent", "security", "synth"]);
  assert.match(requests[2].task, /child-agent output:\nchild nested scope/);
  assert.match(requests[2].task, /security failed/);
  const result = pi.messages.find((message) => message.customType === "pi-workflows-result");
  assert.equal(result.details.isError, true, "partial failures are visible in result details");
  assert.match(result.content, /synth saw/);
}));

test("nested workflows abort before later chain steps when failFast is true", async () => withTempHome(async () => {
  const cwd = mkdtempSync(join(tmpdir(), "pi-workflows-failfast-"));
  writeWorkflow(join(cwd, ".pi", "workflows"), "child-review", `{ "name": "child-review", "agent": "child-agent", "task": "child {{args}}" }`);
  const pi = createPi();
  const requests: any[] = [];
  respondToRequests(pi, (params) => {
    requests.push(params);
    if (params.agent === "security") return { isError: true, errorText: "security failed", text: "security failed" };
    return { text: `${params.agent} ok` };
  });

  await assert.rejects(
    runWorkflow(pi as any, createCtx(cwd) as any, {
      name: "parent",
      sourcePath: "parent.jsonc",
      chain: [
        { parallel: [{ workflow: "child-review" }, { agent: "security", task: "security" }], failFast: true },
        { agent: "synth", task: "should not run" },
      ],
    } as any, "scope"),
    /security failed/,
  );
  assert.deepEqual(requests.map((request) => request.agent).sort(), ["child-agent", "security"]);
}));

test("nested workflow execution is recursive and detects cycles", async () => withTempHome(async () => {
  const cwd = mkdtempSync(join(tmpdir(), "pi-workflows-recursive-"));
  const workflowDir = join(cwd, ".pi", "workflows");
  writeWorkflow(workflowDir, "grandchild", `{ "name": "grandchild", "agent": "grand", "task": "grand {{args}}" }`);
  writeWorkflow(workflowDir, "child", `{ "name": "child", "chain": [{ "workflow": "grandchild", "args": "from child {{args}}" }] }`);
  writeWorkflow(workflowDir, "cycle", `{ "name": "cycle", "chain": [{ "workflow": "cycle" }] }`);
  const pi = createPi();
  const requests: any[] = [];
  respondToRequests(pi, (params) => {
    requests.push(params);
    return { text: `${params.agent}: ${params.task}` };
  });

  await runWorkflow(pi as any, createCtx(cwd) as any, { name: "parent", sourcePath: "parent.jsonc", chain: [{ workflow: "child", args: "scope" }] } as any, "ignored");
  assert.equal(requests[0].agent, "grand");
  assert.equal(requests[0].task, "grand from child scope");

  await assert.rejects(
    runWorkflow(pi as any, createCtx(cwd) as any, { name: "cycle-parent", sourcePath: "cycle-parent.jsonc", chain: [{ workflow: "cycle" }] } as any, "scope"),
    /Workflow composition recursion detected/,
  );
}));

test("missing nested workflows fail clearly", async () => withTempHome(async () => {
  const cwd = mkdtempSync(join(tmpdir(), "pi-workflows-missing-"));
  mkdirSync(join(cwd, ".pi", "workflows"), { recursive: true });
  const pi = createPi();
  await assert.rejects(
    runWorkflow(pi as any, createCtx(cwd) as any, { name: "parent", sourcePath: "parent.jsonc", chain: [{ workflow: "missing" }] } as any, "scope"),
    /Nested workflow not found: missing/,
  );
}));

test("loadWorkflows skips malformed files, rejects removed fields, and keeps valid workflows", () => withTempHome(() => {
  const cwd = mkdtempSync(join(tmpdir(), "pi-workflows-load-"));
  const workflowDir = join(cwd, ".pi", "workflows");
  writeWorkflow(workflowDir, "good", `{ "name": "good", "agent": "a", "task": "t", "model": "m" }`);
  writeWorkflow(workflowDir, "bad-json", `{ "name": "bad", `);
  writeWorkflow(workflowDir, "bad-field", `{ "name": "bad-field", "agent": "a", "task": "t", "forkFallback": "error" }`);
  const warnings: any[] = [];
  const workflows = loadWorkflows(cwd, warnings, true, ["project"]);
  assert.deepEqual(workflows.map((workflow) => workflow.name), ["good"]);
  assert.ok(warnings.some((warning) => warning.path.endsWith("bad-json.jsonc")));
  assert.ok(warnings.some((warning) => warning.path.endsWith("bad-field.jsonc") && /forkFallback is not supported/.test(warning.error)));
}));

test("project workflows override user workflows and malformed project files shadow user names", () => withTempHome((home) => {
  const cwd = mkdtempSync(join(tmpdir(), "pi-workflows-shadow-"));
  const userDir = join(home, ".pi", "agent", "workflows");
  const projectDir = join(cwd, ".pi", "workflows");
  writeWorkflow(userDir, "review", `{ "name": "review", "agent": "user", "task": "user" }`);
  writeWorkflow(projectDir, "review", `{ "name": "review", "agent": "project", "task": "project" }`);
  let workflows = loadWorkflows(cwd, [], true);
  assert.equal(workflows.find((workflow) => workflow.name === "review")?.agent, "project");

  writeWorkflow(projectDir, "review", `{ "name": "review", `);
  let warnings: any[] = [];
  workflows = loadWorkflows(cwd, warnings, true);
  assert.equal(workflows.find((workflow) => workflow.name === "review"), undefined);
  assert.ok(warnings.length > 0);

  writeFileSync(join(projectDir, "review.jsonc"), `{ "agent": `);
  warnings = [];
  workflows = loadWorkflows(cwd, warnings, true);
  assert.equal(workflows.find((workflow) => workflow.name === "review"), undefined);
  assert.ok(warnings.length > 0);
}));

test("runWorkflow reports subagent errors and nested result failures", async () => {
  const pi = createPi();
  respondToRequests(pi, () => ({
    isError: false,
    result: {
      content: [{ type: "text", text: "summary" }],
      details: { results: [{ agent: "bad", exitCode: 1, finalOutput: "nested failed" }] },
    },
  }));

  await assert.rejects(
    runWorkflow(pi as any, createCtx() as any, { name: "bad", sourcePath: "bad.jsonc", agent: "a", task: "t" } as any, "scope"),
    /nested failed/,
  );
  const result = pi.messages.find((message) => message.customType === "pi-workflows-result");
  assert.equal(result.details.isError, true);
  assert.match(result.content, /nested failed/);
});

test("runWorkflow aggregates result-reporting failures with the original error", async () => {
  const pi = createPi();
  respondToRequests(pi, () => ({ isError: true, errorText: "subagent failed", text: "subagent failed" }));
  let sendCount = 0;
  pi.sendMessage = (message: any) => {
    sendCount += 1;
    if (sendCount > 1) throw new Error("send failed");
    pi.messages.push(message);
  };

  await assert.rejects(
    runWorkflow(pi as any, createCtx() as any, { name: "report", sourcePath: "report.jsonc", agent: "a", task: "t" } as any, "scope"),
    (error: any) => error.name === "AggregateError" && /subagent failed/.test(error.message) && error.errors.some((candidate: Error) => /send failed/.test(candidate.message)),
  );
});

test("registerPiWorkflows registers renderers, generic command, and only user direct commands", () => withTempHome((home) => {
  const cwd = mkdtempSync(join(tmpdir(), "pi-workflows-register-"));
  writeWorkflow(join(home, ".pi", "agent", "workflows"), "global", `{ "name": "global", "agent": "a", "task": "t" }`);
  writeWorkflow(join(cwd, ".pi", "workflows"), "local", `{ "name": "local", "agent": "a", "task": "t" }`);
  const pi = createPi();
  registerPiWorkflows(pi as any);
  assert.ok(pi.commands.has("workflow"));
  assert.ok(pi.commands.has("global"));
  assert.equal(pi.commands.has("local"), false);
  assert.ok(pi.renderers.has("pi-workflows-progress"));
  assert.ok(pi.renderers.has("pi-workflows-result"));
}));

test("workflow list command renders skipped-file warnings", async () => withTempHome(async () => {
  const cwd = mkdtempSync(join(tmpdir(), "pi-workflows-list-"));
  const workflowDir = join(cwd, ".pi", "workflows");
  writeWorkflow(workflowDir, "good", `{ "name": "good", "agent": "a", "task": "t" }`);
  writeWorkflow(workflowDir, "bad", `{ "name": "bad", "agent": "a", "task": "t", "context": "fork" }`);
  const pi = createPi();
  registerPiWorkflows(pi as any);
  await pi.commands.get("workflow").handler("--list", createCtx(cwd));
  assert.match(pi.messages.at(-1).content, /\/good/);
  assert.match(pi.messages.at(-1).content, /context is not supported/);
}));

test("project workflow overrides a same-named global direct command during execution", async () => withTempHome(async (home) => {
  const cwd = mkdtempSync(join(tmpdir(), "pi-workflows-direct-"));
  writeWorkflow(join(home, ".pi", "agent", "workflows"), "review", `{ "name": "review", "agent": "global", "task": "global" }`);
  writeWorkflow(join(cwd, ".pi", "workflows"), "review", `{ "name": "review", "agent": "project", "task": "project" }`);
  const pi = createPi();
  const requests: any[] = [];
  respondToRequests(pi, (params) => {
    requests.push(params);
    return { text: "ok" };
  });
  registerPiWorkflows(pi as any);
  await pi.commands.get("review").handler("scope", createCtx(cwd));
  assert.equal(requests[0].agent, "project");
}));

test("unreadable project workflow directory refuses fallback to a user workflow", async () => withTempHome(async (home) => {
  const cwd = mkdtempSync(join(tmpdir(), "pi-workflows-project-warning-"));
  writeWorkflow(join(home, ".pi", "agent", "workflows"), "review", `{ "name": "review", "agent": "global", "task": "global" }`);
  mkdirSync(join(cwd, ".pi"), { recursive: true });
  writeFileSync(join(cwd, ".pi", "workflows"), "not a directory");
  const pi = createPi();
  const requests: any[] = [];
  respondToRequests(pi, (params) => {
    requests.push(params);
    return { text: "should not run" };
  });
  registerPiWorkflows(pi as any);
  await pi.commands.get("workflow").handler("review scope", createCtx(cwd));
  assert.deepEqual(requests, []);
  assert.match(pi.messages.at(-1).content, /not run to avoid falling back to a user workflow/);

  await pi.commands.get("review").handler("scope", createCtx(cwd));
  assert.deepEqual(requests, []);
  assert.match(pi.messages.at(-1).content, /not run to avoid falling back to a user workflow/);
}));

test("nested workflow lookup refuses user fallback when project discovery fails", async () => withTempHome(async (home) => {
  const cwd = mkdtempSync(join(tmpdir(), "pi-workflows-nested-project-warning-"));
  writeWorkflow(join(home, ".pi", "agent", "workflows"), "child", `{ "name": "child", "agent": "global-child", "task": "global" }`);
  mkdirSync(join(cwd, ".pi"), { recursive: true });
  writeFileSync(join(cwd, ".pi", "workflows"), "not a directory");
  const pi = createPi();
  respondToRequests(pi, () => ({ text: "should not run" }));

  await assert.rejects(
    runWorkflow(pi as any, createCtx(cwd) as any, { name: "parent", sourcePath: "parent.jsonc", chain: [{ workflow: "child" }] } as any, "scope"),
    /refused because project workflows could not be read/,
  );
}));

test("workflow result renderer shows compact params without removed context details", async () => withTempHome(async () => {
  const pi = createPi();
  respondToRequests(pi, () => ({ text: "final output" }));
  registerPiWorkflows(pi as any);
  await runWorkflow(pi as any, createCtx() as any, { name: "render", sourcePath: "render.jsonc", agent: "reviewer", task: "Review" } as any, "scope");

  const resultMessage = pi.messages.find((message) => message.customType === "pi-workflows-result");
  const renderer = pi.renderers.get("pi-workflows-result");
  const rendered = renderer(resultMessage, { expanded: true }).render(120).join("\n");
  assert.match(rendered, /workflow \/render completed/);
  assert.match(rendered, /params: single · reviewer/);
  assert.match(rendered, /final output/);
  assert.doesNotMatch(rendered, /fork|fresh|worktree|agentScope/);
}));

test("splitArgs preserves quoted positional arguments", () => {
  assert.deepEqual(splitArgs('one "two words" --flag \'three four\''), ["one", "two words", "--flag", "three four"]);
});
