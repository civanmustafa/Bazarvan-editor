import path from 'path';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import chatgptHandler from './api/chatgpt';
import geminiHandler from './api/gemini';

type ApiHandler = (req: Request) => Promise<Response>;

const apiHandlers = new Map<string, ApiHandler>([
  ['/api/chatgpt', chatgptHandler],
  ['/api/gemini', geminiHandler],
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

export default defineConfig({
      server: {
        port: 3000,
        host: '0.0.0.0',
      },
      plugins: [
        react(),
        {
          name: 'local-api-routes',
          configureServer(server) {
            server.middlewares.use(async (req, res, next) => {
              if (!req.url) {
                next();
                return;
              }

              const origin = `http://${req.headers.host || 'localhost'}`;
              const url = new URL(req.url, origin);
              const handler = apiHandlers.get(url.pathname);

              if (!handler) {
                next();
                return;
              }

              try {
                const request = await createWebRequest(req, url.toString());
                const response = await handler(request);
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
});
