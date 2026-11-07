import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createCredentialStore, createHistory } from '../storage.mjs';

test('管理员凭据加密保存、只初始化一次并支持原子替换', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'prompt-auth-store-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const key = '7'.repeat(64), firstHash = `${'a'.repeat(32)}:${'b'.repeat(128)}`, nextHash = `${'c'.repeat(32)}:${'d'.repeat(128)}`;
  const store = await createCredentialStore(dir, key);
  const other = await createCredentialStore(dir, key);
  assert.equal(await store.get(), '');
  const attempts = await Promise.allSettled([store.initialize(firstHash), other.initialize(nextHash)]);
  assert.equal(attempts.filter(result => result.status === 'fulfilled').length, 1);
  const current = await store.get();
  assert.ok([firstHash, nextHash].includes(current));
  const replacement = current === firstHash ? nextHash : firstHash;
  await assert.rejects(store.replace('f'.repeat(161), replacement), error => error.status === 409);
  await store.replace(current, replacement);
  assert.equal(await (await createCredentialStore(dir, key)).get(), replacement);
  const bytes = await readFile(join(dir, 'auth.enc'));
  assert.equal(bytes.includes(Buffer.from(replacement)), false);
  assert.equal((await stat(join(dir, 'auth.enc'))).mode & 0o777, 0o600);
  await assert.rejects((await createCredentialStore(dir, '8'.repeat(64))).get());
});

test('历史记录加密保存、并发不丢失、重启读取、重复去重与权限', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'prompt-history-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const key = 'a'.repeat(64);
  const history = await createHistory(dir, key);
  await Promise.all([history.save({ original: '私密原文一', result: '结果一' }), history.save({ original: '私密原文二', result: '结果二' })]);
  await history.save({ original: '私密原文一', result: '结果一' });
  assert.equal((await history.list()).length, 2);
  const bytes = await readFile(join(dir, 'history.enc'));
  assert.equal(bytes.includes(Buffer.from('私密原文')), false);
  assert.equal((await stat(join(dir, 'history.enc'))).mode & 0o777, 0o600);
  const restarted = await createHistory(dir, key);
  assert.equal((await restarted.list())[0].original, '私密原文二');
  const wrongKey = await createHistory(dir, 'b'.repeat(64));
  await assert.rejects(wrongKey.list());
  bytes[35] ^= 1; await writeFile(join(dir, 'history.enc'), bytes);
  await assert.rejects(history.verify());
  assert.equal((await history.list()).length, 2);
});

test('旧版历史无损读取，更新持久化、并发编辑拒绝覆盖，删除后重启不恢复', async t => {
  const { createCipheriv } = await import('node:crypto');
  const { createStore } = await import('../storage.mjs');
  const dir = await mkdtemp(join(tmpdir(), 'prompt-legacy-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const key = 'd'.repeat(64), iv = Buffer.alloc(12, 1);
  const cipher = createCipheriv('aes-256-gcm', Buffer.from(key, 'hex'), iv);
  const original = { id: 'legacy', original: '旧版原文', result: '旧版正文', createdAt: '2026-01-01T00:00:00Z' };
  const bytes = Buffer.concat([cipher.update(JSON.stringify([original])), cipher.final()]);
  await writeFile(join(dir, 'history.enc'), Buffer.concat([iv, cipher.getAuthTag(), bytes]));
  let history = await createHistory(dir, key);
  assert.equal((await history.list())[0].revision, 1);
  const writes = await Promise.allSettled([history.update('legacy', 1, { result: '版本二' }), history.update('legacy', 1, { result: '覆盖版本' })]);
  assert.equal(writes.filter(r => r.status === 'fulfilled').length, 1);
  assert.equal(writes.find(r => r.status === 'rejected').reason.status, 409);
  history = await createHistory(dir, key);
  assert.equal((await history.list())[0].result, '版本二');
  assert.equal((await history.list())[0].original, original.original);
  await history.remove('legacy', 2);
  assert.deepEqual(await (await createHistory(dir, key)).list(), []);
  const defaults = [{ id: 'builtin', revision: 1, name: '默认' }];
  const guides = await createStore(dir, key, 'guides', defaults);
  await guides.remove('builtin', 1);
  assert.deepEqual(await (await createStore(dir, key, 'guides', defaults)).list(), []);
});

test('整体替换会原子持久化并保持加密与权限', async t => {
  const { createStore } = await import('../storage.mjs');
  const dir = await mkdtemp(join(tmpdir(), 'prompt-replace-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const key = 'e'.repeat(64), store = await createStore(dir, key, 'guides');
  const records = [{ id: 'imported-guide', revision: 3, createdAt: '2026-09-01T00:00:00.000Z', updatedAt: '2026-09-02T00:00:00.000Z', name: '导入指引', category: '测试', description: '说明', instructions: '内容' }];
  await store.replaceAll(records);
  records[0].name = '外部篡改';
  assert.equal((await store.list())[0].name, '导入指引');
  assert.deepEqual(await (await createStore(dir, key, 'guides')).list(), [{ ...records[0], name: '导入指引' }]);
  const bytes = await readFile(join(dir, 'guides.enc'));
  assert.equal(bytes.includes(Buffer.from('导入指引')), false);
  assert.equal((await stat(join(dir, 'guides.enc'))).mode & 0o777, 0o600);
  await assert.rejects(store.replaceAll(Array.from({ length: 101 }, (_, index) => ({ id: `g-${index}` }))), error => error.status === 409);
  assert.equal((await store.list()).length, 1);
  await assert.rejects(store.replaceAll([{ id: 'oversized', content: 'x'.repeat(1536 * 1024) }]), error => error.status === 413 && /存储上限/.test(error.message));
  assert.equal((await store.list())[0].name, '导入指引');
});

test('导出兼容缺少创建时间的旧模型记录', async () => {
  const { createTransfer, validateTransfer } = await import('../transfer.mjs');
  const updatedAt = '2026-09-19T06:10:18.901Z';
  const legacy = { id: 'active-model', revision: 6, updatedAt, name: '旧模块', protocol: 'chat', baseURL: 'https://model.example/v1', apiKey: 'key', model: 'model', models: ['model'] };
  const exported = createTransfer([], [], [legacy]);
  assert.equal(exported.data.models[0].createdAt, updatedAt);
  assert.equal(exported.data.models[0].updatedAt, updatedAt);
  const payload = { format: 'mingxi-data-export', version: 1, exportedAt: updatedAt, data: { guides: [{ id: 'legacy-guide', revision: 1, name: '旧指引', category: '测试', description: '说明', instructions: '内容' }] } };
  assert.equal(validateTransfer(payload).data.guides[0].createdAt, updatedAt);
  assert.throws(() => validateTransfer({ ...payload, exportedAt: undefined }), /导出时间/);
});
