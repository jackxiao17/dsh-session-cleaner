// dsh-session-cleaner 0.8.0 独立安全回归台：node scripts/verify-safety.mjs
// 维护者工具，不参与插件运行、不进发行包。所有用例共用唯一临时根目录，
// 每个用例再创建独立子目录；无论通过或失败，最外层 finally 都会递归清理。
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const mod = await import(pathToFileURL(join(ROOT, "lib", "index.js")).href);
const TEMP_ROOT = await mkdtemp(join(tmpdir(), "dsh-session-cleaner-safety-"));

const SID = "session-safety-1111-2222-3333-4444-555555555555";
const CHILD = "session-safety-child-0001";
const PROJECT = "--F-safety-demo--";
const CWD = "F:\\safety-demo";
const ARTIFACT = "session.v4.jsonl";
const SCHEDULE_ID = "schedule-safety-active";
const SCHEDULE_CONFLICT_ID = "schedule-safety-conflict";
const SCHEDULE_UPDATED_AT = "2026-01-01T00:00:00.000Z";

let passed = 0;
let failed = 0;

const clone = value => value === undefined ? undefined : JSON.parse(JSON.stringify(value));
const cachePath = (fixture, id) => join(fixture.cacheRoot, `${id}.json`);
const sessionDir = (fixture, id) => join(fixture.sessionsRoot, PROJECT, id);
const artifactPath = (fixture, id) => join(sessionDir(fixture, id), ARTIFACT);
const itemPath = (fixture, id) => join(fixture.home, "dsh-session-cleaner", "trash", "items", id);
const metaPath = (fixture, id) => join(fixture.home, "dsh-session-cleaner", "trash", "meta", `${id}.json`);

async function readIfPresent(path) {
  try { return await readFile(path, "utf8"); }
  catch (error) { if (error?.code === "ENOENT") return undefined; throw error; }
}

function makeHeader(id, extra = {}) {
  return {
    type: "session",
    version: 4,
    id,
    createdAt: 1,
    cwd: CWD,
    isSeeded: false,
    delegationDepth: 0,
    ...extra
  };
}

function makeSnapshot(fixture, id, location) {
  const entry = fixture.sessions.get(id);
  return {
    header: clone(entry.header),
    formatStatus: "current",
    revision: `safety-revision-${id}`,
    sizeBytes: Buffer.byteLength(entry.content),
    ...(location === undefined ? {} : { location: clone(location) })
  };
}

async function createFixture() {
  const home = await mkdtemp(join(TEMP_ROOT, "case-"));
  const sessionsRoot = join(home, "sessions");
  const cacheRoot = join(home, "storages", "session_projcache", "sessions");
  await mkdir(sessionsRoot, { recursive: true });
  await mkdir(cacheRoot, { recursive: true });
  const fixture = {
    home,
    sessionsRoot,
    cacheRoot,
    sessions: new Map(),
    cacheRows: new Map(),
    cacheContent: new Map()
  };

  const createSession = async (id, header = makeHeader(id), { cache = true } = {}) => {
    const dir = sessionDir(fixture, id);
    const artifact = artifactPath(fixture, id);
    const content = JSON.stringify(header) + "\n"
      + JSON.stringify({ type: "turn/start", time: 2, data: { turn: 1 } }) + "\n";
    await mkdir(dir, { recursive: true });
    await writeFile(artifact, content);
    fixture.sessions.set(id, { id, header, dir, artifact, content });
    if (cache) {
      const row = JSON.stringify({
        version: 7,
        record: {
          identity: { formatVersion: 4, createdAt: header.createdAt, cwd: header.cwd, isSeeded: false },
          rows: { title: { ver: 1, seq: 2, val: `安全回归 ${id}` } }
        }
      });
      await writeFile(cachePath(fixture, id), row);
      fixture.cacheRows.set(id, { identity: { formatVersion: 4 } });
      fixture.cacheContent.set(id, row);
    }
    return fixture.sessions.get(id);
  };

  fixture.createSession = createSession;
  await createSession(SID);
  return fixture;
}

