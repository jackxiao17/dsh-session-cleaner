// dsh-session-cleaner 验证台：node scripts/verify.mjs
// 维护者工具（不参与插件运行、不进发行包）。用 mock 宿主 + 真实文件系统，把删除 / 恢复 / 彻底删除 / 启动对账 / 过期清理 /
// 重复目录 / 孤儿项 这些路径真跑一遍。
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm, rename, stat } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, resolve, relative, isAbsolute } from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const mod = await import(pathToFileURL(join(ROOT, "lib", "index.js")).href);

let pass = 0, fail = 0;
const ok = (cond, label, extra = "") => {
  if (cond) { pass++; console.log("  ✓ " + label); }
  else { fail++; console.log("  ✗ " + label + (extra ? "  → " + extra : "")); }
};
const eq = (actual, expected, label) => ok(actual === expected, label, `期望 ${JSON.stringify(expected)}，实际 ${JSON.stringify(actual)}`);

// ───────────────────────── 基础工具 ─────────────────────────

const SID = "session-11111111-2222-3333-4444-555555555555";
const ANCHOR = "session-99999999-8888-7777-6666-555555555555";
const PROJ = "F--work-demo--";
const OTHER = "F--other--";

// DSH 0.2.2-rc.1 起定时任务的归属写在 target.sessionId，顶层不再带 sessionId；
// 更早写入的行仍可能只有顶层 sessionId，插件两种情况都要认。
const ownedBy = (entry, sessionId) => entry?.target?.sessionId === sessionId || entry?.sessionId === sessionId;

async function makeHome() {
  const home = await mkdtemp(join(tmpdir(), "dsh-verify-"));
  await mkdir(join(home, "sessions", PROJ, SID), { recursive: true });
  await mkdir(join(home, "sessions", PROJ, ANCHOR), { recursive: true });
  await mkdir(join(home, "storages", "session_projcache", "sessions"), { recursive: true });
  const header = JSON.stringify({ type: "session", id: SID, cwd: "F:\\work\\demo", createdAt: 1 }) + "\n";
  const events = header
    + JSON.stringify({ type: "turn/start", time: 2 }) + "\n"
    + JSON.stringify({ type: "user/message", time: 3, data: { source: { kind: "user" }, content: "帮我看看室分方案" } }) + "\n"
    + JSON.stringify({ type: "assistant/message", time: 4, data: { message: { content: [{ type: "text", text: "好的" }], source: { model: "deepseek-flash" } } } }) + "\n";
  await writeFile(join(home, "sessions", PROJ, SID, "session.jsonl"), events);
  await writeFile(join(home, "sessions", PROJ, ANCHOR, "session.jsonl"),
    JSON.stringify({ type: "session", id: ANCHOR, cwd: "F:\\work\\demo", createdAt: 1 }) + "\n");
  const row = JSON.stringify({ version: 7, record: { identity: { formatVersion: 4, createdAt: 1, cwd: "F:\\work\\demo", isSeeded: false }, rows: { title: { ver: 1, seq: 3, val: "室分方案" } } } });
  await writeFile(join(home, "storages", "session_projcache", "sessions", `${SID}.json`), row);
  await writeFile(join(home, "storages", "session_projcache", "sessions", `${SID}.json.bak.202601011200`), row);
  await writeFile(join(home, "storages", "session_projcache", "sessions", `${ANCHOR}.json`), row);
  return { home, row };
}

