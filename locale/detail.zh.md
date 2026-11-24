把已关闭的冷会话搬进可恢复回收站，并清理工作区记账、置顶、归档和投影缓存。活动定时任务只会暂停，恢复会话时重新启用；彻底删除时才清除任务。实时会话、活动后台任务、SQLite 或自定义 sessions root 会被明确拒绝，不会做半拆除。

完整说明、截图与安装方式见 [GitHub 仓库](https://github.com/jackxiao17/dsh-session-cleaner)。
