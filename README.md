# dsh-session-cleaner

把「DSH 会话清理」装进 DSH 桌面版：侧栏每个会话的 `···` 菜单里多一项红色的**删除**（排在"归档"下面），一键移入回收站；侧栏底部有**会话回收站**入口，支持搜索、恢复与彻底删除。

## 下载

到 [Releases 页面](https://github.com/jackxiao17/dsh-session-cleaner/releases/latest) 下载最新版压缩包并解压，得到 `dsh-session-cleaner/` 文件夹；也可以 `git clone` 本仓库。

## 安装

1. 把 `dsh-session-cleaner/` 整个文件夹拷到 `~/.dsh/profiles/desktop/local/` 下（Windows 即 `C:\Users\你\.dsh\profiles\desktop\local\dsh-session-cleaner\`）
2. 编辑 `~/.dsh/profiles/desktop/package.json`：
   - `dependencies` 里加一行：`"dsh-session-cleaner": "file:./local/dsh-session-cleaner"`
   - `dsh.profile.bundles` 数组里加一项：`"dsh-session-cleaner"`
3. 在该目录跑一次 DSH 自带的 pnpm：
   ```
   node "%DSH_HOME%\dsh-runtimes\dsh-primary-runtime\dependencies\pnpm\bin\pnpm.cjs" install -C %DSH_HOME%\profiles\desktop
   ```
4. 重启 DSH 生效；在 DSH 的插件管理页可见

## 用法

1. 点会话 `···` → **删除**：直接移入回收站，顶部提示"✓ 会话已删除至回收站"（可恢复，所以无二次确认）
2. 对话中的会话也能删：会先结束当前回答，再移入回收站
3. **会话回收站**（侧栏底部按钮）：
   - 搜索：标题实时过滤；勾选「搜正文」后按关键词搜提问与回复内容
   - 工作区筛选、按删除时间/标题/大小/轮次排序（可倒序）
   - 勾选后底部**恢复所选 / 彻底删除所选**（有确认），也可一键清空
4. **查看对话记录**：每条会话的"查看对话记录"打开逐轮提问与助手回复（Markdown 渲染，超长回复中间省略，正文关键词仍可搜到）
5. 恢复：目录搬回原位、记账挂回原工作区、投影缓存行与注解原样还原，侧栏立即重新出现
6. 回收站保留 **30 天**，启动时自动清理过期项

## 彻底删除的完整范围

从回收站彻底删除时：会话日志目录 + 工作区记账 + 投影缓存行，一次清干净。

## 卸载 / 回滚

1. 从 `~/.dsh/profiles/desktop/package.json` 里删掉 `dsh-session-cleaner` 的 dependencies 行、bundles 行
2. 在该目录跑 `pnpm install`（用 DSH 自带的：`node "%DSH_HOME%\dsh-runtimes\dsh-primary-runtime\dependencies\pnpm\bin\pnpm.cjs" install -C %DSH_HOME%\profiles\desktop`）
3. 重启 DSH。本地文件可整个删掉 `~/.dsh/profiles/desktop/local/dsh-session-cleaner\`

## 开发与同步（源码在别处迭代时看这节）

本仓库就是插件的开发源码。改完代码后，DSH **不会**自动加载新版本，必须手动把整个插件文件夹覆盖拷贝到以下**两处**，再重启 DSH：

1. `~/.dsh/profiles/desktop/local/dsh-session-cleaner\`（安装源，Windows 即 `C:\Users\你\.dsh\profiles\desktop\local\` 下）
2. `~/.dsh/profiles/desktop/node_modules/dsh-session-cleaner\`（DSH 实际加载的目录）

要点：

- **纯代码改动不需要重跑 pnpm install**，覆盖文件 + 重启 DSH 即可。只有第一次安装、或改了 package.json 的依赖时才需要再跑一次：`node "%DSH_HOME%\dsh-runtimes\dsh-primary-runtime\dependencies\pnpm\bin\pnpm.cjs" install -C %DSH_HOME%\profiles\desktop`
- **为什么必须拷两处**：这两个目录里的同名文件是硬链接关系（同一份磁盘数据），但如果拷贝方式是"先删旧文件再放新文件"（不少工具的安全保存就是这个行为），硬链接会被切断，结果 local 是新版、node_modules 还是旧版，DSH 加载的仍是旧代码。两处都覆盖就不会有这个问题。
- **迭代时顺手把 package.json 的 version 升一位**：插件启动时会在日志里打印 `dsh-session-cleaner v<版本号>`，重启后一眼就能确认新版本真的生效了。
- 改动确认无误后提交推送到本仓库，保证 GitHub 上的代码和你本机跑的一致。

## 已知边界

- DSH 的插件接口没有官方稳定性承诺，大版本升级后插件可能失灵——失灵表现为菜单项/按钮消失或操作报错，不会伤及会话数据
- 回收站会占磁盘空间（面板顶部显示总占用），靠 30 天保留期兜底

## License

[MIT](LICENSE)

---

## English

A DSH (DeepSeek Harness) desktop plugin that adds a real **Delete** to sessions: every session's `···` menu gets a red **Delete** item (below "Archive") that moves the session into a recycle bin, and a **Recycle Bin** panel at the bottom of the sidebar supports search, restore and permanent deletion.

**Install**

1. Copy the `dsh-session-cleaner/` folder to `~/.dsh/profiles/desktop/local/`
2. In `~/.dsh/profiles/desktop/package.json`:
   - add `"dsh-session-cleaner": "file:./local/dsh-session-cleaner"` to `dependencies`
   - add `"dsh-session-cleaner"` to the `dsh.profile.bundles` array
3. Run DSH's bundled pnpm: `node "%DSH_HOME%\dsh-runtimes\dsh-primary-runtime\dependencies\pnpm\bin\pnpm.cjs" install -C %DSH_HOME%\profiles\desktop`
4. Restart DSH

**Usage**

- Session `···` → **Delete**: moves straight to the recycle bin (no confirm dialog — it is recoverable). A session with a running reply is finished first, then moved.
- **Recycle Bin** (sidebar footer): title search, full-text search over your questions and the assistant's replies, workspace filter, sorting, restore / permanently delete selection, or empty all.
- **View chat log**: per-turn Q&A with Markdown rendering.
- Permanent delete cleans everything: the session log directory, workspace accounting and the projection-cache row. Recycle bin items expire after 30 days.

License: [MIT](LICENSE)