function makeHost(home, opts = {}) {
  const log = { warnings: [], infos: [] };
  const call = { insertSessionBefore: [], stopSessionTasks: 0, scheduleDelete: [], scheduleEdit: [] };

  // 工作区：一个工作区，槽位顺序 [A, S, B]
  const slots = [ANCHOR + "-prev", SID, ANCHOR];
  const ws = {
    id: "ws-1",
    path: "F:\\work\\demo",
    get sessionIds() { return [...slots]; },
    async attachSession(id) { if (!slots.includes(id)) slots.unshift(id); },
    async detachSession(id) { const i = slots.indexOf(id); if (i !== -1) slots.splice(i, 1); },
    async insertSessionBefore(id, before) {
      call.insertSessionBefore.push([id, before]);
      const i = slots.indexOf(id); if (i !== -1) slots.splice(i, 1);
      if (before === undefined) slots.push(id);
      else { const at = slots.indexOf(before); if (at === -1) throw new Error("WorkspaceMoveInvalidError: anchor not accounted"); slots.splice(at, 0, id); }
    }
  };
  const global = { archivedSessionIds: [], pinnedSessionIds: [SID] };
  const registry = {
    list: () => [ws],
    get: (id) => (id === "ws-1" ? ws : undefined),
    get archivedSessionIds() { return global.archivedSessionIds; },
    get pinnedSessionIds() { return global.pinnedSessionIds; },
    async pinSession(id) { if (!global.pinnedSessionIds.includes(id)) global.pinnedSessionIds.unshift(id); },
    async unpinSession(id) { global.pinnedSessionIds = global.pinnedSessionIds.filter(x => x !== id); },
    async enqueueOperation(fn) { return await fn(); },
    requireState: () => ({ ...global, workspaceIds: ["ws-1"] }),
    async setState(next) {
      if (Array.isArray(next.archivedSessionIds)) global.archivedSessionIds = next.archivedSessionIds;
      if (Array.isArray(next.pinnedSessionIds)) global.pinnedSessionIds = next.pinnedSessionIds;
    }
  };

  const projRows = new Map();
  // domainAbsent 复现真机场景：记录是宿主启动后才写到磁盘的，不在域启动时载入的
  // 内存表里 —— 此时 delete 返回 false 且不碰磁盘，插件必须回落到文件删除并如实回报。
  const domainTable = {
    async delete(key) {
      if (opts.domainAbsent) return false;
      projRows.set(key, "deleted-by-domain");
      await rm(join(home, "storages", "session_projcache", "sessions", `${key}.json`), { force: true });
      return true;
    },
    async put(key, value) { projRows.set(key, value); return undefined; }
  };
  const storageDomain = opts.noStorageDomain ? undefined : { get: (name) => (name === "session_projcache" ? { table: () => domainTable } : undefined) };

  const schedules = [
    // 0.2.2-rc.1 形状：归属在 target.sessionId，顶层没有 sessionId
    { id: "schedule-aaaa", target: { kind: "session", sessionId: SID }, involvedSessionIds: [SID], status: "active", kind: "at", title: "提醒", prompt: "p", scheduledAt: "2099-01-01T00:00:00.000Z" },
    { id: "schedule-bbbb", target: { kind: "session", sessionId: SID }, involvedSessionIds: [SID], status: "inactive", kind: "at", title: "旧提醒", prompt: "p", scheduledAt: "2020-01-01T00:00:00.000Z" },
    // 老格式行：只有顶层 sessionId，宿主仍会读入，插件必须照样认
    { id: "schedule-legacy", sessionId: SID, status: "inactive", kind: "at", title: "上古提醒", prompt: "p", scheduledAt: "2019-01-01T00:00:00.000Z" },
    { id: "schedule-cccc", target: { kind: "session", sessionId: "other-session" }, involvedSessionIds: ["other-session"], status: "active", kind: "at", title: "别人的", prompt: "p", scheduledAt: "2099-01-01T00:00:00.000Z" }
  ];
  const removeRow = (id) => {
    const i = schedules.findIndex(s => s.id === id);
    if (i === -1) return false;
    schedules.splice(i, 1);
    return true;
  };
  const schedule = {
    async catalog() { return schedules.map(s => ({ ...s })); },
    // 0.2.2-rc.1 的 list() 只做分页，sessionId 过滤已移除
    async list({ active, limit = 50, offset = 0 } = {}) {
      const filtered = schedules.filter(s => active === undefined || (s.status === "active") === active);
      const items = filtered.slice(offset, offset + limit).map(s => ({ ...s }));
      return { items, shown: items.length, total: filtered.length, limit, offset };
    },
    async stopSessionTasks(sessionId) {
      call.stopSessionTasks++;
      for (let i = schedules.length - 1; i >= 0; i--) {
        if (ownedBy(schedules[i], sessionId) && schedules[i].status === "active") schedules.splice(i, 1);
      }
    },
    ...(opts.legacyScheduleApi
      ? {
        // 旧宿主（≤0.2.1）的删单条接口
        async delete({ sessionId, id }) {
          call.scheduleDelete.push([sessionId, id]);
          const row = schedules.find(s => s.id === id);
          if (row === undefined || !ownedBy(row, sessionId)) return { id, deleted: false, code: "schedule_not_found" };
          removeRow(id);
          return { id, deleted: true };
        }
      }
      : {
        // 0.2.2-rc.1：删单条只剩 edit({id, action:"delete"})
        async edit(request, actorSessionId) {
          if (request.action !== "delete") throw new Error("verify: 只实现了 delete");
          call.scheduleEdit.push([actorSessionId, request.id]);
          if (!removeRow(request.id)) return { id: request.id, code: "schedule_not_found" };
          return { id: request.id, deleted: true };
        }
      })
  };

  const routes = [];
  const disposers = [];
  const timers = [];
  const services = {
    dshHomePath: (sub) => join(home, sub),
    workspaceRegistry: registry,
    storageDomain,
    schedule: opts.noSchedule ? undefined : schedule
  };
  const ctx = {
    logger: { info: (m) => log.infos.push(String(m)), warn: (m) => log.warnings.push(String(m)), error: (m) => log.warnings.push(String(m)) },
    get: (name) => services[name],
    effect: (fn) => { const d = fn(); if (typeof d === "function") disposers.push(d); return d; },
    emit: () => {},
    webServer: { register: (route) => { routes.push(route); return () => {}; } }
  };
  return { ctx, routes, log, call, slots, global, schedules, projRows, disposers, timers };
}

async function call(host, method, path, body) {
  const handler = host.routes[0].handler;
  const chunks = body === undefined ? [] : [Buffer.from(JSON.stringify(body))];
  const req = {
    method,
    url: "/session-cleaner/api" + path,
    headers: {},
    async *[Symbol.asyncIterator]() { for (const c of chunks) yield c; }
  };
  const out = { status: 0, body: undefined };
  const res = { writeHead(code) { out.status = code; }, end(text) { try { out.body = JSON.parse(text); } catch { out.body = text; } } };
  await handler(req, res);
  return out;
}

// ───────────────────────── 1. 纯函数 ─────────────────────────

console.log("\n[1] 纯函数与路径校验");
eq(mod.name, "dsh-session-cleaner", "导出插件名");
ok(typeof mod.apply === "function", "导出 apply()");
for (const bad of ["", "  ", ".", "..", "a/b", "a\\b", "a:b", "x\u0000y", "trail.", "trail ", 'q"q', "a*b"]) {
  let threw = false;
  try { mod.assertSessionId(bad); } catch { threw = true; }
  ok(threw, `assertSessionId 拒绝 ${JSON.stringify(bad)}`);
}
eq(mod.assertSessionId(SID), SID, "assertSessionId 放行正常 id");
// 会话目录名用宿主的 encodeSegment：安全字符原样，其余转 ~XXXX。
// 注意 assertSessionId 已经拒绝 / \ : 等字符，所以这里用"能过校验但仍需转义"的字符。
eq(mod.encodeSessionSegment(SID), SID, "正常 id 的目录名就是 id 本身（与磁盘一致）");
eq(mod.encodeSessionSegment("a~b"), "a~007Eb", "'~' 自身也转义");
eq(mod.encodeSessionSegment("会话-1"), "~4F1A~8BDD-1", "非 ASCII 字符逐单元转义");
eq(mod.encodeSessionSegment("a b"), "a~0020b", "空格不在宿主安全字符表里，同样转义");
{
  const home = await mkdtemp(join(tmpdir(), "dsh-seg-"));
  await mkdir(join(home, "p", SID), { recursive: true });
  eq(await mod.assertSessionDirectory(home, join(home, "p", SID), SID), resolve(join(home, "p", SID)), "合法会话目录通过校验");
  let threw = false;
  try { await mod.assertSessionDirectory(home, join(home, "p"), SID); } catch { threw = true; }
  ok(threw, "拒绝层级不足的目录");
  threw = false;
  try { await mod.assertSessionDirectory(home, join(home, "..", "outside", SID), SID); } catch { threw = true; }
  ok(threw, "拒绝越界目录");
  await rm(home, { recursive: true, force: true });
}

