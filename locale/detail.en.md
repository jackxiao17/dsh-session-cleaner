Move closed, cold sessions into a recoverable recycle bin while cleaning workspace accounting, pins, archive flags, and projection caches. Active schedules are paused and re-enabled on restore; only permanent delete removes them. Live sessions, active background jobs, SQLite, and custom sessions roots are refused explicitly instead of being partially torn down.

Full documentation, screenshots and install steps: [GitHub repository](https://github.com/jackxiao17/dsh-session-cleaner).
