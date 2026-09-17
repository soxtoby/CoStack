import { Pool } from 'pg'
import { databaseConfig } from './config'

let pool: Pool | undefined

export function databasePool() {
  pool ??= new Pool(databaseConfig(process.env))
  return pool
}

export async function closeDatabasePool() {
  await pool?.end()
  pool = undefined
}
