// dsh-session-cleaner 验证台：node scripts/verify.mjs
// 维护者工具（不参与插件运行、不进发行包）。用 mock 宿主 + 真实文件系统，把删除 / 恢复 / 彻底删除 / 启动对账 / 过期清理 /
// 重复目录 / 孤儿项 这些路径真跑一遍。
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm, stat } from "node:fs/promises";
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
  const call = { insertSessionBefore: [], stopSessionTasks: 0, scheduleDelete: [] };

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
  const domainTable = {
    async delete(key) { projRows.set(key, "deleted-by-domain"); await rm(join(home, "storages", "session_projcache", "sessions", `${key}.json`), { force: true }); return true; },
    async put(key, value) { projRows.set(key, value); return undefined; }
  };
  const storageDomain = { get: (name) => (name === "session_projcache" ? { table: () => domainTable } : undefined) };

  const schedules = [
    { id: "schedule-aaaa", sessionId: SID, status: "active", kind: "at", title: "提醒", prompt: "p", scheduledAt: "2099-01-01T00:00:00.000Z" },
    { id: "schedule-bbbb", sessionId: SID, status: "inactive", kind: "at", title: "旧提醒", prompt: "p", scheduledAt: "2020-01-01T00:00:00.000Z" },
    { id: "schedule-cccc", sessionId: "other-session", status: "active", kind: "at", title: "别人的", prompt: "p", scheduledAt: "2099-01-01T00:00:00.000Z" }
  ];
  const schedule = {
    async catalog() { return schedules.map(s => ({ ...s })); },
    async list({ sessionId }) { return schedules.filter(s => s.sessionId === sessionId && s.status === "active").map(({ sessionId: _s, status: _t, ...record }) => record); },
    async stopSessionTasks(sessionId) { call.stopSessionTasks++; for (let i = schedules.length - 1; i >= 0; i--) if (schedules[i].sessionId === sessionId && schedules[i].status === "active") schedules.splice(i, 1); },
    async delete({ sessionId, id }) {
      call.scheduleDelete.push([sessionId, id]);
      const i = schedules.findIndex(s => s.id === id && s.sessionId === sessionId);
      if (i === -1) return { id, deleted: false, code: "schedule_not_found" };
      schedules.splice(i, 1);
      return { id, deleted: true };
    }
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
ok(mod.encodeSessionSegment("a/b:c").startsWith("--"), "encodeSessionSegment 生成目录段");
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
  eq(meta.version, 2, "meta 版本 2");
  eq(meta.stage, "trashed", "meta stage=trashed");
  eq(meta.filesMoved, true, "meta filesMoved=true");
  eq(meta.workspaceAnchorId, ANCHOR, "记下恢复锚点（原后继会话）");
  eq(meta.workspaceWasLast, false, "记下“不是最后一条”");
  eq(meta.wasPinned, true, "记下删除前是置顶状态");
  eq(meta.pinIndex, 0, "记下置顶位次");
  eq(meta.projcacheRow, row, "快照里存了投影缓存行原文");
  eq(meta.schedules.length, 2, "快照里抄录了该会话的 2 条定时任务");
  eq(trashed.body.result.schedulesKept, 2, "响应回报定时任务仍在");
  eq(trashed.body.result.cacheRemoved, true, "投影缓存行已删");
  eq(trashed.body.result.cacheBackupsRemoved, 1, "投影缓存备份文件已删");
  ok(!existsSync(join(home, "storages", "session_projcache", "sessions", `${SID}.json`)), "缓存行文件不在了");
  ok(!existsSync(join(home, "storages", "session_projcache", "sessions", `${SID}.json.bak.202601011200`)), "缓存备份文件不在了");
  ok(host.projRows.get(SID) === "deleted-by-domain", "走的是宿主存储域的表删除");
  eq(host.slots.join(","), [ANCHOR + "-prev", ANCHOR].join(","), "记账槽位已摘掉");
  eq(host.global.pinnedSessionIds.length, 0, "置顶已清");
  eq(host.schedules.filter(s => s.sessionId === SID).length, 2, "回收站阶段不动定时任务");

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
  ok(host.schedules.every(s => s.sessionId !== SID), "该会话的定时任务（含已结束的历史行）都没了");
  ok(host.schedules.some(s => s.sessionId === "other-session"), "别的会话的定时任务没被误删");
  ok(!existsSync(join(home, "sessions", OTHER)), "只装着它的工程目录被删掉了");
  ok(existsSync(join(home, "sessions", PROJ)), "还有别的会话的工程目录不受影响");
  ok(Array.isArray(purged.body.result.results[0].notes), "回报了清理明细");
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
  ok(host4.schedules.some(s => s.sessionId === SID), "刚恢复的会话的定时任务没被误清");
  await rm(h4.home, { recursive: true, force: true });
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
  for (const need of ["slots", "locale", "sessions", "workspaces"]) {
    ok(exportsObj.inject.includes(need), `inject 声明了 ${need}`);
  }

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
