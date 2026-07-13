import { build } from 'esbuild';

const targets = [
  {
    entryPoint: 'server/server.ts',
    outfile: 'server-dist/server.mjs',
    label: 'production server',
  },
  {
    entryPoint: 'server/externalAnalysisWorker.ts',
    outfile: 'server-dist/external-analysis-worker.mjs',
    label: 'external analysis worker',
  },
  {
    entryPoint: 'server/aiJobWorker.ts',
    outfile: 'server-dist/ai-job-worker.mjs',
    label: 'durable AI job worker',
  },
];

await Promise.all(targets.map(({ entryPoint, outfile }) => build({
  entryPoints: [entryPoint],
  outfile,
  bundle: true,
  platform: 'node',
  target: 'node20',
  format: 'esm',
  packages: 'external',
  sourcemap: false,
})));

targets.forEach(({ label, outfile }) => {
  console.log(`Built ${label}: ${outfile}`);
});
