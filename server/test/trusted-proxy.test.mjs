// Unit tests for the trusted-proxy / client-IP logic.  Run: npm test  (after npm run build)
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { isTrusted, parseTrusted, resolveClientIp, requestInfo } from '../dist/server/src/http.js';

const live = parseTrusted('loopback,docker');
const dev = parseTrusted('loopback');
const fakeReq = (peer, headers = {}) => ({ socket: { remoteAddress: peer }, headers });

test('aliases and CIDRs', () => {
  assert.ok(isTrusted('127.0.0.1', live));
  assert.ok(isTrusted('::ffff:127.0.0.1', live));
  assert.ok(isTrusted('::1', live));
  assert.ok(isTrusted('172.17.0.1', live));
  assert.ok(isTrusted('172.31.255.254', live));
  assert.ok(!isTrusted('172.32.0.1', live));
  assert.ok(!isTrusted('192.168.35.50', live));
  assert.ok(!isTrusted('8.8.8.8', live));
  assert.ok(isTrusted('10.1.2.3', parseTrusted('10.0.0.0/8')));
  assert.throws(() => parseTrusted('not-an-ip'));
});

test('spoofed headers from an untrusted peer are ignored', () => {
  const h = { 'x-forwarded-for': '1.1.1.1', 'x-real-ip': '2.2.2.2', 'x-forwarded-proto': 'https', 'x-forwarded-host': 'evil.example' };
  assert.equal(resolveClientIp('203.0.113.9', h, live), '203.0.113.9');
  const info = requestInfo(fakeReq('203.0.113.9', { ...h, host: 'qt.log2u.me' }), live);
  assert.equal(info.ip, '203.0.113.9');
  assert.equal(info.proto, 'http');
  assert.equal(info.host, 'qt.log2u.me');
  assert.equal(info.secure, false);
});

test('X-Real-IP from a trusted proxy wins', () => {
  assert.equal(resolveClientIp('172.18.0.1', { 'x-real-ip': '198.51.100.7', 'x-forwarded-for': '6.6.6.6, 198.51.100.7' }, live), '198.51.100.7');
});

test('otherwise the right-most untrusted X-Forwarded-For entry', () => {
  // client-supplied junk on the left, real client, then our own proxies on the right
  assert.equal(resolveClientIp('127.0.0.1', { 'x-forwarded-for': '6.6.6.6, 198.51.100.7, 172.17.0.1, 127.0.0.1' }, live), '198.51.100.7');
  assert.equal(resolveClientIp('127.0.0.1', { 'x-forwarded-for': 'garbage, 198.51.100.8' }, live), '198.51.100.8');
});

test('dev (loopback only) does not trust the Docker range', () => {
  assert.equal(resolveClientIp('172.17.0.1', { 'x-forwarded-for': '1.1.1.1' }, dev), '172.17.0.1');
});

test('trusted proxy: https + host honoured, Secure cookies', () => {
  const info = requestInfo(fakeReq('172.17.0.1', { 'x-forwarded-proto': 'https', 'x-forwarded-host': 'qt.log2u.me', 'x-real-ip': '198.51.100.7', host: '127.0.0.1:5190' }), live);
  assert.deepEqual([info.ip, info.proto, info.host, info.secure, info.local], ['198.51.100.7', 'https', 'qt.log2u.me', true, false]);
});

test('local health detail only for direct loopback calls', () => {
  assert.equal(requestInfo(fakeReq('127.0.0.1', { host: 'x' }), live).local, true);
  assert.equal(requestInfo(fakeReq('127.0.0.1', { host: 'x', 'x-forwarded-for': '1.2.3.4' }), live).local, false);
});

test('Cloudflare Tunnel: Cf-Connecting-Ip only when enabled and only from a trusted peer', () => {
  const h = { 'cf-connecting-ip': '198.51.100.20', 'x-forwarded-for': '198.51.100.20' };
  // cloudflared container on the compose network (docker range), flag on
  assert.equal(resolveClientIp('172.19.0.5', h, live, true), '198.51.100.20');
  // flag off: falls back to X-Forwarded-For (same visitor here)
  assert.equal(resolveClientIp('172.19.0.5', { 'cf-connecting-ip': '1.1.1.1', 'x-forwarded-for': '198.51.100.21' }, live, false), '198.51.100.21');
  // untrusted peer: header ignored even with the flag on
  assert.equal(resolveClientIp('203.0.113.9', { 'cf-connecting-ip': '1.1.1.1' }, live, true), '203.0.113.9');
  // garbage header ignored
  assert.equal(resolveClientIp('172.19.0.5', { 'cf-connecting-ip': 'not an ip', 'x-forwarded-for': '198.51.100.22' }, live, true), '198.51.100.22');
});

test('visitors behind the tunnel are not lumped into one IP', () => {
  const a = requestInfo(fakeReq('172.19.0.5', { 'cf-connecting-ip': '198.51.100.30', host: 'qt.log2u.me' }), live, true);
  const b = requestInfo(fakeReq('172.19.0.5', { 'cf-connecting-ip': '198.51.100.31', host: 'qt.log2u.me' }), live, true);
  assert.notEqual(a.ip, b.ip);
  assert.equal(a.ip, '198.51.100.30');
});
