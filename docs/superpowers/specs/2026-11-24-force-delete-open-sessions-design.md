# 强制删除已打开会话设计

## 背景

0.8.0 只允许删除冷会话。DSH 0.2.3-alpha.2 的 Session Controller 在打开会话时会创建 live Agent，并且最近浏览会继续保留历史流；这类 Agent 由 Session Controller 持有，插件没有公开的关闭接口。因此当前会话和打开后切走的会话都会触发 `session-active`。

用户确认需要“强制删除已打开会话”模式，并接受它会停止 live Agent、可能中断当前回答。

## 目标

- 普通冷会话删除保持一键完成。
- 对 live 会话提供明确警告和二次确认后的强制删除。
- 强制删除必须通过 DSH 官方 `AgentHandle.dispose()` 完成，不直接操作私有 registry/store。
- 任何无法证明生命周期已经退出的情况都拒绝移动文件。
- 版本升级为 0.8.1，测试、文档、发行包和 Release 同步更新。

## 非目标

- 不支持 SQLite、自定义 sessions root、未知后端或非默认存储布局。
- 不绕过活动后台任务、终端或子代理的安全检查。
- 不承诺强制删除过程中正在执行的工具调用可以回滚；确认文案必须明确可能中断。
- 不修改 DSH 本体。

## 方案比较

### 方案 A：捕获官方 AgentHandle（采用）

插件在 `agentLoop` 服务可用时包装其公共工厂方法 `createAgent` 和 `resume`，保存返回的 `AgentHandle`。强制删除调用句柄的 `dispose()`，由 DSH 完成停止回合、等待 idle、释放持久化写锁、拆除 Agent/Session 和派发生命周期事件。

优点：使用官方销毁能力，顺序完整，能释放 JSONL 写锁，不依赖私有 Map 结构。

限制：只能捕获插件包装安装后通过 `createAgent`/`resume` 创建的 Agent。插件热重载前已经存在的 Agent，以及 DSH 配置驱动、直接走 `AgentLoop.create()` 的 Agent 没有句柄；前者完整重启后可重试，后者明确提示暂不支持强制删除。

### 方案 B：移植 0.7.9 私有拆除（不采用）

直接调用 `agent.cancel`、`agent.scope.dispose`、`agents.store.delete`、`sessions.store.get(id).detach()`。

缺点：绕过 AgentLoop 的正式 teardown，当前 JSONL 写句柄和跨进程写锁可能没有关闭；Windows 上可能无法 rename 会话目录，并可能留下僵尸生命周期。

### 方案 C：保持冷会话限制（不采用）

只优化提示，不提供强制删除。该方案最安全，但不满足用户当前需求。

## 架构与数据流

### Host

1. `apply()` 在 `agentLoop` 服务注入可用时安装包装：
   - 包装 `createAgent` 与 `resume`；
   - 调用原方法后，以 `handle.agent.id` 为键保存句柄；
   - 插件卸载时仅在当前方法仍是本插件包装时恢复原方法，并清空本地映射；
   - 不持有句柄所有权，不因插件卸载而销毁 Agent。
2. `trashSession(sessionId, { force })`：
   - `force=false` 保持现有行为，live Agent/Session 直接返回 `session-active`。
   - `force=true` 先调用 `collectDescendants(sessionId)` 获取完整子代理树。
   - 对子代理树和主会话逐一检查：
     - 若 `agents.get(id)` 或 `sessions.get(id)` 表明 live，则必须存在身份匹配的 `AgentHandle`；
     - 缺少句柄时返回 `live-handle-unavailable`，不拆除任何会话。
   - 预检通过后，按子→父顺序调用 `handle.dispose()`；每次等待最多 15 秒。
   - 每次销毁后验证 `agents.get(id)` 与 `sessions.get(id)` 均为空；超时、异常或仍 live 时返回错误，不移动文件。
   - 所有目标 cold 后，重新运行现有 `assertColdSession`，包括后台任务、终端、后端与路径检查。
   - 任一活动任务或终端仍未退出时返回 `session-active`，不移动文件。
   - 通过后进入现有快照、暂停定时任务、移入回收站流程。
3. 句柄映射在使用前必须验证 `handle.agent === agents.get(sessionId)`；过期句柄视为不可用。
4. 强制销毁成功后，从映射删除该句柄；失败时保留映射供重试。
5. 普通删除不读取或修改句柄映射。

### 官方子代理与缓存加固

- 强制删除先预检 root 官方句柄、后端/路径、已发现家族成员的缓存检查点能力，再开始任何拆除。
- 使用 `subagents.listDescendants()` 读取官方目录；diagnostic、父链冲突或深度超过 32 时拒绝。
- 家族发现采用三类并集：磁盘后代、官方目录 child 行、`agents.list()`/`sessions.list()` 中 `origin === 'subagent'` 的 live 成员；普通 fork 的 `parentSession` 不参与级联。
- live root 必须先 `await subagents.drainDescendants([root])`，再重新读取官方目录并要求没有 `activity: 'running'`，同时要求 `capacityOf(root).running === 0`。
- 非 root 子代理不提升到树根 drain，直接拒绝，以免误停祖先和兄弟。
- drain 后重新扫描磁盘，纳入刚物化的子代理；external/未落盘 ID 只在存在 live registry 成员或磁盘目录时参与拆除/捕获。
- 销毁前保存家族 Session 对象，销毁后逐个 `await sessionProjectionCache.write(session)`，避免 detach 的 fire-and-forget 检查点晚于快照读取。drain 期间刚物化且未进入 live registry 的子代理使用宿主 detach 检查点；缓存是派生数据，日志与元数据安全不依赖它。
- `terminals.hasOwnerActivity()` 只接受精确 Agent 对象；cold 后没有 Agent 时不做字符串查询。
- `session-active` 响应带 `forceAvailable`；只有存在可用官方 root 句柄时才弹出强制删除确认。

