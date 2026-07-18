const app = require('./api/index');
const express = require('express');
const path = require('path');
const { initDatabase } = require('./database');

const PORT = process.env.PORT || 3000;

async function start() {
  await initDatabase();

  const server = express();

  server.use((req, res) => {
    app(req, res);
  });

  server.listen(PORT, () => {
    console.log(`Enrich U running on http://localhost:${PORT}`);
  });
}

start().catch(err => {
  console.error('Failed to start:', err);
  process.exit(1);
});
