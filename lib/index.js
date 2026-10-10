/**
 * dsh-session-cleaner — Host half.
 *
 * Cordis plugin that adds a true "delete" for DSH sessions, reachable from
 * the sidebar session "..." menu via the client half (lib/client.js).
 *
 * Two-step lifecycle (the client uses both; nothing disappears irreversibly
 * without a second, explicit action):
 *   delete → move the session into this plugin's own recycle bin (reversible)
 *   purge  → permanently remove a binned session and everything it left behind
 *
 * Live-session policy (v0.2.0 and later): a session whose agent is running a
 * turn is NOT refused. The running turn is cancelled, the agent fiber is
 * disposed with a bounded wait, and the session entry is flushed and detached
 * so every connected client drops its row (session/disposed). Deleting a live
 * session therefore ends an in-flight answer; the conversation stays
 * recoverable from the bin.
 *
 * What moving one session to the bin removes:
 *   1. the session artifact directory  <dshHome>/sessions/<proj>/<id>/
 *      renamed into <dshHome>/dsh-session-cleaner/trash/items/<id>/ (same-volume
 *      rename, atomic), never copied.
 *   2. workspace accounting   workspaceRegistry: the owning record's ordered
 *      sessionIds slot is detached, the id is dropped from the global
 *      archivedSessionIds set AND from pinnedSessionIds — a dangling pin would
 *      otherwise outlive the session it names.
 *   3. the projection cache row   <dshHome>/storages/session_projcache/
 *      sessions/<id>.json, plus any <id>.json.bak.* left behind by the host's
 *      backup-and-skip path. Removed through the host's own cache service when
 *      it exposes one, then verified on disk.
 *   4. schedules bound to the session, removed through the host `schedule`
 *      service so a timer cannot fire into a session that now lives in the bin.
 *
 * Every one of 1-4 is snapshotted into trash/meta/<id>.json (artifact
 * directory, workspace id/path + slot index, projection-cache row verbatim,
 * pin state, bound schedule records) so a restore puts the session back where
 * it was: same directory, same sidebar position, same cache row, same pin,
 * same timers.
 *
 * Purging a binned session deletes the artifact directory and the snapshot,
 * re-checks the projection cache and the schedule service, and removes the
 * session's project directory once it is empty.
 *
 * Crash safety: the bin writes its metadata record BEFORE moving files and
 * rewrites it afterwards, so a crash can never leave an invisible directory in
 * the bin; startup reconciliation repairs either half of that pair.
 *
 * File mutations are restricted to verified session directories; every
 * destructive step re-validates the path shape immediately before acting.
 */
