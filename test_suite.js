const express = require('express');
const app = require('./server.js');
const http = require('http');

let server;

function request(method, path, body = null) {
  return new Promise((resolve, reject) => {
    const options = {
      hostname: '127.0.0.1',
      port: 5099,
      path: encodeURI(`/api/pos${path}`),
      method: method,
      headers: {
        'Content-Type': 'application/json',
        'x-tenant-db': 'tenant_db_freshmart'
      }
    };

    const req = http.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => (data += chunk));
      res.on('end', () => {
        try {
          resolve({ status: res.statusCode, body: JSON.parse(data) });
        } catch {
          resolve({ status: res.statusCode, body: data });
        }
      });
    });

    req.on('error', reject);
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

async function run() {
  server = app.listen(5099, async () => {
    console.log('🚀 Internal test server listening on 5099');
  });
}

run();
