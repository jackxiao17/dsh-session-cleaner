Deleting a session does not just move its log directory: every trace it left behind — the workspace accounting slot, its pin, its archive flag, and the projection-cache row (including the host's `.bak` copies) — is cleaned up too. A session with subagents moves as a whole tree; restoring puts everything back, including the original sidebar position; and a permanent delete clears the schedules bound to it.

Full documentation, screenshots and install steps: [GitHub repository](https://github.com/jackxiao17/dsh-session-cleaner).