import { lstat, mkdir, open, readdir, readFile, realpath, rename, rm, rmdir } from "node:fs/promises";
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
    const buildId = "dsh-session-cleaner v0.7.0";
    if (typeof ctx?.logger?.info === "function") ctx.logger.info(buildId);
    else if (typeof console !== "undefined" && console?.info) console.info(buildId);
  } catch (_) { /* ignore logging failures */ }

  const service = name => getService(ctx, name);
  const homePath = service("dshHomePath");
  if (typeof homePath !== "function") {
    ctx?.logger?.warn?.("session-cleaner: dshHomePath 服务不可用，插件功能停用");
    return;
  }

  /** Per-id operation queue so a double-click cannot start two deletions.
   * Every path that touches one session (delete / trash / restore / detail /
   * permanent delete) goes through the SAME key, so a restore can never
   * interleave with the permanent delete of the same session.
   */
  const operations = new Map();
  const mutate = (id, operation) => {
    const pending = (operations.get(id) ?? Promise.resolve()).then(operation);
    const settled = pending.catch(() => {}).finally(() => {
      if (operations.get(id) === settled) operations.delete(id);
    });
    operations.set(id, settled);
    return pending;
  };

  /** Batch slot: a batch takes this key first and each id's key second. A
   * single-session operation never takes the batch key, so the order
   * batch → id cannot deadlock. The key cannot collide with a session id:
   * assertSessionId rejects colons. */
  const BATCH_KEY = "::batch::";

  const mutateBatch = (operation) => mutate(BATCH_KEY, operation);

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

  /** Every header-verified artifact directory for one session id.
   *
   * The persistence hints are treated as candidates, not as the answer: the
   * authoritative pass walks every project segment, so a second copy of the
   * same id (which the host's own resolver refuses to disambiguate) is
   * discovered instead of silently ignored.
   */
  const scanSessionDirs = async (sessionId) => {
    assertSessionId(sessionId);
    const root = homePath("sessions");
    if (typeof root !== "string") throw new Error("无法定位 DSH sessions 目录");
    const persistence = service("sessionPersistence");
    const found = new Set();
    const tryRead = async (dir) => {
      try { await assertSessionDirectory(root, dir, sessionId); }
      catch (error) { if (error.code === "ENOENT") return undefined; throw error; }
      for (const filename of ARTIFACT_NAMES) {
        try {
          const header = await readSessionHeader(join(dir, filename));
          if (header.id !== sessionId) throw new Error("会话工件 header id 与请求不一致");
          return resolve(dir);
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
          if (dir !== undefined) found.add(dir);
        }
      } catch { /* fall through to the disk scan */ }
    }
    if (persistence && typeof persistence.locate === "function") {
      try {
        const located = persistence.locate({ id: sessionId });
        const path = located && located.path;
        if (typeof path === "string") {
          const dir = await tryRead(dirname(path));
          if (dir !== undefined) found.add(dir);
        }
      } catch { /* fall through to the disk scan */ }
    }
    let projects;
    try { projects = await readdir(root, { withFileTypes: true }); }
    catch (error) { if (error.code === "ENOENT") return [...found]; throw error; }
    for (const proj of projects) {
      if (!proj.isDirectory() || proj.isSymbolicLink()) continue;
      for (const candidate of [encodeSessionSegment(sessionId), sessionId]) {
        const dir = await tryRead(join(root, proj.name, candidate));
        if (dir !== undefined) found.add(dir);
      }
    }
    return [...found];
  };

  /** The session's artifact directory, or undefined when it has none.
   *
   * Two verified copies of one id is a corrupt layout the host itself refuses
   * to resolve (`duplicate JSONL session id appears in multiple project
   * directories`). Refuse as well: deleting the first copy would leave the
   * other behind and report success.
   */
  const sessionDirOf = async (sessionId) => {
    const dirs = await scanSessionDirs(sessionId);
    if (dirs.length === 0) return undefined;
    if (dirs.length > 1) {
      throw Object.assign(
        new Error("发现同一会话的多个日志目录，已停止操作。请先清理多余的目录再重试：\n" + dirs.join("\n")),
        { code: "duplicate-session-dirs", dirs }
      );
    }
    return dirs[0];
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

  /** Registry-global state mutation, serialized on the host's own operation
   * queue so a concurrent host write cannot interleave with ours. The mutator
   * returns the next state, or undefined to leave it alone.
   */
  const mutateGlobalState = async (mutator) => {
    const registry = service("workspaceRegistry");
    if (!registry || typeof registry.enqueueOperation !== "function"
      || typeof registry.requireState !== "function" || typeof registry.setState !== "function") return false;
    await registry.enqueueOperation(async () => {
      const state = registry.requireState();
      if (!isRecord(state)) return;
      const next = mutator(state);
      if (next !== undefined && next !== state) await registry.setState(next);
    });
    return true;
  };

  /** Drop the id from the registry-global archived set (durable, serialized). */
  const unarchiveSession = async (sessionId) => mutateGlobalState((state) => {
    if (!Array.isArray(state.archivedSessionIds) || !state.archivedSessionIds.includes(sessionId)) return undefined;
    return { ...state, archivedSessionIds: state.archivedSessionIds.filter(id => id !== sessionId) };
  });

  /** Where the id sits in the registry-global pin order, or undefined. */
  const pinnedIndexOf = (sessionId) => {
    try {
      const pinned = service("workspaceRegistry")?.pinnedSessionIds;
      if (pinned === undefined || pinned === null) return undefined;
      const index = Array.from(pinned).indexOf(sessionId);
      return index === -1 ? undefined : index;
    } catch { return undefined; }
  };

  /** Unpin one session. The pin set is registry-global, so a deleted session
   * must not keep a pin: it would outlive the session it names. */
  const clearPinnedSession = async (sessionId) => {
    const registry = service("workspaceRegistry");
    if (registry && typeof registry.unpinSession === "function") {
      try { await registry.unpinSession(sessionId); } catch { /* fall back to the state patch */ }
      if (pinnedIndexOf(sessionId) === undefined) return true;
    }
    return mutateGlobalState((state) => {
      if (!Array.isArray(state.pinnedSessionIds) || !state.pinnedSessionIds.includes(sessionId)) return undefined;
      return { ...state, pinnedSessionIds: state.pinnedSessionIds.filter(id => id !== sessionId) };
    });
  };

  /** Put a pin back where it was: the host prepends new pins, so simply
   * re-pinning would move a restored session to the front of the pin list. */
  const restorePinnedSession = async (sessionId, index) => {
    const at = Number.isInteger(index) && index >= 0 ? index : 0;
    const registry = service("workspaceRegistry");
    if (registry && typeof registry.pinSession === "function") {
      try { await registry.pinSession(sessionId); } catch { /* fall back to the state patch */ }
      if (pinnedIndexOf(sessionId) === at) return true;
    }
    return mutateGlobalState((state) => {
      const list = Array.isArray(state.pinnedSessionIds)
        ? state.pinnedSessionIds.filter(id => id !== sessionId)
        : [];
      list.splice(Math.min(at, list.length), 0, sessionId);
      return { ...state, pinnedSessionIds: list };
    });
  };

  /** The workspace record that owns this session, plus the anchor needed to
   * put it back later.
   *
   * `entity.sessionIds` is a filtered projection rebuilt on every access (it
   * drops ids the host's header index cannot resolve), so its index is not a
   * durable position. The id of the session that followed is: it stays stable
   * and `insertSessionBefore(id, anchor)` can relocate by anchor.
   */
  const captureWorkspaceSlot = async (sessionId) => {
    const slot = { workspaceId: undefined, workspacePath: undefined, index: undefined, anchorId: null, wasLast: false };
    try {
      for (const entity of (service("workspaceRegistry")?.list?.() ?? [])) {
        const ids = entity?.sessionIds;
        if (!Array.isArray(ids)) continue;
        const index = ids.indexOf(sessionId);
        if (index === -1) continue;
        slot.workspaceId = entity.id;
        slot.workspacePath = entity.path;
        slot.index = index;
        const anchor = ids[index + 1];
        slot.anchorId = typeof anchor === "string" && anchor !== sessionId ? anchor : null;
        slot.wasLast = slot.anchorId === null;
        break;
      }
    } catch { /* best-effort */ }
    return slot;
  };

  /** Put a restored session back into its workspace, at the slot it occupied.
   *
   * `attachSession` prepends, so the anchor session that used to follow it is
   * re-inserted in front of; a session that was last goes back to the end.
   * If the anchor is gone (deleted meanwhile) the session simply stays at the
   * head — the position is reported as not restored rather than guessed.
   */
  const restoreWorkspaceSlot = async (meta, sessionId) => {
    const result = { attached: false, positionRestored: false, error: undefined };
    const registry = service("workspaceRegistry");
    if (!registry) { result.error = "workspaceRegistry 服务不可用"; return result; }

    let entity;
    try {
      if (typeof meta.workspaceId === "string" && typeof registry.get === "function") {
        try { entity = registry.get(meta.workspaceId); } catch { entity = undefined; }
      }
      if (entity === undefined && typeof meta.workspacePath === "string") {
        for (const candidate of (registry.list?.() ?? [])) {
          if (candidate?.path === meta.workspacePath) { entity = candidate; break; }
        }
      }
    } catch (error) { result.error = safeErrorMessage(error); return result; }

    if (entity === undefined || typeof entity.attachSession !== "function") {
      result.error = "找不到原工作区";
      return result;
    }
    try {
      await entity.attachSession(sessionId);
      result.attached = true;
    } catch (error) {
      result.error = safeErrorMessage(error);
      return result;
    }

    if (typeof entity.insertSessionBefore !== "function") return result;
    const anchor = typeof meta.workspaceAnchorId === "string" && meta.workspaceAnchorId !== sessionId
      ? meta.workspaceAnchorId
      : undefined;
    if (anchor === undefined && meta.workspaceWasLast !== true) return result;
    try {
      // anchor 省略 = 追加到末尾（删除前它就是该工作区最后一条）
      await entity.insertSessionBefore(sessionId, anchor);
      result.positionRestored = true;
    } catch (error) {
      // 锚点会话可能已被删掉：停在头部即可，不再猜位置
      ctx?.logger?.warn?.("session-cleaner: 槽位还原失败，会话停在侧栏顶部: " + safeErrorMessage(error));
    }
    return result;
  };

  /** Whether the id currently sits in the registry-global archived set. */
  const isArchivedSession = (sessionId) => {
    try {
      const registry = service("workspaceRegistry");
      const archived = registry?.archivedSessionIds;
      if (archived !== undefined && archived !== null) return Array.from(archived).includes(sessionId);
      const state = typeof registry?.requireState === "function" ? registry.requireState() : undefined;
      return Array.isArray(state?.archivedSessionIds) && state.archivedSessionIds.includes(sessionId);
    } catch { return false; }
  };

  /** Put a restored session back into the archived set (the host appends). */
  const archiveSessionFlag = async (sessionId) => mutateGlobalState((state) => {
    const list = Array.isArray(state.archivedSessionIds) ? state.archivedSessionIds : [];
    if (list.includes(sessionId)) return undefined;
    return { ...state, archivedSessionIds: [...list, sessionId] };
  });

  // ───────────────────── 绑定该会话的定时任务 ─────────────────────
  // 宿主 schedule 服务：catalog() 列全部（含已结束），list({sessionId}) 只列进行中，
  // delete({sessionId, id}) 删单条，stopSessionTasks(sessionId) 停掉该会话全部进行中。
  // 注意：任务**不能**原样重建（create 只接受选择器、强制新 id、清空发送历史），
  // 所以回收站这一步只抄录不删除——删除不可逆，而"移入回收站"必须可逆。
  // 宿主对"会话已不存在"的到期任务只记一条 warn，不会重建会话。

  const scheduleService = () => {
    try { return service("schedule"); } catch { return undefined; }
  };

  /** 该会话当前的定时任务（含已结束的历史行），只读。 */
  const listSessionSchedules = async (sessionId) => {
    const schedule = scheduleService();
    if (!schedule || typeof schedule !== "object") return { supported: false, records: [] };
    try {
      if (typeof schedule.catalog === "function") {
        const all = await schedule.catalog();
        return { supported: true, records: (all ?? []).filter(entry => entry?.sessionId === sessionId) };
      }
      if (typeof schedule.list === "function") {
        const active = await schedule.list({ sessionId });
        return { supported: true, records: (active ?? []).map(record => ({ ...record, sessionId, status: "active" })) };
      }
    } catch (error) {
      ctx?.logger?.warn?.("session-cleaner: 读取定时任务失败: " + safeErrorMessage(error));
    }
    return { supported: false, records: [] };
  };

  /** 彻底删除该会话时清掉它的定时任务：进行中的交给宿主自己的
   * stopSessionTasks（宿主归档会话时走的就是它），已结束的历史行逐条 delete。
   */
  const purgeSessionSchedules = async (sessionId) => {
    const schedule = scheduleService();
    if (!schedule || typeof schedule !== "object") return { removed: 0, supported: false, error: undefined };
    let removed = 0;
    let supported = false;
    let error;

    if (typeof schedule.stopSessionTasks === "function") {
      supported = true;
      const before = await listSessionSchedules(sessionId);
      const active = before.records.filter(record => record.status === "active").length;
      try {
        await schedule.stopSessionTasks(sessionId);
        removed += active;
      } catch (cause) { error = safeErrorMessage(cause); }
    }

    if (typeof schedule.delete === "function") {
      supported = true;
      const left = await listSessionSchedules(sessionId);
      for (const record of left.records) {
        if (typeof record?.id !== "string" || record.id === "") continue;
        try {
          const result = await schedule.delete({ sessionId, id: record.id });
          if (result?.deleted === true) removed++;
        } catch (cause) { error ??= safeErrorMessage(cause); }
      }
    }
    return { removed, supported, error };
  };

  /** The projection-cache document path for one session, shape-checked. */
  const projcachePaths = (sessionId) => {
    assertSessionId(sessionId);
    const storages = homePath("storages");
    if (typeof storages !== "string") return undefined;
    const sessionsRoot = resolve(storages, "session_projcache", "sessions");
    const target = resolve(sessionsRoot, `${sessionId}.json`);
    const rel = relative(sessionsRoot, target);
    if (isAbsolute(rel) || rel.split(sep).length !== 1 || rel !== `${sessionId}.json`) {
      throw new Error("投影缓存路径超出允许范围，已停止清理");
    }
    return { sessionsRoot, target };
  };

  /** The host's already-open projection-cache domain table, if reachable.
   * The domain stores one document per session (`per-record` layout), so
   * `table.delete(key)` really removes
   * <dshHome>/storages/session_projcache/sessions/<id>.json — and it keeps the
   * host's in-memory table in step with the disk. `ctx.storageDomain.get(name)`
   * returns the instance the host service already opened (it is not opened
   * again here: `open()` would throw `already-open`).
   */
  const projcacheDomainTable = () => {
    try {
      const domain = service("storageDomain")?.get?.("session_projcache");
      if (domain && typeof domain.table === "function") {
        const table = domain.table("sessions");
        if (table && typeof table.delete === "function") return table;
      }
    } catch { /* domain closed / not mounted */ }
    return undefined;
  };

  /** Ask the host's projection-cache service to drop one record, so its
   * in-memory table and the durable document agree instead of only the file
   * disappearing under a table that still holds the record.
   *
   * Three faces are tried in order of how directly the host owns the record:
   * the storage domain table, a public `remove` (no current build has one),
   * then the cache service's own table. Whatever happens, the caller removes
   * the file afterwards — that is the part that survives a restart.
   *
   * `markClean` cancels a pending write-behind checkpoint of the live session,
   * which would otherwise re-create the record moments after we drop it.
   */
  const dropProjectionCacheRecord = async (sessionId, liveSession) => {
    const cache = service("sessionProjectionCache");
    if (liveSession !== undefined && liveSession !== null && typeof cache?.markClean === "function") {
      try { cache.markClean(liveSession); } catch { /* best-effort */ }
    }
    const table = projcacheDomainTable();
    if (table !== undefined) {
      try { await table.delete(sessionId); return true; } catch { /* fall through */ }
    }
    if (!cache || typeof cache !== "object") return false;
    if (typeof cache.remove === "function") {
      try { await cache.remove(sessionId); return true; } catch { /* fall through to the service table */ }
    }
    if (typeof cache.requireTable === "function") {
      try {
        const own = cache.requireTable();
        if (own && typeof own.delete === "function") { await own.delete(sessionId); return true; }
      } catch { /* fall through to the file */ }
    }
    return false;
  };

  /** Remove the projection-cache document for one session, plus any
   * `<id>.json.bak.<stamp>` copy the host's backup-and-skip path left behind.
   * The service call comes first (memory stays coherent); the file removal is
   * the authority, so a build without a usable removal API still ends clean.
   * The domain path deletes the file itself, so "did anything go away" is the
   * union of both attempts — not just whether we personally ran a rm.
   */
  const removeProjectionCacheRow = async (sessionId, liveSession) => {
    const paths = projcachePaths(sessionId);
    if (paths === undefined) return { removed: false, backups: 0, viaService: false };
    const viaService = await dropProjectionCacheRecord(sessionId, liveSession);

    let fileRemoved = false;
    let existedOnDisk = false;
    try {
      const info = await lstat(paths.target);
      if (!info.isSymbolicLink() && info.isFile()) {
        existedOnDisk = true;
        await rm(paths.target, { force: true });
        fileRemoved = true;
      }
    } catch (error) {
      // ENOENT 有两种情况：本来就没有，或者域表那一步已经把它删掉了
      if (error.code !== "ENOENT") throw error;
    }

    let backups = 0;
    try {
      for (const entry of await readdir(paths.sessionsRoot)) {
        if (!entry.startsWith(`${sessionId}.json.bak.`)) continue;
        if (relative(paths.sessionsRoot, resolve(paths.sessionsRoot, entry)).split(sep).length !== 1) continue;
        const info = await lstat(join(paths.sessionsRoot, entry)).catch(() => undefined);
        if (info === undefined || info.isSymbolicLink() || !info.isFile()) continue;
        await rm(join(paths.sessionsRoot, entry), { force: true });
        backups++;
      }
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    return { removed: viaService || fileRemoved, backups, viaService, existedOnDisk };
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
      wasLiveSession: session !== undefined && session !== null,
      // handed to the projection-cache cleanup: markClean() needs the session
      // object itself (the host keys its dirty map by object, not by id)
      liveSession: session
    };
  };

  // 旧版有一个"不进回收站直接物理删除"的 /delete 端点与一个 /status 查询端点：
  // 客户端从来不调用它们，而 /delete 是唯一会删投影缓存行的路径，读代码的人
  // 很容易据此以为"删除"覆盖了缓存行。两者已移除：删除只走回收站，
  // 彻底删除在回收站里做，缓存/记账/置顶/定时任务的清理也就都在同一条链上。

  // ───────────────────────── 回收站 ─────────────────────────
  // 「删除」把会话目录整体搬进 <dshHome>/dsh-session-cleaner/trash/items/<id>/，
  // 快照写在 trash/meta/<id>.json：原目录、工作区与槽位序号、投影缓存行原文、
  // 置顶状态、绑定该会话的定时任务。恢复时逐项还原，彻底删除才物理清除。
  // 保留期 30 天：启动跑一次，之后每 6 小时跑一次（DSH 长期不重启也会过期）。

  const TRASH_RETENTION_DAYS = 30;
  const TRASH_PURGE_INTERVAL_MS = 6 * 60 * 60 * 1000;
  /** A record written before the move: files may not be in the bin yet. */
  const META_STAGE_PREPARED = "prepared";
  /** A record whose files are in the bin and complete. */
  const META_STAGE_TRASHED = "trashed";
  /** A record repaired by startup reconciliation: the directory is in the bin
   * but its snapshot (original path and friends) is gone. */
  const META_STAGE_INCOMPLETE = "incomplete";

  const trashRoots = () => ({
    items: join(homePath("dsh-session-cleaner"), "trash", "items"),
    meta: join(homePath("dsh-session-cleaner"), "trash", "meta")
  });

  const itemDirOf = (sessionId) => join(trashRoots().items, sessionId);
  const metaPathOf = (sessionId) => join(trashRoots().meta, `${sessionId}.json`);

  const readMeta = async (sessionId) => {
    try {
      const parsed = JSON.parse(await readFile(metaPathOf(sessionId), "utf8"));
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
    try {
      await rename(temp, metaPathOf(meta.id));
    } catch (error) {
      await rm(temp, { force: true });
      throw error;
    }
  };

  const removeMeta = async (sessionId) => {
    await rm(metaPathOf(sessionId), { force: true });
  };

  const readProjcacheRow = async (sessionId) => {
    const paths = projcachePaths(sessionId);
    if (paths === undefined) return null;
    try {
      const info = await lstat(paths.target);
      if (info.isSymbolicLink() || !info.isFile()) return null;
      return await readFile(paths.target, "utf8");
    } catch { return null; }
  };

  /** Write a snapshot of the projection-cache document back. The file is the
   * authority (it survives a restart); the host's own table is updated too
   * when it exposes one, so the running process agrees with the disk. */
  const writeProjcacheRow = async (sessionId, content) => {
    const paths = projcachePaths(sessionId);
    if (paths === undefined) throw new Error("无法定位投影缓存目录");
    await mkdir(paths.sessionsRoot, { recursive: true });
    const temp = `${paths.target}.${randomBytes(6).toString("hex")}.tmp`;
    const handle = await open(temp, "wx", 0o600);
    try {
      await handle.writeFile(content);
      await handle.sync();
    } finally {
      await handle.close();
    }
    try {
      await rename(temp, paths.target);
    } catch (error) {
      await rm(temp, { force: true });
      throw error;
    }
    // 内存侧同步：优先走宿主存储域的表（同一个实例），拿不到再用缓存服务自己的表
    const record = (() => { try { return JSON.parse(content)?.record; } catch { return undefined; } })();
    if (isRecord(record)) {
      const table = projcacheDomainTable();
      if (table !== undefined && typeof table.put === "function") {
        try { await table.put(sessionId, record); return; } catch { /* fall through */ }
      }
      const cache = service("sessionProjectionCache");
      if (cache && typeof cache.requireTable === "function") {
        try {
          const own = cache.requireTable();
          if (own && typeof own.put === "function") await own.put(sessionId, record);
        } catch (error) {
          ctx?.logger?.warn?.("session-cleaner: 投影缓存内存回写失败（文件已还原）: " + safeErrorMessage(error));
        }
      }
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

    const dir = await sessionDirOf(sessionId);
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

    // 记账位置与置顶/归档状态（都在改动之前记下，恢复时逐项还原）
    const slot = await captureWorkspaceSlot(sessionId);
    const wasArchived = await isArchivedSession(sessionId);
    const pinIndex = pinnedIndexOf(sessionId);

    // 绑定该会话的定时任务：只抄录，不删除。宿主对"会话已不存在"的到期任务
    // 只记一条 warn、不会重建会话，所以留在原处是安全的；而任务无法原样重建
    // （create 强制新 id、清空发送历史），在这里删掉就等于让可逆的删除产生
    // 不可逆的副作用。定时任务由"彻底删除"那一步清。
    const schedules = await listSessionSchedules(sessionId);

    const workspacesDetached = await detachFromWorkspaces(sessionId);
    await unarchiveSession(sessionId);
    await clearPinnedSession(sessionId);

    const { items: itemsRoot, meta: metaRoot } = trashRoots();
    await mkdir(itemsRoot, { recursive: true });
    await mkdir(metaRoot, { recursive: true });
    const targetDir = itemDirOf(sessionId);
    const baseMeta = {
      version: 2,
      id: sessionId,
      originalDir: dir !== undefined ? resolve(dir) : undefined,
      workspaceId: slot.workspaceId,
      workspacePath: slot.workspacePath,
      workspaceIndex: slot.index,
      workspaceAnchorId: slot.anchorId,
      workspaceWasLast: slot.wasLast,
      deletedAt: Date.now(),
      bytes,
      cwd: info.cwd,
      title: info.title,
      turns: info.turns ?? 0,
      userMessages: info.userMessages ?? 0,
      toolCalls: info.toolCalls ?? 0,
      lastTime: info.lastTime,
      projcacheRow,
      wasArchived,
      wasPinned: pinIndex !== undefined,
      pinIndex,
      schedules: schedules.records
    };

    // 先写快照再搬文件：中途崩溃只会留下"快照说文件该在回收站但还在原位"，
    // 启动对账能认出来并回滚；反过来（先搬后写）会留下看不见的孤儿目录。
    await rm(targetDir, { recursive: true, force: true });
    await removeMeta(sessionId);
    await writeMeta({ ...baseMeta, stage: META_STAGE_PREPARED, filesMoved: false });

    let filesMoved = false;
    if (dir !== undefined) {
      try {
        await assertSessionDirectory(homePath("sessions"), dir, sessionId);
        await rename(dir, targetDir);
        filesMoved = true;
      } catch (error) {
        // 搬动失败：撤掉刚写的快照，别在回收站里留一条指向原位的假条目
        await removeMeta(sessionId).catch(() => {});
        throw error;
      }
    }
    await writeMeta({ ...baseMeta, stage: META_STAGE_TRASHED, filesMoved });

    // 投影缓存行最后清（此时日志文件已经在回收站里，快照也落盘了）
    let cache = { removed: false, backups: 0, viaService: false };
    try { cache = await removeProjectionCacheRow(sessionId, live.liveSession); }
    catch (error) { ctx?.logger?.warn?.("session-cleaner: 投影缓存清理失败: " + safeErrorMessage(error)); }

    return {
      sessionId,
      trashed: true,
      filesMoved,
      bytes,
      workspacesDetached,
      cacheRemoved: cache.removed,
      cacheBackupsRemoved: cache.backups,
      cacheViaService: cache.viaService,
      schedulesKept: schedules.records.length,
      schedulesSupported: schedules.supported,
      wasPinned: pinIndex !== undefined,
      wasArchived,
      wasLiveAgent: live.wasLiveAgent,
      wasLiveSession: live.wasLiveSession
    };
  };

  const restoreSession = async (sessionId) => {
    assertSessionId(sessionId);
    const meta = await readMeta(sessionId);
    if (meta === undefined) throw Object.assign(new Error("回收站里没有这个会话"), { code: "session-not-found" });

    // 启动对账收编的孤儿：目录在回收站里，但删除时的快照没了，原路径不可知
    if (meta.stage === META_STAGE_INCOMPLETE) {
      throw Object.assign(
        new Error("这一项缺少删除时的快照，无法确定原路径，只能彻底删除：" + (meta.incomplete ?? "")),
        { code: "incomplete-item" }
      );
    }

    const itemDir = itemDirOf(sessionId);

    // 崩溃窗口：快照写了但文件还没搬走（stage=prepared）。原位仍在就说明
    // 这次删除其实没发生，撤掉残留快照即可，不算一次恢复。
    if (meta.stage === META_STAGE_PREPARED || meta.filesMoved !== true) {
      const stillThere = typeof meta.originalDir === "string" && await existsDir(resolve(meta.originalDir));
      if (stillThere && !(await existsDir(itemDir))) {
        await removeMeta(sessionId);
        return {
          sessionId,
          restored: false,
          recovered: true,
          message: "该会话从未离开原位，已清除回收站里的残留记录。"
        };
      }
    }

    const hasFiles = typeof meta.originalDir === "string";
    if (hasFiles && !(await existsDir(itemDir))) {
      throw Object.assign(new Error("回收站数据不完整：会话目录缺失"), { code: "session-not-found" });
    }

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

    // 记账挂回原工作区，并放回原来的槽位（attachSession 是前插）
    const slot = await restoreWorkspaceSlot(meta, sessionId);
    if (!slot.attached) {
      ctx?.logger?.warn?.("session-cleaner: 记账挂回失败: " + (slot.error ?? "未知原因"));
    }

    // 归档 / 置顶状态还原。宿主的不变量是二者互斥：归档会清掉置顶。
    let archivedRestored = false;
    let pinRestored = false;
    if (meta.wasArchived === true) archivedRestored = await archiveSessionFlag(sessionId);
    else if (meta.wasPinned === true) pinRestored = await restorePinnedSession(sessionId, meta.pinIndex);

    // 定时任务从未被搬动，这里只回报它们仍在（宿主不允许原样重建任务）
    const schedules = await listSessionSchedules(sessionId);

    await removeMeta(sessionId);

    return {
      sessionId,
      restored: true,
      attached: slot.attached,
      positionRestored: slot.positionRestored,
      filesRestored,
      cacheRestored,
      archivedRestored,
      pinRestored,
      schedulesKept: schedules.records.length,
      archived: meta.wasArchived === true,
      pinned: meta.wasPinned === true,
      restoredTo: target,
      ...(slot.attached ? {} : { warning: typeof target === "string"
        ? "会话已恢复到磁盘，但未能挂回侧栏（原工作区可能已删除）。文件位置: " + target
        : "该会话没有磁盘文件，已恢复记账与缓存记录。" })
    };
  };

  /** Permanently remove binned sessions: the artifact directory, the snapshot,
   * any surviving projection-cache document (plus its backups), any schedule
   * still bound to the session, and the project directory once it is empty.
   */
  const deleteFromTrash = async (ids) => {
    const { items: itemsRoot } = trashRoots();
    const itemsRootResolved = resolve(itemsRoot);
    const results = [];
    let freedBytes = 0;
    for (const id of ids) {
      assertSessionId(id);
      const itemDir = resolve(itemsRoot, id);
      const rel = relative(itemsRootResolved, itemDir);
      if (rel.split(sep).length !== 1 || rel !== id) {
        throw new Error("回收站路径超出允许范围，已停止删除");
      }
      // 快照与存在性都放在锁内重新读：读锁外的话，"刚被恢复的那一项"会被
      // 当成还在回收站里，于是它的投影缓存行与定时任务被误清。
      try {
        const entry = await mutate(id, async () => {
          const meta = await readMeta(id);
          const itemExists = await existsDir(itemDir);
          if (!itemExists && meta === undefined) {
            return {
              sessionId: id,
              deleted: false,
              skipped: true,
              reason: "回收站里已经没有这一项（可能已被恢复或已被删除）"
            };
          }
          const notes = [];
          await rm(itemDir, { recursive: true, force: true });
          await removeMeta(id);
          freedBytes += Number(meta?.bytes) || 0;

          // 防御性复查：搬进来那一步若哪项失败，或者宿主之后又把投影缓存行
          // 写了回来，在这里补齐，保证"彻底删除"之后盘上不再有它的痕。
          try {
            const cache = await removeProjectionCacheRow(id);
            if (cache.removed || cache.backups > 0) {
              notes.push(`补清投影缓存${cache.backups > 0 ? `（含 ${cache.backups} 个备份）` : ""}`);
            }
          } catch (error) { notes.push("投影缓存清理失败: " + safeErrorMessage(error)); }
          // 定时任务只在这一步清（回收站阶段只抄录）：任务无法原样重建，
          // 而彻底删除正是"不留痕"的那一步。
          try {
            const schedules = await purgeSessionSchedules(id);
            if (schedules.removed > 0) notes.push(`清除 ${schedules.removed} 个定时任务`);
            if (schedules.error !== undefined) notes.push("定时任务部分失败: " + schedules.error);
          } catch (error) { notes.push("定时任务清理失败: " + safeErrorMessage(error)); }
          if (await removeEmptyProjectDir(meta?.originalDir)) notes.push("已删空的工程目录");

          return { sessionId: id, deleted: true, ...(notes.length ? { notes } : {}) };
        });
        results.push(entry);
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

  /** 会话的工程目录（<sessions>/<项目段>/）在最后一个会话离开后一并删掉。 */
  const removeEmptyProjectDir = async (originalDir) => {
    if (typeof originalDir !== "string" || originalDir === "") return false;
    const root = homePath("sessions");
    if (typeof root !== "string") return false;
    const projectDir = dirname(resolve(originalDir));
    const rel = relative(resolve(root), projectDir);
    if (isAbsolute(rel) || rel === "" || rel.includes("..") || rel.split(sep).length !== 1) return false;
    try {
      if ((await readdir(projectDir)).length > 0) return false;
      await rmdir(projectDir);
      return true;
    } catch { return false; }
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

  /** 下次自动清理的时刻，供面板展示（启动跑一次，之后按间隔跑）。 */
  let nextPurgeAt = Date.now() + TRASH_PURGE_INTERVAL_MS;

  const runRetentionPurge = async () => {
    try { return await purgeExpiredTrash(); }
    catch (error) {
      ctx?.logger?.warn?.("session-cleaner: 回收站过期清理失败: " + safeErrorMessage(error));
      return { removed: 0 };
    } finally {
      nextPurgeAt = Date.now() + TRASH_PURGE_INTERVAL_MS;
    }
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

  /** 启动对账：把回收站的两半（items/ 与 meta/）对齐，修掉崩溃留下的中间态。
   *
   *  - stage=prepared 且原位还在、回收站里没有目录 → 那次删除其实没发生，撤掉快照
   *  - stage=prepared 但目录已在回收站里（搬完没写第二次快照）→ 升级为 trashed
   *  - 有目录、没有快照（旧版本或异常中断的孤儿）→ 造一条 stage=incomplete 的快照，
   *    让它至少可见、可彻底删除，而不是永远占着磁盘又显示不出来
   *  - 残留的 .tmp 快照 → 删掉
   */
  const reconcileTrash = async () => {
    const { items: itemsRoot, meta: metaRoot } = trashRoots();
    const report = { repaired: 0, rolledBack: 0, adopted: 0, tempRemoved: 0 };

    let metaFiles = [];
    try { metaFiles = await readdir(metaRoot); }
    catch (error) { if (error.code !== "ENOENT") throw error; }

    for (const file of metaFiles) {
      if (file.endsWith(".tmp")) {
        await rm(join(metaRoot, file), { force: true }).catch(() => {});
        report.tempRemoved++;
        continue;
      }
      if (!file.endsWith(".json")) continue;
      const id = file.slice(0, -5);
      let meta;
      try { meta = JSON.parse(await readFile(join(metaRoot, file), "utf8")); }
      catch { continue; }
      if (!isRecord(meta) || typeof meta.id !== "string") continue;

      const hasItem = await existsDir(itemDirOf(id));
      const hasOriginal = typeof meta.originalDir === "string" && await existsDir(resolve(meta.originalDir));

      if (meta.stage === META_STAGE_PREPARED || meta.filesMoved !== true) {
        if (hasItem) {
          await writeMeta({ ...meta, stage: META_STAGE_TRASHED, filesMoved: true });
          report.repaired++;
        } else if (hasOriginal) {
          await removeMeta(id);
          report.rolledBack++;
        }
      } else if (!hasItem && hasOriginal) {
        // 文件已经搬回原位，快照却没删掉（恢复的最后一步崩溃）
        await removeMeta(id);
        report.rolledBack++;
      }
    }

    let itemDirs = [];
    try {
      itemDirs = (await readdir(itemsRoot, { withFileTypes: true }))
        .filter(entry => entry.isDirectory() && !entry.isSymbolicLink())
        .map(entry => entry.name);
    } catch (error) { if (error.code !== "ENOENT") throw error; }

    for (const id of itemDirs) {
      try { assertSessionId(id); } catch { continue; }
      if (await readMeta(id) !== undefined) continue;
      const bytes = await dirSize(itemDirOf(id)).catch(() => 0);
      await writeMeta({
        version: 2,
        id,
        stage: META_STAGE_INCOMPLETE,
        filesMoved: true,
        deletedAt: Date.now(),
        bytes,
        incomplete: "缺少删除时的快照（异常中断留下的），无法确定原路径，只能彻底删除"
      });
      report.adopted++;
    }

    if (report.repaired + report.rolledBack + report.adopted + report.tempRemoved > 0) {
      ctx?.logger?.info?.("session-cleaner: 回收站对账 → 修复 " + report.repaired
        + " / 回滚 " + report.rolledBack + " / 收编孤儿 " + report.adopted
        + " / 清临时 " + report.tempRemoved);
    }
    return report;
  };

  // 启动：先对账再清过期；之后每 6 小时清一次（DSH 长期不重启也会过期）
  ctx.effect(() => {
    reconcileTrash().catch(() => {});
    runRetentionPurge().catch(() => {});
    const timer = setInterval(() => { void runRetentionPurge(); }, TRASH_PURGE_INTERVAL_MS);
    if (typeof timer?.unref === "function") timer.unref();
    return () => clearInterval(timer);
  }, "session-cleaner: trash reconciliation and retention");

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
        // 单会话操作：全部走同一个会话锁（同一 id 的"恢复"与"彻底删除"不会交错）
        if (req.method === "POST" && path === "/trash") {
          assertSessionId(sessionId);
          const result = await mutate(sessionId, () => trashSession(sessionId));
          return send(res, 200, { ok: true, result });
        }
        if (req.method === "POST" && path === "/trash/list") {
          const result = await listTrash();
          return send(res, 200, {
            ok: true,
            result: {
              ...result,
              retentionDays: TRASH_RETENTION_DAYS,
              nextPurgeAt,
              schedulesSupported: scheduleService() !== undefined
            }
          });
        }
        if (req.method === "POST" && path === "/trash/search") {
          const keyword = typeof body.keyword === "string" ? body.keyword.trim() : "";
          if (keyword === "") return send(res, 400, { ok: false, error: "keyword 必填", code: "bad-request" });
          const result = await searchTrash(keyword);
          return send(res, 200, { ok: true, result });
        }
        if (req.method === "POST" && path === "/trash/detail") {
          assertSessionId(sessionId);
          const result = await mutate(sessionId, () => trashDetail(sessionId));
          return send(res, 200, { ok: true, result });
        }
        if (req.method === "POST" && path === "/trash/restore") {
          assertSessionId(sessionId);
          const result = await mutate(sessionId, () => restoreSession(sessionId));
          return send(res, 200, { ok: true, result });
        }
        // 批量操作：先占批量位，再逐条占各自的会话位（batch → id，无死锁）
        if (req.method === "POST" && path === "/trash/delete") {
          const rawIds = Array.isArray(body.sessionIds) ? body.sessionIds : [sessionId];
          const ids = Array.from(new Set(rawIds.filter(id => typeof id === "string" && id.trim() !== "").map(id => id.trim())));
          if (ids.length === 0) return send(res, 400, { ok: false, error: "sessionIds 必须是非空数组", code: "bad-request" });
          for (const id of ids) assertSessionId(id);
          const result = await mutateBatch(() => deleteFromTrash(ids));
          return send(res, 200, { ok: true, result });
        }
        if (req.method === "POST" && path === "/trash/empty") {
          const result = await mutateBatch(() => emptyTrash());
          return send(res, 200, { ok: true, result });
        }
        return send(res, 404, { ok: false, error: "not found: " + req.method + " " + path });
      } catch (error) {
        ctx?.logger?.warn?.("session-cleaner: api error: " + safeErrorMessage(error));
        const status = error?.code === "bad-request" || error?.code === "body-too-large" ? 400
          : error?.code === "session-not-found" ? 404
          : error?.code === "session-active" || error?.code === "duplicate-session-dirs" || error?.code === "incomplete-item" ? 409
          : 500;
        return send(res, status, { ok: false, error: safeErrorMessage(error), ...(typeof error?.code === "string" ? { code: error.code } : {}) });
      }
    }
  }), "session-cleaner: http api");
}
