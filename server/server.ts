import './loadEnv';
import compression from 'compression';
import express, { type RequestHandler } from 'express';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import chatgptHandler from '../api/chatgpt';
import geminiHandler, { geminiProgressHandler } from '../api/gemini';
import n8nArticlesHandler from '../api/n8nArticles';
import assignedArticleAutomationHandler from '../api/assignedArticleAutomation';
import systemSettingsHandler from '../api/systemSettings';
import adminUsersHandler from '../api/adminUsers';
import articlesSaveHandler from '../api/articlesSave';
import externalAnalysisHandler from '../api/externalAnalysis';

type ApiHandler = (req: unknown, res: unknown) => Promise<Response | void>;

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, '..');
const distDir = process.env.STATIC_DIR
  ? path.resolve(process.env.STATIC_DIR)
  : path.join(projectRoot, 'dist');
const port = Number.parseInt(process.env.PORT || '8080', 10) || 8080;

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
app.use((_, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  res.setHeader('Referrer-Policy', 'same-origin');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  next();
});
app.use(['/api/gemini', '/api/chatgpt'], express.json({ limit: '1500kb' }));
app.use(express.json({ limit: process.env.API_JSON_LIMIT || '12mb' }));

const healthzHandler: RequestHandler = (_req, res) => {
  res.json({
    ok: true,
    service: 'bazarvan-editor',
  });
};

app.get('/healthz', healthzHandler);
app.get('/api/healthz', healthzHandler);

app.post('/api/gemini/progress/:progressId/cancel', runApiHandler(geminiProgressHandler));
app.all('/api/gemini/progress/:progressId', runApiHandler(geminiProgressHandler));
app.all('/api/gemini', runApiHandler(geminiHandler));
app.all('/api/chatgpt', runApiHandler(chatgptHandler));
app.all('/api/n8n/articles', runApiHandler(n8nArticlesHandler));
app.all('/api/articles/save', runApiHandler(articlesSaveHandler));
app.all('/api/external-analysis', runApiHandler(externalAnalysisHandler));
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
  const status = typeof error === 'object' && error !== null && 'status' in error
    ? Number((error as { status?: unknown }).status)
    : 500;
  const normalizedStatus = Number.isInteger(status) && status >= 400 && status <= 599 ? status : 500;
  res.status(normalizedStatus).json({
    error: normalizedStatus === 413
      ? 'Request body is too large.'
      : normalizedStatus === 400
        ? 'Invalid request body.'
        : 'Internal server error.',
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
