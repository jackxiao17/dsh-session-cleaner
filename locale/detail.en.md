Move cold sessions into a recoverable recycle bin while cleaning workspace accounting, pins, archive flags, and projection caches. Open or recently viewed sessions are closed through DSH's official lifecycle handle after an explicit warning and confirmation. Active schedules are paused and re-enabled on restore; only permanent delete removes them. SQLite and custom sessions roots are refused explicitly instead of being partially torn down.

Full documentation, screenshots and install steps: [GitHub repository](https://github.com/jackxiao17/dsh-session-cleaner).
