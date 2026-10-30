set -eu
umask 077
test -n "$FACTORY_POD_UID"
test -n "$FACTORY_STORE_ID"
test -n "$FACTORY_RUNTIME_IMAGE"
test ! -e /factory-seed/intent
test ! -e /factory-seed/rootfs.tar
printf '%s\n%s\n%s\n' "$FACTORY_POD_UID" "$FACTORY_STORE_ID" "$FACTORY_RUNTIME_IMAGE" > /factory-seed/intent
sync /factory-seed/intent
# This runs in the exact consumer image before the worker starts. Project
# source, assignment credentials and host files are never mounted here.
# The pinned Runtime Host has Node and BusyBox tar. Bound dirty output pages
# rather than waiting for the node-wide writeback threshold to fill this cgroup.
node --input-type=module - <<'FACTORY_EXPORT'
import { spawn } from 'node:child_process';
import { openSync, writeSync, fdatasyncSync, closeSync } from 'node:fs';
import { Writable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
const descriptor = openSync('/factory-seed/rootfs.partial', 'wx', 0o600);
const archive = spawn('tar', [
  '-C', '/', '-cpf', '-',
  '--exclude=./proc', '--exclude=./sys', '--exclude=./dev', '--exclude=./factory-seed',
  '--exclude=./var/run/secrets', '--exclude=./etc/hosts', '--exclude=./etc/hostname',
  '--exclude=./etc/resolv.conf', '.',
], { stdio: ['ignore', 'pipe', 'inherit'] });
const ended = new Promise((resolve, reject) => {
  archive.once('error', reject);
  archive.once('close', (code, signal) => code === 0
    ? resolve()
    : reject(new Error(`Runtime archive failed: ${signal ?? code}`)));
});
let dirty = 0;
const output = new Writable({
  write(chunk, _encoding, done) {
    try {
      let offset = 0;
      while (offset < chunk.length) {
        const written = writeSync(descriptor, chunk, offset, chunk.length - offset);
        if (written === 0) throw new Error('Runtime archive write made no progress');
        offset += written;
        dirty += written;
      }
      if (dirty >= 8 * 1024 * 1024) {
        fdatasyncSync(descriptor);
        dirty = 0;
      }
      done();
    } catch (error) {
      done(error);
    }
  },
});
try {
  await Promise.all([pipeline(archive.stdout, output), ended]);
  fdatasyncSync(descriptor);
} catch (error) {
  archive.kill('SIGTERM');
  await ended.catch(() => {});
  throw error;
} finally {
  closeSync(descriptor);
}
FACTORY_EXPORT
sync /factory-seed/rootfs.partial
mv /factory-seed/rootfs.partial /factory-seed/rootfs.tar
cd /factory-seed
sha256sum rootfs.tar > rootfs.sha256
sync rootfs.sha256
sync .
