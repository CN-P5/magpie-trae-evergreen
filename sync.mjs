import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';
import { TraeAPI, readSession } from './trae-api.mjs';
import { localCredential } from './trae-local-token.mjs';
import { DEFAULT_PORT, configDir } from './identity.mjs';

const CREDENTIAL_FORMAT = 2; // Both AK and empty SK use native envelopes.

export function syncPaths(home = os.homedir()) {
  const directory = configDir(home);
  return { control: path.join(directory, 'connection.json'), state: path.join(directory, 'managed-models.json'), credential: path.join(directory, 'local-credential.json'),
    lock: path.join(directory, 'model-sync.lock'), status: path.join(directory, 'sync-status.json') };
}

function read(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch (e) { if (e.code === 'ENOENT') return fallback; throw new Error('sync_file_unreadable'); }
}
function write(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.${randomUUID()}.tmp`;
  try { fs.writeFileSync(temporary, JSON.stringify(value, null, 2), { mode: 0o600, flag: 'wx' }); fs.renameSync(temporary, file); }
  finally { fs.rmSync(temporary, { force: true }); }
}
function lock(file) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const key = randomUUID();
  const attempt = () => {
    try { fs.writeFileSync(file, JSON.stringify({ pid: process.pid, key }), { flag: 'wx', mode: 0o600 }); }
    catch (e) {
      if (e.code !== 'EEXIST') throw e;
      const current = read(file);
      if (!Number.isInteger(current?.pid) || current.pid <= 0) throw new Error('sync_lock_invalid');
      try { process.kill(current.pid, 0); throw new Error('sync_busy'); }
      catch (error) { if (error.code !== 'ESRCH') throw error; fs.unlinkSync(file); attempt(); }
    }
  };
  attempt();
  return () => { if (read(file)?.key === key) fs.unlinkSync(file); };
}

export function modelRequest(model, endpoint, ak) {
  if (typeof ak !== 'string' || !ak) throw new Error('trae_credential_required');
  const levels = [...new Set(model.efforts || [])].filter(v => typeof v === 'string' && v !== 'default');
  const params = { thinking_enable: levels.length ? 1 : 0 };
  if (model.context > 0) params.prompt_max_tokens = model.context;
  if (model.output > 0) params.max_tokens = model.output;
  if (levels.length) params.reasoning_param = { parameter: 'reasoning_effort', values: ['default', ...levels] };
  return { ak, provider: 'custom_openai_compatible', model_name: model.id,
    is_custom: true, auth_type: 0, region: '', sk: '', base_url: endpoint, custom_model_type: '',
    config_detail: { multimodal: !!model.images, model_hyper_params: params, max_turn: 500 },
    display_name: `${model.name || model.id} · Magpie`.slice(0, 64) };
}

function legacyFingerprint(entry) {
  return JSON.stringify({ model: entry.model, name: entry.name, baseURL: entry.baseURL, status: entry.status, detail: entry.detail });
}
function fingerprint(entry) {
  return JSON.stringify({ configuration: legacyFingerprint(entry),
    credential: createHash('sha256').update(String(entry.ak || '')).digest('hex') });
}
// JSON key order is not part of a value. The account endpoint has returned the
// same entry with a different key order between reads, which made an untouched
// model look hand-edited and stopped it from being managed.
function stable(value) {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stable(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}
function comparable(recorded) {
  const outer = JSON.parse(recorded);
  let configuration = outer.configuration;
  try { configuration = JSON.parse(configuration); } catch { /* already an object */ }
  return stable({ configuration, credential: outer.credential });
}
export function sameRecorded(entry, recorded) {
  if (!recorded) return false;
  const current = fingerprint(entry);
  if (recorded === current) return true;
  try { return comparable(recorded) === comparable(current); } catch { return false; }
}
// The credential is re-encoded with a fresh nonce whenever the plugin restarts,
// so its ciphertext legitimately differs from the recorded one. Only the
// configuration part says whether a human edited the entry in Trae.
export function sameConfiguration(entry, recorded) {
  if (!recorded) return false;
  try {
    const outer = JSON.parse(recorded);
    const configuration = typeof outer.configuration === 'string' ? JSON.parse(outer.configuration) : outer.configuration;
    return stable(configuration) === stable(JSON.parse(legacyFingerprint(entry)));
  } catch { return false; }
}
function matching(entry, request) {
  return entry.model === request.model_name && entry.provider === request.provider && entry.baseURL === request.base_url;
}
// Trae dedupes a model by (provider, model, base_url). The same display name on
// another loopback port is therefore a brand new model, and the picker ends up
// with two entries that look identical.
const LOOPBACK_BASE = /^https?:\/\/(?:127\.0\.0\.1|localhost):(\d+)(?:\/|$)/i;
export const MAGPIE_NAME_SUFFIX = /·\s*Magpie\s*$/;
export function loopbackPort(entry) {
  const match = LOOPBACK_BASE.exec(String(entry?.baseURL || ''));
  return match ? Number(match[1]) : null;
}
// Used only by the explicit cleanup command, never by an automatic sync: a
// listening bridge may belong to another adapter the user still wants.
async function bridgeAnswers(port, request = fetch) {
  try {
    const response = await request(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(800) });
    if (!response.ok) return false;
    const body = await response.json();
    return typeof body?.name === 'string' && body.name.length > 0;
  } catch { return false; }
}
function desiredMatches(entry, request, status = true) {
  return matching(entry, request) && entry.ak === request.ak && entry.name === request.display_name && entry.status === status &&
    isDeepStrictEqual(JSON.parse(JSON.stringify(entry.detail)), JSON.parse(JSON.stringify(request.config_detail)));
}
function updateBody(entry, request, status = true) {
  return { action: 'update', id: Number(entry.id), ...(entry.ak !== request.ak ? { ak: request.ak } : {}), provider: request.provider,
    model_name: request.model_name, status, auth_type: request.auth_type || 0,
    region: request.region || '', sk: request.sk || '', base_url: request.base_url,
    custom_model_type: request.custom_model_type || '', config_detail: request.config_detail,
    display_name: request.display_name };
}
function originalRequest(entry) {
  return { ak: entry.ak, provider: entry.provider, model_name: entry.model, base_url: entry.baseURL,
    auth_type: entry.config.auth_type || 0, sk: entry.config.sk || '', region: entry.config.region || '',
    custom_model_type: entry.config.custom_model_type || '', config_detail: entry.detail, display_name: entry.name };
}

// Only this plugin's endpoint and IDs are managed. The vendor remains the
// source of truth; nothing is injected into Trae's SQLite cache.
export async function syncModels({ paths = syncPaths(), apiFactory = () => new TraeAPI(readSession()), credentialFactory = localCredential, port = DEFAULT_PORT, writeDelayMs = 300 } = {}) {
  const unlock = lock(paths.lock);
  try {
    const control = read(paths.control, null);
    const connected = control?.version === 2 && typeof control.gatewayKey === 'string' && !!control.gatewayKey && Array.isArray(control.models);
    let state = read(paths.state, null);
    if (!connected && !state) return { state: 'disconnected', models: 0 };
    const api = await apiFactory();
    if (state && state.account !== api.session.account) throw new Error('trae_account_changed');
    let remote = await api.list();
    state ||= { version: 2, account: api.session.account, entries: {}, pending: null };
    if (![1, 2].includes(state.version)) throw new Error('sync_state_version_unknown');
    if (!state.pending) {
      for (const managed of Object.values(state.entries)) {
        const entry = remote.find(e => e.id === managed.id);
        if (entry && (sameRecorded(entry, managed.last) || managed.last === legacyFingerprint(entry))) { managed.last = fingerprint(entry); delete managed.ak; }
      }
      state.version = 2;
      write(paths.state, state);
    }
    const endpoint = `http://127.0.0.1:${port}/v1/chat/completions`;
    // Native ciphertext from the account catalog proves the extracted key still
    // matches this client build; without it the credential module can only
    // check the envelope layout.
    const samples = remote.map(entry => entry.ak).filter(value => typeof value === 'string' && value.length >= 28);
    const ak = connected ? await credentialFactory(paths.credential, { verifyWith: samples }) : undefined;
    const desired = connected ? control.models.map(m => modelRequest(m, endpoint, ak)) : [];
    const active = new Set(desired.map(r => r.model_name));
    const warnings = [];
    const save = () => write(paths.state, state);
    const refresh = async (verified = () => true) => {
      for (let attempt = 0; attempt < 6; attempt++) {
        remote = await api.list();
        if (verified(remote)) return;
        if (attempt < 5) await delay(200);
      }
    };
    const remove = async (model, entry) => {
      state.pending = { kind: 'delete', model, before: entry }; save();
      await api.call('update_custom_model', { action: 'delete', id: Number(entry.id) });
      await refresh(list => !list.some(e => e.id === entry.id));
      if (remote.some(e => e.id === entry.id)) throw new Error('trae_model_delete_unverified');
      delete state.entries[model]; state.pending = null; save();
    };

    // Recover a response lost after a successful create using its exact tuple.
    if (state.pending?.kind === 'add') {
      const pending = state.pending;
      const found = remote.filter(e => matching(e, pending.request) && e.name === pending.request.display_name);
      if (found.length > 1) throw new Error('ambiguous_managed_model');
      if (found.length) state.entries[pending.model] = { id: found[0].id, created: true, last: fingerprint(found[0]), credentialFormat: pending.credentialFormat };
      state.pending = null; save();
    }
    if (state.pending?.kind === 'update') {
      const pending = state.pending;
      const entry = remote.find(e => e.id === String(pending.body.id));
      if (!entry) throw new Error('trae_pending_model_missing');
      const expected = pending.body;
      const expectedAK = expected.ak ?? pending.before.ak;
      const target = { ...expected, ak: expectedAK };
      const applied = desiredMatches(entry, target, expected.status);
      if (!applied && fingerprint(entry) !== fingerprint(pending.before)) throw new Error('trae_pending_model_edited');
      // SK is not returned by the catalog. Replay a lost format-repair response
      // even when the visible metadata already matches; the write is idempotent.
      if (!applied || pending.credentialFormat === CREDENTIAL_FORMAT) { await api.call('update_custom_model', expected); await refresh(list => list.some(e => e.id === entry.id && desiredMatches(e, target, expected.status))); }
      const current = remote.find(e => e.id === entry.id);
      if (!current || !desiredMatches(current, target, expected.status)) throw new Error('trae_model_update_unverified');
      if (state.entries[pending.model]) {
        state.entries[pending.model].last = fingerprint(current);
        if (pending.credentialFormat) state.entries[pending.model].credentialFormat = pending.credentialFormat;
      }
      if (pending.release) delete state.entries[pending.model];
      state.pending = null; save();
    }
    if (state.pending?.kind === 'delete') {
      const pending = state.pending;
      const entry = remote.find(e => e.id === pending.before.id);
      if (entry) {
        if (fingerprint(entry) !== fingerprint(pending.before)) throw new Error('trae_pending_model_edited');
        await remove(pending.model, entry);
      } else {
        delete state.entries[pending.model]; state.pending = null; save();
      }
    }

    // A full catalog can be dozens of models. Space the writes: a burst of
    // adds from one device is what the account endpoint rate-limits first.
    let writes = 0;
    const throttle = async () => { if (writes++ > 0 && writeDelayMs > 0) await delay(writeDelayMs); };
    for (const request of desired) {
      let managed = state.entries[request.model_name];
      let entry = managed && remote.find(e => e.id === managed.id);
      if (!managed) {
        const same = remote.filter(e => matching(e, request));
        if (same.length > 1) throw new Error('ambiguous_model_configuration');
        entry = same[0];
        if (entry) {
          // This includes the local entries made during development; all are
          // journaled before adopting so disconnect puts them back exactly.
          managed = { id: entry.id, created: false, before: entry, last: fingerprint(entry) };
          state.entries[request.model_name] = managed; save();
        } else {
          // Never create a second entry that would look identical in the
          // picker: a bridge entry carrying this name is either an orphan of a
          // previous install or another running adapter. Both need the user's
          // decision, so report instead of duplicating.
          const twin = remote.find(e => e.name === request.display_name && loopbackPort(e) !== null);
          if (twin) {
            warnings.push({ model: request.model_name, code: 'duplicate_display_name' });
            continue;
          }
          state.pending = { kind: 'add', model: request.model_name, request, credentialFormat: CREDENTIAL_FORMAT }; save();
          await throttle();
          await api.call('add_custom_model', request); await refresh(list => list.some(e => matching(e, request) && e.name === request.display_name));
          entry = remote.find(e => matching(e, request) && e.name === request.display_name);
          if (!entry) throw new Error('trae_model_create_unverified');
          managed = { id: entry.id, created: true, ak: request.ak, last: fingerprint(entry), credentialFormat: CREDENTIAL_FORMAT };
          state.entries[request.model_name] = managed; state.pending = null; save();
        }
      }
      if (!entry) { warnings.push({ model: request.model_name, code: 'managed_model_removed_in_trae' }); continue; }
      if (managed.last && !sameConfiguration(entry, managed.last)) { warnings.push({ model: request.model_name, code: 'model_edited_in_trae' }); continue; }
      // The plugin re-encodes its own marker on restart, so a different cipher
      // is only a manual edit when it is neither ours now nor the one we wrote.
      if (entry.ak && entry.ak !== request.ak && managed.ak && entry.ak !== managed.ak) {
        warnings.push({ model: request.model_name, code: 'model_edited_in_trae' }); continue;
      }
      if (managed.last !== fingerprint(entry)) { managed.last = fingerprint(entry); save(); }
      if (!desiredMatches(entry, request) || managed.credentialFormat !== CREDENTIAL_FORMAT) {
        const body = updateBody(entry, request);
        state.pending = { kind: 'update', model: request.model_name, before: entry, body, credentialFormat: CREDENTIAL_FORMAT }; save();
        await throttle();
        await api.call('update_custom_model', body); await refresh(list => list.some(e => e.id === managed.id && desiredMatches(e, request)));
        entry = remote.find(e => e.id === managed.id);
        if (!entry || !desiredMatches(entry, request)) throw new Error('trae_model_update_unverified');
        managed.last = fingerprint(entry); managed.ak = request.ak; managed.credentialFormat = CREDENTIAL_FORMAT; state.pending = null; save();
      }
    }

    // Release only journaled entries: delete our additions, restore adoptions.
    // The same rule applies to catalog removal and full disconnection.
    for (const [model, managed] of Object.entries(state.entries)) {
      if (active.has(model)) continue;
      const entry = remote.find(e => e.id === managed.id);
      if (!entry) { delete state.entries[model]; save(); continue; }
      if (managed.last && !sameConfiguration(entry, managed.last)) { warnings.push({ model, code: 'model_edited_in_trae' }); continue; }
      if (managed.last !== fingerprint(entry)) { managed.last = fingerprint(entry); save(); }
      if (managed.created) { await remove(model, entry); continue; }
      const request = originalRequest(managed.before), status = managed.before.status;
      if (!desiredMatches(entry, request, status)) {
        const body = updateBody(entry, request, status);
        state.pending = { kind: 'update', model, before: entry, body, release: true }; save();
        await api.call('update_custom_model', body); await refresh(list => list.some(e => e.id === managed.id && desiredMatches(e, request, status)));
        const after = remote.find(e => e.id === managed.id);
        if (!after || !desiredMatches(after, request, status)) throw new Error('trae_model_restore_unverified');
      }
      delete state.entries[model]; state.pending = null; save();
    }
    // A credential-free revision lets the open client invalidate its own cache.
    const revision = createHash('sha256').update(JSON.stringify(remote.map(e => [e.id, fingerprint(e)]).sort())).digest('hex');
    const result = { state: connected ? 'synced' : 'disconnected', models: desired.length, warnings, revision, updatedAt: new Date().toISOString() };
    write(paths.status, result);
    return result;
  } finally { unlock(); }
}

