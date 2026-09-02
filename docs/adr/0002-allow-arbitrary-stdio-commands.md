# Allow administrators to register arbitrary STDIO commands

Administrators may register arbitrary STDIO commands in development and production. Version one supports Bun/npm and .NET, including exact-version runtime package downloads. Commands run as the non-root gateway user with an explicit environment that excludes gateway secrets. Administrators therefore occupy the host-code-execution trust boundary and deployments must treat them as fully trusted operators.
