# Allow multiple gateway replicas

Azure may run multiple gateway replicas without coordinating ownership of STDIO processes. Each replica may therefore launch its own process for the same Account; this improves availability and avoids distributed process management, but MCP Connections must not require process-local state to remain consistent across separate tool calls.
