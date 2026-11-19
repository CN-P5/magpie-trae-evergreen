import fs from 'node:fs';
import path from 'node:path';
import { createHash, createCipheriv, createDecipheriv, randomBytes, randomUUID } from 'node:crypto';
import { LOCAL_TOKEN } from './bridge.mjs';
import { locateTraeApp } from './trae-install.mjs';

const SOURCE_MARKER = Buffer.from('apps\\icube_server_rs\\crates\\llm-client\\src\\crypto\\crypto.rs');
const HARNESS_MARKER = Buffer.from('key too shortrandom too short');
// What is verified here is the envelope layout, not the build. Trae ships new
// binaries far more often than it changes its credential scheme: 3.4.18,
// 3.4.20 and 3.4.22 all carry the same constants. A version allowlist only
// repeats the upgrade and cannot distinguish a stale list from a real scheme
// change. Instead the extracted profile has to reproduce a native ciphertext
// the account catalog already returned; that check is version-independent and
// fails loudly when the scheme actually changes.
const HARNESS_PATTERN = /^[0-9a-f]{84}$/;
const SOURCE_PATTERN = /^[0-9a-f]{64}[0-9]{10}[0-9a-f]{20}$/;
let cachedProfile;

// Vendor codec constants stay in the installed client. Scan with bounded
// memory; neither the package nor the credential cache contains its AES key.
function inspect(file, marker, prefixBytes) {
  let fd;
  try { fd = fs.openSync(file, 'r'); }
  catch (error) { if (error.code === 'ENOENT') throw new Error('trae_installation_unavailable'); throw error; }
  const chunk = Buffer.alloc(1024 * 1024), candidates = [];
  let tail = Buffer.alloc(0), total = 0;
  try {
    let count;
    while ((count = fs.readSync(fd, chunk, 0, chunk.length, null)) > 0) {
      const current = chunk.subarray(0, count);
      const window = Buffer.concat([tail, current]);
      let at = -1;
      while ((at = window.indexOf(marker, at + 1)) >= 0) {
        const absolute = total - tail.length + at;
        if (at >= prefixBytes && absolute + marker.length > total) candidates.push(Buffer.from(window.subarray(at - prefixBytes, at)));
      }
      total += count;
      tail = Buffer.from(window.subarray(-prefixBytes - marker.length));
    }
  } finally { fs.closeSync(fd); }
  if (candidates.length !== 1) throw new Error('trae_credential_profile_unknown');
  return candidates[0];
}

// A native ciphertext from the account catalog is the strongest available
// proof that the extracted key and AAD match the client the server trusts.
export function verifyProfileKey(profile, samples = []) {
  const encoded = samples.filter(value => typeof value === 'string' && value.length >= 28);
  if (!encoded.length) return true;
  for (const value of encoded) {
    let text;
    try { text = decodeCredential(value, profile); } catch { continue; }
    if (/^[\x20-\x7e]{0,8192}$/.test(text)) return true;
  }
  return false;
}

