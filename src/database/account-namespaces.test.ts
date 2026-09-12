import { readdir } from 'node:fs/promises'
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { PGlite } from '@electric-sql/pglite'

const database = await PGlite.create()
beforeAll(async () => {
  const directory = new URL('./migrations/', import.meta.url)
  for (const file of (await readdir(directory))
    .filter((name) => name.endsWith('.sql'))
    .sort())
    await database.transaction(async (tx) => {
      await tx.exec(await Bun.file(new URL(file, directory)).text())
    })
  await seedUsers()
  await database.query(
    "INSERT INTO mcp_connections(id,organization_id,display_name,namespace,transport,transport_config,state) VALUES ('connection','org','GitHub','github','streamable_http','{}','enabled')",
  )
  for (const owner of ['user-1', 'user-2'])
    await database.query(
      "INSERT INTO mcp_accounts(id,connection_id,kind,owner_user_id,display_name,namespace) VALUES ($1,'connection','personal',$2,'Work','github_work')",
      [`account-${owner}`, owner],
    )
})
afterAll(async () => database.close())

describe('account namespace claims', () => {
  test('Shared and Personal namespaces exclude each other in either creation order', async () => {
    await expect(
      database.query(`INSERT INTO mcp_accounts
      (id,connection_id,kind,display_name,namespace)
      VALUES ('conflicting-shared','connection','shared','Work','github_work')`),
    ).rejects.toMatchObject({
      code: '23505',
      constraint: 'mcp_accounts_namespace_scope',
    })
    await database.query(`INSERT INTO mcp_accounts
      (id,connection_id,kind,display_name,namespace)
      VALUES ('shared','connection','shared','Team','github_team')`)
    for (const owner of ['user-1', 'user-2']) {
      await expect(
        database.query(
          `INSERT INTO mcp_accounts
        (id,connection_id,kind,owner_user_id,display_name,namespace)
        VALUES ($1,'connection','personal',$2,'Team','github_team')`,
          [`conflict-${owner}`, owner],
        ),
      ).rejects.toMatchObject({
        code: '23505',
        constraint: 'mcp_accounts_namespace_scope',
      })
    }
    expect(
      (
        await database.query(
          "SELECT account_count FROM account_namespace_claims WHERE namespace='github_team'",
        )
      ).rows,
    ).toEqual([{ account_count: 1 }])
  })

  test('claims follow updates and deletion, and failed writes leave no reservations', async () => {
    await expect(
      database.query(
        "UPDATE mcp_accounts SET namespace='github_team' WHERE id='account-user-1'",
      ),
    ).rejects.toMatchObject({ constraint: 'mcp_accounts_namespace_scope' })
    await expect(
      database.query(
        "UPDATE mcp_accounts SET kind='shared', owner_user_id=NULL WHERE id='account-user-1'",
      ),
    ).rejects.toMatchObject({ constraint: 'mcp_accounts_namespace_scope' })
    await database.query(
      "UPDATE mcp_accounts SET namespace='github_new' WHERE id='account-user-1'",
    )
    expect(
      (
        await database.query(
          "SELECT account_count FROM account_namespace_claims WHERE namespace='github_work'",
        )
      ).rows,
    ).toEqual([{ account_count: 1 }])
    await database.query("DELETE FROM mcp_accounts WHERE id='account-user-2'")
    await database.query(`INSERT INTO mcp_accounts
      (id,connection_id,kind,display_name,namespace)
      VALUES ('reused','connection','shared','Work','github_work')`)
    await database.query(
      "UPDATE mcp_accounts SET kind='shared', owner_user_id=NULL WHERE id='account-user-1'",
    )
    expect(
      (
        await database.query(
          "SELECT kind,account_count FROM account_namespace_claims WHERE namespace='github_new'",
        )
      ).rows,
    ).toEqual([{ kind: 'shared', account_count: 1 }])
    await database.query('BEGIN')
    await database.query(`INSERT INTO mcp_accounts
      (id,connection_id,kind,display_name,namespace)
      VALUES ('rolled-back','connection','shared','Temporary','temporary')`)
    await database.query('ROLLBACK')
    expect(
      (
        await database.query(
          "SELECT * FROM account_namespace_claims WHERE namespace='temporary'",
        )
      ).rows,
    ).toEqual([])
    await database.query("DELETE FROM mcp_connections WHERE id='connection'")
    expect(
      (await database.query('SELECT * FROM account_namespace_claims')).rows,
    ).toEqual([])
  })

  test('migration rejects legacy cross-kind collisions without renaming accounts', async () => {
    await database.query('BEGIN')
    try {
      await database.query(
        'DROP TRIGGER mcp_accounts_namespace_scope ON mcp_accounts',
      )
      await database.query(`INSERT INTO mcp_connections
        (id,organization_id,display_name,namespace,transport,transport_config,state)
        VALUES ('legacy','org','Legacy','legacy','streamable_http','{}','enabled')`)
      await database.query(`INSERT INTO mcp_accounts
        (id,connection_id,kind,owner_user_id,display_name,namespace) VALUES
        ('legacy-personal','legacy','personal','user-1','Work','legacy_work'),
        ('legacy-shared','legacy','shared',NULL,'Work','legacy_work')`)
      const migration = await Bun.file(
        new URL(
          './migrations/0009_account_namespace_claims.sql',
          import.meta.url,
        ),
      ).text()
      await expect(database.exec(migration)).rejects.toThrow(
        'resolve conflicting accounts',
      )
    } finally {
      await database.query('ROLLBACK')
    }
  })

  test('migration backfills valid existing accounts and keeps their namespaces', async () => {
    await database.query('BEGIN')
    try {
      await database.exec(`DROP TRIGGER mcp_accounts_namespace_scope ON mcp_accounts;
        DROP FUNCTION maintain_account_namespace_claim();
        DROP TABLE account_namespace_claims;`)
      await database.query(`INSERT INTO mcp_connections
        (id,organization_id,display_name,namespace,transport,transport_config,state)
        VALUES ('legacy','org','Legacy','legacy','streamable_http','{}','enabled')`)
      await database.query(`INSERT INTO mcp_accounts
        (id,connection_id,kind,owner_user_id,display_name,namespace) VALUES
        ('legacy-one','legacy','personal','user-1','Work','legacy_work'),
        ('legacy-two','legacy','personal','user-2','Work','legacy_work'),
        ('legacy-shared','legacy','shared',NULL,'Team','legacy_team')`)
      await database.exec(
        await Bun.file(
          new URL(
            './migrations/0009_account_namespace_claims.sql',
            import.meta.url,
          ),
        ).text(),
      )
      expect(
        (
          await database.query(
            'SELECT * FROM account_namespace_claims ORDER BY namespace',
          )
        ).rows,
      ).toEqual([
        { namespace: 'legacy_team', kind: 'shared', account_count: 1 },
        { namespace: 'legacy_work', kind: 'personal', account_count: 2 },
      ])
      await database.query("DELETE FROM mcp_accounts WHERE id='legacy-one'")
      expect(
        (
          await database.query(
            "SELECT account_count FROM account_namespace_claims WHERE namespace='legacy_work'",
          )
        ).rows,
      ).toEqual([{ account_count: 1 }])
    } finally {
      await database.query('ROLLBACK')
    }
  })
})

async function seedUsers() {
  await database.query(
    "INSERT INTO organizations (id, display_name) VALUES ('org', 'Test')",
  )
  for (const id of ['user-1', 'user-2']) {
    await database.query(
      `INSERT INTO principals (id, organization_id, kind, display_name)
       VALUES ($1, 'org', 'user', $1)`,
      [id],
    )
    await database.query(
      `INSERT INTO users (principal_id, email) VALUES ($1, $2)`,
      [id, `${id}@example.test`],
    )
  }
}