// ───────────────────────── 2. 删除 → 恢复 全链路 ─────────────────────────

console.log("\n[2] 移入回收站 / 恢复");
{
  const { home, row } = await makeHome();
  const host = makeHost(home);
  mod.apply(host.ctx);

  const before = await call(host, "POST", "/trash/list");
  eq(before.body.result.items.length, 0, "初始回收站为空");

  const trashed = await call(host, "POST", "/trash", { sessionId: SID });
  eq(trashed.status, 200, "POST /trash 返回 200");
  ok(trashed.body.result.trashed === true, "标记 trashed");
  ok(trashed.body.result.filesMoved === true, "目录已搬入回收站");
  const itemDir = join(home, "dsh-session-cleaner", "trash", "items", SID);
  ok(existsSync(itemDir), "回收站里出现会话目录");
  ok(!existsSync(join(home, "sessions", PROJ, SID)), "原目录已消失");
  const meta = JSON.parse(await readFile(join(home, "dsh-session-cleaner", "trash", "meta", `${SID}.json`), "utf8"));
  eq(meta.version, 3, "meta 版本 3（带 descendants 字段）");
  eq(meta.stage, "trashed", "meta stage=trashed");
  eq(meta.filesMoved, true, "meta filesMoved=true");
  eq(meta.workspaceAnchorId, ANCHOR, "记下恢复锚点（原后继会话）");
  eq(meta.workspaceWasLast, false, "记下“不是最后一条”");
  eq(meta.wasPinned, true, "记下删除前是置顶状态");
  eq(meta.pinIndex, 0, "记下置顶位次");
  eq(meta.projcacheRow, row, "快照里存了投影缓存行原文");
  const listed = await call(host, "POST", "/trash/list");
  const listedItem = listed.body.result.items.find(i => i.id === SID);
  ok(listedItem !== undefined && listedItem.projcacheRow === undefined, "列表响应不携带投影缓存行原文（只回展示字段）");
  eq(meta.schedules.length, 3, "快照里抄录了该会话的 3 条定时任务（新格式 + 老格式）");
  eq(trashed.body.result.schedulesKept, 3, "响应回报定时任务仍在");
  eq(trashed.body.result.cacheRemoved, true, "投影缓存行已删");
  eq(trashed.body.result.cacheBackupsRemoved, 1, "投影缓存备份文件已删");
  ok(!existsSync(join(home, "storages", "session_projcache", "sessions", `${SID}.json`)), "缓存行文件不在了");
  ok(!existsSync(join(home, "storages", "session_projcache", "sessions", `${SID}.json.bak.202601011200`)), "缓存备份文件不在了");
  ok(host.projRows.get(SID) === "deleted-by-domain", "走的是宿主存储域的表删除");
  eq(host.slots.join(","), [ANCHOR + "-prev", ANCHOR].join(","), "记账槽位已摘掉");
  eq(host.global.pinnedSessionIds.length, 0, "置顶已清");
  eq(host.schedules.filter(s => ownedBy(s, SID)).length, 3, "回收站阶段不动定时任务");

  const restored = await call(host, "POST", "/trash/restore", { sessionId: SID });
  eq(restored.status, 200, "POST /trash/restore 返回 200");
  ok(restored.body.result.filesRestored === true, "目录搬回原位");
  ok(existsSync(join(home, "sessions", PROJ, SID)), "原目录回来了");
  ok(!existsSync(itemDir), "回收站里的副本已清");
  eq(await readFile(join(home, "storages", "session_projcache", "sessions", `${SID}.json`), "utf8"), row, "缓存行原文逐字节还原");
  ok(restored.body.result.cacheRestored === true, "响应回报缓存已还原");
  ok(restored.body.result.positionRestored === true, "槽位还原");
  eq(host.call.insertSessionBefore.length, 1, "只做了一次换位调用");
  eq(host.call.insertSessionBefore[0].join(","), `${SID},${ANCHOR}`, "用锚点插回原位（不是简单前插）");
  eq(host.slots.join(","), [ANCHOR + "-prev", SID, ANCHOR].join(","), "槽位顺序与删除前一致");
  eq(restored.body.result.pinRestored, true, "置顶已还原");
  ok(host.global.pinnedSessionIds.includes(SID), "置顶集合里有它");
  eq(host.global.archivedSessionIds.length, 0, "归档集合未被误加");
  ok(!existsSync(join(home, "dsh-session-cleaner", "trash", "meta", `${SID}.json`)), "快照已删除");
  await rm(home, { recursive: true, force: true });
}

// ───────────────────────── 3. 彻底删除 ─────────────────────────

console.log("\n[3] 彻底删除（含定时任务与空工程目录）");
{
  const { home } = await makeHome();
  // 单独一个只放着 SID2 的工程目录，用来验证"删空了就连目录一起删"
  const SID2 = "session-solo-0000";
  await mkdir(join(home, "sessions", OTHER, SID2), { recursive: true });
  await writeFile(join(home, "sessions", OTHER, SID2, "session.jsonl"),
    JSON.stringify({ type: "session", id: SID2, cwd: "F:\\other", createdAt: 1 }) + "\n");
  const host = makeHost(home);
  mod.apply(host.ctx);
  await call(host, "POST", "/trash", { sessionId: SID });
  await call(host, "POST", "/trash", { sessionId: SID2 });

  const purged = await call(host, "POST", "/trash/delete", { sessionIds: [SID, SID2] });
  eq(purged.status, 200, "POST /trash/delete 返回 200");
  eq(purged.body.result.results[0].deleted, true, "该条已彻底删除");
  ok(!existsSync(join(home, "dsh-session-cleaner", "trash", "items", SID)), "回收站目录已删");
  ok(!existsSync(join(home, "dsh-session-cleaner", "trash", "meta", `${SID}.json`)), "快照已删");
  ok(host.call.stopSessionTasks >= 1, "调用了宿主的 stopSessionTasks");
  ok(host.call.scheduleEdit.length >= 1, "0.2.2-rc.1 的历史行用 edit({id,action:'delete'}) 删掉");
  eq(host.call.scheduleDelete.length, 0, "不再依赖 0.2.2-rc.1 已移除的 schedule.delete");
  ok(host.schedules.every(s => !ownedBy(s, SID)), "该会话的定时任务（含已结束的历史行）都没了");
  ok(host.schedules.some(s => ownedBy(s, "other-session")), "别的会话的定时任务没被误删");
  ok(!existsSync(join(home, "sessions", OTHER)), "只装着它的工程目录被删掉了");
  ok(existsSync(join(home, "sessions", PROJ)), "还有别的会话的工程目录不受影响");
  ok(Array.isArray(purged.body.result.results[0].notes), "回报了清理明细");
  await rm(home, { recursive: true, force: true });
}

