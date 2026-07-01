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
  ],
};
