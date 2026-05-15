const http = require('http');
const https = require('https');

function request(url, options = {}) {
  return new Promise((resolve, reject) => {
    const client = url.startsWith('https') ? https : http;
    const req = client.request(url, {
      method: options.method || 'GET',
      headers: options.headers || {},
      timeout: options.timeout || 30000
    }, (res) => {
      if ([301, 302, 307, 308].includes(res.statusCode) && res.headers.location) {
        return request(new URL(res.headers.location, url).href, options).then(resolve).catch(reject);
      }
      let data = Buffer.alloc(0);
      res.on('data', chunk => { data = Buffer.concat([data, chunk]); });
      res.on('end', () => resolve({
        body: data.toString('utf8'),
        buffer: data,  // <-- TAMBAH INI
        statusCode: res.statusCode,
        headers: res.headers
      }));
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('Timeout')); });
    if (options.body) req.write(options.body);
    req.end();
  });
}

async function getJSON(url, headers) {
  const res = await request(url, { headers });
  if (res.statusCode !== 200) throw new Error(`HTTP ${res.statusCode}`);
  return JSON.parse(res.body);
}

function randomUA() {
  const agents = [
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
  ];
  return agents[Math.floor(Math.random() * agents.length)];
}

module.exports = { request, getJSON, randomUA };