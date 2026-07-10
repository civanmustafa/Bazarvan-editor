module.exports = {
  apps: [
    {
      name: 'bazarvan-editor',
      script: 'server-dist/server.mjs',
      cwd: __dirname,
      exec_mode: 'fork',
      instances: 1,
      env: {
        NODE_ENV: 'production',
        PORT: process.env.PORT || '8080',
      },
    },
    {
      name: 'bazarvan-ai-worker',
      script: 'server-dist/external-analysis-worker.mjs',
      cwd: __dirname,
      exec_mode: 'fork',
      instances: 1,
      autorestart: true,
      restart_delay: 2000,
      kill_timeout: 10000,
      env: {
        NODE_ENV: 'production',
        EXTERNAL_ANALYSIS_WORKER_POLL_MS: process.env.EXTERNAL_ANALYSIS_WORKER_POLL_MS || '5000',
        EXTERNAL_ANALYSIS_JOB_LEASE_SECONDS: process.env.EXTERNAL_ANALYSIS_JOB_LEASE_SECONDS || '300',
        EXTERNAL_ANALYSIS_RETRY_MINUTES: process.env.EXTERNAL_ANALYSIS_RETRY_MINUTES || '30',
      },
    },
  ],
};
