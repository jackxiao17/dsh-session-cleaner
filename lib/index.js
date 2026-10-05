/**
 * dsh-session-cleaner — Host half.
 *
 * Cordis plugin that adds a true "delete" for DSH sessions, reachable from
 * the sidebar session "..." menu via the client half (lib/client.js).
 *
 * Deletion policy:
 *   - A session with a LIVE agent (a turn in flight) is REFUSED, never torn
 *     down. The user closes/finishes the conversation first. This keeps the
 *     risky "dissect a running agent" code out of this plugin entirely.
 *   - An in-memory but idle session is flushed and detached (the row drops
 *     from every connected client via session/disposed).
 *   - Cold sessions are deleted straight away.
 *
 * What one deletion covers:
 *   1. the session artifact directory  <dshHome>/sessions/<proj>/<id>/
 *   2. workspace accounting            workspaceRegistry detach + archive set
 *   3. the projection cache row        <dshHome>/storages/session_projcache/sessions/<id>.json
 *
 * File mutations are restricted to verified session directories; every
 * destructive step re-validates the path shape immediately before acting.
 */
import { lstat, mkdir, open, readdir, readFile, realpath, rename, rm } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { randomBytes } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { zstdDecompress } from "node:zlib";
import { promisify } from "node:util";

export const name = "dsh-session-cleaner";

export const inject = [
  "webServer",
  "workspaceRegistry",
  "sessions",
  "agents",
  "dshHomePath"
];

const API_PREFIX = "/session-cleaner/api";
const zstdDecompressAsync = promisify(zstdDecompress);

function safeErrorMessage(error) {
  if (error === null || error === undefined) return `<nullish:${typeof error}>`;
  if (typeof error === "string") return error;
  if (typeof error === "object") {
    if (typeof error.message === "string" && error.message.length > 0) return error.message;
    if (typeof error.code === "string" && error.code.length > 0) return `[code=${error.code}]`;
  }
  try { return JSON.stringify(error); } catch { return String(error); }
}

/** Pull one service out of the Cordis ctx, tolerating direct property fallbacks. */
function getService(ctx, name) {
  try {
    const value = typeof ctx?.get === "function" ? ctx.get(name) : undefined;
    if (value !== undefined) return value;
  } catch { /* fall through to the legacy direct property */ }
  return ctx && ctx[name];
}

// ───────────────────────── 会话标识与目录校验 ─────────────────────────

