import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { buildWave, validateDag } from "../src/dag.ts";
import { DEFAULT_CONFIG, setConfigPath } from "../src/config.ts";
import { detectProjectChecks } from "../src/checks.ts";
import { HeuristicDecisionEngine, routeModel } from "../src/router.ts";
import { archiveText, createGoalId, pathsFor, projectId, readArchive } from "../src/store.ts";
import { runPiAgent } from "../src/pi-runner.ts";
import extension from "../src/index.ts";
import type { GoalTask } from "../src/types.ts";
import { GoalOrchestrator } from "../src/orchestrator.ts";

function task(overrides: Partial<GoalTask>): GoalTask {
  return {
    id: "T1", title: "x", description: "x", role: "coder", mode: "write", dependencies: [],
    acceptanceCriteria: ["AC1"], filesHint: ["src/a.ts"], parallelSafe: false, risk: "low",
    status: "pending", attempts: 0, modelHistory: [], ...overrides,
  };
}

test("DAG validates cycles and safe waves", () => {
  const tasks = [
    task({ id: "A", mode: "read", parallelSafe: true, filesHint: ["src/a"] }),
    task({ id: "B", mode: "read", parallelSafe: true, filesHint: ["src/b"] }),
    task({ id: "C", dependencies: ["A", "B"], filesHint: ["src/c"] }),
  ];
  assert.deepEqual(validateDag(tasks), []);
  assert.deepEqual(buildWave(tasks, 4).map((x) => x.id), ["A", "B"]);
  tasks[0].dependencies = ["C"];
  assert.ok(validateDag(tasks).some((x) => x.includes("Cycle")));
});

test("parallel write tasks require non-overlapping hints", () => {
  const tasks = [
    task({ id: "A", parallelSafe: true, filesHint: ["src/a.ts"] }),
    task({ id: "B", parallelSafe: true, filesHint: ["src/b.ts"] }),
    task({ id: "C", parallelSafe: true, filesHint: ["src/a.ts"] }),
  ];
  assert.deepEqual(buildWave(tasks, 4).map((x) => x.id), ["A", "B"]);
});

test("config dotted setter preserves types", () => {
  const next = setConfigPath(structuredClone(DEFAULT_CONFIG), "parallel.maxConcurrency", "7");
  assert.equal(next.parallel.maxConcurrency, 7);
  assert.throws(() => setConfigPath(next, "parallel.nope", "1"));
});

test("router defaults to Super and escalates architecture/high-risk", async () => {
  const engine = new HeuristicDecisionEngine();
  const low = await routeModel(DEFAULT_CONFIG, engine, task({ risk: "low" }), 0);
  assert.equal(low.tier, "super");
  const high = await routeModel(DEFAULT_CONFIG, engine, task({ role: "architecture", risk: "high" }), 0);
  assert.equal(high.tier, "ultra");
});

test("store archives are reversible and traversal-protected", () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "goal-store-"));
  const gid = createGoalId("test objective");
  const ref = archiveText(cwd, gid, "tool-output", "full raw evidence");
  assert.equal(readArchive(cwd, ref), "full raw evidence");
  assert.equal(readArchive(cwd, "../../etc/passwd"), null);
  assert.ok(projectId(cwd).length === 16);
  assert.ok(pathsFor(cwd, gid).archiveDir.includes(gid));
});

test("check auto-detection finds package scripts", () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "goal-checks-"));
  fs.writeFileSync(path.join(cwd, "package.json"), JSON.stringify({ scripts: { test: "node --test", lint: "echo lint", build: "echo build" } }));
  fs.writeFileSync(path.join(cwd, "pnpm-lock.yaml"), "lockfileVersion: 9");
  const names = detectProjectChecks(cwd).map((x) => x.name);
  assert.deepEqual(names, ["lint", "test", "build"]);
});

test("isolated Pi runner parses JSON event stream", async () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "goal-runner-"));
  const bin = fs.mkdtempSync(path.join(os.tmpdir(), "goal-bin-"));
  const fakeJs = path.join(bin, "fake-pi.cjs");
  // build the event as a real object; JSON.stringify does the escaping (single-quote bugs otherwise)
  const body = JSON.stringify({
    type: "message_end",
    message: {
      role: "assistant",
      content: [{ type: "text", text: '{"ok":true}' }],
      usage: { input: 3, output: 4, totalTokens: 7 },
      stopReason: "stop",
    },
  });
  fs.writeFileSync(fakeJs, `console.log(${JSON.stringify(body)});\n`);
  const r = await runPiAgent({
    cwd, role: "planner", task: "x", systemPrompt: "x",
    model: "fake/model", modelTier: "super", tools: [],
    piInvocation: { command: process.execPath, args: [fakeJs] },
  });
  assert.equal(r.exitCode, 0);
  assert.equal(r.output, '{"ok":true}');
  assert.equal(r.usage.contextTokens, 7);
});

