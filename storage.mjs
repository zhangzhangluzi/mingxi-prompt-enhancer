import { mkdir, readFile, writeFile, rename, unlink } from 'node:fs/promises';
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { join } from 'node:path';

export class StoreError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}
export const DATA_IMPORT_MAX_BYTES = 16 * 1024 * 1024;
export const STORE_BYTE_LIMITS = Object.freeze({
  guides: 1536 * 1024,
  history: 8 * 1024 * 1024,
  model: 5 * 1024 * 1024
});
const STORE_LABELS = { guides: '指引', history: '已收藏', model: '模型配置' };
export function assertStoreCapacity(name, records) {
  const json = JSON.stringify(records);
  const limit = STORE_BYTE_LIMITS[name];
  if (limit && Buffer.byteLength(json, 'utf8') > limit) {
    throw new StoreError(413, `${STORE_LABELS[name]}数据超过存储上限，请删除不再需要的内容后重试。`);
  }
  return json;
}
// 兼容旧的 history.enc 数组格式。串行读改写 + revision 防止并发覆盖。
export async function createStore(directory, keyHex, name, defaults = []) {
  if (!directory || !/^[a-f0-9]{64}$/.test(keyHex || '')) throw new Error('存储需要 DATA_DIR 和 32 字节 STORAGE_KEY。');
  if (!['history', 'guides', 'model'].includes(name)) throw new Error('无效存储名称。');
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const key = Buffer.from(keyHex, 'hex');
  const filename = join(directory, `${name}.enc`);
  let queue = Promise.resolve();
  async function read() {
    let bytes;
    try { bytes = await readFile(filename); } catch (error) { if (error.code === 'ENOENT') return structuredClone(defaults); throw error; }
    const decrypt = createDecipheriv('aes-256-gcm', key, bytes.subarray(0, 12));
    decrypt.setAuthTag(bytes.subarray(12, 28));
    const records = JSON.parse(Buffer.concat([decrypt.update(bytes.subarray(28)), decrypt.final()]).toString('utf8'));
    if (!Array.isArray(records)) throw new Error('存储格式无效。');
    return records.map(record => ({ revision: 1, updatedAt: record.createdAt, ...record }));
  }
  async function write(records) {
    const json = assertStoreCapacity(name, records);
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', key, iv);
    const encrypted = Buffer.concat([cipher.update(json, 'utf8'), cipher.final()]);
    const temp = `${filename}.${randomBytes(8).toString('hex')}.tmp`;
    try {
      await writeFile(temp, Buffer.concat([iv, cipher.getAuthTag(), encrypted]), { mode: 0o600, flag: 'wx' });
      await rename(temp, filename);
    } finally { await unlink(temp).catch(error => { if (error.code !== 'ENOENT') throw error; }); }
  }
  function serial(operation) {
    const next = queue.then(operation);
    queue = next.catch(() => {});
    return next;
  }
  function find(records, id, revision) {
    const index = records.findIndex(record => record.id === id);
    if (index < 0) throw new StoreError(404, '该记录已被删除，请刷新列表。');
    if (records[index].revision !== revision) throw new StoreError(409, '记录已在其他页面修改，请保留当前内容并刷新列表后重新编辑。');
    return index;
  }
  return {
    list: () => serial(read),
    replaceAll: records => serial(async () => {
      if (!Array.isArray(records)) throw new StoreError(400, '导入数据必须是数组。');
      if (records.length > 100) throw new StoreError(409, '每个模块最多保留 100 条记录。');
      const next = structuredClone(records);
      await write(next);
      return structuredClone(next);
    }),
    save: (record, { deduplicate = true } = {}) => serial(async () => {
      const records = await read();
      const duplicate = deduplicate && name === 'history' && records.find(item => item.original === record.original && item.result === record.result && (item.title || '') === (record.title || ''));
      if (duplicate) return duplicate;
      if (records.length >= 100) throw new StoreError(409, '已达到 100 条上限，请先删除不再需要的记录。');
      const now = new Date().toISOString();
      const next = { ...record, id: randomBytes(12).toString('hex'), revision: 1, createdAt: now, updatedAt: now };
      await write([next, ...records]);
      return next;
    }),
    update: (id, revision, record) => serial(async () => {
      const records = await read();
      const index = find(records, id, revision);
      const next = { ...records[index], ...record, id, revision: revision + 1, createdAt: records[index].createdAt, updatedAt: new Date().toISOString() };
      records[index] = next;
      await write(records);
      return next;
    }),
    remove: (id, revision) => serial(async () => {
      const records = await read();
      records.splice(find(records, id, revision), 1);
      await write(records);
    })
  };
}
export const createHistory = (directory, keyHex) => createStore(directory, keyHex, 'history');

export async function createCredentialStore(directory, keyHex) {
  if (!directory || !/^[a-f0-9]{64}$/.test(keyHex || '')) throw new Error('凭据存储需要 DATA_DIR 和 32 字节 STORAGE_KEY。');
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const key = Buffer.from(keyHex, 'hex');
  const filename = join(directory, 'auth.enc');
  let queue = Promise.resolve();
  async function read() {
    let bytes;
    try { bytes = await readFile(filename); } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
    const decrypt = createDecipheriv('aes-256-gcm', key, bytes.subarray(0, 12));
    decrypt.setAuthTag(bytes.subarray(12, 28));
    const record = JSON.parse(Buffer.concat([decrypt.update(bytes.subarray(28)), decrypt.final()]).toString('utf8'));
    if (!record || record.version !== 1 || !/^[a-f0-9]{32}:[a-f0-9]{128}$/.test(record.passwordHash || '')) throw new Error('凭据存储格式无效。');
    return record;
  }
  async function write(passwordHash) {
    if (!/^[a-f0-9]{32}:[a-f0-9]{128}$/.test(passwordHash || '')) throw new Error('密码哈希格式无效。');
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', key, iv);
    const record = { version: 1, passwordHash, updatedAt: new Date().toISOString() };
    const encrypted = Buffer.concat([cipher.update(JSON.stringify(record), 'utf8'), cipher.final()]);
    const temp = `${filename}.${randomBytes(8).toString('hex')}.tmp`;
    try {
      await writeFile(temp, Buffer.concat([iv, cipher.getAuthTag(), encrypted]), { mode: 0o600, flag: 'wx' });
      await rename(temp, filename);
    } finally { await unlink(temp).catch(error => { if (error.code !== 'ENOENT') throw error; }); }
  }
  function serial(operation) {
    const next = queue.then(operation);
    queue = next.catch(() => {});
    return next;
  }
  return {
    get: () => serial(async () => (await read())?.passwordHash || ''),
    initialize: passwordHash => serial(async () => {
      if (await read()) throw new StoreError(409, '管理员密码已经初始化。');
      await write(passwordHash);
    }),
    replace: (expected, passwordHash) => serial(async () => {
      const current = await read();
      if (!current) throw new StoreError(409, '管理员密码尚未初始化。');
      if (current.passwordHash !== expected) throw new StoreError(409, '密码已被其他会话修改，请重新登录。');
      await write(passwordHash);
    })
  };
}
