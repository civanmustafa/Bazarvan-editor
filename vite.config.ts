import path from 'path';
import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';
import chatgptHandler from './api/chatgpt';
import geminiHandler, { geminiProgressHandler } from './api/gemini';
import n8nArticlesHandler from './api/n8nArticles';
import assignedArticleAutomationHandler from './api/assignedArticleAutomation';
import systemSettingsHandler from './api/systemSettings';
import adminUsersHandler from './api/adminUsers';

type ApiHandler = (req: Request) => Promise<Response | void>;

// Add local browser-facing API routes here, then implement their handler in api/*.
const apiHandlers = new Map<string, ApiHandler>([
  ['/api/chatgpt', chatgptHandler],
  ['/api/gemini', geminiHandler],
  ['/api/n8n/articles', n8nArticlesHandler],
  ['/api/articles/assigned-automation', assignedArticleAutomationHandler],
  ['/api/system/settings', systemSettingsHandler],
  ['/api/admin/users', adminUsersHandler],
]);

const readRequestBody = (req: any): Promise<Buffer> => new Promise((resolve, reject) => {
  const chunks: Buffer[] = [];
  req.on('data', (chunk: Buffer | string) => {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  });
  req.on('end', () => resolve(Buffer.concat(chunks)));
  req.on('error', reject);
});

const createWebRequest = async (req: any, url: string): Promise<Request> => {
  const headers = new Headers();
  Object.entries(req.headers || {}).forEach(([key, value]) => {
    if (Array.isArray(value)) {
      value.forEach(item => headers.append(key, String(item)));
    } else if (value !== undefined) {
      headers.set(key, String(value));
    }
  });

  const hasBody = req.method && !['GET', 'HEAD'].includes(req.method);
  const body = hasBody ? await readRequestBody(req) : undefined;

  return new Request(url, {
    method: req.method,
    headers,
    body: body && body.length > 0 ? body : undefined,
  });
};

const sendWebResponse = async (res: any, response: Response) => {
  res.statusCode = response.status;
  response.headers.forEach((value, key) => res.setHeader(key, value));
  const body = Buffer.from(await response.arrayBuffer());
  res.end(body);
};

export default defineConfig(({ mode }) => {
      const env = loadEnv(mode, process.cwd(), '');
      ['GEMINI_API_KEYS', 'GEMINI_API_KEY', 'API_KEY', 'GEMINI_PAID_API_KEYS', 'GEMINI_PAID_API_KEY', 'GEMINI_PRO_API_KEYS', 'GEMINI_PRO_API_KEY', 'GEMINI_MODEL', 'GEMINI_PAID_MODEL', 'GEMINI_ALLOWED_MODELS', 'OPENAI_API_KEY', 'OPENAI_API_KEYS', 'OPENAI_MODEL', 'N8N_INGEST_TOKEN', 'SUPABASE_SERVICE_ROLE_KEY', 'SUPABASE_URL', 'VITE_SUPABASE_URL', 'EDITOR_PUBLIC_URL', 'PUBLIC_EDITOR_URL', 'APP_BASE_URL'].forEach((key) => {
        if (!process.env[key] && env[key]) {
          process.env[key] = env[key];
        }
      });

      return {
      server: {
        port: 3000,
        host: '0.0.0.0',
      },
      plugins: [
        react(),
        {
          name: 'local-api-routes',
          configureServer(server) {
            // Small adapter from Vite/Node middleware requests to Web Request handlers.
            server.middlewares.use(async (req, res, next) => {
              if (!req.url) {
                next();
                return;
              }

              const origin = `http://${req.headers.host || 'localhost'}`;
              const url = new URL(req.url, origin);
              const handler = apiHandlers.get(url.pathname)
                || (url.pathname.startsWith('/api/gemini/progress/') ? geminiProgressHandler : undefined);

              if (!handler) {
                next();
                return;
              }

              try {
                const request = await createWebRequest(req, url.toString());
                const response = await handler(request);
                if (!response) {
                  throw new Error(`Local API route did not return a response for ${url.pathname}`);
                }
                await sendWebResponse(res, response);
              } catch (error) {
                console.error(`Local API route failed for ${url.pathname}:`, error);
                if (!res.headersSent) {
                  res.statusCode = 500;
                  res.setHeader('Content-Type', 'application/json; charset=utf-8');
                  res.end(JSON.stringify({
                    error: error instanceof Error ? error.message : 'Local API route failed',
                  }));
                }
              }
            });
          },
        },
      ],
      build: {
        rollupOptions: {
          output: {
            // Keep heavy editor dependencies in separate chunks for faster cached reloads.
            manualChunks(id) {
              if (!id.includes('node_modules')) return undefined;
              if (id.includes('@tiptap')) return 'tiptap';
              if (id.includes('prosemirror')) return 'prosemirror';
              if (id.includes('react') || id.includes('scheduler')) return 'react';
              if (id.includes('lucide-react')) return 'icons';
              return 'vendor';
            },
          },
        },
      },
      resolve: {
        alias: {
          '@': path.resolve(__dirname, '.'),
        }
      }
      };
});