// ───────────────────────── 3b. 旧宿主的 schedule.delete 回落 ─────────────────────────

console.log("\n[3b] 旧宿主（没有 edit()）回落 schedule.delete");
{
  const { home } = await makeHome();
  const host = makeHost(home, { legacyScheduleApi: true });
  mod.apply(host.ctx);
  await call(host, "POST", "/trash", { sessionId: SID });
  const purged = await call(host, "POST", "/trash/delete", { sessionIds: [SID] });
  eq(purged.status, 200, "POST /trash/delete 返回 200");
  ok(host.call.scheduleDelete.length >= 1, "走了旧的 schedule.delete");
  ok(host.schedules.every(s => !ownedBy(s, SID)), "旧宿主上该会话的定时任务也清干净了");
  ok(host.schedules.some(s => ownedBy(s, "other-session")), "别人的任务仍然保留");
  await rm(home, { recursive: true, force: true });
}

// ───────────────────────── 4. 并发锁 ─────────────────────────

console.log("\n[4] 同 id 操作串行化");
{
  const { home } = await makeHome();
  const host = makeHost(home);
  mod.apply(host.ctx);
  await call(host, "POST", "/trash", { sessionId: SID });
  const [r1, r2] = await Promise.all([
    call(host, "POST", "/trash/restore", { sessionId: SID }),
    call(host, "POST", "/trash/delete", { sessionIds: [SID] })
  ]);
  const outcomes = [r1, r2].map(r => `${r.status}:${r.body.ok}`);
  const consistent = (r1.status === 200 && r1.body.ok && existsSync(join(home, "sessions", PROJ, SID)))
    || (r2.status === 200 && r2.body.ok && !existsSync(join(home, "sessions", PROJ, SID)));
  ok(consistent, "恢复与彻底删除没有把状态搞成两半（" + outcomes.join(" / ") + "）");
  await rm(home, { recursive: true, force: true });

  // 已经恢复过的项，再点"彻底删除"必须如实回报 skipped，而不是假成功去清缓存/定时任务
  const h4 = await makeHome();
  const host4 = makeHost(h4.home);
  mod.apply(host4.ctx);
  await call(host4, "POST", "/trash", { sessionId: SID });
  await call(host4, "POST", "/trash/restore", { sessionId: SID });
  const stale = await call(host4, "POST", "/trash/delete", { sessionIds: [SID] });
  eq(stale.body.result.results[0].deleted, false, "已恢复的项不再被当成已删除");
  eq(stale.body.result.results[0].skipped, true, "如实回报 skipped");
  ok(existsSync(join(h4.home, "sessions", PROJ, SID)), "刚恢复的会话目录没被误删");
  ok(existsSync(join(h4.home, "storages", "session_projcache", "sessions", `${SID}.json`)), "刚恢复的缓存行没被误清");
  ok(host4.schedules.some(s => ownedBy(s, SID)), "刚恢复的会话的定时任务没被误清");
  await rm(h4.home, { recursive: true, force: true });
}

// ───────────────────────── 4b. 子会话级联 ─────────────────────────