export function assertSessionId(id) {
  if (typeof id !== "string" || id.trim() === "" || id === "." || id === ".."
    || /[\\/\x00-\x1f<>:"|?*]/.test(id) || /[. ]$/.test(id)) {
    throw Object.assign(new Error("sessionId 必须是合法的会话标识，不能包含路径或特殊目录名"), { code: "bad-request" });
  }
  return id;
}

/** Mirror of DSH's workspace-segment encoding for <sessions>/<segment>/<id>. */
export function encodeSessionSegment(id) {
  let readable = "";
  let separatorRun = false;
  for (let i = 0; i < id.length; i++) {
    const ch = id[i];
    const code = id.charCodeAt(i);
    if (ch === "/" || ch === "\\" || ch === ":") {
      if (!separatorRun) readable += "-";
      separatorRun = true;
    } else if (ch !== "~" && /^[A-Za-z0-9._-]$/.test(ch)) {
      readable += ch;
      separatorRun = false;
    } else {
      readable += "~" + code.toString(16).toUpperCase().padStart(4, "0");
      separatorRun = false;
    }
  }
  return "--" + (readable.replace(/^-+/, "") || "root").slice(0, 251) + "--";
}

/** Only an actual <sessions>/<project>/<session> directory may be mutated.
 * Neither level may be a symlink/junction. Re-checked immediately before
 * every destructive step.
 */
export async function assertSessionDirectory(root, directory, id, { allowMissing = false } = {}) {
  assertSessionId(id);
  if (typeof root !== "string" || typeof directory !== "string") {
    throw new Error("无法验证会话目录，已停止文件操作");
  }
  const base = resolve(root);
  const target = resolve(directory);
  const rel = relative(base, target);
  const parts = rel.split(sep);
  if (isAbsolute(rel) || parts.length !== 2 || parts.some(p => p === ".." || p === "." || p === "")
    || ![id, encodeSessionSegment(id)].includes(parts[1])) {
    throw new Error("会话目录超出允许范围，已停止文件操作");
  }
  const canonicalRoot = await realpath(base);
  let current = base;
  for (const part of parts) {
    current = join(current, part);
    let info;
    try { info = await lstat(current); }
    catch (error) {
      if (allowMissing && error.code === "ENOENT") return target;
      throw error;
    }
    if (info.isSymbolicLink() || !info.isDirectory()) {
      throw new Error("会话目录不能是符号链接、junction 或普通文件");
    }
    const canonical = await realpath(current);
    const child = relative(canonicalRoot, canonical);
    if (isAbsolute(child) || child === "" || child.split(sep).includes("..")) {
      throw new Error("会话目录解析到了允许范围之外");
    }
  }
  return target;
}

// ───────────────────────── Zstd 帧扫描（只读头帧） ─────────────────────────
// Direct port of DSH's frame layout contract: concatenated checksummed frames,
// boundaries computed from the frame header itself (never a magic-byte guess).

const ZSTD_MAGIC = 0xfd2fb528;

export function scanZstdFrames(buffer, maxFrames = Number.POSITIVE_INFINITY) {
  const frames = [];
  let offset = 0;
  while (offset < buffer.length) {
    const start = offset;
    if (buffer.length - offset < 4) return { frames, tornStart: start };
    if (buffer.readUint32LE(offset) != ZSTD_MAGIC) {
      throw new Error(`corrupt Zstandard session log: invalid frame magic at byte ${offset}`);
    }
    offset += 4;
    if (offset === buffer.length) return { frames, tornStart: start };
    const descriptor = buffer.readUint8(offset++);
    if ((descriptor & 0x18) !== 0) {
      throw new Error(`corrupt Zstandard session log: reserved frame-header bit at byte ${offset - 1}`);
    }
    const contentSizeFlag = descriptor >>> 6;
    const singleSegment = (descriptor & 0x20) !== 0;
    const checksum = (descriptor & 0x04) !== 0;
    const dictionaryFlag = descriptor & 0x03;
    const dictionaryBytes = dictionaryFlag === 3 ? 4 : dictionaryFlag;
    const contentSizeBytes = contentSizeFlag === 0 ? (singleSegment ? 1 : 0) : 1 << contentSizeFlag;
    const remainingHeaderBytes = (singleSegment ? 0 : 1) + dictionaryBytes + contentSizeBytes;
    if (buffer.length - offset < remainingHeaderBytes) return { frames, tornStart: start };
    offset += remainingHeaderBytes;
    for (;;) {
      if (buffer.length - offset < 3) return { frames, tornStart: start };
      const blockHeader = buffer.readUIntLE(offset, 3);
      offset += 3;
      const lastBlock = (blockHeader & 1) !== 0;
      const blockType = (blockHeader >>> 1) & 0x03;
      const blockSize = blockHeader >>> 3;
      if (blockType === 0x03) {
        throw new Error(`corrupt Zstandard session log: reserved block type at byte ${offset - 3}`);
      }
      const payloadBytes = blockType === 0x01 ? 1 : blockSize;
      if (buffer.length - offset < payloadBytes) return { frames, tornStart: start };
      offset += payloadBytes;
      if (lastBlock) break;
    }
    if (checksum) {
      if (buffer.length - offset < 4) return { frames, tornStart: start };
      offset += 4;
    }
    frames.push({ start, end: offset });
    if (frames.length === maxFrames) return { frames };
  }
  return { frames };
}

/** Filenames tried in order to locate a session's durable artifact. */
export const ARTIFACT_NAMES = [
  "session.v4.jsonl.zstd",
  "session.v3.jsonl.zstd",
  "session.v2.jsonl.zstd",
  "session.jsonl.zstd",
  "session.jsonl"
];
const MAX_HEADER_BYTES = 1024 * 1024;

function parseHeader(content) {
  const newline = content.indexOf("\n");
  if (newline < 0) throw new Error("会话工件缺少完整头行");
  const header = JSON.parse(content.slice(0, newline));
  assertSessionId(header?.id);
  return header;
}

async function assertRegularFile(path) {
  const info = await lstat(path);
  if (info.isSymbolicLink() || !info.isFile()) throw new Error("会话工件必须是普通文件，不能是符号链接");
}

/** Header-only read: first zstd frame (or first line for plain JSONL). */
export async function readSessionHeader(path) {
  await assertRegularFile(path);
  const handle = await open(path, "r");
  try {
    let buffer = Buffer.alloc(0);
    while (buffer.length < MAX_HEADER_BYTES) {
      const chunk = Buffer.alloc(Math.min(64 * 1024, MAX_HEADER_BYTES - buffer.length));
      const { bytesRead } = await handle.read(chunk, 0, chunk.length, buffer.length);
      if (bytesRead === 0) break;
      buffer = Buffer.concat([buffer, chunk.subarray(0, bytesRead)]);
      if (path.endsWith(".zstd")) {
        const { frames } = scanZstdFrames(buffer, 1);
        if (frames.length) {
          const frame = frames[0];
          const decoded = await zstdDecompressAsync(buffer.subarray(frame.start, frame.end), { maxOutputLength: MAX_HEADER_BYTES });
          return parseHeader(decoded.toString("utf8"));
        }
      } else if (buffer.includes(10)) {
        return parseHeader(buffer.toString("utf8"));
      }
    }
    throw new Error("会话头行不完整或超过大小限制");
  } finally {
    await handle.close();
  }
}

// ───────────────────────── 会话信息统计（弹窗展示用） ─────────────────────────

/** 解出整个日志（多帧 zstd 或纯 JSONL），供轮次/消息统计。 */
async function decompressArtifact(path, { maxOutputLength = 512 * 1024 * 1024 } = {}) {
  const bytes = await readFile(path);
  if (!path.toLowerCase().endsWith(".zstd")) {
    return { text: bytes.toString("utf8") };
  }
  const { frames } = scanZstdFrames(bytes);
  if (frames.length === 0) throw new Error("会话日志没有可读的 Zstd 帧");
  const parts = [];
  for (const frame of frames) {
    parts.push(await zstdDecompressAsync(bytes.subarray(frame.start, frame.end), { maxOutputLength }));
  }
  return { text: Buffer.concat(parts).toString("utf8") };
}

async function findArtifactPath(dir) {
  for (const filename of ARTIFACT_NAMES) {
    const path = join(dir, filename);
    try {
      const info = await lstat(path);
      if (info.isFile() && !info.isSymbolicLink()) return path;
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
  }
  return undefined;
}

/** 从日志统计弹窗要展示的信息：cwd/轮次/用户消息/工具调用/最后活动。
 * 单行解析失败就跳过该行（尽力而为，不影响删除主流程）。
 */
async function sessionInfo(artifactPath) {
  const { text } = await decompressArtifact(artifactPath);
  let header;
  let title;
  let turns = 0;
  let userMessages = 0;
  let toolCalls = 0;
  let firstTime;
  let lastTime;
  for (const line of text.split("\n")) {
    if (line === "") continue;
    let obj;
    try { obj = JSON.parse(line); } catch { continue; }
    if (obj === null || typeof obj !== "object") continue;
    if (header === undefined && obj.type === "session") { header = obj; continue; }
    if (typeof obj.time === "number") {
      if (firstTime === undefined) firstTime = obj.time;
      lastTime = obj.time;
    }
    switch (obj.type) {
      case "session/title":
        if (obj.data && typeof obj.data.title === "string" && obj.data.title.trim() !== "") title = obj.data.title.trim();
        break;
      case "turn/start":
        turns += 1;
        break;
      case "user/message":
        if (obj.data && obj.data.source && obj.data.source.kind === "user") userMessages += 1;
        break;
      case "tool/call":
        toolCalls += 1;
        break;
      default:
        break;
    }
  }
  return {
    cwd: header && typeof header.cwd === "string" ? header.cwd : undefined,
    createdAt: header && typeof header.createdAt === "number" ? header.createdAt : undefined,
    title: title || undefined,
    turns,
    userMessages,
    toolCalls,
    firstTime,
    lastTime
  };
}

/** 取文本块的纯文本（与 session-lib.mjs 的 textFromContent 同一约定）。 */
function textFromContent(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const out = [];
  for (const block of content) {
    if (block && block.type === "text" && typeof block.text === "string") out.push(block.text);
  }
  return out.join("\n").trim();
}

function collapseText(text, max = 500) {
  const t = String(text).replace(/\s+/g, " ").trim();
  return t.length > max ? t.slice(0, max) + "…" : t;
}

/** 长回复中间省略：保留开头与结尾，切点尽量落在换行边界上（Markdown 结构不被切碎）。 */
function elideMiddle(text, max = 1200, head = 700, tail = 300) {
  const t = String(text).trim();
  if (t.length <= max) return t;
  let h = t.slice(0, head);
  const hCut = h.lastIndexOf("\n");
  if (hCut > head * 0.5) h = h.slice(0, hCut);
  let tl = t.slice(-tail);
  const tCut = tl.indexOf("\n");
  if (tCut !== -1 && tCut < tail * 0.5) tl = tl.slice(tCut + 1);
  return h + "\n\n……（中间内容省略）……\n\n" + tl;
}

// ───────────────────────── 通用小工具 ─────────────────────────

const isRecord = value => value !== null && typeof value === "object" && !Array.isArray(value);

// ───────────────────────── 插件主体 ─────────────────────────

export function apply(ctx) {
  try {
    const buildId = "dsh-session-cleaner v0.6.4";
    if (typeof ctx?.logger?.info === "function") ctx.logger.info(buildId);
    else if (typeof console !== "undefined" && console?.info) console.info(buildId);
  } catch (_) { /* ignore logging failures */ }

  const service = name => getService(ctx, name);
  const homePath = service("dshHomePath");
  if (typeof homePath !== "function") {
    ctx?.logger?.warn?.("session-cleaner: dshHomePath 服务不可用，插件功能停用");
    return;
  }

  /** Per-id operation queue so a double-click cannot start two deletions. */
  const operations = new Map();
  const mutate = (id, operation) => {
    const pending = (operations.get(id) ?? Promise.resolve()).then(operation);
    const settled = pending.catch(() => {}).finally(() => {
      if (operations.get(id) === settled) operations.delete(id);
    });
    operations.set(id, settled);
    return pending;
  };

  const readBody = async (req) => {
    const chunks = [];
    let size = 0;
    for await (const chunk of req) {
      const bytes = Buffer.from(chunk);
      size += bytes.length;
      if (size > 64 * 1024) throw Object.assign(new Error("请求体超过 64 KiB"), { code: "body-too-large" });
      chunks.push(bytes);
    }
    return Buffer.concat(chunks).toString("utf8");
  };

  const send = (res, code, obj) => {
    res.writeHead(code, { "content-type": "application/json; charset=utf-8" });
    res.end(JSON.stringify(obj));
  };

  /** TRUE only when a live agent is attached to the session (a turn in flight). */
  const liveAgentOf = (sessionId) => {
    const agents = service("agents");
    try { return agents && typeof agents.get === "function" ? agents.get(sessionId) : undefined; }
    catch { return undefined; }
  };

  /** In-memory (loaded) session entry, if any. Cold sessions may throw here. */
  const liveSessionOf = (sessionId) => {
    const sessions = service("sessions");
    try { return sessions && typeof sessions.get === "function" ? sessions.get(sessionId) : undefined; }
    catch { return undefined; }
  };

  const isLiveAgent = (agent) => agent !== undefined && agent !== null;

  /** Locate + header-verify the session artifact directory, or undefined.
   * Prefers the persistence index, falls back to a bounded disk scan.
   */
  const sessionDirOf = async (sessionId) => {
    assertSessionId(sessionId);
    const root = homePath("sessions");
    if (typeof root !== "string") throw new Error("无法定位 DSH sessions 目录");
    const persistence = service("sessionPersistence");
    const tryRead = async (dir) => {
      try { await assertSessionDirectory(root, dir, sessionId); }
      catch (error) { if (error.code === "ENOENT") return undefined; throw error; }
      for (const filename of ARTIFACT_NAMES) {
        try {
          const header = await readSessionHeader(join(dir, filename));
          if (header.id !== sessionId) throw new Error("会话工件 header id 与请求不一致");
          return dir;
        } catch (error) {
          // 没有这个工件文件就试下一个名字；其余错误（损坏帧、JSON 非法、
          // id 不一致）立即抛出，绝不把读不动的目录交给 rm
          if (error.code === "ENOENT") continue;
          throw error;
        }
      }
      return undefined;
    };
    if (persistence && typeof persistence.resolveLog === "function") {
      try {
        const located = await persistence.resolveLog(sessionId);
        const path = located && typeof located === "string" ? located : located?.path;
        if (typeof path === "string") {
          const dir = await tryRead(dirname(path));
          if (dir !== undefined) return dir;
        }
      } catch { /* fall through to disk scan */ }
    }
    if (persistence && typeof persistence.locate === "function") {
      try {
        const located = persistence.locate({ id: sessionId });
        const path = located && located.path;
        if (typeof path === "string") {
          const dir = await tryRead(dirname(path));
          if (dir !== undefined) return dir;
        }
      } catch { /* fall through to disk scan */ }
    }
    let projects;
    try { projects = await readdir(root, { withFileTypes: true }); }
    catch (error) { if (error.code === "ENOENT") return undefined; throw error; }
    for (const proj of projects) {
      if (!proj.isDirectory() || proj.isSymbolicLink()) continue;
      for (const candidate of [encodeSessionSegment(sessionId), sessionId]) {
        const dir = await tryRead(join(root, proj.name, candidate));
        if (dir !== undefined) return dir;
      }
    }
    return undefined;
  };

  const dirSize = async (dir) => {
    let total = 0;
    const walk = async (current) => {
      const entries = await readdir(current, { withFileTypes: true });
      for (const entry of entries) {
        const child = join(current, entry.name);
        if (entry.isSymbolicLink()) continue;
        if (entry.isDirectory()) await walk(child);
        else {
          try { total += (await lstat(child)).size; } catch { /* racing file: ignore */ }
        }
      }
    };
    try { await walk(dir); } catch { /* unreadable dir: report what we got */ }
    return total;
  };

  /** Refuse-active gate removed in v0.2.0: a live agent is now torn down
   * (see teardownLive) after the user confirms in the UI — the dialog warns
   * that the in-flight answer will be ended. */

  const detachFromWorkspaces = async (sessionId) => {
    const registry = service("workspaceRegistry");
    let detached = 0;
    if (!registry || typeof registry.list !== "function") return detached;
    for (const entity of registry.list()) {
      const ids = entity?.sessionIds;
      if (Array.isArray(ids) && ids.includes(sessionId) && typeof entity.detachSession === "function") {
        await entity.detachSession(sessionId);
        detached++;
      }
    }
    return detached;
  };

  /** Drop the id from the registry-global archived set (durable, serialized). */
  const unarchiveSession = async (sessionId) => {
    const registry = service("workspaceRegistry");
    if (!registry || typeof registry.enqueueOperation !== "function"
      || typeof registry.requireState !== "function" || typeof registry.setState !== "function") return false;
    await registry.enqueueOperation(async () => {
      const state = registry.requireState();
      if (!state?.archivedSessionIds?.includes(sessionId)) return;
      await registry.setState({
        ...state,
        archivedSessionIds: state.archivedSessionIds.filter(id => id !== sessionId)
      });
    });
    return true;
  };

  /** Remove the projection-cache row; a cleanup plain deletes leave behind. */
  const removeProjectionCacheRow = async (sessionId) => {
    assertSessionId(sessionId);
    const storages = homePath("storages");
    if (typeof storages !== "string") return false;
    const sessionsRoot = resolve(storages, "session_projcache", "sessions");
    const target = resolve(sessionsRoot, `${sessionId}.json`);
    const rel = relative(sessionsRoot, target);
    if (isAbsolute(rel) || rel.split(sep).length !== 1 || rel !== `${sessionId}.json`) {
      throw new Error("投影缓存路径超出允许范围，已停止清理");
    }
    try {
      const info = await lstat(target);
      if (info.isSymbolicLink() || !info.isFile()) return false;
      await rm(target, { force: true });
      return true;
    } catch (error) {
      if (error.code === "ENOENT") return false;
      throw error;
    }
  };

  /** End-of-life for in-memory state: cancel a running turn, dispose the
   * agent fiber (bounded in case teardown stalls), flush and detach the
   * session entry so every connected client drops the row. Every step is
   * best-effort with bounded waits.
   */
  const teardownLive = async (sessionId) => {
    const agents = service("agents");
    const sessions = service("sessions");
    let agent = undefined;
    try { agent = agents && typeof agents.get === "function" ? agents.get(sessionId) : undefined; } catch { agent = undefined; }
    let session = undefined;
    try { session = sessions && typeof sessions.get === "function" ? sessions.get(sessionId) : undefined; } catch { session = undefined; }

    if (agent !== undefined && agent !== null) {
      // Stop any running turn (disposed-kind suppresses re-wake), then quiesce
      // the agent's own fiber with a hard 3s bound.
      try { if (typeof agent.cancel === "function") agent.cancel({ kind: "disposed" }); } catch { /* best-effort */ }
      if (typeof agent.scope?.dispose === "function") {
        await Promise.race([agent.scope.dispose(), delay(3000)]);
      }
      // Drop the zombie from the registry so a later session.create/open with
      // the same id cannot resurrect it.
      try { agents?.store?.delete?.(sessionId); } catch { /* best-effort */ }
    }

    let detached = false;
    if (session !== undefined && session !== null) {
      // Flush buffered events to disk first so the retirement drain is a no-op.
      try { if (typeof sessions.flush === "function") await sessions.flush(session); } catch { /* best-effort */ }
      try {
        const entry = sessions?.store?.get?.(sessionId);
        if (entry !== undefined && typeof entry.detach === "function") {
          entry.detach();
          await delay(200); // let the write-behind retirement settle
          detached = true;
        }
      } catch { /* best-effort */ }
    }
    if (!detached) {
      // Cold or already-detached session: emit explicitly so every connected
      // client drops the row.
      try { ctx.emit("session/disposed", { id: sessionId }); } catch { /* best-effort */ }
    }
    return {
      wasLiveAgent: agent !== undefined && agent !== null,
      wasLiveSession: session !== undefined && session !== null
    };
  };

  const deleteSession = async (sessionId) => {
    assertSessionId(sessionId);
    // 先做现场拆除：正在对话的会话结束当前轮次（cancel + 有限时 dispose），
    // 空闲/冷会话直接跳过这一步。失败路径全部 best-effort，不阻塞删除。
    const live = await teardownLive(sessionId);

    let dir = await sessionDirOf(sessionId);
    const sizeBytes = dir !== undefined ? await dirSize(dir) : 0;

    const workspacesDetached = await detachFromWorkspaces(sessionId);
    await unarchiveSession(sessionId);

    let filesRemoved = false;
    if (dir !== undefined) {
      // Re-validate the path shape immediately before the rm.
      await assertSessionDirectory(homePath("sessions"), dir, sessionId);
      await rm(dir, { recursive: true, force: true });
      filesRemoved = true;
    }

    let cacheRemoved = false;
    try { cacheRemoved = await removeProjectionCacheRow(sessionId); }
    catch (error) { ctx?.logger?.warn?.("session-cleaner: 投影缓存清理失败: " + safeErrorMessage(error)); }

    return {
      sessionId,
      deleted: true,
      filesRemoved,
      freedBytes: filesRemoved ? sizeBytes : 0,
      workspacesDetached,
      cacheRemoved,
      wasLiveAgent: live.wasLiveAgent,
      wasLiveSession: live.wasLiveSession
    };
  };

  const sessionStatus = async (sessionId) => {
    assertSessionId(sessionId);
    // 状态查询是只读的：活动中的会话也照样解析目录，弹窗才能显示完整信息
    const dir = await sessionDirOf(sessionId);
    const result = {
      sessionId,
      exists: dir !== undefined,
      active: isLiveAgent(liveAgentOf(sessionId)),
      bytes: 0
    };
    if (dir === undefined) return result;
    result.bytes = await dirSize(dir);
    try {
      const artifactPath = await findArtifactPath(dir);
      if (artifactPath !== undefined) {
        const info = await sessionInfo(artifactPath);
        result.cwd = info.cwd;
        result.turns = info.turns;
        result.userMessages = info.userMessages;
        result.toolCalls = info.toolCalls;
        result.lastTime = info.lastTime;
        result.logTitle = info.title;
      }
    } catch (error) {
      // 信息统计失败不影响删除主流程，弹窗只少几行展示
      ctx?.logger?.warn?.("session-cleaner: 会话信息解析失败（不影响删除）: " + safeErrorMessage(error));
    }
    return result;
  };

  // ───────────────────────── 回收站 ─────────────────────────
  // 「删除」默认把会话目录整体搬进 ~/.dsh/dsh-session-cleaner/trash/items/<id>/，
  // 元数据快照写在 trash/meta/<id>.json（原目录、工作区、缓存行、注解等），
  // 恢复时原样搬回并写回快照；彻底删除才物理清除。保留期 30 天，启动时清理。

  const TRASH_RETENTION_DAYS = 30;

  const trashRoots = () => ({
    items: join(homePath("dsh-session-cleaner"), "trash", "items"),
    meta: join(homePath("dsh-session-cleaner"), "trash", "meta")
  });

  const readMeta = async (sessionId) => {
    const { meta: metaRoot } = trashRoots();
    try {
      const parsed = JSON.parse(await readFile(join(metaRoot, `${sessionId}.json`), "utf8"));
      if (!isRecord(parsed) || parsed.id !== sessionId) return undefined;
      return parsed;
    } catch (error) {
      if (error.code === "ENOENT") return undefined;
      throw error;
    }
  };

  const writeMeta = async (meta) => {
    const { meta: metaRoot } = trashRoots();
    await mkdir(metaRoot, { recursive: true });
    const temp = join(metaRoot, `${meta.id}.${randomBytes(6).toString("hex")}.tmp`);
    const handle = await open(temp, "wx", 0o600);
    try {
      await handle.writeFile(JSON.stringify(meta, null, 2) + "\n");
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(temp, join(metaRoot, `${meta.id}.json`));
  };

  const readProjcacheRow = async (sessionId) => {
    assertSessionId(sessionId);
    const storages = homePath("storages");
    const path = resolve(storages, "session_projcache", "sessions", `${sessionId}.json`);
    if (relative(resolve(storages), path).split(sep).length !== 3) return null;
    try {
      const info = await lstat(path);
      if (info.isSymbolicLink() || !info.isFile()) return null;
      return await readFile(path, "utf8");
    } catch { return null; }
  };

  const writeProjcacheRow = async (sessionId, content) => {
    assertSessionId(sessionId);
    const storages = homePath("storages");
    const sessionsRoot = resolve(storages, "session_projcache", "sessions");
    const target = resolve(sessionsRoot, `${sessionId}.json`);
    if (relative(sessionsRoot, target).split(sep).length !== 1 || basename(target) !== `${sessionId}.json`) {
      throw new Error("投影缓存路径超出允许范围，已停止写入");
    }
    await mkdir(sessionsRoot, { recursive: true });
    const temp = `${target}.${randomBytes(6).toString("hex")}.tmp`;
    const handle = await open(temp, "wx", 0o600);
    try {
      await handle.writeFile(content);
      await handle.sync();
    } finally {
      await handle.close();
    }
    try {
      await rename(temp, target);
    } catch (error) {
      await rm(temp, { force: true });
      throw error;
    }
  };

  const listTrash = async () => {
    const { meta: metaRoot } = trashRoots();
    let files;
    try { files = await readdir(metaRoot); }
    catch (error) { if (error.code === "ENOENT") return { items: [], totalBytes: 0 }; throw error; }
    const items = [];
    let totalBytes = 0;
    for (const file of files) {
      if (!file.endsWith(".json") || file.endsWith(".tmp")) continue;
      try {
        const parsed = JSON.parse(await readFile(join(metaRoot, file), "utf8"));
        if (!isRecord(parsed) || typeof parsed.id !== "string") continue;
        items.push(parsed);
        totalBytes += Number(parsed.bytes) || 0;
      } catch { /* 跳过损坏的 meta */ }
    }
    return { items, totalBytes };
  };

  const trashSession = async (sessionId) => {
    assertSessionId(sessionId);
    const live = await teardownLive(sessionId);

    let dir = await sessionDirOf(sessionId);
    const bytes = dir !== undefined ? await dirSize(dir) : 0;

    // 快照要带走的信息与附属数据（趁文件还在原位）
    let info = {};
    let projcacheRow = null;
    if (dir !== undefined) {
      try {
        const artifactPath = await findArtifactPath(dir);
        if (artifactPath !== undefined) info = await sessionInfo(artifactPath);
      } catch (error) { ctx?.logger?.warn?.("session-cleaner: 会话信息解析失败: " + safeErrorMessage(error)); }
      try { projcacheRow = await readProjcacheRow(sessionId); } catch { /* best-effort */ }
    }

    // 原工作区身份（detach 之前记下，恢复时挂回去用）
    let workspaceId;
    let workspacePath;
    try {
      for (const entity of (service("workspaceRegistry")?.list?.() ?? [])) {
        if (Array.isArray(entity?.sessionIds) && entity.sessionIds.includes(sessionId)) {
          workspaceId = entity.id;
          workspacePath = entity.path;
          break;
        }
      }
    } catch { /* best-effort */ }

    const workspacesDetached = await detachFromWorkspaces(sessionId);
    await unarchiveSession(sessionId);

    // 搬进回收站：同盘 rename，瞬时完成；同 id 的旧回收项被新状态取代
    const { items: itemsRoot, meta: metaRoot } = trashRoots();
    await mkdir(itemsRoot, { recursive: true });
    await mkdir(metaRoot, { recursive: true });
    const targetDir = join(itemsRoot, sessionId);
    let filesMoved = false;
    if (dir !== undefined) {
      await assertSessionDirectory(homePath("sessions"), dir, sessionId);
      await rm(targetDir, { recursive: true, force: true });
      await rename(dir, targetDir);
      filesMoved = true;
    }
    await rm(join(metaRoot, `${sessionId}.json`), { force: true });
    await writeMeta({
      version: 1,
      id: sessionId,
      originalDir: dir !== undefined ? resolve(dir) : undefined,
      workspaceId,
      workspacePath,
      deletedAt: Date.now(),
      bytes,
      cwd: info.cwd,
      title: info.title,
      turns: info.turns ?? 0,
      userMessages: info.userMessages ?? 0,
      toolCalls: info.toolCalls ?? 0,
      lastTime: info.lastTime,
      projcacheRow
    });

    return {
      sessionId,
      trashed: true,
      filesMoved,
      bytes,
      workspacesDetached,
      wasLiveAgent: live.wasLiveAgent,
      wasLiveSession: live.wasLiveSession
    };
  };

  const restoreSession = async (sessionId) => {
    assertSessionId(sessionId);
    const meta = await readMeta(sessionId);
    if (meta === undefined) throw Object.assign(new Error("回收站里没有这个会话"), { code: "session-not-found" });
    const { items: itemsRoot, meta: metaRoot } = trashRoots();
    const itemDir = join(itemsRoot, sessionId);
    const hasFiles = typeof meta.originalDir === "string";
    if (hasFiles && !existsDir(itemDir)) throw Object.assign(new Error("回收站数据不完整：会话目录缺失"), { code: "session-not-found" });

    const root = homePath("sessions");
    let target;
    let filesRestored = false;
    if (hasFiles) {
      target = resolve(meta.originalDir);
      // 形状校验：必须仍然是 <sessions>/<项目段>/<会话id>，且各级不是符号链接
      await assertSessionDirectory(root, target, sessionId, { allowMissing: true });
      try {
        await lstat(target);
        throw Object.assign(new Error("目标位置已存在同名会话目录，无法恢复: " + target), { code: "target-exists" });
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
      }
      await mkdir(dirname(target), { recursive: true });
      await rename(itemDir, target);
      filesRestored = true;
    }

    let cacheRestored = false;
    if (typeof meta.projcacheRow === "string") {
      try { await writeProjcacheRow(sessionId, meta.projcacheRow); cacheRestored = true; }
      catch (error) { ctx?.logger?.warn?.("session-cleaner: 投影缓存行写回失败: " + safeErrorMessage(error)); }
    }

    // 记账挂回原工作区；工作区没了就按路径找，再不行就只能恢复到磁盘
    let attached = false;
    try {
      const registry = service("workspaceRegistry");
      let entity;
      if (typeof meta.workspaceId === "string" && typeof registry?.get === "function") {
        try { entity = registry.get(meta.workspaceId); } catch { entity = undefined; }
      }
      if (entity === undefined && typeof meta.workspacePath === "string") {
        for (const candidate of (registry?.list?.() ?? [])) {
          if (candidate?.path === meta.workspacePath) { entity = candidate; break; }
        }
      }
      if (entity !== undefined && typeof entity.attachSession === "function") {
        await entity.attachSession(sessionId);
        attached = true;
      }
    } catch (error) { ctx?.logger?.warn?.("session-cleaner: 记账挂回失败: " + safeErrorMessage(error)); }

    await rm(join(metaRoot, `${sessionId}.json`), { force: true });

    return {
      sessionId,
      restored: true,
      attached,
      filesRestored,
      cacheRestored,
      restoredTo: target,
      ...(attached ? {} : { warning: typeof target === "string"
        ? "会话已恢复到磁盘，但未能挂回侧栏（原工作区可能已删除）。文件位置: " + target
        : "该会话没有磁盘文件，已恢复记账与缓存记录。" })
    };
  };

  const deleteFromTrash = async (ids) => {
    const { items: itemsRoot, meta: metaRoot } = trashRoots();
    const results = [];
    let freedBytes = 0;
    for (const id of ids) {
      assertSessionId(id);
      const itemDir = resolve(itemsRoot, id);
      const rel = relative(resolve(itemsRoot), itemDir);
      if (rel.split(sep).length !== 1 || rel !== id) {
        throw new Error("回收站路径超出允许范围，已停止删除");
      }
      const meta = await readMeta(id);
      try {
        await rm(itemDir, { recursive: true, force: true });
        await rm(join(metaRoot, `${id}.json`), { force: true });
        freedBytes += Number(meta?.bytes) || 0;
        results.push({ sessionId: id, deleted: true });
      } catch (error) {
        results.push({ sessionId: id, deleted: false, error: safeErrorMessage(error) });
      }
    }
    return { results, freedBytes };
  };

  const emptyTrash = async () => {
    const { items } = await listTrash();
    return deleteFromTrash(items.map(item => item.id));
  };

  const searchTrash = async (keyword) => {
    const { items: itemsRoot } = trashRoots();
    const needle = keyword.toLowerCase();
    const { items } = await listTrash();
    const matches = {};
    for (const meta of items) {
      let count = typeof meta.title === "string" && meta.title.toLowerCase().includes(needle) ? 1 : 0;
      try {
        const artifact = await findArtifactPath(join(itemsRoot, meta.id));
        if (artifact !== undefined) {
          const { text: logText } = await decompressArtifact(artifact, { maxOutputLength: 256 * 1024 * 1024 });
          // 只搜「用户提问 + 助手正文输出」：思考块、工具调用噪声不算对话内容
          let spoken = "";
          for (const line of logText.split("\n")) {
            if (line === "") continue;
            let e;
            try { e = JSON.parse(line); } catch { continue; }
            if (e === null || typeof e !== "object" || !e.data) continue;
            if (e.type === "user/message" && e.data.source && e.data.source.kind === "user") {
              spoken += "\n" + textFromContent(e.data.content);
            } else if (e.type === "assistant/message") {
              // 助手文本在 data.message.content（真实日志结构，与 cmdDetail 同源）
              spoken += "\n" + textFromContent(e.data.message ? e.data.message.content : undefined);
            }
            if (spoken.length > 5 * 1024 * 1024) break;
          }
          const lower = spoken.toLowerCase();
          let idx = 0;
          let hits = 0;
          while ((idx = lower.indexOf(needle, idx)) !== -1 && hits < 10000) { hits++; idx += needle.length; }
          count += hits;
        }
      } catch { /* 日志读不出来就只算标题命中 */ }
      if (count > 0) matches[meta.id] = count;
    }
    return { keyword, scanned: items.length, matches };
  };

  const purgeExpiredTrash = async () => {
    const { items } = await listTrash();
    const cutoff = Date.now() - TRASH_RETENTION_DAYS * 24 * 60 * 60 * 1000;
    const expired = items.filter(item => typeof item.deletedAt !== "number" || item.deletedAt < cutoff);
    if (expired.length === 0) return { removed: 0 };
    const result = await deleteFromTrash(expired.map(item => item.id));
    const removed = result.results.filter(r => r.deleted).length;
    ctx?.logger?.info?.(`session-cleaner: 回收站自动清理 ${removed} 条超过 ${TRASH_RETENTION_DAYS} 天的会话`);
    return { removed };
  };

  function existsDir(path) {
    return lstat(path).then(info => info.isDirectory() && !info.isSymbolicLink()).catch(() => false);
  }

  /** 回收站内查看对话记录：解压日志按事件流还原每轮提问（与黑窗口 d N 同源）。 */
  const trashDetail = async (sessionId) => {
    assertSessionId(sessionId);
    const meta = await readMeta(sessionId);
    if (meta === undefined) throw Object.assign(new Error("回收站里没有这个会话"), { code: "session-not-found" });
    const { items: itemsRoot } = trashRoots();
    const result = {
      sessionId,
      title: meta.title,
      cwd: meta.cwd,
      turns: meta.turns ?? 0,
      userMessages: meta.userMessages ?? 0,
      toolCalls: meta.toolCalls ?? 0,
      bytes: meta.bytes ?? 0,
      lastTime: meta.lastTime,
      deletedAt: meta.deletedAt,
      questions: []
    };
    if (typeof meta.originalDir !== "string") return result; // 无磁盘文件的空白会话
    const artifact = await findArtifactPath(join(itemsRoot, sessionId));
    if (artifact === undefined) return result;
    try {
      const { text } = await decompressArtifact(artifact);
      // 解析逻辑与 session-lib.mjs 的 cmdDetail 同源：
      //   助手文本在 e.data.message.content（不是 e.data.content！），
      //   轮次优先取 e.data.turn，一轮内多条助手消息取最后一条。
      let turnCounter = 0;
      const questions = [];
      let pendingTools = 0;
      let openQuestion;
      let lastAssistant = undefined;
      let lastAssistantModel = undefined;
      const flushTurn = () => {
        if (openQuestion !== undefined) {
          openQuestion.toolCalls = pendingTools;
          openQuestion.assistantReply = lastAssistant ? elideMiddle(lastAssistant, 1200) : "";
          if (lastAssistantModel !== undefined) openQuestion.model = lastAssistantModel;
          questions.push(openQuestion);
          openQuestion = undefined;
        }
        pendingTools = 0;
        lastAssistant = undefined;
        lastAssistantModel = undefined;
      };
      for (const line of text.split("\n")) {
        if (line === "") continue;
        let e;
        try { e = JSON.parse(line); } catch { continue; }
        if (e === null || typeof e !== "object") continue;
        switch (e.type) {
          case "turn/start":
            flushTurn();
            turnCounter += 1;
            break;
          case "user/message": {
            if (!e.data || !e.data.source || e.data.source.kind !== "user") break;
            const questionText = textFromContent(e.data.content);
            if (questionText === "") break;
            openQuestion = {
              turn: typeof e.data.turn === "number" ? e.data.turn : (turnCounter || undefined),
              time: typeof e.time === "number" ? e.time : undefined,
              question: collapseText(questionText, 500),
              toolCalls: 0,
              assistantReply: ""
            };
            break;
          }
          case "assistant/message": {
            const msg = e.data && e.data.message;
            const reply = textFromContent(msg ? msg.content : undefined);
            if (reply !== "") {
              lastAssistant = reply;
              // 模型名挂在 message.source.model（真实日志结构，如 "deepseek-flash"）
              if (msg && msg.source && typeof msg.source.model === "string" && msg.source.model !== "") {
                lastAssistantModel = msg.source.model;
              }
              if (openQuestion !== undefined && typeof e.data.turn === "number" && openQuestion.turn === undefined) {
                openQuestion.turn = e.data.turn;
              }
            }
            break;
          }
          case "tool/call":
            pendingTools += 1;
            break;
          default:
            break;
        }
      }
      flushTurn();
      result.questions = questions;
    } catch (error) {
      result.parseError = safeErrorMessage(error);
      ctx?.logger?.warn?.("session-cleaner: 回收站对话记录解析失败: " + safeErrorMessage(error));
    }
    return result;
  };

  // 启动时清理超过保留期的回收项（尽力而为，不阻塞加载）
  ctx.effect(() => { purgeExpiredTrash().catch(() => {}); }, "session-cleaner: trash retention purge");

  ctx.effect(() => ctx.webServer.register({
    kind: "prefix",
    path: API_PREFIX,
    handler: async (req, res) => {
      try {
        const url = new URL(req.url ?? "/", "http://localhost");
        const path = url.pathname.startsWith(API_PREFIX) ? url.pathname.slice(API_PREFIX.length) || "/" : "/";
        let body = {};
        if (req.method === "POST") {
          const raw = await readBody(req);
          if (raw.trim() !== "") {
            try { body = JSON.parse(raw); }
            catch { return send(res, 400, { ok: false, error: "请求体不是合法 JSON" }); }
          }
        }
        if (body === null || typeof body !== "object" || Array.isArray(body)) {
          return send(res, 400, { ok: false, error: "请求体必须是 JSON 对象" });
        }
        const sessionId = typeof body.sessionId === "string" ? body.sessionId.trim() : "";
        if (req.method === "GET" && path === "/health") {
          return send(res, 200, { ok: true, result: { plugin: name } });
        }
        if (req.method === "POST" && path === "/status") {
          const status = await mutate(`status:${sessionId}`, () => sessionStatus(sessionId));
          return send(res, 200, { ok: true, result: status });
        }
        if (req.method === "POST" && path === "/delete") {
          assertSessionId(sessionId);
          const result = await mutate(sessionId, () => deleteSession(sessionId));
          return send(res, 200, { ok: true, result });
        }
        if (req.method === "POST" && path === "/trash") {
          assertSessionId(sessionId);
          const result = await mutate(sessionId, () => trashSession(sessionId));
          return send(res, 200, { ok: true, result });
        }
        if (req.method === "POST" && path === "/trash/list") {
          const result = await listTrash();
          return send(res, 200, { ok: true, result });
        }
        if (req.method === "POST" && path === "/trash/search") {
          const keyword = typeof body.keyword === "string" ? body.keyword.trim() : "";
          if (keyword === "") return send(res, 400, { ok: false, error: "keyword 必填", code: "bad-request" });
          const result = await searchTrash(keyword);
          return send(res, 200, { ok: true, result });
        }
        if (req.method === "POST" && path === "/trash/detail") {
          assertSessionId(sessionId);
          const result = await mutate(`detail:${sessionId}`, () => trashDetail(sessionId));
          return send(res, 200, { ok: true, result });
        }
        if (req.method === "POST" && path === "/trash/restore") {
          assertSessionId(sessionId);
          const result = await mutate(`restore:${sessionId}`, () => restoreSession(sessionId));
          return send(res, 200, { ok: true, result });
        }
        if (req.method === "POST" && path === "/trash/delete") {
          const rawIds = Array.isArray(body.sessionIds) ? body.sessionIds : [sessionId];
          const ids = Array.from(new Set(rawIds.filter(id => typeof id === "string" && id.trim() !== "").map(id => id.trim())));
          if (ids.length === 0) return send(res, 400, { ok: false, error: "sessionIds 必须是非空数组", code: "bad-request" });
          for (const id of ids) assertSessionId(id);
          const result = await deleteFromTrash(ids);
          return send(res, 200, { ok: true, result });
        }
        if (req.method === "POST" && path === "/trash/empty") {
          const result = await emptyTrash();
          return send(res, 200, { ok: true, result });
        }
        return send(res, 404, { ok: false, error: "not found: " + req.method + " " + path });
      } catch (error) {
        ctx?.logger?.warn?.("session-cleaner: api error: " + safeErrorMessage(error));
        const status = error?.code === "bad-request" || error?.code === "body-too-large" ? 400
          : error?.code === "session-not-found" ? 404
          : error?.code === "session-active" ? 409
          : 500;
        return send(res, status, { ok: false, error: safeErrorMessage(error), ...(typeof error?.code === "string" ? { code: error.code } : {}) });
      }
    }
  }), "session-cleaner: http api");
}
