import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { encodeCredential, decodeCredential, localCredential, readNativeCredentialProfile } from '../trae-local-token.mjs';
import { locateTraeApp, resetTraeLocationCache } from '../trae-install.mjs';
import { LOCAL_TOKEN } from '../bridge.mjs';

// Synthetic profile; no vendor codec material or account credentials in tests.
const profile = { id: 'synthetic-v1', key: Buffer.alloc(32, 0x61), aad: Buffer.from('fixture-auth-data') };

function fakeClient(t, { version = '9.9.9', harness = 'a'.repeat(64) + 'b'.repeat(20),
  legacy = 'a'.repeat(64) + '0123456789' + 'b'.repeat(20) } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'trae-client-test-'));
  t.after(() => {
    resetTraeLocationCache();
    assert.ok(path.resolve(root).startsWith(path.resolve(os.tmpdir()) + path.sep));
    fs.rmSync(root, { recursive: true, force: true });
  });
  const app = path.join(root, 'resources/app'), modules = path.join(app, 'modules/ai-agent');
  fs.mkdirSync(modules, { recursive: true });
  fs.writeFileSync(path.join(app, 'product.json'), JSON.stringify({ appVersion: version }));
  fs.writeFileSync(path.join(modules, 'harness.dll'), harness + 'key too shortrandom too short');
  fs.writeFileSync(path.join(modules, 'ai_agent.dll'), legacy + 'apps\\icube_server_rs\\crates\\llm-client\\src\\crypto\\crypto.rs');
  return { root, app };
}

test('credential envelope uses a 12-byte nonce and authenticated payload, with fresh nonces', () => {
  const a = encodeCredential(LOCAL_TOKEN, profile), b = encodeCredential(LOCAL_TOKEN, profile);
  assert.notEqual(a, b);
  assert.equal(Buffer.from(a, 'base64').length, 12 + Buffer.byteLength(LOCAL_TOKEN) + 16);
  assert.equal(decodeCredential(a, profile), LOCAL_TOKEN);
  for (const index of [0, 15, Buffer.from(a, 'base64').length - 1]) {
    const tampered = Buffer.from(a, 'base64'); tampered[index] ^= 1;
    assert.throws(() => decodeCredential(tampered.toString('base64'), profile), /trae_credential_invalid/);
  }
  assert.throws(() => decodeCredential(a, { ...profile, aad: Buffer.alloc(0) }), /trae_credential_invalid/);
  assert.throws(() => decodeCredential(a, { ...profile, key: Buffer.alloc(32) }), /trae_credential_invalid/);
});

test('malformed or plaintext credentials are rejected', () => {
  for (const value of ['', LOCAL_TOKEN, '!!!!', Buffer.alloc(28).toString('base64')]) {
    assert.throws(() => decodeCredential(value, profile), /trae_credential_invalid/);
  }
  assert.throws(() => encodeCredential(null, profile), /trae_credential_input_invalid/);
  assert.throws(() => encodeCredential('fixture', profile, Buffer.alloc(16)), /trae_credential_input_invalid/);
});

test('the unused empty SK still has an authenticated 28-byte native envelope', () => {
  const encoded = encodeCredential('', profile);
  assert.equal(encoded.length, 40);
  assert.equal(Buffer.from(encoded, 'base64').length, 28);
  assert.equal(decodeCredential(encoded, profile), '');
  const tampered = Buffer.from(encoded, 'base64'); tampered[27] ^= 1;
  assert.throws(() => decodeCredential(tampered.toString('base64'), profile), /trae_credential_invalid/);
});

test('credential cache stays stable across syncs and regenerates for a changed profile', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'trae-credential-test-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, 'credential.json');
  const a = localCredential(file, { profile });
  assert.equal(localCredential(file, { profile }), a);
  const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.deepEqual(Object.keys(saved).sort(), ['ak', 'profile', 'version']);
  assert.equal(decodeCredential(saved.ak, profile), LOCAL_TOKEN);
  const next = { ...profile, id: 'synthetic-v2', aad: Buffer.from('next-auth-data') };
  const b = localCredential(file, { profile: next });
  assert.notEqual(b, a); assert.equal(decodeCredential(b, next), LOCAL_TOKEN);
  fs.writeFileSync(file, '{bad');
  assert.throws(() => localCredential(file, { profile }), /trae_credential_cache_unreadable/);
  assert.equal(fs.readFileSync(file, 'utf8'), '{bad');
});

test('an unlisted client version is accepted when the envelope layout matches', t => {
  const { app } = fakeClient(t, { version: '9.9.9' });
  const found = readNativeCredentialProfile({ app });
  assert.equal(found.version, '9.9.9');
  assert.equal(found.verification, 'structure');
  assert.equal(found.aad.toString(), '0123456789');
  assert.equal(decodeCredential(encodeCredential(LOCAL_TOKEN, found), found), LOCAL_TOKEN);
});

test('a native catalog ciphertext upgrades the profile to a verified key', t => {
  const { app } = fakeClient(t, { version: '9.9.9' });
  const unverified = readNativeCredentialProfile({ app });
  const native = encodeCredential(LOCAL_TOKEN, unverified);
  const verified = readNativeCredentialProfile({ app, verifyWith: [native] });
  assert.equal(verified.verification, 'catalog');
  assert.equal(verified.id, unverified.id);
});

test('a catalog ciphertext from another key is refused instead of used', t => {
  const { app } = fakeClient(t, { version: '9.9.9' });
  const foreign = encodeCredential(LOCAL_TOKEN, profile);
  assert.throws(() => readNativeCredentialProfile({ app, verifyWith: [foreign] }), /trae_credential_key_unverified/);
});

test('DLL material that does not share one key prefix is refused', t => {
  const { app } = fakeClient(t, { version: '9.9.9', legacy: 'c'.repeat(64) + '0123456789' + 'b'.repeat(20) });
  assert.throws(() => readNativeCredentialProfile({ app }), /trae_credential_profile_unknown/);
});

test('the install locator accepts an explicit candidate and rejects empty roots', t => {
  const { root, app } = fakeClient(t, { version: '9.9.8' });
  assert.equal(locateTraeApp({ sources: [() => [app]] }).version, '9.9.8');
  resetTraeLocationCache();
  assert.throws(() => locateTraeApp({ sources: [() => [path.join(root, 'missing')]] }), /trae_installation_unavailable/);
});
