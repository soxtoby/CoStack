# Search and call upstream tools through meta-tools

The Gateway MCP exposes `search_tools`, `call_tool`, and the approval-annotated `call_tool_with_approval` instead of advertising every upstream tool through `tools/list`. MCP has no portable way to promote search results into dynamically callable tools, so search returns authorized tool names, schemas, and policy metadata while the call meta-tools perform policy enforcement and forwarding without server-side client sessions.
