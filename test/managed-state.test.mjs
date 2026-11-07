import assert from 'node:assert/strict';
import { randomBytes, randomUUID, scryptSync } from 'node:crypto';
import { once } from 'node:events';
import { spawn } from 'node:child_process';
import { mkdtemp, rename, rm, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { createApp } from '../server.mjs';
import { createCredentialStore, createStore } from '../storage.mjs';
import { openState, provisionState } from '../state.mjs';
import { TRANSFER_FORMAT } from '../transfer.mjs';

const origin = 'https://fixture.example';
const password = 'fixture-password-for-testing-only';
const salt = 'a'.repeat(32);
const passwordHash = salt + ':' + scryptSync(password, salt, 64).toString('hex');
const time = '2026-11-07T00:00:00Z';
const model = { id: 'local-model', name: '测试模块', revision: 1, createdAt: time, updatedAt: time, protocol: 'chat', model: '', baseURL: '', apiKey: '', models: [] };
const guide = { id: 'guide-1', name: '原指引', category: '测试', description: '说明', instructions: '示例', revision: 1, createdAt: time, updatedAt: time };
const history = { id: 'saved-item', original: '原文', result: '原结果', title: '', guideId: guide.id, guideName: guide.name, revision: 1, createdAt: time, updatedAt: time };
const initial = { auth: { version: 1, passwordHash, updatedAt: time }, model: [model], guides: [guide], history: [history] };

async function setup(t) {
  const dataDir = await mkdtemp(join(tmpdir(), 'managed-workbench-'));
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  return { dataDir, storageKey: randomBytes(32).toString('hex'), origin, secure: true, managed: true, log() {} };
}

async function listen(t, config) {
  const app = await createApp(config);
  app.listen(0, '127.0.0.1');
  await once(app, 'listening');
  const close = async () => {
    if (!app.listening) return;
    app.closeAllConnections();
    await new Promise(resolve => app.close(resolve));
  };
  t.after(close);
  let cookie = '';
  const api = async (path, body, headers = {}) => {
    const response = await fetch('http://127.0.0.1:' + app.address().port + path, {
      method: body === undefined ? 'GET' : 'POST',
      headers: { Origin: origin, Cookie: cookie, 'Content-Type': 'application/json', ...headers },
      body: body === undefined ? undefined : JSON.stringify(body)
    });
    if (response.headers.has('set-cookie')) cookie = response.headers.get('set-cookie').split(';')[0];
    return { status: response.status, data: await response.json() };
  };
  const login = headers => api('/api/login', { password }, headers);
  return { api, login, close };
}

test('已有加密文件迁移后可登录，凭据或历史缺失时保持关闭，空目录拒绝网页初始化', async t => {
  const config = await setup(t);
  const { dataDir, storageKey } = config;
  await (await createCredentialStore(dataDir, storageKey)).initialize(passwordHash);
  for (const kind of ['guides', 'history', 'model']) await (await createStore(dataDir, storageKey, kind)).replaceAll(initial[kind]);
  await provisionState(dataDir, storageKey);
  const first = await listen(t, config);
  assert.equal((await first.login()).status, 200);
  assert.equal((await first.api('/api/history')).data.records[0].original, history.original);

  for (const kind of ['auth', 'history']) {
    const path = join(dataDir, kind + '.enc');
    await rename(path, path + '.fixture');
    assert.equal((await first.api('/health/live')).status, 200);
    assert.equal((await first.api('/health/ready')).status, 503);
    assert.equal((await first.api('/api/history', { original: '新原文', result: '新结果' })).status, 503);
    const restarted = await listen(t, config);
    assert.equal((await restarted.api('/api/auth/initialize', { password, confirmation: password })).status, 404);
    await restarted.close();
    await rename(path + '.fixture', path);
    assert.equal((await first.api('/health/ready')).status, 200);
  }
  await first.close();
  const wrongKey = await listen(t, { ...config, storageKey: randomBytes(32).toString('hex') });
  assert.equal((await wrongKey.api('/health/ready')).status, 503);
  assert.equal((await wrongKey.api('/api/auth/initialize', { password, confirmation: password })).status, 404);
  const empty = await setup(t);
  const fresh = await listen(t, empty);
  assert.equal((await fresh.api('/api/auth/initialize', { password, confirmation: password })).status, 404);
  assert.deepEqual(await readdir(empty.dataDir), []);
});

test('导入只提交一次并拒绝旧页面写入，同一导入回执跨重启可读', async t => {
  const config = await setup(t);
  await provisionState(config.dataDir, config.storageKey, initial);
  let service = await listen(t, config);
  assert.equal((await service.login()).status, 200);
  const staleHistory = (await service.api('/api/history')).data.records[0];
  const staleModel = (await service.api('/api/models')).data.modules[0];
  const generations = (await service.api('/api/data/import')).data.generations;
  const payload = { format: TRANSFER_FORMAT, version: 1, exportedAt: time, data: {
    favorites: [{ ...history, result: '导入结果' }], models: [{ ...model, name: '导入模型' }]
  } };
  const request = { importId: randomUUID(), generations, modules: ['favorites', 'models'], payload };
  assert.equal((await service.api('/api/data/import', request)).status, 200);
  assert.equal((await service.api('/api/history/update', { ...staleHistory, result: '旧页面覆盖' })).status, 409);
  assert.equal((await service.api('/api/models/delete', { id: staleModel.id, revision: staleModel.revision, generation: staleModel.generation })).status, 409);
  const current = (await service.api('/api/history')).data.records[0];
  assert.equal(current.result, '导入结果');
  assert.equal((await service.api('/api/history/update', { ...current, result: '正常新编辑' })).status, 200);
  await service.close();

  service = await listen(t, config);
  assert.equal((await service.login()).status, 200);
  assert.equal((await service.api('/api/data/import', request)).status, 200);
  assert.equal((await service.api('/api/data/import', { ...request, importId: randomUUID() })).status, 409);
  assert.equal((await service.api('/api/history')).data.records[0].result, '正常新编辑');
});

test('错误格式不占登录额度，可信客户端之间独立限流', async t => {
  const config = await setup(t);
  await provisionState(config.dataDir, config.storageKey, initial);
  const { api, login } = await listen(t, { ...config, trustProxyClient: true });
  const a = { 'X-Workbench-Client': '192.0.2.11' };
  const b = { 'X-Workbench-Client': '192.0.2.12' };
  for (let n = 0; n < 12; n++) {
    assert.equal((await api('/api/login', {}, { ...a, 'Content-Type': 'text/plain' })).status, 415);
  }
  assert.equal((await login(a)).status, 200);
  for (let n = 0; n < 10; n++) {
    assert.equal((await api('/api/login', { password: 'invalid-password-for-testing' }, a)).status, 401);
  }
  assert.equal((await login(a)).status, 429);
  assert.equal((await login(b)).status, 200);
});

test('导入提交前后进程中断，重启按清单选择完整数据', { timeout: 10000 }, async t => {
  for (const boundary of ['before', 'after']) {
    const config = await setup(t);
    await provisionState(config.dataDir, config.storageKey, initial);
    const module = new URL('../state.mjs', import.meta.url).href;
    const code = [
      "import fs from 'node:fs'; import { syncBuiltinESMExports } from 'node:module';",
      "const args = JSON.parse(process.env.MANAGED_TEST_ARGS); const original = fs.promises.rename;",
      "fs.promises.rename = async (from, to) => {",
      "  if (!to.endsWith('/state.enc')) return original(from, to);",
      "  if (args.boundary === 'after') await original(from, to);",
      "  process.send('cut'); await new Promise(() => {});",
      "}; syncBuiltinESMExports();",
      "const { openState } = await import(args.module);",
      "const state = await openState(args.dataDir, args.storageKey); await state.commit(args.changes, args.receipt);"
    ].join('\n');
    const changes = { history: [{ ...history, result: '新结果' }], guides: [{ ...guide, name: '新指引' }] };
    const receipt = { id: randomUUID(), fingerprint: 'fixture', counts: { favorites: 1, guides: 1 } };
    const child = spawn(process.execPath, ['--input-type=module', '-e', code], {
      env: { ...process.env, MANAGED_TEST_ARGS: JSON.stringify({ ...config, module, boundary, changes, receipt }) },
      stdio: ['ignore', 'ignore', 'inherit', 'ipc']
    });
    t.after(() => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); });
    const exited = once(child, 'exit');
    const signal = await Promise.race([once(child, 'message').then(([value]) => value), exited.then(() => 'exited early')]);
    assert.equal(signal, 'cut');
    child.kill('SIGKILL');
    await exited;
    const reopened = await openState(config.dataDir, config.storageKey);
    const expected = boundary === 'before' ? initial : changes;
    assert.deepEqual(reopened.read('history'), expected.history);
    assert.deepEqual(reopened.read('guides'), expected.guides);
    assert.equal(!!reopened.receipt(receipt.id), boundary === 'after');
    await reopened.cleanStaged();
    await reopened.verify();
  }
});

