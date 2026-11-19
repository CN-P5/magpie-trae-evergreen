import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { locateTraeApp } from './trae-install.mjs';
import { clientBackups } from './identity.mjs';

// The loader is the only change made to the client: two appended lines at the
// very end of the Electron main bundle. Nothing before them is rewritten.
export const LOADER = '\n// Magpie model catalog refresh (reversible, Trae CN 3.4.18).\nimport("./magpie-model-refresh.cjs").then(m=>m.default.startNotifier()).catch(()=>{});\n';
export const loaderFor = version => LOADER.replace('3.4.18', version);
// The 3.4.18 payload hash is kept for reference; matching is no longer limited
// to a build list. Every install pins the exact bytes it patched in the
// manifest, and a changed client is refused instead of silently re-patched.
export const MAIN_SHA256 = '6540f065068c73e9a76f63c92283abedab234d69ea0779996ff7098e4b21bf2a';
const LOADER_PATTERN = /\n\/\/ Magpie model catalog refresh \(reversible, Trae CN [^)]+\)\.\nimport\("\.\/magpie-model-refresh\.cjs"\)[^\n]*\n$/;
const sha = value => createHash('sha256').update(value).digest('hex');

function atomicWrite(file, content) {
  const temporary = `${file}.${randomUUID()}.tmp`;
  try { fs.writeFileSync(temporary, content, { flag: 'wx' }); fs.renameSync(temporary, file); }
  finally { fs.rmSync(temporary, { force: true }); }
}

// A real Electron main bundle is large and ends with a source map reference.
// This shape check refuses an obviously foreign file when there is no earlier
// backup to compare against.
export function looksLikeMainBundle(text) {
  return typeof text === 'string' && text.length > 64 * 1024 &&
    /\/\/# sourceMappingURL=/.test(text.slice(-4096)) &&
    /BrowserWindow|app\.whenReady|createWindow/.test(text);
}

export function installClientRefresh({ local = process.env.LOCALAPPDATA, home = os.homedir(),
  app, expectedHash, restore = false, force = false } = {}) {
  const root = app || locateTraeApp({ local, home }).app;
  const product = JSON.parse(fs.readFileSync(path.join(root, 'product.json'), 'utf8'));
  const version = product.appVersion;
  if (typeof version !== 'string' || !version) throw new Error('trae_client_refresh_build_unsupported');
  const main = path.join(root, 'out/main.js'), helper = path.join(root, 'out/magpie-model-refresh.cjs');
  const current = fs.readFileSync(main, 'utf8');
  const original = LOADER_PATTERN.test(current) ? current.replace(LOADER_PATTERN, '') : current;

  const directory = path.join(clientBackups(home), version);
  fs.mkdirSync(directory, { recursive: true });
  const backup = path.join(directory, 'main.original.js');
  let recorded;
  if (fs.existsSync(backup)) {
    recorded = fs.readFileSync(backup, 'utf8');
    if (recorded !== original) {
      const rebased = (expectedHash && sha(original) === expectedHash) || force;
      if (!rebased) throw new Error('trae_client_refresh_build_unsupported');
      atomicWrite(backup, original);
      recorded = original;
    }
  } else {
    const accepted = expectedHash ? sha(original) === expectedHash : looksLikeMainBundle(original);
    if (!accepted && !force) throw new Error('trae_client_refresh_build_unsupported');
    fs.writeFileSync(backup, original, { flag: 'wx' });
    recorded = original;
  }
  if (!restore) {
    const content = fs.readFileSync(new URL('./trae-refresh-notifier.cjs', import.meta.url));
    if (!fs.existsSync(helper) || sha(fs.readFileSync(helper)) !== sha(content)) atomicWrite(helper, content);
  }
  const wanted = restore ? recorded : recorded + loaderFor(version);
  if (current !== wanted) atomicWrite(main, wanted);
  if (restore) fs.rmSync(helper, { force: true });
  const result = { state: restore ? 'restored' : 'installed', version, changed: current !== wanted,
    patched: !restore, backup, originalSha256: sha(recorded), updatedAt: new Date().toISOString() };
  fs.writeFileSync(path.join(directory, 'manifest.json'), JSON.stringify(result, null, 2));
  return result;
}
