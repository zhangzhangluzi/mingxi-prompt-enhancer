import { createCipheriv, createDecipheriv, createHash, randomBytes, randomUUID } from 'node:crypto';
import { lstat, mkdir, open, readdir, readFile, rename, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { assertStoreCapacity, StoreError } from './storage.mjs';

const kinds = ['auth', 'guides', 'history', 'model'];
const manifestName = 'state.enc';
const legacyFile = kind => kind + '.enc';
const managedFile = /^(auth|guides|history|model)-[a-f0-9]{32}\.enc$/;
const hashPattern = /^[a-f0-9]{32}:[a-f0-9]{128}$/;
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const unavailable = () => new StoreError(503, '数据存储需要本机管理员检查，已暂停访问。');
const signature = info => [info.dev, info.ino, info.size, info.mtimeNs, info.ctimeNs].join(':');

function keyBytes(hex) {
  if (!/^[a-f0-9]{64}$/.test(hex || '')) throw unavailable();
  return Buffer.from(hex, 'hex');
}
function encrypt(value, key) {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const body = Buffer.concat([cipher.update(JSON.stringify(value), 'utf8'), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), body]);
}
function decrypt(bytes, key) {
  const decipher = createDecipheriv('aes-256-gcm', key, bytes.subarray(0, 12));
  decipher.setAuthTag(bytes.subarray(12, 28));
  return JSON.parse(Buffer.concat([decipher.update(bytes.subarray(28)), decipher.final()]).toString('utf8'));
}
function checkValue(kind, value) {
  if (kind === 'auth') {
    if (value?.version !== 1 || !hashPattern.test(value.passwordHash || '')) throw unavailable();
    return;
  }
  if (!Array.isArray(value) || value.length > 100 || value.some(item => !item || typeof item.id !== 'string') ||
      new Set(value.map(item => item.id)).size !== value.length || (kind === 'model' && !value.length)) throw unavailable();
  assertStoreCapacity(kind, value);
}
async function syncDir(directory) {
  const handle = await open(directory, 'r');
  try { await handle.sync(); } finally { await handle.close(); }
}
async function readStateFile(directory, name) {
  const path = join(directory, name);
  const before = await lstat(path, { bigint: true });
  if (!before.isFile() || before.size > 16n * 1024n * 1024n) throw unavailable();
  const bytes = await readFile(path);
  const after = await lstat(path, { bigint: true });
  if (signature(before) !== signature(after)) throw unavailable();
  return { bytes, signature: signature(after), digest: digest(bytes) };
}
async function durableWrite(path, bytes) {
  const handle = await open(path, 'wx', 0o600);
  try { await handle.writeFile(bytes); await handle.sync(); } finally { await handle.close(); }
}
async function publishManifest(directory, manifest, key, beforeCommit = async () => {}) {
  const temp = join(directory, 'state-' + randomBytes(16).toString('hex') + '.tmp');
  try {
    await durableWrite(temp, encrypt(manifest, key));
    await syncDir(directory);
    await beforeCommit();
    await rename(temp, join(directory, manifestName));
    await syncDir(directory);
  } finally {
    await unlink(temp).catch(() => {});
  }
}
function entry(name, bytes) {
  return { file: name, digest: digest(bytes), generation: randomUUID() };
}
async function collectLegacy(directory, key) {
  const entries = {};
  for (const kind of kinds) {
    const file = legacyFile(kind);
    const { bytes } = await readStateFile(directory, file);
    checkValue(kind, decrypt(bytes, key));
    entries[kind] = entry(file, bytes);
  }
  return entries;
}
export async function provisionState(directory, keyHex, initial) {
  const key = keyBytes(keyHex);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const names = await readdir(directory);
  if (names.includes(manifestName)) {
    if (initial) throw new StoreError(409, '实例已初始化。');
    return openState(directory, keyHex);
  }
  if (names.some(name => managedFile.test(name))) throw unavailable();
  if (initial && names.some(name => kinds.some(kind => name === legacyFile(kind)))) {
    throw new StoreError(409, '发现旧数据，请先验证并迁移原加密文件。');
  }
  const entries = initial ? {} : await collectLegacy(directory, key);
  if (initial) {
    for (const kind of kinds) {
      checkValue(kind, initial[kind]);
      const bytes = encrypt(initial[kind], key);
      const file = kind + '-' + randomBytes(16).toString('hex') + '.enc';
      await durableWrite(join(directory, file), bytes);
      entries[kind] = entry(file, bytes);
    }
  }
  await publishManifest(directory, { version: 1, entries, receipts: [] }, key);
  return openState(directory, keyHex);
}
export async function openState(directory, keyHex) {
  const key = keyBytes(keyHex);
  const manifestFile = await readStateFile(directory, manifestName);
  let manifest = decrypt(manifestFile.bytes, key);
  if (manifest.version !== 1 || !Array.isArray(manifest.receipts) || manifest.receipts.length > 32) throw unavailable();
  const values = {};
  const seen = new Map([[manifestName, { signature: manifestFile.signature, digest: manifestFile.digest }]]);
  for (const kind of kinds) {
    const expected = manifest.entries?.[kind];
    if (!expected || (expected.file !== legacyFile(kind) && (!managedFile.test(expected.file) || !expected.file.startsWith(kind + '-'))) ||
        !/^[a-f0-9]{64}$/.test(expected.digest) || typeof expected.generation !== 'string') throw unavailable();
    const current = await readStateFile(directory, expected.file);
    if (current.digest !== expected.digest) throw unavailable();
    const value = decrypt(current.bytes, key);
    checkValue(kind, value);
    values[kind] = value;
    seen.set(expected.file, { signature: current.signature, digest: current.digest });
  }

  let queue = Promise.resolve(), checking, inspection, uncertain = false;
  const serial = operation => {
    const next = queue.then(operation);
    queue = next.catch(() => {});
    return next;
  };
  async function verify(full = false) {
    if (uncertain) throw unavailable();
    for (const [file, expected] of seen) {
      const info = await lstat(join(directory, file), { bigint: true });
      if (!info.isFile()) throw unavailable();
      if (!full && signature(info) === expected.signature) continue;
      const current = await readStateFile(directory, file);
      if (current.digest !== expected.digest) throw unavailable();
      expected.signature = current.signature;
    }
  }
  async function commit(changes, receipt, beforeCommit) {
    return serial(async () => {
      await verify();
      const entries = { ...manifest.entries };
      const staged = new Map();
      let publishing = false;
      try {
        for (const [kind, value] of Object.entries(changes)) {
          checkValue(kind, value);
          const bytes = encrypt(value, key);
          const file = kind + '-' + randomBytes(16).toString('hex') + '.enc';
          const info = entry(file, bytes);
          if (!receipt) info.generation = entries[kind].generation;
          entries[kind] = info;
          staged.set(file, { digest: info.digest });
          await durableWrite(join(directory, file), bytes);
          staged.get(file).signature = signature(await lstat(join(directory, file), { bigint: true }));
        }
        const next = { version: 1, entries, receipts: receipt ? [receipt, ...manifest.receipts].slice(0, 32) : manifest.receipts };
        await publishManifest(directory, next, key, async () => {
          await verify();
          await beforeCommit?.();
          publishing = true;
        });
        const committed = await readStateFile(directory, manifestName);
        if (JSON.stringify(decrypt(committed.bytes, key)) !== JSON.stringify(next)) throw unavailable();
        const retired = [];
        for (const [kind, value] of Object.entries(changes)) {
          const old = manifest.entries[kind].file;
          seen.delete(old);
          if (managedFile.test(old)) retired.push(old);
          const file = entries[kind].file;
          seen.set(file, staged.get(file));
          values[kind] = value;
        }
        manifest = next;
        seen.set(manifestName, { signature: committed.signature, digest: committed.digest });
        await Promise.all(retired.map(file => unlink(join(directory, file)).catch(() => {})));
      } catch (error) {
        if (publishing) uncertain = true;
        else await Promise.all([...staged.keys()].map(file => unlink(join(directory, file)).catch(() => {})));
        if (error.status) throw error;
        throw unavailable();
      }
    });
  }
  return {
    read: kind => structuredClone(values[kind]),
    generation: kind => manifest.entries[kind].generation,
    receipt: id => manifest.receipts.find(item => item.id === id),
    commit,
    check: () => checking ??= serial(() => verify()).finally(() => { checking = undefined; }),
    verify: () => inspection ??= serial(() => verify(true)).finally(() => { inspection = undefined; }),
    async cleanStaged() {
      return serial(async () => {
        await verify();
        for (const file of await readdir(directory)) {
          if ((managedFile.test(file) && !seen.has(file)) || /^state-[a-f0-9]{32}\.tmp$/.test(file)) {
            await unlink(join(directory, file));
          }
        }
        await syncDir(directory);
      });
    }
  };
}