### Client

1. `performTrash(sessionId, t, { force=false })` 首次普通删除。
2. 收到 `session-active` 且未 force 时，打开模块级确认框：
   - 标题说明目标仍被 DSH 打开或最近浏览保留；
   - 明确警告会停止并关闭 live Agent，可能中断当前回答；
   - 按钮为“取消”和“强制删除”。
3. 确认后调用同一 `/trash` 接口并传 `force:true`。
4. 请求期间禁用按钮，防止重复提交。
5. `live-handle-unavailable` 显示“请完整重启 DSH 后再强制删除”。
6. 其他错误继续显示服务端具体信息；成功后刷新侧栏并显示现有成功提示。
7. 确认框注册在现有 `shell.overlay`，复用主题与浮层拖拽排除属性。

## 错误语义

- `session-active`：普通删除遇到 live，或强制销毁后仍有活动任务/终端。
- `live-handle-unavailable`：live 会话没有身份匹配的官方销毁句柄。
- `lifecycle-check-failed`：销毁超时、销毁异常或销毁后 registry 仍报告 live。
- `force-dispose-failed`：官方 `dispose()` 拒绝，保留原始错误信息。
- `subagent-drain-unavailable` / `subagent-drain-failed`：官方子代理接口缺失、drain 失败、官方目录仍 running 或 capacity 非零。
- `subagent-nonroot-unsupported`：目标是非根子代理，不能安全提升到树根。
- `descendant-discovery-failed`：官方目录 diagnostic、格式异常或父链来源冲突。
- `cache-checkpoint-unavailable` / `cache-checkpoint-failed`：无法在拆除前证明缓存检查点能力，或拆除后检查点失败。
- 所有错误均发生在文件移动之前；不创建回收站快照。

## 测试策略

### Host 回归

- 冷会话普通删除保持成功，不调用 dispose。
- live 会话普通删除返回 409，且没有任何副作用。
- live 会话 force 删除调用身份匹配的官方句柄一次，并按子→父顺序执行。
- 缺少句柄、句柄身份不匹配、dispose 超时、dispose 拒绝、销毁后仍 live 均拒绝且不移动文件。
- 销毁后仍有 running/stopping job 或 terminal 时拒绝且不移动文件。
- 子代理预检缺少任一官方句柄时，不销毁父会话也不移动文件。
- 包装安装前创建的 Agent 不进入映射；插件卸载恢复包装且不销毁 Agent；外层包装存在时停用捕获而不摘除别人的包装。
- `agent/disposed` / `session/disposed` 按精确身份释放自然关闭的句柄。
- dispose/drain 超时后的重试复用同一 in-flight Promise，不重复拆除。
- 官方目录 diagnostic、running、capacity 非零、超深、父链冲突、非 root、缺少服务均在拆除前拒绝。
- 普通 fork 不因 `parentSession` 被级联；无关 live 会话不写入缓存检查点。
- 后端、路径和缓存能力预检发生在 drain/dispose 前。
- 现有恢复崩溃、部分恢复、purge 反馈与布局测试全部保持通过。

### Client 回归

- 普通 409 打开确认框，不直接发送 force。
- 取消不发送请求。
- 确认只发送一次 `force:true`，请求期间按钮禁用。
- force 成功刷新列表；失败显示对应错误。
- 中英文提示键完整。

### 真机验证

使用专用可丢弃 JSONL v4 会话：

1. 创建并打开会话，产生至少一轮历史；
2. 切到其他会话，确认最近浏览仍保留 live；
3. 普通删除应弹确认且不移动文件；
4. 确认强制删除，验证会话进入回收站；
5. 从回收站恢复，验证日志、工作区槽位、投影缓存、置顶/归档与定时任务；
6. 再次彻底删除，验证无残留；
7. 当前正在运行的会话仅在明确警告后测试，确认能够停止并删除；
8. 测试数据全部清理，用户现有会话与回收站数据不动。

真机结果（2026-11-24）：Windows Desktop + DSH 0.2.3-alpha.2，对可丢弃的真实 JSONL v4/zstd 会话完成普通删除二次确认、强制关闭、移入回收站和恢复；日志与缓存 SHA256 与删除前一致，侧栏显示正常，回收站快照和目录清理正确。

## 版本与发布

- `package.json.version` 与 `lib/index.js` buildId 升为 0.8.1。
- 更新中英文 README、包描述、About 和更新记录。
- `npm test` 全量通过后构建 ZIP、同步两处安装目录、重新激活插件。
- 提交并推送 main，创建 `v0.8.1` 标签与 GitHub Release，上传 ZIP 并核对 digest。