function makeHost(fixture, options = {}) {
  const calls = {
    cancel: [],
    scopeDispose: [],
    agentStoreDelete: [],
    sessionFlush: [],
    sessionDetach: [],
    cacheMarkClean: [],
    cacheDelete: [],
    cachePut: [],
    workspaceDetach: [],
    workspaceInsert: [],
    persistenceStat: [],
    jobsList: [],
    terminalsHasOwnerActivity: [],
    stopSessionTasks: [],
    scheduleDelete: [],
    scheduleEdit: [],
    events: []
  };
  const liveAgents = new Map();
  const liveSessions = new Map();
  const slots = [SID];
  const globalState = { archivedSessionIds: [], pinnedSessionIds: [] };
  const schedules = clone(options.schedules ?? []);

  const workspace = {
    id: "ws-safety",
    path: CWD,
    get sessionIds() { return [...slots]; },
    async attachSession(id) { if (!slots.includes(id)) slots.unshift(id); },
    async detachSession(id) {
      calls.workspaceDetach.push(id);
      const index = slots.indexOf(id);
      if (index !== -1) slots.splice(index, 1);
      if (options.workspaceDetachError) {
        if (options.blockRollbackParent) {
          const projectDir = dirname(sessionDir(fixture, id));
          await rm(projectDir, { recursive: true, force: true });
          await writeFile(projectDir, "blocked-rollback-parent");
        }
        throw Object.assign(new Error("injected workspace detach failure"), { code: "workspace-detach-failed" });
      }
    },
    async insertSessionBefore(id, before) {
      calls.workspaceInsert.push([id, before]);
      const index = slots.indexOf(id);
      if (index !== -1) slots.splice(index, 1);
      if (before === undefined) slots.push(id);
      else {
        const at = slots.indexOf(before);
        if (at === -1) throw new Error("anchor not found");
        slots.splice(at, 0, id);
      }
    }
  };

  const workspaceRegistry = {
    list: () => [workspace],
    get: id => id === workspace.id ? workspace : undefined,
    get archivedSessionIds() { return globalState.archivedSessionIds; },
    get pinnedSessionIds() { return globalState.pinnedSessionIds; },
    async pinSession(id) { if (!globalState.pinnedSessionIds.includes(id)) globalState.pinnedSessionIds.unshift(id); },
    async unpinSession(id) { globalState.pinnedSessionIds = globalState.pinnedSessionIds.filter(value => value !== id); },
    async enqueueOperation(operation) { return await operation(); },
    requireState: () => clone(globalState),
    async setState(next) {
      if (Array.isArray(next?.archivedSessionIds)) globalState.archivedSessionIds = [...next.archivedSessionIds];
      if (Array.isArray(next?.pinnedSessionIds)) globalState.pinnedSessionIds = [...next.pinnedSessionIds];
    }
  };

  const agents = {
    get: id => liveAgents.get(id),
    list: () => [...liveAgents.values()],
    store: {
      delete(id) {
        calls.agentStoreDelete.push(id);
        liveAgents.delete(id);
      }
    }
  };

  const sessions = {
    get: id => liveSessions.get(id),
    list: () => [...liveSessions.values()],
    async flush(session) {
      calls.sessionFlush.push(session?.id);
      return true;
    },
    store: {
      get(id) {
        if (!liveSessions.has(id)) return undefined;
        return {
          detach() {
            calls.sessionDetach.push(id);
            liveSessions.delete(id);
          }
        };
      }
    }
  };

  const cacheTable = {
    async delete(id) {
      calls.cacheDelete.push(id);
      fixture.cacheRows.delete(id);
      fixture.cacheContent.delete(id);
      await rm(cachePath(fixture, id), { force: true });
      return true;
    },
    async put(id, value) {
      calls.cachePut.push(id);
      fixture.cacheRows.set(id, clone(value));
    }
  };

  const storageDomain = {
    get: name => name === "session_projcache" ? { table: () => cacheTable } : undefined
  };

  const sessionProjectionCache = {
    markClean(session) { calls.cacheMarkClean.push(session?.id); }
  };

  let scheduleClock = 0;
  const nextUpdatedAt = () => new Date(Date.UTC(2026, 0, 1, 0, 0, ++scheduleClock)).toISOString();
  const ownedBy = (entry, id) => entry?.target?.sessionId === id || entry?.sessionId === id;
  const removeSchedule = id => {
    const index = schedules.findIndex(entry => entry.id === id);
    if (index === -1) return false;
    schedules.splice(index, 1);
    return true;
  };
  const schedule = {
    async catalog() {
      if (options.scheduleCatalogError) throw new Error("injected schedule catalog failure");
      return clone(schedules);
    },
    async list({ active, limit = 50, offset = 0 } = {}) {
      const filtered = schedules.filter(entry => active === undefined || (entry.status === "active") === active);
      const items = clone(filtered.slice(offset, offset + limit));
      return { items, shown: items.length, total: filtered.length, limit, offset };
    },
    async stopSessionTasks(id) {
      calls.stopSessionTasks.push(id);
      for (let index = schedules.length - 1; index >= 0; index--) {
        if (ownedBy(schedules[index], id) && schedules[index].status === "active") schedules.splice(index, 1);
      }
    },
    async edit(request, actorSessionId) {
      const recorded = { request: clone(request), actorSessionId };
      calls.scheduleEdit.push(recorded);
      const row = schedules.find(entry => entry.id === request?.id);
      if (!row) return { id: request?.id, code: "schedule_not_found" };
      if (request.action === "update" && request.id === options.scheduleConflictId) {
        return { id: request.id, code: "schedule_conflict" };
      }
      if (request.action === "delete") {
        if (options.scheduleDeleteError) throw new Error("injected schedule delete failure");
        removeSchedule(row.id);
        return { id: row.id, deleted: true };
      }
      if (request.action !== "update") throw new Error("safety harness: unsupported schedule action");
      if (request.expectedUpdatedAt !== undefined && request.expectedUpdatedAt !== row.updatedAt) {
        return { id: row.id, code: "schedule_conflict" };
      }
      Object.assign(row, clone(request.patch ?? {}));
      if (row.active === false) row.status = "paused";
      else if (row.active === true) row.status = "active";
      delete row.active;
      row.updatedAt = nextUpdatedAt();
      if (request.patch?.active === false && typeof options.afterSchedulePause === "function") {
        await options.afterSchedulePause(request, row, fixture);
      }
      return clone(row);
    },
    async delete({ sessionId, id }) {
      calls.scheduleDelete.push([sessionId, id]);
      const row = schedules.find(entry => entry.id === id);
      if (!row || !ownedBy(row, sessionId)) return { id, deleted: false, code: "schedule_not_found" };
      removeSchedule(id);
      return { id, deleted: true };
    }
  };

  const sessionPersistence = options.noPersistence ? undefined : {
    async stat(id) {
      calls.persistenceStat.push(id);
      if (Object.hasOwn(options, "snapshot")) {
        return typeof options.snapshot === "function" ? options.snapshot(id, fixture) : clone(options.snapshot);
      }
      const entry = fixture.sessions.get(id);
      if (!entry) return undefined;
      return makeSnapshot(fixture, id, { kind: "jsonl", path: entry.artifact });
    }
  };

  const jobs = options.noJobs ? undefined : {
    async list(sessionId) {
      calls.jobsList.push(sessionId);
      if (options.jobsError) throw new Error("injected jobs list failure");
      return clone(options.jobs ?? []);
    }
  };

  const terminals = options.noTerminals ? undefined : {
    hasOwnerActivity(sessionId) {
      calls.terminalsHasOwnerActivity.push(sessionId);
      if (options.terminalsError) throw new Error("injected terminal activity failure");
      return options.terminalActivity === true;
    }
  };

  const routes = [];
  const disposers = [];
  const services = {
    dshHomePath: sub => sub === "sessions" ? (options.sessionsRoot ?? fixture.sessionsRoot) : join(fixture.home, sub),
    workspaceRegistry,
    storageDomain,
    sessionProjectionCache,
    schedule,
    sessions,
    agents,
    jobs,
    terminals,
    sessionPersistence
  };
  const ctx = {
    logger: { info() {}, warn() {}, error() {} },
    get: name => services[name],
    effect(fn) {
      const disposer = fn();
      if (typeof disposer === "function") disposers.push(disposer);
      return disposer;
    },
    emit(name, payload) { calls.events.push({ name, payload }); },
    webServer: {
      register(route) {
        routes.push(route);
        return () => {};
      }
    }
  };

  return {
    ctx,
    routes,
    calls,
    schedules,
    scheduleService: schedule,
    slots,
    globalState,
    liveAgents,
    liveSessions,
    dispose() { for (const disposer of disposers.reverse()) disposer(); }
  };
}

