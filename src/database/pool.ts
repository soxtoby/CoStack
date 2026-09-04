import { Pool } from 'pg'

let pool: Pool | undefined

export function databasePool() {
  const connectionString = process.env.DATABASE_URL
  if (!connectionString) throw new Error('DATABASE_URL is required')

  const configuredMax = Number(process.env.DATABASE_POOL_MAX ?? 10)
  pool ??= new Pool({ connectionString, max: configuredMax })
  return pool
}

export async function closeDatabasePool() {
  await pool?.end()
  pool = undefined
}
