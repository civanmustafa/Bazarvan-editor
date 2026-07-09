import './loadEnv';
import compression from 'compression';
import express, { type RequestHandler } from 'express';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import chatgptHandler from '../api/chatgpt';
import geminiHandler from '../api/gemini';
import n8nArticlesHandler from '../api/n8nArticles';
import assignedArticleAutomationHandler from '../api/assignedArticleAutomation';
import systemSettingsHandler from '../api/systemSettings';
import adminUsersHandler from '../api/adminUsers';
import articlesSaveHandler from '../api/articlesSave';

type ApiHandler = (req: unknown, res: unknown) => Promise<Response | void>;

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, '..');
const distDir = process.env.STATIC_DIR
  ? path.resolve(process.env.STATIC_DIR)
  : path.join(projectRoot, 'dist');
const port = Number.parseInt(process.env.PORT || '8080', 10) || 8080;

const hasEnvValue = (...keys: string[]): boolean => keys.some(key => Boolean(process.env[key]?.trim()));
const secretList = (...keys: string[]): string[] => (
  Array.from(new Set(
    keys
      .flatMap(key => String(process.env[key] || '').split(/[\n,;]+/))
      .map(item => item.trim())
      .filter(Boolean)
  ))
);
const countSecretList = (...keys: string[]): number => (
  secretList(...keys).length
);

const runApiHandler = (handler: ApiHandler): RequestHandler => async (req, res, next) => {
  try {
    await handler(req, res);
  } catch (error) {
    next(error);
  }
};

const app = express();

app.disable('x-powered-by');
app.set('trust proxy', true);
app.use(compression());
app.use(express.json({ limit: '25mb' }));

const healthzHandler: RequestHandler = (_req, res) => {
  res.json({
    ok: true,
    service: 'bazarvan-editor',
    uptimeSeconds: Math.round(process.uptime()),
    ai: {
      geminiConfigured: hasEnvValue('GEMINI_API_KEYS', 'GEMINI_API_KEY', 'API_KEY'),
      geminiKeyCount: countSecretList('GEMINI_API_KEYS', 'GEMINI_API_KEY', 'API_KEY'),
      geminiPaidConfigured: hasEnvValue('GEMINI_PAID_API_KEYS', 'GEMINI_PAID_API_KEY', 'GEMINI_PRO_API_KEYS', 'GEMINI_PRO_API_KEY'),
      geminiPaidKeyCount: countSecretList('GEMINI_PAID_API_KEYS', 'GEMINI_PAID_API_KEY', 'GEMINI_PRO_API_KEYS', 'GEMINI_PRO_API_KEY'),
      openAiConfigured: hasEnvValue('OPENAI_API_KEY', 'OPENAI_API_KEYS'),
      openAiKeyCount: countSecretList('OPENAI_API_KEY', 'OPENAI_API_KEYS'),
      n8nConfigured: hasEnvValue('N8N_INGEST_TOKEN') && hasEnvValue('SUPABASE_SERVICE_ROLE_KEY'),
    },
    envFilesLoaded: process.env.BAZARVAN_ENV_FILES_LOADED || '',
  });
};

app.get('/healthz', healthzHandler);
app.get('/api/healthz', healthzHandler);

app.all('/api/gemini', runApiHandler(geminiHandler));
app.all('/api/chatgpt', runApiHandler(chatgptHandler));
app.all('/api/n8n/articles', runApiHandler(n8nArticlesHandler));
app.all('/api/articles/save', runApiHandler(articlesSaveHandler));
app.all('/api/articles/assigned-automation', runApiHandler(assignedArticleAutomationHandler));
app.all('/api/system/settings', runApiHandler(systemSettingsHandler));
app.all('/api/admin/users', runApiHandler(adminUsersHandler));

app.use('/assets', express.static(path.join(distDir, 'assets'), {
  immutable: true,
  maxAge: '1y',
}));
app.use(express.static(distDir, {
  index: false,
  maxAge: '1h',
}));

app.use((req, res, next) => {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    next();
    return;
  }

  const indexFile = path.join(distDir, 'index.html');
  if (!fs.existsSync(indexFile)) {
    res.status(503).type('text/plain').send('Production build not found. Run npm run build first.');
    return;
  }

  res.setHeader('Cache-Control', 'no-store, max-age=0');
  res.sendFile(indexFile);
});

app.use((req, res) => {
  res.status(404).json({ error: `Route not found: ${req.method} ${req.path}` });
});

app.use((error: unknown, _req: express.Request, res: express.Response, next: express.NextFunction) => {
  console.error('Production server error:', error);
  if (res.headersSent) {
    next(error);
    return;
  }
  res.status(500).json({
    error: error instanceof Error ? error.message : 'Internal server error',
  });
});

const server = app.listen(port, '0.0.0.0', () => {
  console.log(`Bazarvan Editor is running on http://0.0.0.0:${port}`);
  console.log(`Static files: ${distDir}`);
});

server.ref();
server.on('error', (error) => {
  console.error('Could not start Bazarvan Editor server:', error);
  process.exitCode = 1;
});

const shutdown = (signal: NodeJS.Signals) => {
  console.log(`Received ${signal}. Closing Bazarvan Editor server...`);
  server.close(() => {
    process.exit(0);
  });
};

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
