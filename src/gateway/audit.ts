import { randomUUID } from 'node:crypto'
import type { ToolPolicyEffect } from '../connections/types'
import type { Pool } from 'pg'

export type AuditEvent = {
  organizationId: string
  principalId: string
  principalDisplayName: string
  clientId?: string
  connectionId?: string
  accountId?: string
  toolName?: string
  policy?: ToolPolicyEffect
  outcome: string
  durationMs?: number
  errorCode?: string
}

/** The only audit write API. It deliberately has no payload fields. */
export async function writeAudit(pool: Pool, event: AuditEvent) {
  await pool.query(
    `INSERT INTO audit_records
      (id, organization_id, principal_id, principal_display_name, mcp_client_id,
       connection_id, account_id, tool_name, policy_effect, outcome, duration_ms, error_code)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
    [
      randomUUID(),
      event.organizationId,
      event.principalId,
      event.principalDisplayName,
      event.clientId ?? null,
      event.connectionId ?? null,
      event.accountId ?? null,
      event.toolName ?? null,
      event.policy ?? null,
      event.outcome,
      event.durationMs ?? null,
      event.errorCode ?? null,
    ],
  )
}

export async function pruneAudit(pool: Pool) {
  await pool.query(
    `DELETE FROM audit_records
     WHERE occurred_at < now() - (
       (SELECT audit_retention_days FROM gateway_settings WHERE singleton) * interval '1 day'
     )`,
  )
}
