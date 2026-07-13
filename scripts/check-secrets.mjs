import { execFileSync } from 'node:child_process';
import fs from 'node:fs';

const trackedFiles = execFileSync('git', ['ls-files', '-z'], { encoding: 'utf8' })
  .split('\0')
  .filter(Boolean);

const directSecretPatterns = [
  /AIza[0-9A-Za-z_-]{25,}/g,
  /AQ\.[0-9A-Za-z_-]{30,}/g,
  /sk-(?:proj-)?[0-9A-Za-z_-]{20,}/g,
  /sb_secret_[0-9A-Za-z_-]{20,}/g,
];
const assignedSecretPattern = /^(?:export[ \t]+)?(?:SUPABASE_SERVICE_ROLE_KEY|N8N_INGEST_TOKEN|GEMINI(?:_PAID|_PRO)?_API_KEYS?|OPENAI_API_KEYS?)[ \t]*=[ \t]*["']?([^\s"'#]{20,})/gm;
const placeholderPattern = /^(?:your|example|placeholder|replace|change|make-a-|gemini-key-|openai-key-|supabase-|n8n-|free_key|paid_|ضع_|المفتاح_)/i;
const findings = [];

for (const file of trackedFiles) {
  let stat;
  try {
    stat = fs.statSync(file);
  } catch {
    continue;
  }
  if (!stat.isFile() || stat.size > 2_000_000) continue;

  let content;
  try {
    content = fs.readFileSync(file, 'utf8');
  } catch {
    continue;
  }
  if (content.includes('\0')) continue;

  for (const pattern of directSecretPatterns) {
    pattern.lastIndex = 0;
    for (const match of content.matchAll(pattern)) {
      findings.push({ file, index: match.index || 0, kind: 'credential-shaped value' });
    }
  }

  assignedSecretPattern.lastIndex = 0;
  for (const match of content.matchAll(assignedSecretPattern)) {
    const value = String(match[1] || '');
    if (!placeholderPattern.test(value)) {
      findings.push({ file, index: match.index || 0, kind: 'non-placeholder secret assignment' });
    }
  }
}

if (findings.length > 0) {
  console.error('Secret scan failed. Potential credentials were found in tracked files:');
  for (const finding of findings) {
    const content = fs.readFileSync(finding.file, 'utf8');
    const line = content.slice(0, finding.index).split(/\r?\n/).length;
    console.error(`- ${finding.file}:${line} (${finding.kind})`);
  }
  console.error('No secret value was printed. Remove it from Git and rotate the credential.');
  process.exit(1);
}

console.log(`Secret scan passed (${trackedFiles.length} tracked files checked).`);
