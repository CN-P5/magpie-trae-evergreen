// A short-lived worker can finish network restoration after a shared host exits.
import fs from 'node:fs';
import { syncModels, syncPaths } from './sync.mjs';
import { DEFAULT_PORT } from './identity.mjs';
const port = Number(process.argv[2] || DEFAULT_PORT);
try {
  const paths = syncPaths();
  let control;
  try { control = JSON.parse(fs.readFileSync(paths.control, 'utf8')); }
  catch (e) { if (e.code !== 'ENOENT') process.exit(0); }
  if (!control?.gatewayKey && fs.existsSync(paths.state)) await syncModels({ port });
}
catch { /* Pending journal is retried when the plugin starts again. */ }
