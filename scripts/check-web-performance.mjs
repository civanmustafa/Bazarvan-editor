import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';

const root = process.cwd();
const manifestPath = path.join(root, 'dist', '.vite', 'manifest.json');
const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
const entries = Object.entries(manifest);
const appEntry = entries.find(([, chunk]) => chunk.isEntry);

if (!appEntry) {
  throw new Error('Vite manifest does not contain an application entry.');
}

const initialKeys = new Set();
const visitStaticImports = (key) => {
  if (initialKeys.has(key)) return;
  const chunk = manifest[key];
  if (!chunk) throw new Error(`Missing manifest chunk: ${key}`);
  initialKeys.add(key);
  (chunk.imports || []).forEach(visitStaticImports);
};
visitStaticImports(appEntry[0]);

const routeKeys = [
  'components/Dashboard.tsx',
  'components/AdminApp.tsx',
  'components/SettingsPage.tsx',
  'components/EditorApp.tsx',
];

const findManifestChunk = (sourcePath) => {
  if (manifest[sourcePath]) return [sourcePath, manifest[sourcePath]];
  const expectedName = path.basename(sourcePath, path.extname(sourcePath));
  return entries.find(([, chunk]) => chunk.src === sourcePath || chunk.name === expectedName);
};

for (const routeKey of routeKeys) {
  const routeEntry = findManifestChunk(routeKey);
  const routeChunk = routeEntry?.[1];
  if (!routeChunk?.isDynamicEntry) {
    throw new Error(`${routeKey} must remain a lazy route chunk.`);
  }
  if (initialKeys.has(routeEntry[0])) {
    throw new Error(`${routeKey} leaked into the initial application graph.`);
  }
}

const initialFiles = [...initialKeys]
  .map(key => manifest[key]?.file)
  .filter(file => typeof file === 'string' && file.endsWith('.js'));
const initialBytes = (await Promise.all(
  initialFiles.map(file => stat(path.join(root, 'dist', file)).then(info => info.size)),
)).reduce((sum, size) => sum + size, 0);
const initialBudgetBytes = 900 * 1024;

if (initialBytes > initialBudgetBytes) {
  throw new Error(`Initial JavaScript is ${initialBytes} bytes; budget is ${initialBudgetBytes} bytes.`);
}

const editorChunk = findManifestChunk('components/EditorApp.tsx')?.[1];
if (!editorChunk) throw new Error('Editor route chunk is missing from the Vite manifest.');
const editorBytes = (await stat(path.join(root, 'dist', editorChunk.file))).size;
const editorEntryBudgetBytes = 500 * 1024;

if (editorBytes > editorEntryBudgetBytes) {
  throw new Error(`Editor route entry is ${editorBytes} bytes; budget is ${editorEntryBudgetBytes} bytes.`);
}

console.log(JSON.stringify({
  initialJavaScriptBytes: initialBytes,
  initialBudgetBytes,
  initialFiles,
  editorRouteEntryBytes: editorBytes,
  editorRouteEntryBudgetBytes: editorEntryBudgetBytes,
}, null, 2));
