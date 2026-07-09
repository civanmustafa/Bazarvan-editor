import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, '..');

const ENV_FILES = ['.env.production', '.env.local', '.env'];

const stripOptionalExport = (line: string): string => (
  line.startsWith('export ') ? line.slice('export '.length).trimStart() : line
);

const unquoteValue = (value: string): string => {
  const trimmed = value.trim();
  const quote = trimmed[0];
  if ((quote === '"' || quote === "'") && trimmed.endsWith(quote)) {
    const inner = trimmed.slice(1, -1);
    return quote === '"'
      ? inner.replace(/\\n/g, '\n').replace(/\\r/g, '\r').replace(/\\t/g, '\t')
      : inner;
  }

  return trimmed;
};

const parseEnvLine = (line: string): [string, string] | null => {
  const trimmed = stripOptionalExport(line.trim());
  if (!trimmed || trimmed.startsWith('#')) return null;

  const separatorIndex = trimmed.indexOf('=');
  if (separatorIndex <= 0) return null;

  const key = trimmed.slice(0, separatorIndex).trim();
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) return null;

  return [key, unquoteValue(trimmed.slice(separatorIndex + 1))];
};

const loadEnvFile = (fileName: string): boolean => {
  const envPath = path.join(projectRoot, fileName);
  if (!fs.existsSync(envPath)) return false;

  const raw = fs.readFileSync(envPath, 'utf8');
  raw.split(/\r?\n/).forEach((line) => {
    const parsed = parseEnvLine(line);
    if (!parsed) return;

    const [key, value] = parsed;
    if (process.env[key] === undefined || process.env[key] === '') {
      process.env[key] = value;
    }
  });

  return true;
};

const loadedFiles = ENV_FILES.filter(loadEnvFile);

if (loadedFiles.length > 0) {
  process.env.BAZARVAN_ENV_FILES_LOADED = loadedFiles.join(',');
  console.log(`Loaded environment files: ${loadedFiles.join(', ')}`);
}
