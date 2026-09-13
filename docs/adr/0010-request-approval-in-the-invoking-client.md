# Request tool approval in the invoking client

For a tool governed by Require Approval, each User chooses gateway-enforced or client-managed approval. Gateway-enforced approval uses MCP elicitation before execution and binds approval to the Principal, tool, arguments, policy, nonce, and five-minute expiry. Client-managed approval trusts the MCP Client to prompt before invoking the direct tool. Version one has no separate approval inbox.

The installed MCP TypeScript SDK does not expose an `input_required` result. The gateway uses MCP elicitation on the active request instead. It fails closed when the client does not advertise elicitation. The persisted approval remains bound to the Principal, Connection, Account, tool, canonical argument hash, policy, nonce, five-minute expiry, and single use.