test("extension registers expected Pi commands", () => {
  const commands = new Set<string>();
  const events = new Set<string>();
  const fakePi = {
    registerCommand(name: string) { commands.add(name); },
    on(name: string) { events.add(name); },
  } as any;
  extension(fakePi);
  for (const name of ["goal", "goal-direct", "goal-status", "goal-graph", "goal-pause", "goal-resume", "goal-config", "goal-tools", "goal-memory"]) {
    assert.ok(commands.has(name), `missing ${name}`);
  }
  assert.ok(events.has("session_start"));
  assert.ok(events.has("session_shutdown"));
});

import { pruneToolContext } from "../src/context-pruner.ts";

test("context pruner reversibly spills oversized tool results", () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "goal-context-"));
  const raw = "BEGIN-RAW\n" + "0123456789".repeat(2500) + "\nEND-RAW";
  const messages = [
    { role: "user", content: [{ type: "text", text: "keep me" }] },
    { role: "toolResult", toolName: "read", content: [{ type: "text", text: raw }] },
  ];
  const out = pruneToolContext(cwd, messages, structuredClone(DEFAULT_CONFIG), 60);
  assert.equal(out.stats.prunedMessages, 1);
  assert.equal(out.messages[0], messages[0]);
  const replacement = out.messages[1].content[0].text as string;
  assert.ok(replacement.length < raw.length);
  const match = replacement.match(/\[PI_AUTOGRAPH_SPILL:([^\]]+)\]/);
  assert.ok(match, "missing reversible spill marker");
  const spillFile = path.resolve(cwd, match![1]);
  assert.equal(fs.readFileSync(spillFile, "utf8"), raw);
});

test("isolated Pi runner reaps a settled child that keeps handles open", async () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "goal-runner-settled-"));
  const bin = fs.mkdtempSync(path.join(os.tmpdir(), "goal-bin-settled-"));
  const fakeJs = path.join(bin, "fake-pi-settled.cjs");
  // keep the event loop alive after emit, simulating a leaked third-party extension handle
  fs.writeFileSync(fakeJs, [
    'console.log(\'{"type":"message_end","message":{"role":"assistant","content":[{"type":"text","text":"done"}],"usage":{"totalTokens":5},"stopReason":"stop"}}\');',
    'console.log(\'{"type":"agent_settled"}\');',
    'setInterval(() => {}, 1000);',
  ].join("\n"));
  const started = Date.now();
  const r = await runPiAgent({
    cwd, role: "coder", task: "x", systemPrompt: "x",
    model: "fake/model", modelTier: "super", tools: [],
    settleGraceMs: 500, timeoutMs: 3000,
    piInvocation: { command: process.execPath, args: [fakeJs] },
  });
  assert.equal(r.exitCode, 0);
  assert.equal(r.output, "done");
  assert.ok(Date.now() - started < 3000, "settled child was not reaped promptly");
});


test("worker retries transient provider errors with backoff", async () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "goal-retry-"));
  const bin = fs.mkdtempSync(path.join(os.tmpdir(), "goal-retry-bin-"));
  const fakeJs = path.join(bin, "fake-flaky.cjs");
  const body = JSON.stringify({
    type: "message_end",
    message: { role: "assistant", content: [{ type: "text", text: '{"ok":true}' }], usage: { totalTokens: 3 }, stopReason: "stop" },
  });
  fs.writeFileSync(fakeJs, [
    'const fs=require("fs"); const pathmod=require("path");',
    'const cf=pathmod.join(__dirname,"c.txt");',
    'let n=0; try{n=parseInt(fs.readFileSync(cf,"utf8")||"0");}catch{}',
    'fs.writeFileSync(cf,String(n+1));',
    'if(n<2){ console.error("HTTP 504 gateway timeout"); process.exit(1); }',
    `console.log(${JSON.stringify(body)});`,
  ].join("\n"));
  const r = await runPiAgent({
    cwd, role: "planner", task: "x", systemPrompt: "x",
    model: "fake/model", modelTier: "super", tools: [],
    piInvocation: { command: process.execPath, args: [fakeJs] },
    maxRetries: 3, retryDelayMs: 10,
  });
  assert.equal(r.exitCode, 0);
  assert.equal(r.output, '{"ok":true}');
});

