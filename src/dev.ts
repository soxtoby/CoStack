import { mkdir } from 'node:fs/promises'
import { PGlite } from '@electric-sql/pglite'
import { PGLiteSocketServer } from '@electric-sql/pglite-socket'
import { Pool } from 'pg'
import { migrate } from './database/migrate'

const directory = '.pglite'
await mkdir(directory, { recursive: true })

const database = await PGlite.create(directory)
const socket = new PGLiteSocketServer({
  db: database,
  host: '127.0.0.1',
  port: 5432,
})
await socket.start()

const databaseUrl =
  'postgresql://postgres:postgres@127.0.0.1:5432/postgres?sslmode=disable'
const pool = new Pool({ connectionString: databaseUrl, max: 1 })
await migrate(pool)
await pool.end()

const vite = Bun.spawn(
  ['bunx', 'vite', 'dev', '--host', '0.0.0.0', '--port', '3000'],
  {
    env: {
      ...process.env,
      DATABASE_URL: databaseUrl,
      DATABASE_POOL_MAX: '1',
    },
    stdin: 'inherit',
    stdout: 'inherit',
    stderr: 'inherit',
  },
)

const exitCode = await vite.exited
await socket.stop()
await database.close()
process.exit(exitCode)
