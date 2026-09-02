# Use one organization per deployment

Each deployment serves one Organization, while persisted records retain an organization identifier. This keeps the first release operationally simple without making a future multi-organization service require a data-model rewrite.
