# Ship a Linux container suitable for Azure

The project ships a portable Linux container that can run on Azure Container Apps. The container owns Bun and the arbitrary child processes required by STDIO MCP servers, reads deployment settings from its environment, and applies database migrations at startup. Azure infrastructure, topology, backups, and regional recovery remain outside the project.
