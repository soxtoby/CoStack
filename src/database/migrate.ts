import { readdir } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { databasePool } from './pool'
import type { Pool } from 'pg'

const migrationsDirectory = fileURLToPath(
  new URL('./migrations/', import.meta.url),
)
const migrationLock = 1_129_796_916

export async function migrate(pool: Pool = databasePool()) {
  const client = await pool.connect()
  try {
    await client.query('SELECT pg_advisory_lock($1)', [migrationLock])
    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        name text PRIMARY KEY,
        applied_at timestamptz NOT NULL DEFAULT now()
      )
    `)

    const applied = await client.query<{ name: string }>(
      'SELECT name FROM schema_migrations',
    )
    const appliedNames = new Set(applied.rows.map(({ name }) => name))
    const files = (await readdir(migrationsDirectory))
      .filter((name) => name.endsWith('.sql'))
      .sort()

    for (const name of files) {
      if (appliedNames.has(name)) continue
      const sql = await Bun.file(`${migrationsDirectory}/${name}`).text()
      await client.query('BEGIN')
      try {
        await client.query(sql)
        await client.query('INSERT INTO schema_migrations (name) VALUES ($1)', [
          name,
        ])
        await client.query('COMMIT')
      } catch (error) {
        await client.query('ROLLBACK')
        throw error
      }
    }
  } finally {
    await client.query('SELECT pg_advisory_unlock($1)', [migrationLock])
    client.release()
  }
}

if (import.meta.main) {
  await migrate()
  await databasePool().end()
}
