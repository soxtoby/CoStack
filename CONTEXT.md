# MCP gateway

An organizational gateway that gives authenticated callers controlled access to MCP servers through one endpoint.

## Language

**Organization**:
The single organization served by a deployment.
_Avoid_: Tenant, customer

**Principal**:
The authenticated identity accountable for a gateway request. A Principal is either a User or a Service Account.
_Avoid_: Caller, actor

**User**:
A human Principal who signs in to manage or consume MCP servers.
_Avoid_: Account

**Pre-provisioned Access**:
A verified email address with initial Group memberships prepared before first sign-in. The first matching SSO identity claims it and becomes a User.
_Avoid_: Invitation, pending user

**Service Account**:
A non-human Principal used by unattended agents or internal services.
_Avoid_: Bot user, machine user

**Administrator**:
An active User in the protected Administrators Group. Administrators alone assign Capabilities and change Administrator membership.
_Avoid_: Superuser, owner

**MCP Connection**:
A configured upstream MCP server with transport settings, eligible Groups, Tool Policies, and Accounts. It may be created directly or imported from a Registry Source.
_Avoid_: Managed MCP, integration, connector

**Connection Namespace**:
The immutable prefix for an MCP Connection's directly exposed tools and the basis of default Account Namespaces.
_Avoid_: Connection slug, tool prefix

**Shared Account**:
A named set of MCP Connection credentials available to every eligible Principal.
_Avoid_: Shared credentials, service login

**Personal Account**:
A named set of MCP Connection credentials owned by one User.
_Avoid_: Personal credentials, user login

**Account Namespace**:
The immutable name used to select an Account and prefix its compatibility tool names. Shared namespaces are reserved organization-wide against both Shared and Personal Accounts; Personal namespaces are unique per User and may be reused by different Users.
_Avoid_: Slug, tool prefix

**Gateway MCP**:
The single MCP presented to Principals, combining their eligible MCP Connections and Accounts.
_Avoid_: Aggregate MCP, proxy MCP

**MCP Client**:
An application, such as ChatGPT or Claude, authorized to connect a Principal to the Gateway MCP.
_Avoid_: Agent, consumer

**Capability**:
A separately assignable administrative or consumption right.
_Avoid_: Role, permission

**Group**:
A locally managed collection of Principals used to assign Capabilities and MCP access.
_Avoid_: SSO group, team

**Tool Policy**:
An access rule matching a tool name, a wildcard set of names, or an annotation condition on an MCP Connection. Its effect is Allow, Require Approval, or Block.
_Avoid_: Tool permission, ACL

**Approval Request**:
A client-native request for a User to authorize one exact tool call before the gateway executes it.
_Avoid_: Prompt, consent

**Approval Method**:
A User preference choosing gateway-enforced MCP approval or client-managed prompting. Client-managed prompting trusts the invoking client and cannot prove that a human approved the call.
_Avoid_: Approval mode

**Registry Source**:
An MCP Registry v0.1 catalog from which administrators may import server metadata.
_Avoid_: Marketplace, directory

**SSO Provider**:
The Organization's single active OpenID Connect identity provider.
_Avoid_: Login provider, identity service