export function startModelSync(options = {}) {
  let busy = null, stopped = false, last = '', previous = '', checked = 0;
  const tick = () => {
    if (stopped || busy) return busy;
    const paths = options.paths || syncPaths();
    let content;
    try { content = fs.readFileSync(paths.control, 'utf8'); } catch { content = ''; }
    if (content === previous && Date.now() - checked < 60000) return;
    checked = Date.now();
    busy = syncModels(options).then(() => { last = ''; previous = content; }).catch(e => {
      if (e.message === 'sync_busy') return;
      const code = /^[a-z_0-9]+$/.test(e.message) ? e.message : 'trae_sync_failed';
      if (code !== last) { console.error(`Trae model sync: ${code}`); last = code; }
      try { write(paths.status, { state: 'pending', code, updatedAt: new Date().toISOString() }); } catch { /* Leave recoverable state alone. */ }
    }).finally(() => { busy = null; });
  };
  const ready = tick();
  const timer = setInterval(tick, options.interval ?? 5000); timer.unref?.();
  return { ready, stop: async () => { stopped = true; clearInterval(timer); await busy; } };
}

// An install that was replaced or renamed leaves its entries behind under a
// bridge port nobody listens on any more. Those entries are absent from the
// journal, so no disconnect will ever collect them, and Trae keeps showing them
// next to the current ones. Removal is opt-in and only touches entries whose
// bridge does not answer.
export async function reclaimStaleEntries({ paths = syncPaths(), apiFactory = () => new TraeAPI(readSession()),
  port = DEFAULT_PORT, apply = false, request = fetch, writeDelayMs = 300 } = {}) {
  const state = read(paths.state, null);
  const api = await apiFactory();
  let remote = await api.list();
  const owned = new Set(Object.values(state?.entries || {}).map(managed => String(managed.id)));
  // A model that is still selected is never cleanup material: sync either adopts
  // it or reports it. Only leftovers of a previous selection are removable.
  const control = read(paths.control, null);
  const endpoint = `http://127.0.0.1:${port}/v1/chat/completions`;
  const selected = new Set((control?.models || [])
    .map(model => `${typeof model.id === 'string' ? model.id.trim() : ''}@${endpoint}`));
  const candidates = remote.filter(entry => MAGPIE_NAME_SUFFIX.test(entry.name || '') &&
    loopbackPort(entry) !== null && !owned.has(String(entry.id)) &&
    !selected.has(`${entry.model}@${entry.baseURL}`));
  const stale = [];
  for (const entry of candidates) {
    const at = loopbackPort(entry);
    // A live port only proves that *something* answers, not that this entry is
    // owned. An unowned entry on our own port is a leftover of an earlier run
    // of this adapter: if it is still selected, the next sync recreates it with
    // a journal record. A foreign port is only removed when nothing answers.
    const reachable = at === port ? true : await bridgeAnswers(at, request);
    const removable = !reachable || at === port;
    let removed = false;
    if (apply && removable) {
      await api.call('update_custom_model', { action: 'delete', id: Number(entry.id) });
      removed = true;
      if (writeDelayMs > 0) await delay(writeDelayMs);
    }
    stale.push({ id: entry.id, name: entry.name, baseURL: entry.baseURL, reachable, removable, removed });
  }
  if (apply && stale.some(item => item.removed)) remote = await api.list();
  return { currentPort: port, checked: remote.length, stale, removed: stale.filter(item => item.removed).length };
}
