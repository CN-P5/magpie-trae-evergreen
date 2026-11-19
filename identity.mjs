import os from 'node:os';
import path from 'node:path';

// One source of truth for every runtime name this adapter owns.
//
// Two adapters for the same client must never share a config directory, a
// bridge port or an agent ID. Magpie writes one control file per agent, and a
// shared recovery journal would let one adapter delete or restore the other's
// models. Keeping these names here means a future rename touches one file.
export const PLUGIN_ID = 'magpie-trae-evergreen';
export const AGENT_ID = 'trae-cn-evergreen';
export const AGENT_NAME = 'Trae CN · Evergreen';
export const DEFAULT_PORT = 3499;

export const configDir = (home = os.homedir()) => path.join(home, '.config', PLUGIN_ID);
export const connectionPath = (home = os.homedir()) => path.join(configDir(home), 'connection.json');
export const clientBackups = (home = os.homedir()) => path.join(configDir(home), 'client-backups');