function materialProfile({ app, version, verifyWith }) {
  const root = path.join(app, 'modules/ai-agent');
  const files = ['harness.dll', 'ai_agent.dll'].map(name => path.join(root, name));
  let identity;
  try {
    identity = `${app}|${version}|` + files.map(file => { const s = fs.statSync(file); return `${file}:${s.size}:${s.mtimeMs}`; }).join('|');
  } catch (error) { if (error.code === 'ENOENT') throw new Error('trae_installation_unavailable'); throw error; }
  if (cachedProfile?.identity === identity) {
    if (Array.isArray(verifyWith) && verifyWith.length && cachedProfile.verification !== 'catalog') {
      if (!verifyProfileKey(cachedProfile, verifyWith)) throw new Error('trae_credential_key_unverified');
      cachedProfile.verification = 'catalog';
    }
    return cachedProfile;
  }
  const harness = inspect(files[0], HARNESS_MARKER, 84).toString('latin1');
  const legacy = inspect(files[1], SOURCE_MARKER, 94).toString('latin1');
  if (!HARNESS_PATTERN.test(harness) || !SOURCE_PATTERN.test(legacy)) throw new Error('trae_credential_profile_unknown');
  // Both DLLs embed the same 64-hex key prefix and split the remaining 20 hex
  // characters; a mismatch means the marker hit unrelated data.
  if (legacy.slice(0, 64) !== harness.slice(0, 64) || legacy.slice(74) !== harness.slice(64)) {
    throw new Error('trae_credential_profile_unknown');
  }
  const key = Buffer.from(harness.slice(0, 64), 'hex'), salt = Buffer.from(harness.slice(64), 'hex');
  for (let i = 0; i < 8; i++) key[i] ^= salt[i];
  salt.fill(0);
  const fingerprint = createHash('sha256').update(key).digest('hex').slice(0, 16);
  const profile = { identity, id: `trae-cn-${version}:${fingerprint}`, version, app, key,
    aad: Buffer.from(legacy.slice(64, 74)), verification: 'structure' };
  if (Array.isArray(verifyWith) && verifyWith.length) {
    if (!verifyProfileKey(profile, verifyWith)) throw new Error('trae_credential_key_unverified');
    profile.verification = 'catalog';
  }
  cachedProfile = profile;
  return profile;
}

export function readNativeCredentialProfile({ local, home, app, verifyWith } = {}) {
  if (app) {
    const version = JSON.parse(fs.readFileSync(path.join(app, 'product.json'), 'utf8')).appVersion;
    return materialProfile({ app, version, verifyWith });
  }
  const located = locateTraeApp({ local, home });
  return materialProfile({ app: located.app, version: located.version, verifyWith });
}

export function encodeCredential(value, profile = readNativeCredentialProfile(), nonce = randomBytes(12)) {
  if (typeof value !== 'string' || nonce.length !== 12) throw new Error('trae_credential_input_invalid');
  const cipher = createCipheriv('aes-256-gcm', profile.key, nonce);
  cipher.setAAD(profile.aad);
  return Buffer.concat([nonce, cipher.update(value, 'utf8'), cipher.final(), cipher.getAuthTag()]).toString('base64');
}

export function decodeCredential(value, profile = readNativeCredentialProfile()) {
  if (typeof value !== 'string' || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) throw new Error('trae_credential_invalid');
  const bytes = Buffer.from(value, 'base64');
  if (bytes.length < 28 || bytes.toString('base64') !== value) throw new Error('trae_credential_invalid');
  try {
    const decipher = createDecipheriv('aes-256-gcm', profile.key, bytes.subarray(0, 12));
    decipher.setAAD(profile.aad); decipher.setAuthTag(bytes.subarray(-16));
    return Buffer.concat([decipher.update(bytes.subarray(12, -16)), decipher.final()]).toString('utf8');
  } catch { throw new Error('trae_credential_invalid'); }
}

export function localCredential(file, { profile, verifyWith, app, local, home } = {}) {
  profile ||= readNativeCredentialProfile({ app, local, home, verifyWith });
  let stored;
  try { stored = JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch (error) { if (error.code !== 'ENOENT') throw new Error('trae_credential_cache_unreadable'); }
  if (stored?.version === 1 && stored.profile === profile.id) {
    try { if (decodeCredential(stored.ak, profile) === LOCAL_TOKEN) return stored.ak; }
    catch { /* An unreadable cache is regenerated, never trusted. */ }
  }
  const ak = encodeCredential(LOCAL_TOKEN, profile);
  if (decodeCredential(ak, profile) !== LOCAL_TOKEN) throw new Error('trae_credential_self_check_failed');
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.${randomUUID()}.tmp`;
  try {
    fs.writeFileSync(temporary, JSON.stringify({ version: 1, profile: profile.id, ak }, null, 2), { mode: 0o600, flag: 'wx' });
    fs.renameSync(temporary, file);
  } finally { fs.rmSync(temporary, { force: true }); }
  return ak;
}
