# Request tool approval in the invoking client

For a tool governed by Require Approval, each User chooses gateway-enforced or client-managed approval. Gateway-enforced approval returns MCP `input_required` before execution and accepts only a retry bound to the Principal, tool, arguments, policy, nonce, and five-minute expiry. Client-managed approval requires the separately annotated `call_tool_with_approval` meta-tool and trusts the MCP Client to prompt; ordinary `call_tool` rejects that target. Version one has no separate approval inbox.

The installed MCP TypeScript SDK does not expose an `input_required` result. The gateway uses MCP elicitation on the active request instead. It fails closed when the client does not advertise elicitation. The persisted approval remains bound to the Principal, Connection, Account, tool, canonical argument hash, policy, nonce, five-minute expiry, and single use.