test('接近各模块容量上限的三模块导入可提交并回读', { timeout: 20000 }, async t => {
  const config = await setup(t);
  await provisionState(config.dataDir, config.storageKey, initial);
  const { api, login } = await listen(t, config);
  assert.equal((await login()).status, 200);
  const modelNames = Array.from({ length: 720 }, (_, index) => 'm'.repeat(64) + index);
  const data = {
    guides: Array.from({ length: 100 }, (_, index) => ({ ...guide, id: 'guide-' + index, instructions: '文'.repeat(3920) })),
    favorites: Array.from({ length: 100 }, (_, index) => ({ ...history, id: 'history-' + index, result: '文'.repeat(27000) })),
    models: Array.from({ length: 100 }, (_, index) => ({ ...model, id: 'model-' + index, baseURL: 'https://model.example/v1',
      apiKey: 'test-only', model: modelNames[0], models: modelNames }))
  };
  const generations = (await api('/api/data/import')).data.generations;
  const request = { importId: randomUUID(), generations, modules: ['guides', 'favorites', 'models'], payload: { format: TRANSFER_FORMAT, version: 1, exportedAt: time, data } };
  const size = Buffer.byteLength(JSON.stringify(request));
  assert.ok(size >= 13 * 1024 * 1024 && size < 16 * 1024 * 1024);
  const result = await api('/api/data/import', request);
  assert.equal(result.status, 200);
  assert.deepEqual(result.data.imported, { guides: 100, favorites: 100, models: 100 });
  const reopened = await openState(config.dataDir, config.storageKey);
  assert.equal(reopened.read('model').length, 100);
  assert.equal(reopened.read('history').length, 100);
  assert.equal(reopened.read('guides').length, 100);
});
