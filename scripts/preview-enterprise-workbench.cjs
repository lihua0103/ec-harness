'use strict';
// Preview only explicitly approved static prototype assets, never project files.
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '../prototypes/enterprise-workbench');
const files = new Map([
  ['/', ['index.html', 'text/html; charset=utf-8']],
  ['/index.html', ['index.html', 'text/html; charset=utf-8']],
  ['/design.html', ['design.html', 'text/html; charset=utf-8']],
  ['/design-v5.html', ['design-v5.html', 'text/html; charset=utf-8']],
  ['/design.css', ['design.css', 'text/css; charset=utf-8']],
  ['/design-v5.css', ['design-v5.css', 'text/css; charset=utf-8']],
  ['/design-v5.js', ['design-v5.js', 'text/javascript; charset=utf-8']],
  ['/styles.css', ['styles.css', 'text/css; charset=utf-8']],
  ['/app.js', ['app.js', 'text/javascript; charset=utf-8']],
  ['/applications.mjs', ['applications.mjs', 'text/javascript; charset=utf-8']],
  ['/models.mjs', ['models.mjs', 'text/javascript; charset=utf-8']],
  ['/model.mjs', ['model.mjs', 'text/javascript; charset=utf-8']],
  ['/storage.mjs', ['storage.mjs', 'text/javascript; charset=utf-8']],
  ['/brand.svg', ['brand.svg', 'image/svg+xml']],
]);
const server = http.createServer((req, res) => {
  const headers = {'X-Content-Type-Options':'nosniff','Cache-Control':'no-store','Content-Security-Policy':"default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'none'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'"};
  if (!['GET', 'HEAD'].includes(req.method)) {res.writeHead(405, {...headers, Allow:'GET, HEAD'});res.end();return;}
  const pathname = req.url.split('?')[0];
  const item = files.get(pathname);
  if (!item) {res.writeHead(404, headers);res.end('Not found');return;}
  fs.readFile(path.join(root, item[0]), (error, body) => {
    if(error){res.writeHead(500, headers);res.end('Preview asset unavailable');console.error(error.message);return;}
    res.writeHead(200, {...headers,'Content-Type':item[1],'Content-Length':body.length});
    res.end(req.method === 'HEAD' ? undefined : body);
  });
});
server.on('error', error => {console.error(`Prototype preview failed: ${error.message}`);process.exitCode=1;});
const port = Number(process.env.PORT) || 3081;
server.listen(port, '127.0.0.1', () => console.log(`Enterprise workbench prototype ready: http://127.0.0.1:${server.address().port}`));
for(const signal of ['SIGINT','SIGTERM']) process.on(signal,()=>server.close(()=>process.exit(0)));
