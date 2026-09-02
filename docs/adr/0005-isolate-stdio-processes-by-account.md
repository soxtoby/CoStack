# Isolate STDIO processes by Account

The gateway keeps one long-running STDIO process per Shared or Personal Account rather than per call or MCP Connection. This follows MCP client lifecycle conventions, preserves server state and startup performance, and prevents credentials or sessions from crossing Account boundaries; the gateway restarts processes after crashes, configuration changes, or credential rotation.
