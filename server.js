// Minimal Express server for local development
require('dotenv').config();
const express = require('express');
const serverless = require('serverless-http');
const api = require('./netlify/functions/api');
const path = require('path');
const app = express();

// Serve static files from public
app.use(express.static(path.join(__dirname, 'public')));

// Mount the API at root since api.js routes already have /api prefix
app.use('/', api.app || api);

// Fallback to index.html for SPA
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`EduCrate running at http://localhost:${PORT}`);
});
