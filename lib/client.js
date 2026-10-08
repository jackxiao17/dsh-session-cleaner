/**
 * dsh-session-cleaner — Client half.
 *
 * 三块能力：
 *   1. 侧栏会话 `···` 菜单里的红色「删除」项 → 确认后移入回收站；
 *   2. 侧栏底部「会话回收站」按钮（与会话管理同款位置/适配）→ 面板：
 *      标题与正文搜索、工作区筛选、排序、恢复、彻底删除（单条/批量/清空）；
 *   3. shell.overlay 确认框（菜单关闭后仍存活，自带深浅色主题）。
 *
 * No build step: DSH loads this file as a Cordis client bundle via the
 * dsh.client declaration in package.json.
 */
window.__ModuleLoader__.load({
  id: "dsh-session-cleaner",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

    const React = require("react");
    const { useState, useEffect, useMemo, useRef, useSyncExternalStore } = React;
    const P = require("@deepseek-ai/dsh-client-ui-primitives");

    const h = (type, props, ...children) => React.createElement(type, props, ...children);

    const NS = "session-cleaner";
    const API = "/session-cleaner/api";

    // apply(ctx) 时挂上的宿主上下文引用，供恢复后刷新侧栏、删除后清主视图用。
    let hostCtx = undefined;

    const zh = {
      "menu.delete": "删除",
      "dialog.loading": "正在读取会话信息…",
      "dialog.retention": "回收站保留 30 天，之后自动清除。",
      "dialog.cancel": "取消",
      "dialog.error": "操作失败：{message}",
      "dialog.close": "关闭",
      "toast.trashed": "会话已删除至回收站",
      "toast.trashFailed": "移入回收站失败：{message}",
      "info.title": "会话名称",
      "info.cwd": "工作目录",
      "info.turns": "对话轮次",
      "info.userMessages": "用户消息",
      "info.toolCalls": "工具调用",
      "info.size": "大小",
      "info.lastActive": "最后活动",
      "unit.turns": "轮",
      "unit.messages": "条",
      "unit.calls": "次",
      "unit.items": "项",
      "trash.title": "会话回收站",
      "trash.count": "共 {n} 项 · 占用 {size}",
      "trash.search": "搜索标题，或勾选后搜正文内容",
      "trash.searchContent": "搜正文",
      "trash.searching": "正在搜索正文…",
      "trash.workspaceAll": "全部工作区",
      "trash.sortDeleted": "删除时间",
      "trash.sortTitle": "标题",
      "trash.sortSize": "大小",
      "trash.sortTurns": "轮次",
      "trash.restore": "恢复",
      "trash.purge": "彻底删除",
      "trash.selectAll": "全选",
      "trash.deselectAll": "全不选",
      "trash.selected": "已选 {n} 项",
      "trash.restoreSelected": "恢复所选",
      "trash.purgeSelected": "彻底删除所选",
      "trash.emptyBin": "清空回收站",
      "trash.confirmPurge": "确认彻底删除所选 {n} 项？此操作不可恢复。",
      "trash.confirmEmpty": "确认清空回收站（共 {n} 项）？此操作不可恢复。",
      "trash.confirm": "确认",
      "trash.restored": "已恢复到侧栏",
      "trash.purged": "已彻底删除",
      "trash.emptyDone": "回收站已清空",
      "trash.deletedAt": "删除于",
      "trash.emptyState": "回收站是空的",
      "trash.searchHit": "{n} 处匹配",
      "trash.searchNone": "没有匹配的内容",
      "trash.restoreWarning": "恢复后原工作区可能已变化，若侧栏未出现请稍候或刷新。",
      "trash.viewLog": "查看对话记录",
      "sort.asc": "升序",
      "sort.desc": "降序",
      "detail.back": "返回",
      "detail.title": "对话记录",
      "detail.questions": "提问记录（共 {n} 条）",
      "detail.turn": "第 {n} 轮",
      "detail.tools": "工具 {n} 次",
      "detail.noQuestions": "这个会话没有提问记录（可能是空白会话或子代理会话）。",
      "detail.loading": "正在读取对话记录…"
    };
    const en = {
      "menu.delete": "Delete",
      "dialog.loading": "Loading session info…",
      "dialog.retention": "The recycle bin keeps sessions for 30 days, then clears them automatically.",
      "dialog.cancel": "Cancel",
      "dialog.error": "Operation failed: {message}",
      "dialog.close": "Close",
      "toast.trashed": "Session moved to recycle bin",
      "toast.trashFailed": "Failed to move to recycle bin: {message}",
      "info.title": "Session",
      "info.cwd": "Workspace",
      "info.turns": "Turns",
      "info.userMessages": "User messages",
      "info.toolCalls": "Tool calls",
      "info.size": "Size",
      "info.lastActive": "Last activity",
      "unit.turns": "turns",
      "unit.messages": "messages",
      "unit.calls": "calls",
      "unit.items": "items",
      "trash.title": "Recycle bin",
      "trash.count": "{n} items · {size}",
      "trash.search": "Search titles, or check the box to search content",
      "trash.searchContent": "Search content",
      "trash.searching": "Searching content…",
      "trash.workspaceAll": "All workspaces",
      "trash.sortDeleted": "Deleted time",
      "trash.sortTitle": "Title",
      "trash.sortSize": "Size",
      "trash.sortTurns": "Turns",
      "trash.restore": "Restore",
      "trash.purge": "Delete forever",
      "trash.selectAll": "Select all",
      "trash.deselectAll": "Deselect all",
      "trash.selected": "{n} selected",
      "trash.restoreSelected": "Restore selected",
      "trash.purgeSelected": "Delete selected forever",
      "trash.emptyBin": "Empty recycle bin",
      "trash.confirmPurge": "Permanently delete the selected {n} item(s)? This cannot be undone.",
      "trash.confirmEmpty": "Empty the recycle bin ({n} items)? This cannot be undone.",
      "trash.confirm": "Confirm",
      "trash.restored": "Restored to sidebar",
      "trash.purged": "Deleted forever",
      "trash.emptyDone": "Recycle bin emptied",
      "trash.deletedAt": "Deleted",
      "trash.emptyState": "The recycle bin is empty",
      "trash.searchHit": "{n} hits",
      "trash.searchNone": "No matching content",
      "trash.restoreWarning": "The original workspace may have changed; if the session does not appear, wait or refresh.",
      "trash.viewLog": "View conversation",
      "sort.asc": "Ascending",
      "sort.desc": "Descending",
      "detail.back": "Back",
      "detail.title": "Conversation log",
      "detail.questions": "Questions ({n})",
      "detail.turn": "Turn {n}",
      "detail.tools": "{n} tool calls",
      "detail.noQuestions": "No questions recorded (this may be a blank or subagent session).",
      "detail.loading": "Loading conversation…"
    };

    const formatBytes = (bytes) => {
      if (!Number.isFinite(bytes) || bytes < 0) return "?";
      if (bytes < 1024) return bytes + " B";
      if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + " KB";
      if (bytes < 1024 * 1024 * 1024) return (bytes / 1024 / 1024).toFixed(1) + " MB";
      return (bytes / 1024 / 1024 / 1024).toFixed(2) + " GB";
    };

    const formatTime = (ms) => {
      if (typeof ms !== "number" || !Number.isFinite(ms)) return "—";
      try {
        const d = new Date(ms);
        const pad = (n) => String(n).padStart(2, "0");
        return d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate()) + " " + pad(d.getHours()) + ":" + pad(d.getMinutes());
      } catch { return "—"; }
    };

    const callApi = (path, payload) => fetch(API + path, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload || {})
    }).then((r) => r.json());

    const refreshSidebar = async () => {
      try { if (hostCtx?.sessions?.refresh) await hostCtx.sessions.refresh(); } catch { /* best-effort */ }
      try { if (hostCtx?.workspaces?.refresh) await hostCtx.workspaces.refresh(); } catch { /* best-effort */ }
    };

    // ───────────────────────── 主题探测（不依赖 DSH 变量） ─────────────────────────

    function detectTheme() {
      try {
        // DSH 的主题呈现器把当前配色写在 body[data-ds-dark-theme] 上
        // （设置里 light/dark/system 三选一，只有 system 才跟随系统），
        // 属性在不在就是权威信号；先看它，避免"系统深色 + 应用内浅色"被误判。
        const body = document.body;
        if (body) {
          if (body.hasAttribute("data-ds-dark-theme")) return "dark";
          // 主题已投影（内联了 --dsw-alias-* 令牌）但属性缺席 ⇒ 明确是浅色，
          // 不必再猜；否则继续用下面的兜底判断。
          if (body.style.getPropertyValue("--dsw-alias-label-primary") !== "") return "light";
        }
      } catch { /* fall through */ }
      try {
        const color = getComputedStyle(document.body).color || "";
        const parts = color.match(/\d+(?:\.\d+)?/g);
        if (parts && parts.length >= 3) {
          const luminance = 0.2126 * Number(parts[0]) + 0.7152 * Number(parts[1]) + 0.0722 * Number(parts[2]);
          if (luminance > 160) return "dark";
          if (luminance < 96) return "light";
        }
        const mq = typeof window.matchMedia === "function" ? window.matchMedia("(prefers-color-scheme: dark)") : null;
        if (mq) return mq.matches ? "dark" : "light";
      } catch { /* fall through */ }
      return "light";
    }

    function useTheme() {
      const [theme, setTheme] = useState(() => detectTheme());
      useEffect(() => {
        const listener = () => setTheme(detectTheme());
        const mq = typeof window.matchMedia === "function" ? window.matchMedia("(prefers-color-scheme: dark)") : null;
        if (mq) {
          if (typeof mq.addEventListener === "function") mq.addEventListener("change", listener);
          else if (typeof mq.addListener === "function") mq.addListener(listener);
        }
        // 设置里手动切换主题时，DSH 只改 body 上的属性，不会触发媒体查询
        const observer = typeof MutationObserver === "function" && document.body
          ? new MutationObserver(listener)
          : null;
        if (observer) observer.observe(document.body, { attributes: true, attributeFilter: ["data-ds-dark-theme", "style"] });
        return () => {
          if (mq) {
            if (typeof mq.removeEventListener === "function") mq.removeEventListener("change", listener);
            else if (typeof mq.removeListener === "function") mq.removeListener(listener);
          }
          if (observer) observer.disconnect();
        };
      }, []);
      return theme;
    }

    const paletteFor = (theme) => theme === "dark" ? {
      layer: "rgba(0,0,0,.55)",
      panel: "#232326",
      panelBorder: "rgba(255,255,255,.14)",
      shadow: "0 8px 28px rgba(0,0,0,.5)",
      text: "#f1f1f3",
      secondary: "#a9a9b2",
      danger: "#f0616d",
      success: "#5ad197",
      btnBorder: "rgba(255,255,255,.2)",
      rowBorder: "rgba(255,255,255,.1)",
      inputBg: "#1b1b1e",
      user: "#7ab0ff",
      model: "#5ad197",
      turn: "#b99cf5"
    } : {
      layer: "rgba(0,0,0,.4)",
      panel: "#ffffff",
      panelBorder: "rgba(0,0,0,.12)",
      shadow: "0 8px 28px rgba(0,0,0,.18)",
      text: "#1f2328",
      secondary: "#67707c",
      danger: "#d92d20",
      success: "#1a7f37",
      btnBorder: "rgba(0,0,0,.16)",
      rowBorder: "rgba(0,0,0,.08)",
      inputBg: "#ffffff",
      user: "#1a6bed",
      model: "#1a7f37",
      turn: "#7c4ddb"
    };

    /** 极简 Markdown 渲染（无构建环境，手写常用子集）：
     *  代码块/行内代码/标题/加粗/无序与有序列表/引用/链接。
     */
    function renderMarkdown(src, palette) {
      const inline = (text, keyPrefix) => {
        const nodes = [];
        const re = /(`[^`\n]+`|\*\*[^*\n]+\*\*|\[[^\]\n]+\]\([^)\n]+\))/g;
        let last = 0;
        let m;
        let n = 0;
        while ((m = re.exec(text)) !== null) {
          if (m.index > last) nodes.push(text.slice(last, m.index));
          const tok = m[0];
          if (tok.startsWith("`")) {
            nodes.push(h("code", { key: keyPrefix + "-i" + n++ }, tok.slice(1, -1)));
          } else if (tok.startsWith("**")) {
            nodes.push(h("strong", { key: keyPrefix + "-b" + n++ }, tok.slice(2, -2)));
          } else {
            const mm = tok.match(/^\[([^\]]+)\]\(([^)]+)\)$/);
            nodes.push(h("span", { key: keyPrefix + "-l" + n++, style: { textDecoration: "underline", wordBreak: "break-all" } }, mm[1] + "（" + mm[2] + "）"));
          }
          last = m.index + tok.length;
        }
        if (last < text.length) nodes.push(text.slice(last));
        return nodes;
      };
      const blocks = [];
      const lines = String(src).split("\n");
      const isBlockStart = (line) => /^\s*(```|#{1,4}\s|[-*]\s+|\d+[.)]\s+|>\s?)/.test(line);
      let i = 0;
      let key = 0;
      while (i < lines.length) {
        const line = lines[i];
        if (line.trim() === "") { i++; continue; }
        if (/^\s*```/.test(line)) {
          const code = [];
          i++;
          while (i < lines.length && !/^\s*```/.test(lines[i])) { code.push(lines[i]); i++; }
          if (i < lines.length) i++;
          blocks.push(h("pre", { key: "k" + key++ }, h("code", null, code.join("\n"))));
          continue;
        }
        const heading = line.match(/^(#{1,4})\s+(.*)$/);
        if (heading) {
          const level = heading[1].length;
          blocks.push(h("div", { key: "k" + key++, style: { fontWeight: 700, fontSize: level <= 2 ? 15 : 13.5, margin: "8px 0 4px" } }, inline(heading[2], "h" + key)));
          i++;
          continue;
        }
        if (/^\s*[-*]\s+/.test(line)) {
          const items = [];
          while (i < lines.length && /^\s*[-*]\s+/.test(lines[i])) { items.push(lines[i].replace(/^\s*[-*]\s+/, "")); i++; }
          blocks.push(h("div", { key: "k" + key++, style: { margin: "4px 0", display: "flex", flexDirection: "column", gap: 2 } },
            items.map((item, j) => h("div", { key: j, style: { display: "flex", gap: 6 } },
              h("span", { style: { color: palette.secondary } }, "•"),
              h("span", { style: { flex: 1 } }, inline(item, "li" + key + "-" + j))
            ))
          ));
          continue;
        }
        if (/^\s*\d+[.)]\s+/.test(line)) {
          const items = [];
          while (i < lines.length && /^\s*\d+[.)]\s+/.test(lines[i])) { items.push(lines[i].replace(/^\s*\d+[.)]\s+/, "")); i++; }
          blocks.push(h("div", { key: "k" + key++, style: { margin: "4px 0", display: "flex", flexDirection: "column", gap: 2 } },
            items.map((item, j) => h("div", { key: j, style: { display: "flex", gap: 6 } },
              h("span", { style: { color: palette.secondary } }, String(j + 1) + "."),
              h("span", { style: { flex: 1 } }, inline(item, "ol" + key + "-" + j))
            ))
          ));
          continue;
        }
        if (/^\s*>\s?/.test(line)) {
          const quote = [];
          while (i < lines.length && /^\s*>\s?/.test(lines[i])) { quote.push(lines[i].replace(/^\s*>\s?/, "")); i++; }
          blocks.push(h("blockquote", { key: "k" + key++, style: { margin: "6px 0", padding: "2px 10px", borderLeft: "3px solid " + palette.rowBorder } }, inline(quote.join("\n"), "q" + key)));
          continue;
        }
        const para = [line];
        i++;
        while (i < lines.length && lines[i].trim() !== "" && !isBlockStart(lines[i])) { para.push(lines[i]); i++; }
        blocks.push(h("p", { key: "k" + key++, style: { margin: "4px 0" } }, inline(para.join("\n"), "p" + key)));
      }
      return blocks;
    }

    // ───────────────────────── 轻提示（toast）与直接移入回收站 ─────────────────────────
    // 「删除」不再有二次确认弹窗：点菜单即移入回收站（可恢复），成功/失败用
    // 顶部轻提示反馈。toast 状态走模块级 store，Toast 组件常驻 shell.overlay。

    let toastState = null; // { text, kind, at }
    const toastListeners = new Set();
    let toastTimer = null;
    const toastStore = {
      show(text, kind) {
        toastState = { text, kind, at: Date.now() };
        toastListeners.forEach(l => l());
        if (toastTimer) clearTimeout(toastTimer);
        toastTimer = setTimeout(() => {
          toastState = null;
          toastListeners.forEach(l => l());
        }, 2600);
      },
      subscribe(listener) { toastListeners.add(listener); return () => toastListeners.delete(listener); },
      getSnapshot: () => toastState
    };
    const useToastState = () => useSyncExternalStore(toastStore.subscribe, toastStore.getSnapshot, toastStore.getSnapshot);

    async function performTrash(sessionId, t) {
      try {
        const r = await callApi("/trash", { sessionId });
        if (r && r.ok) {
          // 若删的是当前打开的会话，清掉聊天主视图（和恢复/移动同款处理）
          try {
            const sessions = hostCtx && hostCtx.sessions;
            const snapshot = sessions && sessions.list && sessions.list.getSnapshot ? sessions.list.getSnapshot() : null;
            if (snapshot && snapshot.current === sessionId && typeof sessions.clear === "function") sessions.clear();
          } catch { /* best-effort */ }
          toastStore.show(t("toast.trashed"), "success");
        } else {
          toastStore.show("✕ " + t("toast.trashFailed").replace("{message}", (r && r.error) || "unknown"), "error");
        }
      } catch (error) {
        toastStore.show("✕ " + t("toast.trashFailed").replace("{message}", String(error)), "error");
      }
    }

    // ───────────────────────── 样式（结构层，颜色走内联） ─────────────────────────

    const CSS = `
.scl-layer{position:fixed;inset:0;z-index:11000;display:flex;align-items:center;justify-content:center}
.scl-panel{position:relative;width:480px;max-width:92vw;max-height:82vh;overflow:auto;border-radius:10px;padding:18px 20px;font-size:13px;line-height:18px}
.scl-panelSmall{width:380px}
.scl-close{position:absolute;top:8px;right:8px;width:26px;height:26px;display:flex;align-items:center;justify-content:center;border:0;border-radius:6px;background:transparent;cursor:pointer;font-size:16px;line-height:1;padding:0}
.scl-close:hover{background:rgba(127,127,127,.18)}
.scl-close:disabled{opacity:.45;cursor:default}
.scl-title{margin:0 30px 12px 0;font-size:15px;font-weight:600}
.scl-info{display:flex;flex-direction:column;gap:5px;margin:2px 0 4px}
.scl-infoRow{display:flex;gap:12px}
.scl-infoLabel{flex:0 0 66px}
.scl-infoValue{flex:1;word-break:break-all}
.scl-reminders{margin-top:12px;padding-top:10px}
.scl-warn,.scl-error{margin:5px 0 0;word-break:break-all}
.scl-ok{margin:10px 0 0}
.scl-footer{display:flex;justify-content:flex-end;gap:10px;margin-top:16px}
.scl-btn{min-width:76px;min-height:30px;padding:4px 14px;border-radius:7px;border:1px solid transparent;cursor:pointer;font-size:13px}
.scl-btn:disabled{opacity:.55;cursor:default}
.scl-footerSlot{position:relative;width:100%;display:flex}
.scl-footerBtn{flex:1 1 auto;min-width:0;min-height:36px;padding:8px 10px;border:1px solid transparent;border-radius:8px;cursor:pointer;font-size:14px;font-weight:500;gap:8px;justify-content:center;align-items:center;text-align:center;display:flex}
.scl-themeLight .scl-footerBtn{background:#ffffff;border:1px solid rgba(0,0,0,.12);color:#1f2328}
.scl-themeLight .scl-footerBtn:hover{background:#f1f3f5;border-color:rgba(0,0,0,.18)}
.scl-themeDark .scl-footerBtn{background:#43454a;border:1px solid rgba(255,255,255,.09);color:#f2f2f4}
.scl-themeDark .scl-footerBtn:hover{background:#353638;border-color:rgba(255,255,255,.14)}
.scl-footerBtnRail{flex:0 0 36px;width:36px;min-width:36px;min-height:36px;padding:0}
/* 侧栏收起（rail）时对齐原生「新会话」图标态：无底色，仅悬停着色 */
.scl-railOnly .scl-footerBtn{background:transparent;border:1px solid transparent}
.scl-themeLight .scl-railOnly .scl-footerBtn:hover{background:rgba(38,49,72,.06)}
.scl-themeDark .scl-railOnly .scl-footerBtn:hover{background:rgba(255,255,255,.08)}
.scl-modalWide{width:640px;max-width:94vw;max-height:82vh;overflow:auto;border-radius:10px;padding:16px 18px;font-size:13px;line-height:18px;display:flex;flex-direction:column}
.scl-modalHeader{display:flex;align-items:flex-start;gap:10px;margin-bottom:12px;padding-bottom:12px}
.scl-headLeft{flex:1;min-width:0}
.scl-headTitle{margin:0;font-size:15px;font-weight:600}
.scl-headSub{font-size:12px;margin-top:3px}
.scl-count{font-size:12px}
.scl-controls{display:flex;gap:8px;margin:0 0 10px;flex-wrap:wrap;align-items:center}
.scl-input{flex:1;min-width:130px;height:28px;box-sizing:border-box;padding:0 8px;border-radius:7px;border:1px solid transparent;font-size:13px;outline:none}
.scl-select{height:28px;box-sizing:border-box;padding:0 6px;border-radius:7px;border:1px solid transparent;font-size:12px;outline:none;cursor:pointer}
.scl-check{display:flex;align-items:center;gap:4px;height:28px;font-size:12px;cursor:pointer;white-space:nowrap}
.scl-tList{flex:1;overflow:auto;display:flex;flex-direction:column;gap:6px;padding-right:2px;min-height:120px}
.scl-tRow{display:flex;gap:10px;align-items:center;padding:8px 10px;border:1px solid transparent;border-radius:8px}
.scl-tMain{flex:1;min-width:0}
.scl-tTitle{font-weight:600;word-break:break-all;display:flex;align-items:center;gap:6px;flex-wrap:wrap}
.scl-tMeta{font-size:12px;margin-top:3px;word-break:break-all}
.scl-tBadge{font-size:11px;font-weight:500;padding:1px 6px;border-radius:8px;background:rgba(127,127,127,.2)}
.scl-tBtns{display:flex;flex-direction:row;gap:6px}
.scl-miniBtn{min-width:56px;min-height:26px;padding:3px 10px;border-radius:6px;border:1px solid transparent;background:transparent;cursor:pointer;font-size:12px;display:flex;align-items:center;justify-content:center}
.scl-miniBtn:disabled{opacity:.5;cursor:default}
.scl-batchBar{display:flex;gap:8px;align-items:center;margin-top:10px;padding-top:10px;flex-wrap:wrap}
.scl-spacer{flex:1}
.scl-tNotice{font-size:12px;margin:0 0 8px;word-break:break-all}
.scl-notice{font-size:12px;margin:6px 0 0}
.scl-empty{flex:1;display:flex;align-items:center;justify-content:center;font-size:13px;min-height:120px}
.scl-sortBtn{height:28px;box-sizing:border-box;min-width:28px;padding:0 6px;border-radius:7px;border:1px solid transparent;background:transparent;cursor:pointer;font-size:12px}
.scl-turn{display:flex;flex-direction:column;gap:8px;padding:10px 12px;border:1px solid transparent;border-radius:8px;cursor:pointer}
.scl-turn:hover{background:rgba(127,127,127,.07)}
.scl-turnHead{display:flex;align-items:center;gap:10px;font-size:12px;flex-wrap:wrap}
.scl-turnBadge{padding:1px 8px;border-radius:999px;font-weight:600;font-size:11px;background:rgba(127,127,127,.16)}
.scl-turnArrow{margin-left:auto;font-size:11px}
.scl-collapsedRow{display:flex;gap:4px;align-items:baseline;min-width:0}
.scl-fade{flex:1;min-width:0;white-space:nowrap;overflow:hidden;-webkit-mask-image:linear-gradient(to right,#000 78%,transparent);mask-image:linear-gradient(to right,#000 78%,transparent)}
.scl-md{white-space:pre-wrap;word-break:break-word;font-size:13px;line-height:20px}
.scl-md pre{margin:6px 0;padding:8px 10px;border-radius:6px;overflow-x:auto;background:rgba(127,127,127,.14);white-space:pre;font-size:12px;line-height:17px}
.scl-md code{font-family:Consolas,"Courier New",monospace;font-size:12px;background:rgba(127,127,127,.16);padding:0 4px;border-radius:4px}
.scl-md pre code{background:transparent;padding:0}
`;

    function injectStyle() {
      try {
        if (document.getElementById("dsh-session-cleaner-style")) return () => {};
        const tag = document.createElement("style");
        tag.id = "dsh-session-cleaner-style";
        tag.textContent = CSS;
        document.head.appendChild(tag);
        return () => { try { tag.remove(); } catch { /* ignore */ } };
      } catch { return () => {}; }
    }

    // ───────────────────────── ··· 菜单里的删除项 ─────────────────────────

    function DeleteSessionMenuItem(props) {
      const { sessionId, useMenuOpenState, t } = props;
      if (typeof P.MenuItemButton !== "function" || !P.IconTrashOutlineRegular) return null;
      try {
        const [, setMenuOpen] = useMenuOpenState();
        return h(P.MenuItemButton, {
          danger: true, // 原生红色菜单项样式：字号/颜色与官方条目完全一致
          icon: h(P.IconTrashOutlineRegular, {}),
          onSelect: () => {
            try { setMenuOpen(false); } catch { /* menu already closing */ }
            performTrash(sessionId, t);
          },
          children: t("menu.delete")
        });
      } catch { return null; }
    }

    // 顶部轻提示：移入回收站的成败反馈（自动消失）
    function TrashToast() {
      const theme = useTheme();
      const palette = paletteFor(theme);
      const toast = useToastState();
      if (!toast) return null;
      return h("div", {
        style: {
          position: "fixed", top: 14, left: "50%", transform: "translateX(-50%)", zIndex: 11100,
          background: palette.panel, border: "1px solid " + palette.panelBorder, boxShadow: palette.shadow,
          color: palette.text, borderRadius: 8, padding: "8px 16px", fontSize: 13,
          display: "flex", alignItems: "center", gap: 8
        },
        role: "status"
      },
        h("span", { style: { color: toast.kind === "error" ? palette.danger : palette.success, fontWeight: 600 } }, toast.kind === "error" ? "✕" : "✓"),
        h("span", null, toast.text)
      );
    }

    // ───────────────────────── 侧栏底部「会话回收站」按钮 + 面板 ─────────────────────────

    // 回收站弹窗开关：模块级 store。footer 按钮直接调 openTrashUi()（同模块），
    // 弹窗本体渲染在 shell.overlay 里、经注入的 use hook 读取开关——与
    // 「菜单项 → 确认框」完全同一套已验证机制（居中弹窗、×/Esc/点背景都能关）。
    let trashUiOpen = false;
    const trashUiListeners = new Set();
    const trashUiStore = {
      subscribe(listener) { trashUiListeners.add(listener); return () => trashUiListeners.delete(listener); },
      getSnapshot: () => trashUiOpen,
      open() { if (!trashUiOpen) { trashUiOpen = true; trashUiListeners.forEach(l => l()); } },
      close() { if (trashUiOpen) { trashUiOpen = false; trashUiListeners.forEach(l => l()); } }
    };
    const useTrashUiOpen = () => useSyncExternalStore(trashUiStore.subscribe, trashUiStore.getSnapshot, trashUiStore.getSnapshot);
    const openTrashUi = () => trashUiStore.open();
    const closeTrashUi = () => trashUiStore.close();

    // 面板渲染的错误边界：面板内部出错时只收起弹窗，不拖垮整个界面
    class SclErrorBoundary extends React.Component {
      constructor(props) { super(props); this.state = { failed: false }; }
      static getDerivedStateFromError() { return { failed: true }; }
      componentDidCatch(error) { try { console.error("session-cleaner:", error); } catch { /* ignore */ } }
      render() { return this.state.failed ? null : this.props.children; }
    }

    function TrashFooterAction(props) {
      const { t, openTrashUi: openPanel } = props;
      const wide = props.wide === true;
      const theme = useTheme();
      try {
        return h("div", {
          className: "scl-footerSlot"
            + (theme === "dark" ? " scl-themeDark" : " scl-themeLight")
            + (wide ? "" : " scl-railOnly")
        },
          h("button", {
            type: "button",
            className: "scl-footerBtn" + (wide ? "" : " scl-footerBtnRail"),
            "aria-label": t("trash.title"),
            onClick: () => openPanel()
          },
            h(P.IconArchiveOutlineRegular, { size: wide ? 16 : 18 }),
            wide ? h("span", null, t("trash.title")) : null
          )
        );
      } catch { return null; }
    }

    const footerInjected = () => ({ openTrashUi });

    function RecycleBinOverlay({ useTrashUiOpen, closeTrashUi, t }) {
      const open = useTrashUiOpen();
      const theme = useTheme();
      const palette = paletteFor(theme);
      const [items, setItems] = useState(null);
      const [totalBytes, setTotalBytes] = useState(0);
      const [keyword, setKeyword] = useState("");
      const [searchContent, setSearchContent] = useState(false);
      const [contentMatches, setContentMatches] = useState(null);
      const [searching, setSearching] = useState(false);
      const [workspaceFilter, setWorkspaceFilter] = useState("");
      const [sortKey, setSortKey] = useState("deletedAt");
      const [sortAsc, setSortAsc] = useState(false);
      const [checked, setChecked] = useState(() => new Set());
      const [notice, setNotice] = useState("");
      const [errorText, setErrorText] = useState("");
      const [busy, setBusy] = useState(false);
      const [confirmState, setConfirmState] = useState(null); // {message, run}
      const [detail, setDetail] = useState(null); // null | {loading,id} | {loading:false,.../trash/detail 结果}
      const [expandedTurns, setExpandedTurns] = useState(() => new Set()); // 默认全部折叠
      const busyRef = useRef(false);
      busyRef.current = busy;
      const detailRef = useRef(null);
      detailRef.current = detail;

      useEffect(() => {
        if (!open) return;
        const handler = (event) => {
          if (event.key !== "Escape" || busyRef.current) return;
          event.preventDefault();
          if (detailRef.current) setDetail(null); // 详情页 Esc 先返回列表
          else closeTrashUi();
        };
        window.addEventListener("keydown", handler);
        return () => window.removeEventListener("keydown", handler);
      }, [open]);

      useEffect(() => {
        // 弹窗常驻（关闭只是返回 null），列表必须每次打开时重新拉取，
        // 否则删除后新进回收站的会话要重启 DSH 才能看到
        if (!open) return;
        let cancelled = false;
        callApi("/trash/list").then((r) => {
          if (cancelled) return;
          if (r && r.ok) { setItems(r.result.items || []); setTotalBytes(r.result.totalBytes || 0); }
          else setErrorText(t("dialog.error").replace("{message}", (r && r.error) || "list failed"));
        }).catch((error) => { if (!cancelled) setErrorText(t("dialog.error").replace("{message}", String(error))); });
        return () => { cancelled = true; };
      }, [open]);

      useEffect(() => {
        if (!notice) return;
        const id = setTimeout(() => setNotice(""), 3000);
        return () => clearTimeout(id);
      }, [notice]);

      const refreshList = async () => {
        const r = await callApi("/trash/list");
        if (r && r.ok) { setItems(r.result.items || []); setTotalBytes(r.result.totalBytes || 0); }
        setChecked(new Set());
      };

      const workspaces = useMemo(() => {
        const set = new Map();
        for (const item of (items || [])) {
          if (typeof item.cwd === "string" && item.cwd !== "" && !set.has(item.cwd)) set.set(item.cwd, item.cwd);
        }
        return [...set.values()];
      }, [items]);

      const visibleItems = useMemo(() => {
        let list = items || [];
        if (workspaceFilter) list = list.filter(item => item.cwd === workspaceFilter);
        if (contentMatches !== null) {
          list = list.filter(item => contentMatches[item.id] !== undefined);
        } else if (keyword.trim() !== "") {
          const needle = keyword.trim().toLowerCase();
          list = list.filter(item =>
            (typeof item.title === "string" && item.title.toLowerCase().includes(needle)) ||
            (typeof item.cwd === "string" && item.cwd.toLowerCase().includes(needle)));
        }
        const direction = sortAsc ? 1 : -1;
        return [...list].sort((a, b) => {
          if (sortKey === "title") return String(a.title || "").localeCompare(String(b.title || "")) * direction;
          const va = Number(a[sortKey]) || 0;
          const vb = Number(b[sortKey]) || 0;
          return (va - vb) * direction;
        });
      }, [items, workspaceFilter, keyword, contentMatches, sortKey, sortAsc]);

      // 勾选「搜正文」后，输入关键词自动防抖搜索（不再需要额外按钮）
      useEffect(() => {
        if (!searchContent) { setContentMatches(null); return; }
        const kw = keyword.trim();
        if (kw === "") { setContentMatches(null); return; }
        let cancelled = false;
        const timer = setTimeout(() => {
          setSearching(true);
          callApi("/trash/search", { keyword: kw }).then((r) => {
            if (!cancelled && r && r.ok) setContentMatches(r.result.matches || {});
          }).catch(() => { /* 静默：保留上一次结果 */ }).finally(() => {
            if (!cancelled) setSearching(false);
          });
        }, 350);
        return () => { cancelled = true; clearTimeout(timer); };
      }, [keyword, searchContent]);

      const doRestore = async (ids) => {
        // 兼容单条（字符串）与批量（数组）两种入参；接口只收单个 sessionId
        const list = Array.isArray(ids) ? ids : [ids];
        setBusy(true);
        setErrorText("");
        let restoredCount = 0;
        try {
          for (const id of list) {
            const r = await callApi("/trash/restore", { sessionId: id });
            if (r && r.ok) {
              restoredCount++;
            } else {
              setErrorText(t("dialog.error").replace("{message}", (r && r.error) || "restore failed"));
              break;
            }
          }
          if (restoredCount > 0) {
            setNotice(t("trash.restored") + (restoredCount > 1 ? " ×" + restoredCount : ""));
            await refreshList();
            await refreshSidebar();
          }
        } catch (error) {
          setErrorText(t("dialog.error").replace("{message}", String(error)));
        } finally {
          setBusy(false);
        }
      };

      const doPurge = async (ids) => {
        setBusy(true);
        setErrorText("");
        try {
          const r = await callApi("/trash/delete", { sessionIds: ids });
          if (r && r.ok) {
            setNotice(t("trash.purged"));
            setConfirmState(null);
            await refreshList();
          } else {
            setErrorText(t("dialog.error").replace("{message}", (r && r.error) || "purge failed"));
          }
        } catch (error) {
          setErrorText(t("dialog.error").replace("{message}", String(error)));
        } finally {
          setBusy(false);
        }
      };

      const doEmpty = async () => {
        setBusy(true);
        setErrorText("");
        try {
          const r = await callApi("/trash/empty");
          if (r && r.ok) {
            setNotice(t("trash.emptyDone"));
            setConfirmState(null);
            await refreshList();
          } else {
            setErrorText(t("dialog.error").replace("{message}", (r && r.error) || "empty failed"));
          }
        } catch (error) {
          setErrorText(t("dialog.error").replace("{message}", String(error)));
        } finally {
          setBusy(false);
        }
      };

      const toggleChecked = (id) => {
        setChecked((prev) => {
          const next = new Set(prev);
          if (next.has(id)) next.delete(id); else next.add(id);
          return next;
        });
      };
      const openDetail = async (id) => {
        setDetail({ loading: true, id });
        setExpandedTurns(new Set()); // 每次打开默认全部折叠
        try {
          const r = await callApi("/trash/detail", { sessionId: id });
          if (r && r.ok) setDetail({ loading: false, ...r.result });
          else {
            setErrorText(t("dialog.error").replace("{message}", (r && r.error) || "detail failed"));
            setDetail(null);
          }
        } catch (error) {
          setErrorText(t("dialog.error").replace("{message}", String(error)));
          setDetail(null);
        }
      };

      const toggleSelectAllVisible = () => setChecked(visibleItems.length > 0 && visibleItems.every(i => checked.has(i.id)) ? new Set() : new Set(visibleItems.map(i => i.id)));

      const themeInput = { background: palette.inputBg, color: palette.text, border: "1px solid " + palette.btnBorder };

      if (!open) return null;

      if (detail) {
        const d = detail;
        return h("div", {
          className: "scl-layer",
          style: { background: palette.layer },
          role: "presentation",
          onMouseDown: (event) => {
            if (event.target === event.currentTarget && !busy) setDetail(null);
          }
        },
          h("section", {
            className: "scl-panel scl-modalWide",
            style: { background: palette.panel, border: "1px solid " + palette.panelBorder, boxShadow: palette.shadow, color: palette.text },
            role: "dialog",
            "aria-modal": "true",
            "aria-labelledby": "scl-detail-title"
          },
            h("div", { className: "scl-modalHeader", style: { borderBottom: "1px solid " + palette.panelBorder } },
              h("button", {
                type: "button", className: "scl-miniBtn", style: { ...themeInput, color: palette.text, flex: "0 0 auto" },
                disabled: busy, onClick: () => setDetail(null)
              }, "← " + t("detail.back")),
              h("div", { className: "scl-headLeft" },
                h("h2", { id: "scl-detail-title", className: "scl-headTitle", style: { color: palette.text } }, t("detail.title")),
                h("div", { className: "scl-headSub", style: { color: palette.secondary } }, d.title || d.id)
              ),
              h("button", {
                type: "button", className: "scl-close", style: { color: palette.secondary },
                "aria-label": t("dialog.close"), title: t("dialog.close"),
                onClick: closeTrashUi
              }, "\u00d7")
            ),
            d.loading
              ? h("div", { className: "scl-empty", style: { color: palette.secondary } }, t("detail.loading"))
              : [
                  h("div", { key: "info", className: "scl-info", style: { margin: "0 0 10px" } },
                    [
                      typeof d.cwd === "string" && d.cwd ? ["info.cwd", d.cwd] : null,
                      Number.isFinite(d.turns) ? ["info.turns", d.turns + " " + t("unit.turns")] : null,
                      Number.isFinite(d.userMessages) ? ["info.userMessages", d.userMessages + " " + t("unit.messages")] : null,
                      Number.isFinite(d.toolCalls) ? ["info.toolCalls", d.toolCalls + " " + t("unit.calls")] : null,
                      ["info.size", formatBytes(d.bytes)],
                      Number.isFinite(d.deletedAt) ? ["trash.deletedAt", formatTime(d.deletedAt)] : null
                    ].filter(Boolean).map(([labelKey, value]) => h("div", { className: "scl-infoRow", key: labelKey },
                      h("span", { className: "scl-infoLabel", style: { color: palette.secondary } }, t(labelKey)),
                      h("span", { className: "scl-infoValue", style: { color: palette.text } }, value)
                    ))
                  ),
                  d.parseError ? h("div", { key: "perr", className: "scl-tNotice", style: { color: palette.danger } }, t("dialog.error").replace("{message}", d.parseError)) : null,
                  h("div", { key: "qhead", style: { color: palette.text, fontWeight: 600, margin: "0 0 6px" } }, t("detail.questions").replace("{n}", String((d.questions || []).length))),
                  h("div", { key: "qlist", className: "scl-tList" },
                    (d.questions || []).length === 0
                      ? h("div", { className: "scl-empty", style: { color: palette.secondary } }, t("detail.noQuestions"))
                      : d.questions.map((q, i) => {
                          const expanded = expandedTurns.has(i);
                          return h("div", {
                            className: "scl-turn", key: i,
                            style: { borderColor: palette.rowBorder },
                            onClick: () => setExpandedTurns((prev) => {
                              const next = new Set(prev);
                              if (next.has(i)) next.delete(i); else next.add(i);
                              return next;
                            })
                          },
                            h("div", { className: "scl-turnHead" },
                              h("span", { className: "scl-turnBadge", style: { color: palette.turn } }, t("detail.turn").replace("{n}", String(q.turn ?? i + 1))),
                              h("span", { style: { color: palette.secondary } }, formatTime(q.time)),
                              h("span", { style: { color: palette.secondary } }, t("detail.tools").replace("{n}", String(q.toolCalls || 0))),
                              h("span", { className: "scl-turnArrow", style: { color: palette.secondary } }, expanded ? "▾" : "▸")
                            ),
                            expanded
                              ? [
                                  h("div", { key: "q", className: "scl-md", style: { color: palette.user } }, q.question || "（无文本内容）"),
                                  q.assistantReply ? h("div", { key: "a", className: "scl-md", style: { color: palette.model } }, renderMarkdown(q.assistantReply, palette)) : null
                                ]
                              : h("div", { className: "scl-collapsedRow" },
                                  h("span", { className: "scl-fade", style: { color: palette.user } }, q.question || "（无文本内容）")
                                )
                          );
                        })
                  )
                ]
          )
        );
      }

      return h("div", {
        className: "scl-layer",
        style: { background: palette.layer },
        role: "presentation",
        onMouseDown: (event) => {
          if (event.target === event.currentTarget && !busy) closeTrashUi();
        }
      },
        h("section", {
          className: "scl-panel scl-modalWide",
          style: { background: palette.panel, border: "1px solid " + palette.panelBorder, boxShadow: palette.shadow, color: palette.text },
          role: "dialog",
          "aria-modal": "true",
          "aria-labelledby": "scl-trash-title"
        },
        h("div", { className: "scl-modalHeader", style: { borderBottom: "1px solid " + palette.panelBorder } },
          h("div", { className: "scl-headLeft" },
            h("h2", { id: "scl-trash-title", className: "scl-headTitle", style: { color: palette.text } }, t("trash.title")),
            items ? h("div", { className: "scl-headSub", style: { color: palette.secondary } },
              t("trash.count").replace("{n}", String(visibleItems.length)).replace("{size}", formatBytes(totalBytes))
                + " · " + t("dialog.retention")) : null
          ),
          h("button", {
            type: "button", className: "scl-close", style: { color: palette.secondary },
            "aria-label": t("dialog.close"), title: t("dialog.close"),
            disabled: busy, onClick: () => { if (!busy) closeTrashUi(); }
          }, "\u00d7")
        ),
        h("div", { className: "scl-controls" },
          h("input", {
            className: "scl-input", style: themeInput, type: "text",
            placeholder: t("trash.search"), value: keyword,
            onChange: (e) => { setKeyword(e.target.value); if (contentMatches !== null) setContentMatches(null); }
          }),
          h("label", { className: "scl-check", style: { color: palette.secondary } },
            h("input", {
              type: "checkbox", checked: searchContent,
              onChange: (e) => { setSearchContent(e.target.checked); if (!e.target.checked) setContentMatches(null); }
            }),
            t("trash.searchContent")
          ),
          h("select", {
            className: "scl-select", style: themeInput, value: workspaceFilter,
            onChange: (e) => setWorkspaceFilter(e.target.value)
          },
            h("option", { value: "" }, t("trash.workspaceAll")),
            workspaces.map((cwd) => h("option", { key: cwd, value: cwd }, cwd))
          ),
          h("select", {
            className: "scl-select", style: themeInput, value: sortKey,
            onChange: (e) => setSortKey(e.target.value)
          },
            h("option", { value: "deletedAt" }, t("trash.sortDeleted")),
            h("option", { value: "title" }, t("trash.sortTitle")),
            h("option", { value: "bytes" }, t("trash.sortSize")),
            h("option", { value: "turns" }, t("trash.sortTurns"))
          ),
          h("button", {
            type: "button", className: "scl-sortBtn", style: { ...themeInput, color: palette.text },
            title: sortAsc ? t("sort.asc") : t("sort.desc"), onClick: () => setSortAsc(!sortAsc)
          }, sortAsc ? "↑" : "↓")
        ),
        notice ? h("div", { className: "scl-tNotice", style: { color: palette.success } }, notice) : null,
        errorText ? h("div", { className: "scl-tNotice", style: { color: palette.danger } }, errorText) : null,
        items === null
          ? h("div", { className: "scl-empty", style: { color: palette.secondary } }, t("dialog.loading"))
          : h("div", { className: "scl-tList" },
              visibleItems.length === 0
                ? h("div", { className: "scl-empty", style: { color: palette.secondary } },
                    searching ? t("trash.searching")
                      : contentMatches !== null && keyword.trim() !== "" ? t("trash.searchNone")
                        : t("trash.emptyState"))
                : visibleItems.map((item) => {
                    const hits = contentMatches ? contentMatches[item.id] : undefined;
                    const metaBits = [];
                    if (typeof item.cwd === "string" && item.cwd) metaBits.push(item.cwd);
                    if (Number.isFinite(item.turns)) metaBits.push(item.turns + " " + t("unit.turns"));
                    if (Number.isFinite(item.bytes)) metaBits.push(formatBytes(item.bytes));
                    if (Number.isFinite(item.deletedAt)) metaBits.push(t("trash.deletedAt") + " " + formatTime(item.deletedAt));
                    return h("div", { className: "scl-tRow", key: item.id, style: { borderColor: palette.rowBorder } },
                      h("input", {
                        type: "checkbox", checked: checked.has(item.id),
                        onChange: () => toggleChecked(item.id)
                      }),
                      h("div", { className: "scl-tMain" },
                        h("div", { className: "scl-tTitle", style: { color: palette.text } },
                          item.title || item.id,
                          hits !== undefined ? h("span", { className: "scl-tBadge", style: { color: palette.secondary } }, t("trash.searchHit").replace("{n}", String(hits))) : null
                        ),
                        metaBits.length ? h("div", { className: "scl-tMeta", style: { color: palette.secondary } }, metaBits.join(" · ")) : null
                      ),
                      h("div", { className: "scl-tBtns" },
                        h("button", {
                          type: "button", className: "scl-miniBtn", style: { ...themeInput, color: palette.text },
                          disabled: busy, onClick: () => openDetail(item.id)
                        }, t("trash.viewLog"))
                      )
                    );
                  })
            ),
        h("div", { className: "scl-batchBar", style: { borderTop: "1px solid " + palette.panelBorder } },
          h("button", {
            type: "button", className: "scl-miniBtn", style: { ...themeInput, color: palette.text },
            disabled: !items || visibleItems.length === 0,
            onClick: toggleSelectAllVisible
          }, visibleItems.length > 0 && visibleItems.every(i => checked.has(i.id)) ? t("trash.deselectAll") : t("trash.selectAll")),
          checked.size > 0 ? h("span", { className: "scl-tNotice", style: { color: palette.secondary, margin: 0 } }, t("trash.selected").replace("{n}", String(checked.size))) : null,
          h("button", {
            type: "button", className: "scl-miniBtn", style: { ...themeInput, color: palette.text },
            disabled: busy || checked.size === 0,
            onClick: () => doRestore([...checked])
          }, t("trash.restoreSelected")),
          h("button", {
            type: "button", className: "scl-miniBtn", style: { color: palette.danger, borderColor: palette.rowBorder },
            disabled: busy || checked.size === 0,
            onClick: () => setConfirmState({ message: t("trash.confirmPurge").replace("{n}", String(checked.size)), run: () => doPurge([...checked]) })
          }, t("trash.purgeSelected")),
          h("div", { className: "scl-spacer" }),
          h("button", {
            type: "button", className: "scl-miniBtn", style: { color: palette.danger, borderColor: palette.rowBorder },
            disabled: busy || !items || items.length === 0,
            onClick: () => setConfirmState({ message: t("trash.confirmEmpty").replace("{n}", String(items.length)), run: doEmpty })
          }, t("trash.emptyBin"))
        )
        ),
        confirmState ? h("div", {
          className: "scl-layer", style: { background: palette.layer, zIndex: 11050 },
          role: "presentation",
          onMouseDown: (event) => { if (event.target === event.currentTarget && !busy) setConfirmState(null); }
        },
          h("section", {
            className: "scl-panel scl-panelSmall",
            style: { background: palette.panel, border: "1px solid " + palette.panelBorder, boxShadow: palette.shadow, color: palette.text },
            role: "dialog", "aria-modal": "true"
          },
            h("div", { style: { color: palette.text } }, confirmState.message),
            h("div", { className: "scl-footer" },
              h("button", {
                type: "button", className: "scl-btn",
                style: { border: "1px solid " + palette.btnBorder, background: "transparent", color: palette.text },
                disabled: busy,
                onClick: () => setConfirmState(null)
              }, t("dialog.cancel")),
              h("button", {
                type: "button", className: "scl-btn scl-btnDanger",
                style: { border: "1px solid " + palette.danger, background: palette.danger, color: "#ffffff" },
                disabled: busy,
                onClick: () => { const run = confirmState.run; setConfirmState(null); run(); }
              }, t("trash.confirm"))
            )
          )
        ) : null
      );
    }

    // ───────────────────────── 插件入口 ─────────────────────────

    function apply(ctx) {
      hostCtx = ctx;

      ctx.effect(() => injectStyle(), "session-cleaner: styles");
      ctx.effect(() => ctx.locale.register(NS, { zh, en }), "session-cleaner: dictionaries");

      ctx.slots.inject("sidebar.workspaces.session.menu.item", function* () {
        yield ctx.slots.register({
          name: "sidebar.workspaces.session.menu.item",
          id: "session-cleaner-delete",
          order: 500,
          locale: NS,
          inject: () => ({})
        }, DeleteSessionMenuItem);
      });

      ctx.slots.inject("sidebar.footer.action", function* () {
        yield ctx.slots.register({
          name: "sidebar.footer.action",
          id: "session-cleaner-trash",
          order: 30, // 侧栏底部，归档入口之下
          locale: NS,
          inject: footerInjected
        }, TrashFooterAction);
      });

      ctx.slots.inject("shell.overlay", function* () {
        yield ctx.slots.register({
          name: "shell.overlay",
          id: "session-cleaner-toast",
          locale: NS,
          inject: () => ({})
        }, TrashToast);
        yield ctx.slots.register({
          name: "shell.overlay",
          id: "session-cleaner-trash-ui",
          locale: NS,
          inject: () => ({ useTrashUiOpen, closeTrashUi })
        }, RecycleBinOverlay);
      });
    }

    const inject = ["slots", "locale", "sessions", "workspaces"];

    exports.apply = apply;
    exports.inject = inject;
    return module.exports;
  }
});