test("a goal is blocked when its cost budget is blown", async () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "goal-budget-"));
  const bin = fs.mkdtempSync(path.join(os.tmpdir(), "goal-budget-bin-"));
  const fakeJs = path.join(bin, "fake-budget.cjs");
  const fakeBody = [
    'const pathmod = require("node:path");',
    'const a = process.argv.slice(2);',
    'const i = a.indexOf("--append-system-prompt");',
    'const base = pathmod.basename(i >= 0 ? a[i + 1] : "");',
    'let text = "ok";',
    'if (base.startsWith("planner")) text = JSON.stringify({summary:"p",acceptanceCriteria:[{id:"AC1",description:"x",required:true}],tasks:[{id:"T1",title:"t",description:"d",role:"coder",mode:"write",dependencies:[],acceptanceCriteria:["AC1"],filesHint:["x"],parallelSafe:false,risk:"low"}]});',
    'else if (base.startsWith("plan-critic")) text = JSON.stringify({approved:true,issues:[]});',
    'console.log(JSON.stringify({type:"message_end",message:{role:"assistant",content:[{type:"text",text}],usage:{input:1,output:1,totalTokens:2},stopReason:"stop"}}));',
  ].join("\n");
  fs.writeFileSync(fakeJs, fakeBody);
  process.env.PI_GOAL_GRAPH_FAKE_PI = fakeJs;
  try {
    const cfg = structuredClone(DEFAULT_CONFIG);
    cfg.execution.maxCostUsd = 0;          // spent-everything budget -> should block before any write
    const p = pathsFor(cwd);
    fs.mkdirSync(path.dirname(p.configFile), { recursive: true });
    fs.writeFileSync(p.configFile, JSON.stringify(cfg, null, 2));
    const orchestrator = new GoalOrchestrator(cwd);
    const goal = await orchestrator.start("mock budget goal");
    assert.equal(goal.status, "blocked");
    assert.ok(/Cost budget/.test(goal.blockedReason ?? ""), `unexpected reason: ${goal.blockedReason}`);
  } finally {
    delete process.env.PI_GOAL_GRAPH_FAKE_PI;
  }
});

test("orchestrator completes a full mocked plan-work-review-audit graph", async () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "goal-e2e-"));
  const bin = fs.mkdtempSync(path.join(os.tmpdir(), "goal-e2e-bin-"));
  const fakeJs = path.join(bin, "fake-pi-e2e.cjs");
  const fakeBody = [
    'const pathmod = require("node:path");',
    'const a = process.argv.slice(2);',
    'const i = a.indexOf("--append-system-prompt");',
    'const base = pathmod.basename(i >= 0 ? a[i + 1] : "");',
    'let text = "ok";',
    'if (base.startsWith("planner")) text = JSON.stringify({summary:"mock plan",acceptanceCriteria:[{id:"AC1",description:"mock goal is verified",required:true}],tasks:[{id:"T1",title:"implement",description:"perform mock implementation",role:"coder",mode:"write",dependencies:[],acceptanceCriteria:["AC1"],filesHint:["mock.txt"],parallelSafe:false,risk:"low"}]});',
    'else if (base.startsWith("plan-critic")) text = JSON.stringify({approved:true,issues:[]});',
    'else if (base.startsWith("reviewer")) text = JSON.stringify({pass:true,summary:"review clean",findings:[]});',
    'else if (base.startsWith("auditor")) text = JSON.stringify({pass:true,summary:"all criteria verified",criteria:[{criterionId:"AC1",status:"verified",reason:"mock evidence",evidenceIds:[]}],missingWork:[]});',
    'else if (base.startsWith("reflection")) text = JSON.stringify({episodeSummary:"successful mocked run",lessons:[]});',
    'console.log(JSON.stringify({type:"message_end",message:{role:"assistant",content:[{type:"text",text}],usage:{input:1,output:1,totalTokens:2},stopReason:"stop"}}));',
  ].join("\n");
  fs.writeFileSync(fakeJs, fakeBody);
  process.env.PI_GOAL_GRAPH_FAKE_PI = fakeJs;
  try {
    const orchestrator = new GoalOrchestrator(cwd);
    const goal = await orchestrator.start("mock goal");
    assert.equal(goal.status, "completed");
    assert.equal(goal.tasks[0].status, "completed");
    assert.equal(goal.acceptanceCriteria[0].status, "verified");
  } finally {
    delete process.env.PI_GOAL_GRAPH_FAKE_PI;
  }
});
