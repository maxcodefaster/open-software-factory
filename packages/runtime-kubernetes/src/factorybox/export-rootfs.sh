set -eu
umask 077
test -n "$FACTORY_POD_UID"
test -n "$FACTORY_STORE_ID"
test -n "$FACTORY_RUNTIME_IMAGE"
test ! -e /factory-seed/intent
test ! -e /factory-seed/rootfs.tar
printf '%s\n%s\n%s\n' "$FACTORY_POD_UID" "$FACTORY_STORE_ID" "$FACTORY_RUNTIME_IMAGE" > /factory-seed/intent
sync /factory-seed/intent
# A replacement worker on the same retained store may reuse an earlier admission's
# export of this exact image. The source must carry the identity receipt that
# Factory preparation wrote after hashing it. This program hashes the copy again,
# so no unverified byte is trusted. Any refusal falls back to a fresh export.
reused=0
if [ -d /factory-seeds ] && node --input-type=module - <<'FACTORY_REUSE'
import { createHash } from 'node:crypto';
import {
  closeSync, constants, copyFileSync, fdatasyncSync, fstatSync, lstatSync, openSync,
  readFileSync, readSync, readdirSync, renameSync, rmSync, writeFileSync,
} from 'node:fs';
const store = process.env.FACTORY_STORE_ID;
const image = process.env.FACTORY_RUNTIME_IMAGE;
const own = process.env.FACTORY_SEED_NAMESPACE ?? '';
const ownerID = process.getuid();
const regularPrivate = (info) =>
  info.isFile() && info.uid === BigInt(ownerID) && (info.mode & 0o777n) === 0o600n && info.nlink === 1n;
const sameFile = (left, right) => ['dev', 'ino', 'size', 'mtimeNs', 'ctimeNs']
  .every((key) => left[key] === right[key]);
// Python wrote the receipt with exact 64-bit nanosecond integers. JSON.parse
// would round them, so read only this exact shape as BigInt.
function receiptFile(text) {
  const match = /^\{"version":1,"sha256":"([a-f0-9]{64})","file":\{"device":(\d+),"inode":(\d+),"bytes":(\d+),"mtimeNS":(\d+),"ctimeNS":(\d+)\}\}\n?$/.exec(text);
  if (!match) return null;
  const [, sha256, dev, ino, size, mtimeNs, ctimeNs] = match;
  return { sha256, file: { dev: BigInt(dev), ino: BigInt(ino), size: BigInt(size),
    mtimeNs: BigInt(mtimeNs), ctimeNs: BigInt(ctimeNs) } };
}
function candidate(name) {
  if (!/^[a-f0-9]{32}$/.test(name) || name === own) return null;
  const seed = `/factory-seeds/${name}/bootstrap`;
  try {
    const intent = readFileSync(`${seed}/intent`, 'utf8').split('\n');
    const checksum = readFileSync(`${seed}/rootfs.sha256`, 'utf8').trim().split(/\s+/);
    const receipt = receiptFile(readFileSync(`${seed}/rootfs.verified.json`, 'utf8'));
    const entries = readdirSync(seed);
    if (entries.includes('archive-retirement.json') || entries.includes('archive-retired.json')) return null;
    const archive = lstatSync(`${seed}/rootfs.tar`, { bigint: true });
    const receiptInfo = lstatSync(`${seed}/rootfs.verified.json`, { bigint: true });
    if (intent[1] !== store || intent[2] !== image || checksum.length !== 2 ||
        checksum[1] !== 'rootfs.tar' || !/^[a-f0-9]{64}$/.test(checksum[0]) || !receipt ||
        receipt.sha256 !== checksum[0] || !regularPrivate(archive) || !regularPrivate(receiptInfo) ||
        !sameFile(archive, receipt.file)) return null;
    return { seed, sha256: checksum[0], archive, time: receiptInfo.mtimeNs };
  } catch {
    return null;
  }
}
const sources = readdirSync('/factory-seeds').map(candidate).filter(Boolean)
  .sort((a, b) => (a.time < b.time ? 1 : -1));
if (sources.length === 0) process.exit(1);
const source = sources[0];
const partial = '/factory-seed/rootfs.partial';
try {
  copyFileSync(`${source.seed}/rootfs.tar`, partial, constants.COPYFILE_EXCL | constants.COPYFILE_FICLONE);
  const descriptor = openSync(partial, 'r+');
  try {
    fdatasyncSync(descriptor);
    const hash = createHash('sha256');
    const block = Buffer.allocUnsafe(1024 * 1024);
    for (let count = readSync(descriptor, block, 0, block.length, null); count > 0;
         count = readSync(descriptor, block, 0, block.length, null)) hash.update(block.subarray(0, count));
    if (hash.digest('hex') !== source.sha256 || BigInt(fstatSync(descriptor).size) !== source.archive.size)
      throw new Error('Reused export differs from its verified checksum');
  } finally {
    closeSync(descriptor);
  }
  if (!sameFile(lstatSync(`${source.seed}/rootfs.tar`, { bigint: true }), source.archive))
    throw new Error('Reused export source changed while it was copied');
  renameSync(partial, '/factory-seed/rootfs.tar');
  writeFileSync('/factory-seed/rootfs.sha256', `${source.sha256}  rootfs.tar\n`, { mode: 0o600, flag: 'wx' });
  const final = lstatSync('/factory-seed/rootfs.tar', { bigint: true });
  const receipt = `{"version":1,"sha256":"${source.sha256}","file":{"device":${final.dev},"inode":${final.ino},` +
    `"bytes":${final.size},"mtimeNS":${final.mtimeNs},"ctimeNS":${final.ctimeNs}}}\n`;
  writeFileSync('/factory-seed/rootfs.verified.json', receipt, { mode: 0o600, flag: 'wx' });
  console.log(`reused verified export of ${image} from admission ${source.seed.split('/')[2]}`);
} catch (error) {
  console.error(`Export reuse refused: ${error.message}`);
  rmSync(partial, { force: true });
  rmSync('/factory-seed/rootfs.sha256', { force: true });
  process.exit(1);
}
FACTORY_REUSE
then
  reused=1
fi
if [ "$reused" = 0 ]; then
# This runs in the exact consumer image before the worker starts. Project
# source, assignment credentials and host files are never mounted here.
# The pinned Runtime Host has Node and BusyBox tar. Bound dirty output pages
# rather than waiting for the node-wide writeback threshold to fill this cgroup.
checksum=$(node --input-type=module - <<'FACTORY_EXPORT'
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { openSync, writeSync, fdatasyncSync, closeSync } from 'node:fs';
import { Writable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
const descriptor = openSync('/factory-seed/rootfs.partial', 'wx', 0o600);
const archive = spawn('tar', [
  '-C', '/', '-cpf', '-',
  '--exclude=./proc', '--exclude=./sys', '--exclude=./dev', '--exclude=./factory-seed',
  '--exclude=./factory-seeds',
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
const hash = createHash('sha256');
const output = new Writable({
  write(chunk, _encoding, done) {
    try {
      hash.update(chunk);
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
  process.stdout.write(`${hash.digest('hex')}\n`);
} catch (error) {
  archive.kill('SIGTERM');
  await ended.catch(() => {});
  throw error;
} finally {
  closeSync(descriptor);
}
FACTORY_EXPORT
)
printf '%s  rootfs.tar\n' "$checksum" > /factory-seed/rootfs.sha256
sync /factory-seed/rootfs.partial
mv /factory-seed/rootfs.partial /factory-seed/rootfs.tar
fi
cd /factory-seed
sync rootfs.sha256
sync .
