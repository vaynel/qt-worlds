// Static client: brotli when accepted, gzip as the fallback, identity otherwise; same headers either way.
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, request } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { brotliDecompressSync, gunzipSync } from 'node:zlib';
import { acceptsEncoding, StaticClient } from '../dist/server/src/http.js';

let dir;
let server;
let port;
const js = `export const words = ${JSON.stringify(Array.from({ length: 400 }, (_, i) => `말씀 ${i} grace and peace`))};\n`;

before(async () => {
  dir = mkdtempSync(join(tmpdir(), 'worlds-static-'));
  mkdirSync(join(dir, 'assets'));
  writeFileSync(join(dir, 'index.html'), `<!doctype html><title>t</title>${'<p>hello</p>'.repeat(200)}`);
  writeFileSync(join(dir, 'assets', 'index-abc.js'), js);
  const sc = new StaticClient(dir);
  await sc.warm();
  server = createServer((req, res) => {
    if (!sc.handle(req, res)) {
      res.writeHead(404);
      res.end();
    }
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  port = server.address().port;
});
after(() => {
  server?.close();
  rmSync(dir, { recursive: true, force: true });
});

const get = (path, enc) =>
  new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, path, headers: enc === undefined ? {} : { 'accept-encoding': enc } }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
    });
    req.on('error', reject);
    req.end();
  });

test('accept-encoding parsing', () => {
  assert.ok(acceptsEncoding('gzip, deflate, br, zstd', 'br'));
  assert.ok(acceptsEncoding('gzip;q=1.0, br;q=0.5', 'br'));
  assert.ok(!acceptsEncoding('gzip, br;q=0', 'br'));
  assert.ok(!acceptsEncoding('gzip', 'br'));
  assert.ok(!acceptsEncoding(undefined, 'gzip'));
});

test('br when accepted, gzip fallback, identity without either', async () => {
  const br = await get('/assets/index-abc.js', 'gzip, deflate, br');
  assert.equal(br.headers['content-encoding'], 'br');
  assert.equal(brotliDecompressSync(br.body).toString(), js);
  const gz = await get('/assets/index-abc.js', 'gzip, deflate');
  assert.equal(gz.headers['content-encoding'], 'gzip');
  assert.equal(gunzipSync(gz.body).toString(), js);
  assert.ok(br.body.length < gz.body.length, `br ${br.body.length} < gz ${gz.body.length}`);
  const plain = await get('/assets/index-abc.js');
  assert.equal(plain.headers['content-encoding'], undefined);
  assert.equal(plain.body.toString(), js);
  for (const r of [br, gz, plain]) {
    assert.equal(r.headers.vary, 'accept-encoding');
    assert.equal(r.headers['cache-control'], 'public, max-age=31536000, immutable');
    assert.equal(Number(r.headers['content-length']), r.body.length);
  }
});

test('HTML keeps its security headers (CSP) with brotli', async () => {
  const r = await get('/', 'br, gzip');
  assert.equal(r.headers['content-encoding'], 'br');
  assert.match(String(r.headers['content-security-policy']), /default-src 'self'/);
  assert.equal(r.headers['cache-control'], 'no-cache');
  assert.match(brotliDecompressSync(r.body).toString(), /<p>hello<\/p>/);
});