console.log("\n[4b] 子会话（subagent）随父会话一起走");
{
  // 一个父会话 + 两个直接子会话 + 一个孙会话，各自带日志、缓存行、记账槽位
  const CHILD1 = "session-child-0001";
  const CHILD2 = "session-child-0002";
  const GRAND = "session-grand-0003";
  const { home, row } = await makeHome();
  const mk = async (id, parent) => {
    await mkdir(join(home, "sessions", PROJ, id), { recursive: true });
    const header = { type: "session", id, cwd: "F:\\work\\demo", createdAt: 1, isSeeded: false, delegationDepth: parent ? 1 : 0 };
    if (parent) { header.parentSession = parent; header.origin = "subagent"; }
    await writeFile(join(home, "sessions", PROJ, id, "session.jsonl"),
      JSON.stringify(header) + "\n" + JSON.stringify({ type: "turn/start", time: 2 }) + "\n");
    await writeFile(join(home, "storages", "session_projcache", "sessions", `${id}.json`), row);
  };
  await mk(CHILD1, SID);
  await mk(CHILD2, SID);
  await mk(GRAND, CHILD1);
  // 另一个不相干父会话的子会话，绝不能被带进来
  await mk("session-stranger-0004", "session-someone-else");

  const host = makeHost(home);
  mod.apply(host.ctx);
  const trashed = await call(host, "POST", "/trash", { sessionId: SID });
  eq(trashed.status, 200, "删除带子会话的父会话 → 200");
  eq(trashed.body.result.descendantsCount, 3, "发现 3 个后代（2 子 + 1 孙）");
  ok(trashed.body.result.descendants.every(d => d.filesMoved === true), "每个后代的目录都搬走了");
  for (const id of [SID, CHILD1, CHILD2, GRAND]) {
    ok(!existsSync(join(home, "sessions", PROJ, id)), `${id} 的原目录已消失`);
    ok(!existsSync(join(home, "storages", "session_projcache", "sessions", `${id}.json`)), `${id} 的投影缓存行已删`);
  }
  ok(existsSync(join(home, "sessions", PROJ, "session-stranger-0004")), "别人的子会话没被牵连");
  ok(existsSync(join(home, "dsh-session-cleaner", "trash", "items", SID, ".children", CHILD1)), "子会话目录在父项的 .children/ 下");
  ok(existsSync(join(home, "dsh-session-cleaner", "trash", "items", SID, ".children", GRAND)), "孙会话也在");

  // 恢复：父 + 全部后代一起回位，缓存行逐字还原
  const restored = await call(host, "POST", "/trash/restore", { sessionId: SID });
  eq(restored.status, 200, "恢复整棵树 → 200");
  eq(restored.body.result.descendantsCount, 3, "回报恢复了 3 个后代");
  for (const id of [SID, CHILD1, CHILD2, GRAND]) {
    ok(existsSync(join(home, "sessions", PROJ, id)), `${id} 目录回位`);
    eq(await readFile(join(home, "storages", "session_projcache", "sessions", `${id}.json`), "utf8"), row, `${id} 缓存行原文还原`);
  }
  ok(!existsSync(join(home, "dsh-session-cleaner", "trash", "items", SID)), "回收站里的父项已清空");
  await rm(home, { recursive: true, force: true });

  // 彻底删除：父 + 后代一起没，缓存行/定时任务/工程目录都收尾
  const h5 = await makeHome();
  // 子会话单独造（父会话已由 makeHome 建好）
  const mkChild = async (id, parent) => {
    await mkdir(join(h5.home, "sessions", PROJ, id), { recursive: true });
    await writeFile(join(h5.home, "sessions", PROJ, id, "session.jsonl"),
      JSON.stringify({ type: "session", id, cwd: "F:\\work\\demo", createdAt: 1, isSeeded: false, delegationDepth: 1, parentSession: parent, origin: "subagent" }) + "\n");
    await writeFile(join(h5.home, "storages", "session_projcache", "sessions", `${id}.json`), row);
  };
  await mkChild(CHILD1, SID);
  await mkChild(GRAND, CHILD1);
  const host5 = makeHost(h5.home);
  mod.apply(host5.ctx);
  await call(host5, "POST", "/trash", { sessionId: SID });
  // 给父子都挂上定时任务，验证彻底删除时一起清
  host5.schedules.push({ id: "schedule-p", target: { kind: "session", sessionId: SID }, involvedSessionIds: [SID], status: "active", kind: "at", title: "t", prompt: "p", scheduledAt: "2099-01-01T00:00:00.000Z" });
  host5.schedules.push({ id: "schedule-c", target: { kind: "session", sessionId: CHILD1 }, involvedSessionIds: [CHILD1], status: "active", kind: "at", title: "t", prompt: "p", scheduledAt: "2099-01-01T00:00:00.000Z" });
  const purged = await call(host5, "POST", "/trash/delete", { sessionIds: [SID] });
  eq(purged.body.result.results[0].deleted, true, "彻底删除父会话");
  eq(purged.body.result.results[0].descendantsPurged, 2, "回报清掉了 2 个后代");
  for (const id of [SID, CHILD1, GRAND]) {
    ok(!existsSync(join(h5.home, "storages", "session_projcache", "sessions", `${id}.json`)), `${id} 缓存行彻底清掉`);
    ok(!host5.schedules.some(s => ownedBy(s, id)), `${id} 的定时任务已清`);
  }
  ok(!existsSync(join(h5.home, "dsh-session-cleaner", "trash", "items", SID)), "回收站目录（含 .children）已删");
  await rm(h5.home, { recursive: true, force: true });

  // 崩溃窗口：父会话搬走了、子会话还没搬（stage=prepared）。
  // 对账必须"全有或全无"——把已搬走的父会话搬回原位，而不是留半棵在回收站里。
  const h6 = await makeHome();
  const mkChild6 = async (id, parent) => {
    await mkdir(join(h6.home, "sessions", PROJ, id), { recursive: true });
    await writeFile(join(h6.home, "sessions", PROJ, id, "session.jsonl"),
      JSON.stringify({ type: "session", id, cwd: "F:\\work\\demo", createdAt: 1, isSeeded: false, delegationDepth: 1, parentSession: parent, origin: "subagent" }) + "\n");
    await writeFile(join(h6.home, "storages", "session_projcache", "sessions", `${id}.json`), row);
  };
  await mkChild6(CHILD1, SID);
  const host6 = makeHost(h6.home);
  mod.apply(host6.ctx);
  // 手工制造"搬了一半"：只搬父会话，快照停留在 prepared
  const binItems = join(h6.home, "dsh-session-cleaner", "trash", "items");
  const binMeta = join(h6.home, "dsh-session-cleaner", "trash", "meta");
  await mkdir(binItems, { recursive: true });
  await mkdir(binMeta, { recursive: true });
  await rename(join(h6.home, "sessions", PROJ, SID), join(binItems, SID));
  await writeFile(join(binMeta, `${SID}.json`), JSON.stringify({
    version: 3, id: SID, stage: "prepared", filesMoved: false,
    originalDir: join(h6.home, "sessions", PROJ, SID), deletedAt: Date.now(), bytes: 10,
    descendants: [{ id: CHILD1, originalDir: join(h6.home, "sessions", PROJ, CHILD1), projcacheRow: row }]
  }));
  // 重启（重新 apply）触发对账
  mod.apply(makeHost(h6.home).ctx);
  await new Promise(r => setTimeout(r, 250));
  ok(existsSync(join(h6.home, "sessions", PROJ, SID)), "对账把只搬了一半的父会话搬回原位");
  ok(existsSync(join(h6.home, "sessions", PROJ, CHILD1)), "没搬过的子会话还在原位");
  ok(!existsSync(join(binItems, SID)), "回收站里不留半棵树");
  ok(!existsSync(join(binMeta, `${SID}.json`)), "半途快照被撤掉");
  await rm(h6.home, { recursive: true, force: true });
}

// ───────────────────────── 4c. 缓存行删除的三种落点 ─────────────────────────