function addLiveAgent(host, id = SID) {
  const agent = {
    id,
    cancel(cause) { host.calls.cancel.push({ id, cause: clone(cause) }); },
    scope: {
      async dispose() { host.calls.scopeDispose.push(id); }
    }
  };
  host.liveAgents.set(id, agent);
  return agent;
}

function addLiveSession(host, id = SID, header = makeHeader(id)) {
  const session = { id, header };
  host.liveSessions.set(id, session);
  return session;
}

async function call(host, method, path, body) {
  const route = host.routes.find(candidate => candidate?.kind === "prefix" && candidate.path === "/session-cleaner/api");
  assert.ok(route, "插件应注册 /session-cleaner/api HTTP handler");
  const chunks = body === undefined ? [] : [Buffer.from(JSON.stringify(body))];
  const req = {
    method,
    url: "/session-cleaner/api" + path,
    headers: {},
    async *[Symbol.asyncIterator]() { for (const chunk of chunks) yield chunk; }
  };
  const out = { status: 0, body: undefined };
  const res = {
    writeHead(code) { out.status = code; },
    end(text) { try { out.body = JSON.parse(text); } catch { out.body = text; } }
  };
  await route.handler(req, res);
  return out;
}

async function scenario(options, fn) {
  const fixture = await createFixture();
  const host = makeHost(fixture, options);
  mod.apply(host.ctx);
  try { await fn(fixture, host); }
  finally { host.dispose(); }
}

function expectCondition(problems, condition, message) {
  if (!condition) problems.push(message);
}

async function rejectedWithoutMutationProblems(fixture, host, response, expectedCode, expectedStatus = 409) {
  const problems = [];
  const id = SID;
  const entry = fixture.sessions.get(id);
  expectCondition(problems, response.status === expectedStatus, `期望 HTTP ${expectedStatus}，实际 ${response.status}`);
  expectCondition(problems, response.body?.ok === false, "响应应明确 ok=false");
  if (expectedCode !== undefined) {
    expectCondition(problems, response.body?.code === expectedCode, `期望错误码 ${expectedCode}，实际 ${response.body?.code ?? "<missing>"}`);
  }
  expectCondition(problems, existsSync(entry.dir), "原会话目录被移动或删除了");
  expectCondition(problems, await readIfPresent(entry.artifact) === entry.content, "原会话工件内容发生变化");
  expectCondition(problems, await readIfPresent(cachePath(fixture, id)) === fixture.cacheContent.get(id), "投影缓存被清除或改写");
  expectCondition(problems, !host.calls.cacheDelete.includes(id), "调用了存储域 cache.delete");
  expectCondition(problems, !host.calls.workspaceDetach.includes(id), "调用了 workspace.detachSession");
  expectCondition(problems, !existsSync(itemPath(fixture, id)), "回收站出现了会话目录");
  expectCondition(problems, !existsSync(metaPath(fixture, id)), "回收站出现了会话快照");
  return problems;
}

function assertNoProblems(problems) {
  assert.equal(problems.length, 0, problems.join("；"));
}

async function test(name, fn) {
  try {
    await fn();
    passed++;
    console.log(`  ✓ ${name}`);
  } catch (error) {
    failed++;
    console.log(`  ✗ ${name}`);
    console.log(`    → ${error instanceof Error ? error.message : String(error)}`);
  }
}

function activeSchedule(id = SCHEDULE_ID) {
  return {
    id,
    target: { kind: "session", sessionId: SID },
    involvedSessionIds: [SID],
    status: "active",
    kind: "at",
    title: "安全回归定时任务",
    prompt: "保留我",
    scheduledAt: "2099-01-01T00:00:00.000Z",
    updatedAt: SCHEDULE_UPDATED_AT
  };
}

console.log(`dsh-session-cleaner 安全回归台（${mod.name}）`);

