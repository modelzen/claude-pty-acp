// Fix a recurring node-pty packaging gotcha: on some npm installs the prebuilt
// `spawn-helper` binary loses its executable bit, which makes pty.spawn() fail
// with "posix_spawnp failed". Re-apply +x for the current platform prebuild.
import { chmodSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const prebuilds = join(root, 'node_modules', 'node-pty', 'prebuilds');
const plat = `${process.platform}-${process.arch}`;
const helper = join(prebuilds, plat, 'spawn-helper');

try {
  if (existsSync(helper)) {
    chmodSync(helper, 0o755);
    console.error(`[cc-server postinstall] chmod +x ${helper}`);
  }
} catch (e) {
  console.error('[cc-server postinstall] could not fix spawn-helper:', e?.message);
}
