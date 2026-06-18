const express = require('express');
const path = require('path');
const { createProxyMiddleware } = require('http-proxy-middleware');
const app = express();
const PORT = 3001;

const dist = path.join(__dirname, '..', 'admin', 'dist');

app.use('/api', createProxyMiddleware({ target: 'http://localhost:3000/api', changeOrigin: true }));
app.use(express.static(dist));
app.get('*', (req, res) => res.sendFile(path.join(dist, 'index.html')));
app.listen(PORT, () => console.log('Admin SPA on http://localhost:' + PORT));
