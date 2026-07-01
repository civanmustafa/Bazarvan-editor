import { build } from 'esbuild';

await build({
  entryPoints: ['server/server.ts'],
  outfile: 'server-dist/server.mjs',
  bundle: true,
  platform: 'node',
  target: 'node20',
  format: 'esm',
  packages: 'external',
  sourcemap: false,
});

console.log('Built production server: server-dist/server.mjs');
