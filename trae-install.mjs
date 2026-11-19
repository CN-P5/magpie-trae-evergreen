import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

// Trae CN installs wherever the user points the installer. Never assume
// %LOCALAPPDATA%\Programs: the client is commonly placed on another drive.
// Resolution order: explicit override, registry, conventional paths, then the
// client's own startup logs, which record the resources directory verbatim.
const APP_NAMES = ['Trae CN', 'Trae'];
let cachedLocation;

function productAt(app) {
  if (typeof app !== 'string' || !app) return null;
  try {
    const product = JSON.parse(fs.readFileSync(path.join(app, 'product.json'), 'utf8'));
    if (typeof product.appVersion !== 'string' || !product.appVersion) return null;
    return { app, version: product.appVersion, product };
  } catch { return null; }
}

function candidateRoots({ local, home, env }) {
  const roots = [];
  const push = value => { if (typeof value === 'string' && value && !roots.includes(value)) roots.push(value); };
  if (env?.TRAE_APP) push(env.TRAE_APP);
  if (env?.TRAE_HOME) push(path.join(env.TRAE_HOME, 'resources/app'));
  const localApps = [local, path.join(home, 'AppData/Local')].filter(Boolean);
  for (const base of localApps) for (const name of APP_NAMES) push(path.join(base, 'Programs', name, 'resources/app'));
  for (const base of [env?.ProgramFiles, env?.['ProgramFiles(x86)'], 'C:/Program Files', 'C:/Program Files (x86)']) {
    for (const name of APP_NAMES) push(path.join(base, name, 'resources/app'));
  }
  for (const drive of ['C:', 'D:', 'E:', 'F:']) for (const name of APP_NAMES) push(`${drive}/${name}/resources/app`);
  if (process.platform === 'darwin') push('/Applications/Trae CN.app/Contents/Resources/app');
  return roots;
}

// reg.exe can be unavailable (locked-down or sandboxed shells); resolution
// continues with the remaining sources instead of failing.
function fromRegistry(env) {
  if (process.platform !== 'win32') return [];
  const keys = [];
  for (const hive of ['HKCU', 'HKLM']) {
    for (const name of APP_NAMES) {
      keys.push(`${hive}\\Software\\Microsoft\\Windows\\CurrentVersion\\App Paths\\${name}.exe`);
      keys.push(`${hive}\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\${name}`);
    }
  }
  const found = [];
  for (const key of keys) {
    let output;
    try {
      output = execFileSync('reg', ['query', key, '/ve'], { encoding: 'utf8', windowsHide: true, timeout: 4000, stdio: ['ignore', 'pipe', 'ignore'] });
    } catch { continue; }
    for (const line of output.split(/\r?\n/)) {
      const at = line.indexOf('REG_SZ');
      if (at < 0) continue;
      let value = line.slice(at + 6).trim().replace(/^"|"$/g, '');
      if (!value) continue;
      if (/\.exe$/i.test(value)) value = path.dirname(value);
      found.push(path.join(value, 'resources/app'));
    }
  }
  return found;
}

// A crashed or upgraded client still leaves its resources path in these logs.
function fromClientLogs({ home, env }) {
  if (process.platform !== 'win32') return [];
  const roaming = env?.APPDATA || path.join(home, 'AppData/Roaming');
  const root = path.join(roaming, 'Trae CN', 'logs');
  let directories;
  try {
    directories = fs.readdirSync(root, { withFileTypes: true })
      .filter(entry => entry.isDirectory() && /^\d{8}T\d{6}$/.test(entry.name))
      .map(entry => ({ name: entry.name, at: fs.statSync(path.join(root, entry.name)).mtimeMs }))
      .sort((a, b) => b.at - a.at).slice(0, 3).map(entry => path.join(root, entry.name));
  } catch { return []; }
  const pattern = /([A-Za-z]:[\\/][^"'\r\n<>|]{0,120}?[\\/]resources[\\/]app)/gi;
  const found = [];
  const walk = (directory, depth) => {
    let entries;
    try { entries = fs.readdirSync(directory, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      const file = path.join(directory, entry.name);
      if (entry.isDirectory()) { if (depth > 0) walk(file, depth - 1); continue; }
      if (!entry.isFile() || !/\.log$/i.test(entry.name)) continue;
      let text;
      try { if (fs.statSync(file).size > 8 * 1024 * 1024) continue; text = fs.readFileSync(file, 'utf8'); } catch { continue; }
      for (const match of text.matchAll(pattern)) found.push(match[1].replace(/[\\/]+/g, path.sep));
    }
  };
  for (const directory of directories) walk(directory, 2);
  return found;
}

export function readProduct(app) {
  const located = productAt(app);
  if (!located) throw new Error('trae_installation_unavailable');
  return located;
}

export function locateTraeApp({ local = process.env.LOCALAPPDATA, home = os.homedir(), env = process.env, sources } = {}) {
  if (cachedLocation && productAt(cachedLocation.app)?.version === cachedLocation.version) return cachedLocation;
  const groups = sources || [
    () => candidateRoots({ local, home, env }),
    () => fromClientLogs({ home, env }),
    () => fromRegistry(env),
  ];
  const tried = [];
  for (const group of groups) {
    for (const app of group()) {
      if (tried.includes(app)) continue;
      tried.push(app);
      const located = productAt(app);
      if (located) { cachedLocation = { ...located, sources: tried.length }; return cachedLocation; }
    }
  }
  const error = new Error('trae_installation_unavailable');
  error.tried = tried.slice(0, 12);
  throw error;
}

export function resetTraeLocationCache() { cachedLocation = undefined; }
