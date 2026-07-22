import './loadEnv';
import compression from 'compression';
import express, { type RequestHandler } from 'express';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { API_ROUTES, type ApiHandler } from './apiRouteRegistry';
import {
  checkContentWritingReadiness,
  toPublicContentWritingReadiness,
} from './contentWritingReadiness';

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

const readyzHandler: RequestHandler = async (_req, res) => {
  const staticBuild = fs.existsSync(path.join(distDir, 'index.html'));
  const contentWriting = await checkContentWritingReadiness();
  const ok = staticBuild && contentWriting.ok;
  if (!ok && contentWriting.detail) {
    console.error(`[readyz] ${contentWriting.detail}`);
  }
  res.status(ok ? 200 : 503).json({
    ok,
    service: 'bazarvan-editor',
    checks: {
      staticBuild,
      contentWriting: toPublicContentWritingReadiness(contentWriting),
    },
  });
};

app.get('/healthz', healthzHandler);
app.get('/api/healthz', healthzHandler);
app.get('/readyz', readyzHandler);
app.get('/api/readyz', readyzHandler);

API_ROUTES.forEach(route => {
  const handler = runApiHandler(route.handler);
  if (route.method === 'POST') {
    app.post(route.path, handler);
    return;
  }
  app.all(route.path, handler);
});

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
