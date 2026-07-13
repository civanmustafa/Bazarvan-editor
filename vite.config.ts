import path from 'path';
import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';
import { findApiRoute } from './server/apiRouteRegistry';
import { createWebRequest, sendWebResponse } from './server/viteApiAdapter';

export default defineConfig(({ mode }) => {
      const env = loadEnv(mode, process.cwd(), '');
      ['GEMINI_API_KEYS', 'GEMINI_API_KEY', 'API_KEY', 'GEMINI_PAID_API_KEYS', 'GEMINI_PAID_API_KEY', 'GEMINI_PRO_API_KEYS', 'GEMINI_PRO_API_KEY', 'GEMINI_MODEL', 'GEMINI_PAID_MODEL', 'GEMINI_ALLOWED_MODELS', 'OPENAI_API_KEY', 'OPENAI_API_KEYS', 'OPENAI_MODEL', 'OPENAI_ALLOWED_MODELS', 'FIRECRAWL_API_KEY', 'FIRECRAWL_API_URL', 'COMPETITOR_PREVIEW_CACHE_HOURS', 'N8N_INGEST_TOKEN', 'SUPABASE_SERVICE_ROLE_KEY', 'SUPABASE_URL', 'SUPABASE_ANON_KEY', 'VITE_SUPABASE_URL', 'VITE_SUPABASE_ANON_KEY', 'EDITOR_PUBLIC_URL', 'PUBLIC_EDITOR_URL', 'APP_BASE_URL', 'ALLOWED_API_ORIGINS', 'AI_MAX_PROMPT_CHARS', 'API_AUTH_CACHE_TTL_SECONDS', 'GEMINI_START_RATE_LIMIT_PER_MINUTE', 'GEMINI_PROGRESS_RATE_LIMIT_PER_MINUTE', 'GEMINI_CANCEL_RATE_LIMIT_PER_MINUTE', 'OPENAI_START_RATE_LIMIT_PER_MINUTE', 'ARTICLE_SAVE_MAX_BYTES', 'ARTICLE_SAVE_RATE_LIMIT_PER_MINUTE'].forEach((key) => {
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
              const route = findApiRoute(url.pathname, req.method || 'GET');

              if (!route) {
                next();
                return;
              }

              try {
                const request = await createWebRequest(req, url.toString());
                const response = await route.handler(request);
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
        manifest: true,
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