try {
  console.log("\n[1] live Agent / live Session 必须 fail closed");
  await test("live Agent：/trash 返回 409 session-active，且无任何拆除或文件副作用", () => scenario({}, async (fixture, host) => {
    addLiveAgent(host);
    addLiveSession(host);
    const response = await call(host, "POST", "/trash", { sessionId: SID });
    const problems = await rejectedWithoutMutationProblems(fixture, host, response, "session-active");
    expectCondition(problems, host.calls.cancel.length === 0, "调用了 agent.cancel");
    expectCondition(problems, host.calls.scopeDispose.length === 0, "调用了 agent.scope.dispose");
    expectCondition(problems, host.calls.agentStoreDelete.length === 0, "调用了 agents.store.delete");
    expectCondition(problems, host.calls.sessionFlush.length === 0, "调用了 sessions.flush");
    expectCondition(problems, host.calls.sessionDetach.length === 0, "调用了 session store detach");
    expectCondition(problems, host.calls.cacheMarkClean.length === 0, "调用了 sessionProjectionCache.markClean");
    assertNoProblems(problems);
  }));

  await test("live Session（无 Agent）：同样返回 409，且不 detach、不移动、不清缓存", () => scenario({}, async (fixture, host) => {
    addLiveSession(host);
    const response = await call(host, "POST", "/trash", { sessionId: SID });
    const problems = await rejectedWithoutMutationProblems(fixture, host, response, "session-active");
    expectCondition(problems, host.calls.sessionFlush.length === 0, "调用了 sessions.flush");
    expectCondition(problems, host.calls.sessionDetach.length === 0, "调用了 session store detach");
    expectCondition(problems, !host.calls.events.some(event => event.name === "session/disposed"), "伪造了 session/disposed");
    assertNoProblems(problems);
  }));

  for (const status of ["running", "stopping"]) {
    await test(`jobs.list 返回 ${status}：409 session-active 且无副作用`, () => scenario({
      jobs: [{ id: "job-safety-active", kind: "bash", label: "安全回归任务", owner: SID, status, startedAt: 1, output: { total: 0, earliest: 0 } }]
    }, async (fixture, host) => {
      const response = await call(host, "POST", "/trash", { sessionId: SID });
      const problems = await rejectedWithoutMutationProblems(fixture, host, response, "session-active");
      expectCondition(problems, JSON.stringify(host.calls.jobsList) === JSON.stringify([SID]), "未先用 jobs.list(sessionId) 检查后台任务");
      expectCondition(problems, host.calls.persistenceStat.length === 0, "活动 jobs 门禁后仍读取持久化后端");
      expectCondition(problems, host.calls.scheduleEdit.length === 0, "活动 jobs 门禁后仍修改定时任务");
      assertNoProblems(problems);
    }));
  }

  await test("jobs.list 的 unowned running job 不得误拒当前会话", () => scenario({
    jobs: [{ id: "job-safety-unowned", kind: "bash", label: "无主任务", status: "running", startedAt: 1, output: { total: 0, earliest: 0 } }]
  }, async (fixture, host) => {
    const response = await call(host, "POST", "/trash", { sessionId: SID });
    assert.equal(response.status, 200, `unowned job 不应误拒，实际 ${response.status}: ${JSON.stringify(response.body)}`);
    assert.equal(response.body?.result?.trashed, true);
    assert.equal(JSON.stringify(host.calls.jobsList), JSON.stringify([SID]));
    assert.equal(existsSync(sessionDir(fixture, SID)), false, "允许后原会话目录应进入回收站");
    assert.equal(existsSync(itemPath(fixture, SID)), true, "允许后回收站应出现会话目录");
  }));

  await test("terminals.hasOwnerActivity=true：409 session-active 且无副作用", () => scenario({
    terminalActivity: true
  }, async (fixture, host) => {
    const response = await call(host, "POST", "/trash", { sessionId: SID });
    const problems = await rejectedWithoutMutationProblems(fixture, host, response, "session-active");
    expectCondition(problems, JSON.stringify(host.calls.terminalsHasOwnerActivity) === JSON.stringify([SID]), "未调用 terminals.hasOwnerActivity(sessionId)");
    expectCondition(problems, host.calls.persistenceStat.length === 0, "活动终端门禁后仍读取持久化后端");
    expectCondition(problems, host.calls.scheduleEdit.length === 0, "活动终端门禁后仍修改定时任务");
    assertNoProblems(problems);
  }));

  console.log("\n[2] 冷会话事件与定时任务生命周期");
  await test("冷会话 trash 不得 emit session/disposed", () => scenario({}, async (_fixture, host) => {
    const response = await call(host, "POST", "/trash", { sessionId: SID });
    assert.equal(response.status, 200, `trash 应成功，实际 ${response.status}: ${JSON.stringify(response.body)}`);
    assert.equal(response.body?.result?.trashed, true);
    const disposed = host.calls.events.filter(event => event.name === "session/disposed");
    assert.equal(disposed.length, 0, `冷会话被伪造了 ${disposed.length} 次 session/disposed`);
  }));

  await test("定时任务：trash 暂停、restore 恢复、purge 才 delete，全程不调用 stopSessionTasks", () => scenario({ schedules: [activeSchedule()] }, async (_fixture, host) => {
    const problems = [];
    const trashed = await call(host, "POST", "/trash", { sessionId: SID });
    expectCondition(problems, trashed.status === 200, `trash 应成功，实际 ${trashed.status}`);

    const pause = host.calls.scheduleEdit.find(call => call.request?.action === "update" && call.request?.patch?.active === false);
    expectCondition(problems, pause !== undefined, "trash 未调用 edit({action:'update',patch:{active:false}})");
    if (pause) {
      expectCondition(problems, pause.request.id === SCHEDULE_ID, "暂停请求 id 不正确");
      expectCondition(problems, pause.request.expectedUpdatedAt === SCHEDULE_UPDATED_AT, "暂停请求未带原始 expectedUpdatedAt");
      expectCondition(problems, pause.actorSessionId === undefined, "暂停请求伪造了 actorSessionId");
    }
    expectCondition(problems, host.calls.stopSessionTasks.length === 0, "trash 调用了 stopSessionTasks");
    expectCondition(problems, !host.calls.scheduleEdit.some(call => call.request?.action === "delete"), "trash 阶段删除了定时任务");
    expectCondition(problems, host.schedules.find(row => row.id === SCHEDULE_ID)?.status === "paused", "trash 后任务应仍在且 status=paused");

    const pausedUpdatedAt = host.schedules.find(row => row.id === SCHEDULE_ID)?.updatedAt;
    const restored = await call(host, "POST", "/trash/restore", { sessionId: SID });
    expectCondition(problems, restored.status === 200, `restore 应成功，实际 ${restored.status}`);
    const resume = host.calls.scheduleEdit.find(call => call.request?.action === "update" && call.request?.patch?.active === true);
    expectCondition(problems, resume !== undefined, "restore 未调用 edit({action:'update',patch:{active:true}})");
    if (resume) {
      expectCondition(problems, resume.request.id === SCHEDULE_ID, "恢复请求 id 不正确");
      expectCondition(problems, resume.request.expectedUpdatedAt === pausedUpdatedAt, "恢复请求未带暂停后的 expectedUpdatedAt");
      expectCondition(problems, resume.actorSessionId === undefined, "恢复请求伪造了 actorSessionId");
    }
    expectCondition(problems, host.schedules.find(row => row.id === SCHEDULE_ID)?.status === "active", "restore 后任务应恢复 active");

    // restore 已移除回收站项；要验证 purge 删除任务，必须先重新 trash 一次。
    const retrashed = await call(host, "POST", "/trash", { sessionId: SID });
    expectCondition(problems, retrashed.status === 200, `purge 前重新 trash 应成功，实际 ${retrashed.status}`);
    expectCondition(problems, host.schedules.find(row => row.id === SCHEDULE_ID)?.status === "paused", "重新 trash 后任务应再次暂停");

    const purged = await call(host, "POST", "/trash/delete", { sessionIds: [SID] });
    expectCondition(problems, purged.status === 200, `purge 应成功，实际 ${purged.status}`);
    expectCondition(problems, purged.body?.result?.results?.[0]?.deleted === true, "purge 未删除回收站项");
    expectCondition(problems, host.calls.scheduleEdit.some(call => call.request?.action === "delete" && call.request.id === SCHEDULE_ID), "purge 未通过 edit({action:'delete'}) 删除任务");
    expectCondition(problems, !host.schedules.some(row => row.id === SCHEDULE_ID), "purge 后定时任务仍存在");
    expectCondition(problems, host.calls.stopSessionTasks.length === 0, "全程调用了 stopSessionTasks");
    expectCondition(problems, host.calls.scheduleDelete.length === 0, "调用了旧 schedule.delete");
    assertNoProblems(problems);
  }));

  await test("restore 时 schedule.edit 缺失：恢复成功但 schedulesResumeSkipped>0", () => scenario({ schedules: [activeSchedule()] }, async (fixture, host) => {
    const trashed = await call(host, "POST", "/trash", { sessionId: SID });
    assert.equal(trashed.status, 200, `trash 应成功，实际 ${trashed.status}: ${JSON.stringify(trashed.body)}`);
    assert.equal(host.schedules.find(row => row.id === SCHEDULE_ID)?.status, "paused");
    delete host.scheduleService.edit;

    const restored = await call(host, "POST", "/trash/restore", { sessionId: SID });
    assert.equal(restored.status, 200, `restore 应成功，实际 ${restored.status}: ${JSON.stringify(restored.body)}`);
    assert.equal(restored.body?.result?.filesRestored, true);
    assert.equal(restored.body?.result?.schedulesResumed, 0, "缺少 edit 时不应伪报任务已恢复");
    assert.ok(restored.body?.result?.schedulesResumeSkipped > 0, "缺少 edit 时应回报 schedulesResumeSkipped>0");
    assert.equal(host.schedules.find(row => row.id === SCHEDULE_ID)?.status, "paused", "缺少 edit 时任务应保持 paused");
    assert.equal(existsSync(sessionDir(fixture, SID)), true, "restore 后原会话目录应存在");
    assert.equal(existsSync(itemPath(fixture, SID)), false, "restore 后回收站目录应清除");
    assert.equal(existsSync(metaPath(fixture, SID)), false, "restore 后快照应清除");
  }));

  console.log("\n[2b] 失败路径必须完整回滚");
  await test("schedule.catalog 抛错：trash 非 200 且无文件/缓存/workspace 副作用", () => scenario({
    scheduleCatalogError: true
  }, async (fixture, host) => {
    const response = await call(host, "POST", "/trash", { sessionId: SID });
    const problems = await rejectedWithoutMutationProblems(fixture, host, response, undefined, 500);
    expectCondition(problems, /schedule catalog failure/i.test(response.body?.error ?? ""), `失败信息未保留 catalog 错误：${response.body?.error ?? "<empty>"}`);
    expectCondition(problems, host.calls.scheduleEdit.length === 0, "catalog 失败后仍调用了 schedule.edit");
    assertNoProblems(problems);
  }));

  await test("purge 时 schedule edit(delete) 抛错：deleted=false，item/meta 保留", () => scenario({
    schedules: [activeSchedule()],
    scheduleDeleteError: true
  }, async (fixture, host) => {
    const trashed = await call(host, "POST", "/trash", { sessionId: SID });
    assert.equal(trashed.status, 200, `trash 应成功，实际 ${trashed.status}: ${JSON.stringify(trashed.body)}`);
    const purged = await call(host, "POST", "/trash/delete", { sessionIds: [SID] });
    assert.equal(purged.status, 200, `purge 接口应返回 200，实际 ${purged.status}: ${JSON.stringify(purged.body)}`);
    const result = purged.body?.result?.results?.[0];
    assert.equal(result?.deleted, false, "schedule delete 失败时不得报 deleted=true");
    assert.match(result?.error ?? "", /schedule delete failure/i);
    assert.equal(existsSync(itemPath(fixture, SID)), true, "schedule delete 失败时回收站目录应保留");
    assert.equal(existsSync(metaPath(fixture, SID)), true, "schedule delete 失败时快照应保留");
    assert.equal(host.schedules.find(row => row.id === SCHEDULE_ID)?.status, "paused", "删除失败时任务行应保留");
    assert.equal(host.calls.stopSessionTasks.length, 0, "调用了 stopSessionTasks");
  }));

  await test("detach 失败且回滚 rename 也失败：trash 失败，bin 目录与 prepared meta 保留", () => scenario({
    schedules: [activeSchedule()],
    workspaceDetachError: true,
    blockRollbackParent: true
  }, async (fixture, host) => {
    const entry = fixture.sessions.get(SID);
    const response = await call(host, "POST", "/trash", { sessionId: SID });
    assert.equal(response.status, 500, `trash 应失败，实际 HTTP ${response.status}: ${JSON.stringify(response.body)}`);
    assert.equal(response.body?.ok, false);
    assert.equal(existsSync(itemPath(fixture, SID)), true, "回滚 rename 失败时 bin 目录应保留");
    assert.equal(await readIfPresent(join(itemPath(fixture, SID), ARTIFACT)), entry.content, "bin 内工件内容应完整保留");
    const meta = JSON.parse(await readFile(metaPath(fixture, SID), "utf8"));
    assert.equal(meta.stage, "prepared", "回滚失败时快照应保持 prepared");
    const projectDir = dirname(entry.dir);
    assert.equal(await readIfPresent(projectDir), "blocked-rollback-parent", "未成功制造回滚目标父路径阻塞");
    assert.equal(await readIfPresent(cachePath(fixture, SID)), fixture.cacheContent.get(SID), "detach 失败后缓存不应丢失");
    assert.equal(host.schedules.find(row => row.id === SCHEDULE_ID)?.status, "paused", "文件仍滞留 bin 时任务应保持暂停等待对账");
  }));

  await test("第二个任务暂停冲突：409、第一个任务回滚 active，文件/缓存/workspace 不变", () => scenario({
    schedules: [activeSchedule(), activeSchedule(SCHEDULE_CONFLICT_ID)],
    scheduleConflictId: SCHEDULE_CONFLICT_ID
  }, async (fixture, host) => {
    const response = await call(host, "POST", "/trash", { sessionId: SID });
    const problems = await rejectedWithoutMutationProblems(fixture, host, response, "schedule-conflict");
    expectCondition(problems, host.schedules.find(row => row.id === SCHEDULE_ID)?.status === "active", "第一个任务未回滚为 active");
    expectCondition(problems, host.schedules.find(row => row.id === SCHEDULE_CONFLICT_ID)?.status === "active", "冲突任务应保持 active");
    const editSequence = host.calls.scheduleEdit.map(entry => [entry.request.id, entry.request.action, entry.request.patch?.active]);
    expectCondition(problems, JSON.stringify(editSequence) === JSON.stringify([
      [SCHEDULE_ID, "update", false],
      [SCHEDULE_CONFLICT_ID, "update", false],
      [SCHEDULE_ID, "update", true]
    ]), `暂停/回滚调用顺序不正确：${JSON.stringify(editSequence)}`);
    expectCondition(problems, host.calls.stopSessionTasks.length === 0, "调用了 stopSessionTasks");
    expectCondition(problems, !host.calls.scheduleEdit.some(entry => entry.request.action === "delete"), "冲突回滚时删除了任务");
    assertNoProblems(problems);
  }));

  await test("搬移目标父路径被文件阻塞：trash 失败，任务回滚且文件/缓存/workspace 不变", () => scenario({
    schedules: [activeSchedule()],
    afterSchedulePause: async (_request, _row, fixture) => {
      const itemsRoot = join(fixture.home, "dsh-session-cleaner", "trash", "items");
      await rm(itemsRoot, { recursive: true, force: true });
      await writeFile(itemsRoot, "blocked-target-parent");
    }
  }, async (fixture, host) => {
    const response = await call(host, "POST", "/trash", { sessionId: SID });
    const problems = await rejectedWithoutMutationProblems(fixture, host, response, undefined, 500);
    const itemsRoot = join(fixture.home, "dsh-session-cleaner", "trash", "items");
    expectCondition(problems, await readIfPresent(itemsRoot) === "blocked-target-parent", "未在暂停后制造目标父路径阻塞");
    expectCondition(problems, /EEXIST|exist|文件/i.test(response.body?.error ?? ""), `失败信息未指向目标路径阻塞：${response.body?.error ?? "<empty>"}`);
    expectCondition(problems, host.schedules.find(row => row.id === SCHEDULE_ID)?.status === "active", "搬移失败后任务未恢复 active");
    expectCondition(problems, host.calls.scheduleEdit.some(entry => entry.request.action === "update" && entry.request.patch?.active === true), "搬移失败后未调用任务恢复");
    expectCondition(problems, host.calls.stopSessionTasks.length === 0, "调用了 stopSessionTasks");
    assertNoProblems(problems);
  }));

  await test("workspace.detachSession 抛错：已移动文件回滚，任务恢复 active，缓存不丢", () => scenario({
    schedules: [activeSchedule()],
    workspaceDetachError: true
  }, async (fixture, host) => {
    const entry = fixture.sessions.get(SID);
    const response = await call(host, "POST", "/trash", { sessionId: SID });
    const problems = [];
    expectCondition(problems, response.status === 500, `trash 应失败，实际 HTTP ${response.status}`);
    expectCondition(problems, response.body?.ok === false, "失败响应应 ok=false");
    expectCondition(problems, existsSync(entry.dir), "已移动文件没有回滚到原目录");
    expectCondition(problems, await readIfPresent(entry.artifact) === entry.content, "回滚后工件内容发生变化");
    expectCondition(problems, await readIfPresent(cachePath(fixture, SID)) === fixture.cacheContent.get(SID), "清理失败后投影缓存丢失或被改写");
    expectCondition(problems, !host.calls.cacheDelete.includes(SID), "detach 失败后仍调用了 cache.delete");
    expectCondition(problems, host.slots.includes(SID), "workspace 槽位没有恢复");
    expectCondition(problems, host.calls.workspaceDetach.length === 1, "未按预期触发一次 detachSession");
    expectCondition(problems, host.calls.workspaceInsert.length >= 1, "回滚时没有重新挂回 workspace 槽位");
    expectCondition(problems, host.schedules.find(row => row.id === SCHEDULE_ID)?.status === "active", "清理失败后任务未恢复 active");
    expectCondition(problems, host.calls.scheduleEdit.some(entry => entry.request.action === "update" && entry.request.patch?.active === true), "清理失败后未调用任务恢复");
    expectCondition(problems, !existsSync(itemPath(fixture, SID)), "回滚后回收站仍残留会话目录");
    expectCondition(problems, !existsSync(metaPath(fixture, SID)), "回滚后回收站仍残留快照");
    expectCondition(problems, host.calls.stopSessionTasks.length === 0, "调用了 stopSessionTasks");
    assertNoProblems(problems);
  }));

  console.log("\n[3] sessionPersistence 后端与路径必须 fail closed");
  const backendCases = [
    {
      name: "SQLite location.kind 返回 409 unsupported-backend，且无文件/缓存副作用",
      code: "unsupported-backend",
      snapshot: (_id, fixture) => makeSnapshot(fixture, SID, { kind: "sqlite", path: join(fixture.home, "storages", "sessions.db") })
    },
    {
      name: "未知 location.kind 返回 409 unsupported-backend，且无文件/缓存副作用",
      code: "unsupported-backend",
      snapshot: (_id, fixture) => makeSnapshot(fixture, SID, { kind: "mystery", path: artifactPath(fixture, SID) })
    },
    {
      name: "缺失 location 返回 409 unsupported-backend，且无文件/缓存副作用",
      code: "unsupported-backend",
      snapshot: (_id, fixture) => makeSnapshot(fixture, SID)
    },
    {
      name: "JSONL location.path 与 sessions root 不匹配返回 409 backend-path-mismatch，且无文件/缓存副作用",
      code: "backend-path-mismatch",
      snapshot: (_id, fixture) => makeSnapshot(fixture, SID, { kind: "jsonl", path: join(fixture.home, "custom-sessions", PROJECT, SID, ARTIFACT) })
    }
  ];

  for (const backendCase of backendCases) {
    await test(backendCase.name, () => scenario({ snapshot: backendCase.snapshot }, async (fixture, host) => {
      const response = await call(host, "POST", "/trash", { sessionId: SID });
      const problems = await rejectedWithoutMutationProblems(fixture, host, response, backendCase.code);
      expectCondition(problems, host.calls.persistenceStat.includes(SID), "删除前没有调用 sessionPersistence.stat(sessionId)");
      assertNoProblems(problems);
    }));
  }

  console.log("\n[4] 子代理 header 与深度边界");
  await test("只有 origin='subagent' 才级联；缺少 origin 的 parentSession 子会话必须留在原地", () => scenario({}, async (fixture, host) => {
    const childHeader = makeHeader(CHILD, { parentSession: SID, delegationDepth: 1 });
    const child = await fixture.createSession(CHILD, childHeader);
    const response = await call(host, "POST", "/trash", { sessionId: SID });
    assert.equal(response.status, 200, `父会话 trash 应成功，实际 ${response.status}: ${JSON.stringify(response.body)}`);
    const problems = [];
    expectCondition(problems, response.body?.result?.descendantsCount === 0, `缺少 origin 的子会话被级联，descendantsCount=${response.body?.result?.descendantsCount}`);
    expectCondition(problems, existsSync(child.dir), "缺少 origin 的子会话目录被移动");
    expectCondition(problems, await readIfPresent(child.artifact) === child.content, "缺少 origin 的子会话工件发生变化");
    expectCondition(problems, await readIfPresent(cachePath(fixture, CHILD)) === fixture.cacheContent.get(CHILD), "缺少 origin 的子会话缓存被清除");
    expectCondition(problems, !host.calls.cacheDelete.includes(CHILD), "缺少 origin 的子会话调用了 cache.delete");
    expectCondition(problems, !existsSync(join(itemPath(fixture, SID), ".children", CHILD)), "缺少 origin 的子会话进入父项 .children");
    assertNoProblems(problems);
  }));

  await test("32 层合法子代理树成功进入回收站", () => scenario({}, async (fixture, host) => {
    const chain = [];
    let parent = SID;
    for (let depth = 1; depth <= 32; depth++) {
      const id = `session-safety-depth32-${String(depth).padStart(2, "0")}`;
      const header = makeHeader(id, { parentSession: parent, origin: "subagent", delegationDepth: depth });
      chain.push(await fixture.createSession(id, header));
      parent = id;
    }
    const response = await call(host, "POST", "/trash", { sessionId: SID });
    assert.equal(response.status, 200, `32 层树应成功，实际 ${response.status}: ${JSON.stringify(response.body)}`);
    assert.equal(response.body?.result?.descendantsCount, 32);
    assert.equal(existsSync(sessionDir(fixture, SID)), false, "根会话目录应进入回收站");
    for (const entry of chain) {
      assert.equal(existsSync(entry.dir), false, `${entry.id} 原目录应进入回收站`);
      assert.equal(existsSync(join(itemPath(fixture, SID), ".children", entry.id)), true, `${entry.id} 应在父项 .children 下`);
      assert.equal(existsSync(cachePath(fixture, entry.id)), false, `${entry.id} 缓存应清除`);
    }
  }));

  await test("子代理深度超过 32 层必须明确失败，且整棵树不移动、不清缓存", () => scenario({}, async (fixture, host) => {
    const chain = [];
    let parent = SID;
    for (let depth = 1; depth <= 33; depth++) {
      const id = `session-safety-depth-${String(depth).padStart(2, "0")}`;
      const header = makeHeader(id, { parentSession: parent, origin: "subagent", delegationDepth: depth });
      const entry = await fixture.createSession(id, header);
      chain.push(entry);
      parent = id;
    }

    const response = await call(host, "POST", "/trash", { sessionId: SID });
    const problems = [];
    expectCondition(problems, response.status >= 400 && response.status !== 200, `超深树应明确失败，实际 HTTP ${response.status}`);
    expectCondition(problems, response.body?.ok === false, "超深树失败响应应 ok=false");
    const diagnostic = `${response.body?.code ?? ""} ${response.body?.error ?? ""}`;
    expectCondition(problems, /depth|深度|32/i.test(diagnostic), `失败信息未明确指向深度上限：${diagnostic || "<empty>"}`);

    const rootEntry = fixture.sessions.get(SID);
    expectCondition(problems, existsSync(rootEntry.dir), "超深失败时根会话目录被移动");
    expectCondition(problems, await readIfPresent(rootEntry.artifact) === rootEntry.content, "超深失败时根会话工件发生变化");
    expectCondition(problems, await readIfPresent(cachePath(fixture, SID)) === fixture.cacheContent.get(SID), "超深失败时根会话缓存被清除");
    for (const entry of chain) {
      expectCondition(problems, existsSync(entry.dir), `超深失败时 ${entry.id} 目录被移动`);
      expectCondition(problems, await readIfPresent(cachePath(fixture, entry.id)) === fixture.cacheContent.get(entry.id), `超深失败时 ${entry.id} 缓存被清除`);
    }
    expectCondition(problems, host.calls.workspaceDetach.length === 0, "超深失败时仍调用了 workspace.detachSession");
    assertNoProblems(problems);
  }));

  console.log("\n[5] 默认 JSONL v4 冷会话全链路回归");
  await test("默认 JSONL v4 冷会话 trash → restore → delete 成功", () => scenario({}, async (fixture, host) => {
    const entry = fixture.sessions.get(SID);
    const originalArtifact = await readFile(entry.artifact, "utf8");
    const originalCache = await readFile(cachePath(fixture, SID), "utf8");

    const trashed = await call(host, "POST", "/trash", { sessionId: SID });
    assert.equal(trashed.status, 200, `trash 应成功，实际 ${trashed.status}: ${JSON.stringify(trashed.body)}`);
    assert.equal(trashed.body?.result?.trashed, true);
    assert.equal(trashed.body?.result?.filesMoved, true);
    assert.equal(existsSync(entry.dir), false, "trash 后原目录仍存在");
    assert.equal(existsSync(itemPath(fixture, SID)), true, "trash 后回收站目录不存在");

    const restored = await call(host, "POST", "/trash/restore", { sessionId: SID });
    assert.equal(restored.status, 200, `restore 应成功，实际 ${restored.status}: ${JSON.stringify(restored.body)}`);
    assert.equal(restored.body?.result?.filesRestored, true);
    assert.equal(await readFile(entry.artifact, "utf8"), originalArtifact, "restore 后工件内容不一致");
    assert.equal(await readFile(cachePath(fixture, SID), "utf8"), originalCache, "restore 后缓存内容不一致");
    assert.equal(existsSync(itemPath(fixture, SID)), false, "restore 后回收站目录仍存在");

    // restore 已清掉回收站项；重新 trash 后才能验证永久 delete。
    const retrashed = await call(host, "POST", "/trash", { sessionId: SID });
    assert.equal(retrashed.status, 200, `purge 前重新 trash 应成功，实际 ${retrashed.status}: ${JSON.stringify(retrashed.body)}`);
    assert.equal(retrashed.body?.result?.trashed, true);

    const purged = await call(host, "POST", "/trash/delete", { sessionIds: [SID] });
    assert.equal(purged.status, 200, `purge 应成功，实际 ${purged.status}: ${JSON.stringify(purged.body)}`);
    assert.equal(purged.body?.result?.results?.[0]?.deleted, true, "purge 结果未 deleted=true");
    assert.equal(existsSync(itemPath(fixture, SID)), false, "purge 后回收站目录仍存在");
    assert.equal(existsSync(metaPath(fixture, SID)), false, "purge 后快照仍存在");
  }));
} finally {
  await rm(TEMP_ROOT, { recursive: true, force: true });
  console.log(`\n临时目录已清理：${TEMP_ROOT}`);
}

console.log(`\n结果：${passed} 通过 / ${failed} 失败`);
process.exitCode = failed === 0 ? 0 : 1;