console.log("\n[4c] 投影缓存行删除：域表 / 文件 / 回报如实");
{
  // 场景一（真机最常见）：记录不在域的内存表里 → delete 返回 false 且不碰磁盘，
  // 必须回落到文件删除，且 cacheViaService 要如实回报 false
  const { home } = await makeHome();
  const host = makeHost(home, { domainAbsent: true });
  mod.apply(host.ctx);
  const r1 = await call(host, "POST", "/trash", { sessionId: SID });
  eq(r1.body.result.cacheRemoved, true, "域表说没有 → 文件仍然删掉了");
  eq(r1.body.result.cacheViaService, false, "如实回报不是走域表删的");
  ok(!existsSync(join(home, "storages", "session_projcache", "sessions", `${SID}.json`)), "磁盘上确实没有了");
  await rm(home, { recursive: true, force: true });

  // 场景二：域表里有记录 → 走域表，回报 true
  const h2 = await makeHome();
  const host2 = makeHost(h2.home);
  mod.apply(host2.ctx);
  const r2 = await call(host2, "POST", "/trash", { sessionId: SID });
  eq(r2.body.result.cacheViaService, true, "域表里有记录 → 走域表并如实回报");
  eq(host2.projRows.get(SID), "deleted-by-domain", "确实是域表删的");
  await rm(h2.home, { recursive: true, force: true });

  // 场景三：存储域服务根本没挂 → 只有文件删除，回报 false
  const h3 = await makeHome();
  const host3 = makeHost(h3.home, { noStorageDomain: true });
  mod.apply(host3.ctx);
  const r3 = await call(host3, "POST", "/trash", { sessionId: SID });
  eq(r3.body.result.cacheRemoved, true, "没有存储域服务也能删掉缓存行");
  eq(r3.body.result.cacheViaService, false, "如实回报没走域表");
  await rm(h3.home, { recursive: true, force: true });
}

// ───────────────────────── 5. 边界与错误路径 ─────────────────────────

console.log("\n[5] 边界与错误路径");
{
  // 重复目录
  const { home } = await makeHome();
  await mkdir(join(home, "sessions", OTHER, SID), { recursive: true });
  await writeFile(join(home, "sessions", OTHER, SID, "session.jsonl"),
    JSON.stringify({ type: "session", id: SID, cwd: "F:\\other", createdAt: 1 }) + "\n");
  const host = makeHost(home);
  mod.apply(host.ctx);
  const dup = await call(host, "POST", "/trash", { sessionId: SID });
  eq(dup.status, 409, "同一 id 两份日志 → 409 拒绝");
  eq(dup.body.code, "duplicate-session-dirs", "错误码 duplicate-session-dirs");
  ok(existsSync(join(home, "sessions", PROJ, SID)), "拒绝时没有动任何一份目录");
  await rm(home, { recursive: true, force: true });

  // 无定时任务服务
  const h2 = await makeHome();
  const host2 = makeHost(h2.home, { noSchedule: true });
  mod.apply(host2.ctx);
  const t2 = await call(host2, "POST", "/trash", { sessionId: SID });
  eq(t2.status, 200, "宿主没挂 schedule 时删除仍成功");
  eq(t2.body.result.schedulesSupported, false, "并如实回报不支持");
  await rm(h2.home, { recursive: true, force: true });

  // 不存在的会话 / 非法 id / 坏 body
  const h3 = await makeHome();
  const host3 = makeHost(h3.home);
  mod.apply(host3.ctx);
  const ghost = await call(host3, "POST", "/trash", { sessionId: "session-nonexistent" });
  eq(ghost.status, 200, "磁盘上没有的会话：走“没有磁盘文件”的路径");
  eq(ghost.body.result.filesMoved, false, "没有文件可搬");
  const badId = await call(host3, "POST", "/trash", { sessionId: "../evil" });
  eq(badId.status, 400, "非法 sessionId → 400");
  const notFound = await call(host3, "POST", "/trash/restore", { sessionId: "session-never-trashed" });
  eq(notFound.status, 404, "恢复一个从没进过回收站的会话 → 404");
  eq(notFound.body.code, "session-not-found", "错误码 session-not-found");
  const removedStatus = await call(host3, "POST", "/status", { sessionId: SID });
  eq(removedStatus.status, 404, "已移除的 /status 端点 → 404");
  const removedDelete = await call(host3, "POST", "/delete", { sessionId: SID });
  eq(removedDelete.status, 404, "已移除的 /delete 端点 → 404");
  await rm(h3.home, { recursive: true, force: true });
}

// ───────────────────────── 6. 启动对账 ─────────────────────────

console.log("\n[6] 启动对账（崩溃窗口）");
{
  const { home } = await makeHome();
  const trashItems = join(home, "dsh-session-cleaner", "trash", "items");
  const trashMeta = join(home, "dsh-session-cleaner", "trash", "meta");
  const ORPHAN = "session-orphan-0000";
  const PREPARED = "session-prepared-0000";
  await mkdir(join(trashItems, ORPHAN), { recursive: true });
  await writeFile(join(trashItems, ORPHAN, "session.jsonl"), "{}\n");
  await mkdir(trashMeta, { recursive: true });
  await writeFile(join(trashMeta, `${ORPHAN}.1234abcd.tmp`), "{}");
  // 崩溃窗口：快照写了 stage=prepared，但文件还没搬走（原目录仍在）
  await mkdir(join(home, "sessions", PROJ, PREPARED), { recursive: true });
  await writeFile(join(home, "sessions", PROJ, PREPARED, "session.jsonl"),
    JSON.stringify({ type: "session", id: PREPARED, cwd: "F:\\work\\demo", createdAt: 1 }) + "\n");
  await writeFile(join(trashMeta, `${PREPARED}.json`), JSON.stringify({
    version: 2, id: PREPARED, stage: "prepared", filesMoved: false,
    originalDir: join(home, "sessions", PROJ, PREPARED), deletedAt: Date.now(), bytes: 10
  }));

  const host = makeHost(home);
  mod.apply(host.ctx);
  await new Promise(r => setTimeout(r, 250)); // 让 effect 里的对账跑完

  const metaFiles = await readdir(trashMeta);
  ok(!metaFiles.some(f => f.endsWith(".tmp")), "残留的 .tmp 快照被清掉");
  ok(!metaFiles.includes(`${PREPARED}.json`), "“没搬成”的快照被回滚（会话仍在原位）");
  ok(existsSync(join(home, "sessions", PROJ, PREPARED)), "回滚没有误删原目录");
  ok(metaFiles.includes(`${ORPHAN}.json`), "孤儿目录被收编成一条快照");
  const orphanMeta = JSON.parse(await readFile(join(trashMeta, `${ORPHAN}.json`), "utf8"));
  eq(orphanMeta.stage, "incomplete", "收编项标记为 incomplete");
  const list = await call(host, "POST", "/trash/list");
  ok(list.body.result.items.some(i => i.id === ORPHAN), "收编项在面板里可见（不再白占磁盘）");
  const restoreOrphan = await call(host, "POST", "/trash/restore", { sessionId: ORPHAN });
  eq(restoreOrphan.status, 409, "收编项拒绝恢复（原路径不可知）");
  eq(restoreOrphan.body.code, "incomplete-item", "错误码 incomplete-item");
  const purgeOrphan = await call(host, "POST", "/trash/delete", { sessionIds: [ORPHAN] });
  eq(purgeOrphan.body.result.results[0].deleted, true, "收编项可以彻底删除");

  // 没有磁盘文件的"空会话"进了回收站，跨重启不能被对账当成假条目清掉
  const GHOST = "session-ghost-0000";
  await call(host, "POST", "/trash", { sessionId: GHOST });
  const ghostHost = makeHost(home);
  mod.apply(ghostHost.ctx);
  await new Promise(r => setTimeout(r, 250));
  const ghostMeta = await readFile(join(trashMeta, `${GHOST}.json`), "utf8").then(JSON.parse).catch(() => undefined);
  ok(ghostMeta !== undefined, "无文件的回收项跨重启仍在（没被对账误清）");
  eq(ghostMeta?.stage, "trashed", "它的 stage 仍是 trashed");
  const ghostList = await call(ghostHost, "POST", "/trash/list");
  ok(ghostList.body.result.items.some(i => i.id === GHOST), "面板里仍可见");
  const ghostRestore = await call(ghostHost, "POST", "/trash/restore", { sessionId: GHOST });
  eq(ghostRestore.status, 200, "无文件项可以恢复（恢复记账与缓存记录）");
  await rm(home, { recursive: true, force: true });
}

