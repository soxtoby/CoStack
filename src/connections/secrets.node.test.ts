import { expect, test } from 'bun:test'

test('secret vault works in the Node runtime used by Vite', async () => {
  const source = await Bun.file(new URL('./secrets.ts', import.meta.url)).text()
  const javascript = new Bun.Transpiler({
    loader: 'ts',
    target: 'node',
  }).transformSync(source)
  const result = Bun.spawnSync([
    'node',
    '--input-type=module',
    '--eval',
    `${javascript}
    const vault = await SecretVault.fromBase64('AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=');
    const envelope = await vault.seal({ token: 'test-secret' });
    const opened = await vault.open(envelope);
    if (opened.token !== 'test-secret') throw new Error('Secret round trip failed');
    for (const invalid of ['AA==', '!'.repeat(44)]) {
      let rejected = false;
      try { await SecretVault.fromBase64(invalid); } catch { rejected = true; }
      if (!rejected) throw new Error('Invalid key was accepted');
    }
  `,
  ])
  expect(result.stderr.toString()).toBe('')
  expect(result.exitCode).toBe(0)
})
