// Throwaway, local-only icon comparison sheet; never mounted in the app.
const page = Bun.file(new URL('./index.html', import.meta.url))
Bun.serve({
  hostname: '127.0.0.1',
  port: 4318,
  fetch: () => new Response(page),
})
console.log('Icon prototype: http://127.0.0.1:4318')