// ───────────────────────── 7. 保留期 ─────────────────────────

console.log("\n[7] 保留期与定时清理");
{
  const { home } = await makeHome();
  const host = makeHost(home);
  // 拦 setInterval，拿到插件注册的清理回调
  const realSetInterval = globalThis.setInterval;
  let purgeCallback;
  globalThis.setInterval = (fn, ms) => { purgeCallback = fn; return { unref() {} }; };
  try {
    mod.apply(host.ctx);
    host.disposers.forEach(() => {});
  } finally { globalThis.setInterval = realSetInterval; }
  ok(typeof purgeCallback === "function", "注册了周期性清理回调");

  await call(host, "POST", "/trash", { sessionId: SID });
  const metaPath = join(home, "dsh-session-cleaner", "trash", "meta", `${SID}.json`);
  const meta = JSON.parse(await readFile(metaPath, "utf8"));
  meta.deletedAt = Date.now() - 31 * 24 * 60 * 60 * 1000; // 31 天前
  await writeFile(metaPath, JSON.stringify(meta));
  const listBefore = await call(host, "POST", "/trash/list");
  eq(listBefore.body.result.items.length, 1, "过期项还在（尚未触发清理）");
  ok(typeof listBefore.body.result.nextPurgeAt === "number", "列出下次清理时刻");
  eq(listBefore.body.result.retentionDays, 30, "回报保留期 30 天");

  await purgeCallback();
  await new Promise(r => setTimeout(r, 300));
  const listAfter = await call(host, "POST", "/trash/list");
  eq(listAfter.body.result.items.length, 0, "超过 30 天的项被自动清掉");
  ok(!existsSync(join(home, "dsh-session-cleaner", "trash", "items", SID)), "对应的回收站目录也删了");
  await rm(home, { recursive: true, force: true });
}

// ───────────────────────── 8. 真实会话日志解析（只读） ─────────────────────────

console.log("\n[8] 真实 DSH 日志帧解析（只读本机样本）");
{
  const sessionsRoot = join(process.env.USERPROFILE ?? "", ".dsh", "sessions");
  let sample;
  try {
    for (const proj of await readdir(sessionsRoot)) {
      for (const id of await readdir(join(sessionsRoot, proj))) {
        for (const name of mod.ARTIFACT_NAMES) {
          const p = join(sessionsRoot, proj, id, name);
          if (existsSync(p)) { sample = p; break; }
        }
        if (sample) break;
      }
      if (sample) break;
    }
  } catch { /* 没有样本就跳过 */ }
  if (sample) {
    const header = await mod.readSessionHeader(sample);
    ok(typeof header.id === "string" && header.id.length > 0, "读到真实日志头（id=" + header.id.slice(0, 18) + "…）");
    const buf = await readFile(sample);
    if (sample.endsWith(".zstd")) {
      const { frames } = mod.scanZstdFrames(buf, 3);
      ok(frames.length > 0, "zstd 帧扫描成功（" + frames.length + " 帧）");
    } else {
      const { frames } = mod.scanZstdFrames(Buffer.from("not-zstd"));
      ok(frames.length === 0, "非 zstd 数据不误判为帧");
    }
  } else {
    console.log("  （本机没有会话日志样本，跳过）");
  }
}

// ───────────────────────── 9. 前端半边（真跑客户端 apply） ─────────────────────────

console.log("\n[9] 客户端 bundle（slot 注册与语言包）");
{
  const clientPath = join(ROOT, "lib", "client.js");
  const source = await readFile(clientPath, "utf8");
  let captured;
  class StubComponent {
    constructor(props) { this.props = props ?? {}; }
    setState() {}
    render() { return null; }
  }
  const reactBase = {
    createElement: (type, props, ...children) => ({ type, props, children }),
    Component: StubComponent,
    PureComponent: StubComponent,
    Fragment: "Fragment",
    useState: (v) => [v, () => {}],
    useEffect: () => {},
    useLayoutEffect: () => {},
    useMemo: (fn) => fn(),
    useCallback: (fn) => fn,
    useRef: (v) => ({ current: v }),
    useReducer: (r, init) => [init, () => {}],
    useSyncExternalStore: (sub, get) => get(),
    createContext: () => ({ Provider: null, Consumer: null }),
    forwardRef: (fn) => fn,
    memo: (fn) => fn
  };
  const stubReact = new Proxy(reactBase, {
    get: (target, key) => (key in target ? target[key] : () => null)
  });
  const fakeRequire = (id) => {
    if (id === "react") return stubReact;
    if (id === "@deepseek-ai/dsh-client-ui-primitives") return new Proxy({}, { get: () => () => null });
    throw new Error("unexpected require: " + id);
  };
  globalThis.window = { __ModuleLoader__: { load: (m) => { captured = m; } } };
  try {
    // 直接求值 bundle（它调用 window.__ModuleLoader__.load）
    const fn = new Function("require", source);
    fn(fakeRequire);
  } finally { delete globalThis.window; }
  ok(captured && typeof captured === "object", "客户端 bundle 调用了 __ModuleLoader__.load");
  eq(captured.id, "dsh-session-cleaner", "bundle id 正确");
  const exportsObj = captured.factory(fakeRequire);
  ok(typeof exportsObj.apply === "function", "客户端导出 apply()");
  ok(Array.isArray(exportsObj.inject), "客户端声明了 inject 列表");
  for (const need of ["slots", "locale", "sessions"]) {
    ok(exportsObj.inject.includes(need), `inject 声明了 ${need}`);
  }
  ok(!exportsObj.inject.includes("workspaces"), "inject 不再声明 workspaces（0.2.1-rc.3 的 workspaces 服务没有 refresh，插件也不再使用它）");

  const registrations = [];
  const dictionaries = [];
  const effects = [];
  const ctx = {
    effect: (fn, label) => { effects.push(label); const d = fn(); return d; },
    slots: {
      inject: (name, fn) => { registrations.push({ name, items: [...fn()] }); },
      register: (spec, component) => ({ spec, component })
    },
    locale: { register: (ns, dicts) => { dictionaries.push({ ns, dicts }); return () => {}; } }
  };
  exportsObj.apply(ctx);
  const slotNames = registrations.map(r => r.name);
  for (const need of ["sidebar.workspaces.session.menu.item", "sidebar.footer.action", "shell.overlay"]) {
    ok(slotNames.includes(need), `注册到 slot: ${need}`);
  }
  ok(registrations.every(r => r.items.every(i => i && i.spec && i.spec.id)), "每个注册项都有 id");
  const overlayCount = registrations.find(r => r.name === "shell.overlay")?.items.length ?? 0;
  eq(overlayCount, 2, "shell.overlay 注册了 toast 与回收站面板两个");
  eq(dictionaries.length, 1, "注册了一份语言包");
  const zh = dictionaries[0].dicts.zh, en = dictionaries[0].dicts.en;
  for (const key of ["trash.restored", "trash.restoredArchived", "trash.restoredMixed", "trash.purged", "toast.trashed", "menu.delete"]) {
    ok(typeof zh[key] === "string" && zh[key] !== "", `中文语言包有 ${key}`);
    ok(typeof en[key] === "string" && en[key] !== "", `英文语言包有 ${key}`);
  }
  eq(Object.keys(zh).length, Object.keys(en).length, "中英文语言包键数一致（不会漏译）");
  ok(effects.some(l => String(l).includes("styles")), "注入了样式 effect");
}

// ───────────────────────── 10. 截图声明与仓库一致性 ─────────────────────────
// contributing.md 的规矩：screenshots.json 放在 package.json 旁边，1-8 条，
// 相对路径不能跳出插件目录。这里顺手查一遍，防止改名后图片 404。

console.log("\n[10] screenshots.json 与 README 图片");
{
  const manifestPath = join(ROOT, "screenshots.json");
  ok(existsSync(join(ROOT, "package.json")), "package.json 在仓库根（screenshots.json 要挨着它）");
  let manifest;
  try { manifest = JSON.parse(await readFile(manifestPath, "utf8")); }
  catch (error) { ok(false, "screenshots.json 可解析", String(error)); manifest = undefined; }
  const list = Array.isArray(manifest) ? manifest : (Array.isArray(manifest?.screenshots) ? manifest.screenshots : undefined);
  ok(Array.isArray(list), "screenshots.json 是数组（或 {screenshots: [...]}）");
  if (Array.isArray(list)) {
    ok(list.length >= 1 && list.length <= 8, `截图数量在 1-8 之间（当前 ${list.length} 张）`);
    for (const entry of list) {
      const isRelative = typeof entry === "string"
        && !entry.startsWith("/")
        && !/^[a-zA-Z]+:/.test(entry)
        && !entry.split(/[\\/]/).includes("..");
      ok(isRelative, `相对路径合法：${entry}`);
      if (!isRelative) continue;
      const abs = resolve(ROOT, entry);
      const inside = relative(ROOT, abs);
      ok(inside !== "" && !inside.startsWith("..") && !isAbsolute(inside), `没有跳出插件目录：${entry}`);
      ok(existsSync(abs), `文件真实存在：${entry}`);
    }
  }
  // README 里引用的本地图片也必须存在（GitHub 页面 / 市场抽图都看这里）
  const readmes = ["README.md", "README.en.md"];
  let refCount = 0;
  for (const name of readmes) {
    const path = join(ROOT, name);
    ok(existsSync(path), `${name} 存在`);
    if (!existsSync(path)) continue;
    const text = await readFile(path, "utf8");
    const refs = [...text.matchAll(/!\[[^\]]*\]\(([^)\s]+)\)/g)]
      .map(m => m[1])
      .filter(p => !/^[a-zA-Z]+:/.test(p));
    refCount += refs.length;
    for (const ref of refs) {
      ok(existsSync(resolve(ROOT, ref)), `${name} 引用的图片存在：${ref}`);
    }
    // 顶部语言切换必须互指到真实存在的另一个 README
    const links = [...text.matchAll(/\[([^\]]+)\]\((README[^)\s]*\.md)\)/g)].map(m => m[2]);
    for (const target of new Set(links)) {
      if (target === name) continue;
      ok(existsSync(join(ROOT, target)), `${name} 的语言切换链接有效：${target}`);
    }
  }
  ok(refCount > 0, "README 里确实展示了截图");
  const zhHead = (await readFile(join(ROOT, "README.md"), "utf8")).slice(0, 400);
  const enHead = (await readFile(join(ROOT, "README.en.md"), "utf8")).slice(0, 400);
  ok(zhHead.includes("README.en.md"), "中文版顶部有 English 链接");
  ok(enHead.includes("README.md"), "英文版顶部有简体中文链接");
}

console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);

