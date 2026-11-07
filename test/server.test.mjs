import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { scryptSync } from 'node:crypto';
import { request as httpRequest } from 'node:http';
import { createConnection } from 'node:net';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp, configFromEnv } from '../server.mjs';
import { DATA_IMPORT_MAX_BYTES } from '../storage.mjs';

const password = 'test-password-123456789';
const salt = 'a'.repeat(32);
const passwordHash = `${salt}:${scryptSync(password, salt, 64).toString('hex')}`;
async function fixture(t, upstream, overrides = {}) {
  const logs = [];
  const config = { origin: 'https://test.example', secure: true, passwordHash, modelURL: 'https://model.example/v1/chat/completions', apiKey: 'secret-server-only', model: 'test', timeoutMs: 100, log: entry => logs.push(entry), ...overrides };
  const server = await createApp(config, upstream);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  const base = `http://127.0.0.1:${server.address().port}`;
  let cookie = '';
  const call = async (path, data, headers = {}) => {
    const response = await fetch(base + path, { method: data === undefined ? 'GET' : 'POST', headers: { Origin: config.origin, 'Content-Type': 'application/json', Cookie: cookie, ...headers }, body: data === undefined ? undefined : JSON.stringify(data) });
    const nextCookie = response.headers.get('set-cookie');
    if (nextCookie) cookie = nextCookie.split(';')[0];
    return response;
  };
  const login = async () => { const r = await call('/api/login', { password }); cookie = r.headers.get('set-cookie')?.split(';')[0]; return r; };
  return { server, base, call, login, logs, getCookie: () => cookie, clearCookie: () => { cookie = ''; } };
}
test('首次初始化、页面路由守卫、密码修改及凭据重启回读', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'prompt-auth-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const storageKey = '9'.repeat(64), initialPassword = 'initial-password-123456', nextPassword = 'next-password-987654321';
  const first = await fixture(t, undefined, { dataDir: dir, storageKey, passwordHash: '' });
  let session = await (await first.call('/api/session')).json();
  assert.equal(session.initialized, false); assert.equal(session.authenticated, false);
  for (const [path, location] of [['/', '/setup'], ['/login', '/setup'], ['/app', '/setup'], ['/app/guides', '/setup'], ['/app/history', '/setup'], ['/app/models', '/setup'], ['/app/data', '/setup']]) {
    const response = await fetch(first.base + path, { redirect: 'manual' });
    assert.equal(response.status, 302); assert.equal(response.headers.get('location'), location);
  }
  assert.equal((await fetch(first.base + '/setup')).status, 200);
  assert.equal((await first.call('/api/history')).status, 409);
  assert.equal((await first.call('/api/auth/initialize', { password: 'short', confirmation: 'short' })).status, 400);
  assert.equal((await first.call('/api/auth/initialize', { password: initialPassword, confirmation: 'different-password-1' })).status, 400);
  let response = await first.call('/api/auth/initialize', { password: initialPassword, confirmation: initialPassword });
  assert.equal(response.status, 200); assert.equal((await response.json()).authenticated, true);
  assert.equal((await fetch(first.base + '/setup', { redirect: 'manual', headers: { Cookie: response.headers.get('set-cookie')?.split(';')[0] || '' } })).headers.get('location'), '/app');
  assert.equal((await first.call('/app')).status, 200);
  first.clearCookie();
  for (const path of ['/app', '/app/editor', '/app/guides', '/app/history', '/app/models', '/app/data']) {
    response = await fetch(first.base + path, { redirect: 'manual' });
    assert.equal(response.status, 302); assert.equal(response.headers.get('location'), '/login');
  }
  assert.equal((await first.call('/api/history')).status, 401);
  assert.equal((await first.call('/api/login', { password: initialPassword })).status, 200);
  assert.equal((await first.call('/api/password', { currentPassword: 'wrong-password-123456', newPassword: nextPassword, confirmation: nextPassword })).status, 401);
  assert.equal((await (await first.call('/api/session')).json()).authenticated, true);
  response = await first.call('/api/password', { currentPassword: initialPassword, newPassword: nextPassword, confirmation: nextPassword });
  assert.equal(response.status, 200);
  assert.equal((await first.call('/api/login', { password: initialPassword })).status, 401);
  assert.equal((await first.call('/api/login', { password: nextPassword })).status, 200);
  const encrypted = await (await import('node:fs/promises')).readFile(join(dir, 'auth.enc'));
  assert.equal(encrypted.includes(Buffer.from(initialPassword)), false); assert.equal(encrypted.includes(Buffer.from(nextPassword)), false);
  const second = await fixture(t, undefined, { dataDir: dir, storageKey, passwordHash: '' });
  session = await (await second.call('/api/session')).json(); assert.equal(session.initialized, true); assert.equal(session.authenticated, false);
  assert.equal((await second.call('/api/login', { password: nextPassword })).status, 200);
});
test('访问保护、会话 Cookie、安全响应头、来源验证、退出失效', async t => {
  const { call, login } = await fixture(t, () => { throw new Error('must not call'); });
  assert.equal((await call('/api/enhance', { prompt: '私密信息' })).status, 401);
  assert.equal((await call('/api/login', { password: 'wrong' })).status, 401);
  assert.equal((await call('/api/login', { password }, { Origin: 'https://evil.example' })).status, 403);
  const logged = await login(); assert.equal(logged.status, 200);
  assert.match(logged.headers.get('set-cookie'), /__Host-prompt_session=.*HttpOnly; SameSite=Strict.*Secure/);
  const page = await call('/'); assert.equal(page.headers.get('cache-control'), 'no-store'); assert.match(page.headers.get('content-security-policy'), /frame-ancestors 'none'/);
  assert.equal((await (await call('/api/session')).json()).authenticated, true);
  assert.equal((await call('/.env')).status, 404);
  await call('/api/logout', {});
  assert.equal((await call('/api/enhance', { prompt: '私密信息' })).status, 401);
});
test('原文完整传入、规则约束、仅返回正文、密钥只发送给模型', async t => {
  const prompt = 'Write an email under 100 words. 不要增加承诺。';
  const { call, login } = await fixture(t, async (url, options) => {
    assert.equal(url, 'https://model.example/v1/chat/completions');
    const payload = JSON.parse(options.body);
    assert.equal(payload.messages[1].content, prompt);
    assert.match(payload.messages[0].content, /严格使用原文相同/);
    assert.match(payload.messages[0].content, /不编造事实/);
    assert.equal(options.headers.Authorization, 'Bearer secret-server-only');
    return Response.json({ choices: [{ finish_reason: 'stop', message: { content: '  Revised prompt.  ' } }] });
  });
  await login();
  const r = await call('/api/enhance', { prompt }); assert.equal(r.status, 200);
  assert.deepEqual(await r.json(), { result: 'Revised prompt.' });
});
test('空白、超长、错误类型在模型调用前拒绝', async t => {
  const { call, login } = await fixture(t, () => { throw new Error('must not call'); }); await login();
  for (const prompt of ['', '  \n', 1, null]) assert.equal((await call('/api/enhance', { prompt })).status, 400);
  assert.equal((await call('/api/enhance', { prompt: '文'.repeat(8001) })).status, 413);
  assert.equal((await call('/api/enhance', { prompt: 'x'.repeat(66000) })).status, 413);
});
test('上游错误不泄露凭据或原文，截断和空结果拒绝', async t => {
  let response;
  const { call, login } = await fixture(t, async () => response); await login();
  response = new Response('secret-upstream-trace', { status: 500 });
  let r = await call('/api/enhance', { prompt: 'test' }); assert.equal(r.status, 502); assert.doesNotMatch(await r.text(), /secret/);
  for (const choice of [{ finish_reason: 'length', message: { content: 'partial' } }, { finish_reason: 'stop', message: { content: ' ' } }]) {
    response = Response.json({ choices: [choice] });
    assert.equal((await call('/api/enhance', { prompt: 'test' })).status, 502);
  }
});
test('超时后允许重试', async t => {
  const { call, login } = await fixture(t, (url, { signal }) => new Promise((resolve, reject) => signal.addEventListener('abort', () => reject(new Error('aborted'))))); await login();
  assert.equal((await call('/api/enhance', { prompt: 'test' })).status, 504);
  assert.equal((await call('/api/enhance', { prompt: 'test' })).status, 504);
});
test('登录限流', async t => {
  const { call } = await fixture(t);
  for (let i = 0; i < 10; i++) assert.equal((await call('/api/login', { password: 'wrong' })).status, 401);
  assert.equal((await call('/api/login', { password })).status, 429);
});
test('生产配置拒绝明文站点、外网监听和不安全模型地址', () => {
  const env = { PUBLIC_ORIGIN: 'https://prompt.example', PASSWORD_HASH: passwordHash, DATA_DIR: '/var/lib/prompt-enhancer', STORAGE_KEY: '1'.repeat(64), MODEL_BASE_URL: 'https://model.example/v1', MODEL_API_KEY: 'key', MODEL_NAME: 'model' };
  assert.equal(configFromEnv(env).secure, true);
  assert.equal(configFromEnv({ ...env, PASSWORD_HASH: '' }).passwordHash, '');
  assert.throws(() => configFromEnv({ ...env, PUBLIC_ORIGIN: 'http://prompt.example' }));
  assert.throws(() => configFromEnv({ ...env, HOST: '0.0.0.0' }));
  assert.throws(() => configFromEnv({ ...env, MODEL_BASE_URL: 'http://model.example' }));
  assert.throws(() => configFromEnv({ ...env, DATA_DIR: '' }));
  assert.throws(() => configFromEnv({ ...env, STORAGE_KEY: '' }));
});
test('健康检查支持 GET/HEAD，readiness 在存储损坏时失败，静态资源支持 HEAD', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'prompt-health-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const { base, call, login } = await fixture(t, undefined, { dataDir: dir, storageKey: 'f'.repeat(64) });
  let response = await call('/health/live'); assert.equal(response.status, 200); assert.deepEqual(await response.json(), { status: 'ok' });
  response = await fetch(`${base}/health/live`, { method: 'HEAD' }); assert.equal(response.status, 200); assert.equal(await response.text(), '');
  response = await call('/health/ready'); assert.equal(response.status, 200); assert.deepEqual(await response.json(), { status: 'ready' });
  response = await fetch(`${base}/`, { method: 'HEAD' }); assert.equal(response.status, 200); assert.equal(await response.text(), ''); assert.match(response.headers.get('content-type'), /text\/html/);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  response = await fetch(`${base}/app.js?v=2.2.5`, { method: 'HEAD' }); assert.equal(response.status, 200); assert.equal(response.headers.get('cache-control'), 'public, max-age=31536000, immutable');
  response = await fetch(`${base}/app.js`, { method: 'HEAD' }); assert.equal(response.status, 200); assert.equal(response.headers.get('cache-control'), 'no-store');
  response = await fetch(`${base}/favicon.svg?v=2.2.5`); assert.equal(response.status, 200); assert.match(response.headers.get('content-type'), /image\/svg\+xml/); assert.equal(response.headers.get('cache-control'), 'public, max-age=31536000, immutable'); assert.match(await response.text(), />明<\/text>/);
  await login(); await call('/api/history', { original: '原文', result: '结果' });
  await writeFile(join(dir, 'history.enc'), 'corrupted');
  response = await call('/health/ready'); assert.equal(response.status, 503); assert.deepEqual(await response.json(), { status: 'unavailable' });
});
test('结构化日志可按请求追踪且不记录密码、密钥、提示语或模型正文', async t => {
  const secretPassword = 'wrong-password-marker';
  const secretPrompt = 'private-prompt-marker';
  const { call, login, logs } = await fixture(t, async () => new Response('private-upstream-marker', { status: 500 }));
  const denied = await call('/api/login', { password: secretPassword }); assert.equal(denied.status, 401); assert.match(denied.headers.get('x-request-id'), /^[0-9a-f-]{36}$/); await denied.text();
  await login();
  const failed = await call('/api/enhance', { prompt: secretPrompt }); assert.equal(failed.status, 502); assert.match(failed.headers.get('x-request-id'), /^[0-9a-f-]{36}$/); await failed.text();
  const unknown = await call('/api/private-route-marker'); assert.equal(unknown.status, 404); await unknown.text();
  const entry = logs.find(item => item.route === '/api/enhance');
  assert.equal(entry.status, 502); assert.equal(entry.errorCategory, 'upstream'); assert.equal(entry.authenticated, true); assert.equal(entry.event, 'http_request'); assert.ok(Number.isInteger(entry.durationMs));
  const serialized = JSON.stringify(logs);
  for (const secret of [secretPassword, secretPrompt, 'secret-server-only', 'private-upstream-marker', 'private-route-marker']) assert.ok(!serialized.includes(secret));
  assert.ok(logs.some(item => item.route === '/api/unknown'));
});
test('历史 API 需要认证，保存后回读正确，登出后不可读', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'prompt-api-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const { call, login } = await fixture(t, undefined, { dataDir: dir, storageKey: 'c'.repeat(64) });
  assert.equal((await call('/api/history')).status, 401);
  await login();
  assert.equal((await call('/api/history', { original: '原文', result: '结果' })).status, 200);
  const records = (await (await call('/api/history')).json()).records;
  assert.equal(records.length, 1); assert.equal(records[0].original, '原文'); assert.equal(records[0].result, '结果');
  assert.equal((await call('/api/history', { original: '', result: '结果' })).status, 400);
  await call('/api/logout', {});
  assert.equal((await call('/api/history')).status, 401);
});
test('退出时撤销已经开始上传但尚未写入的历史请求', { timeout: 5000 }, async t => {
  const dir = await mkdtemp(join(tmpdir(), 'prompt-logout-write-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const { server, base, call, login, getCookie } = await fixture(t, undefined, { dataDir: dir, storageKey: 'c'.repeat(64) });
  await login();
  const body = JSON.stringify({ original: 'old session', result: 'pending result' });
  const started = new Promise(resolve => server.prependOnceListener('request', req => req.once('data', resolve)));
  const request = httpRequest(base + '/api/history', {
    method: 'POST',
    headers: { Origin: 'https://test.example', Cookie: getCookie(), 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }
  });
  t.after(() => request.destroy());
  const reply = once(request, 'response');
  request.write(body.slice(0, 5));
  await started;
  assert.equal((await call('/api/logout', {})).status, 200);
  request.end(body.slice(5));
  const [response] = await reply;
  response.resume();
  assert.equal(response.statusCode, 401);
  await login();
  assert.deepEqual((await (await call('/api/history')).json()).records, []);
});
test('未配置模型时安全启动且明确报错，不伪造增强结果', async t => {
  const { call, login } = await fixture(t, () => { throw new Error('must not call'); }, { apiKey: '' });
  const response = await login();
  assert.equal((await response.json()).modelReady, false);
  assert.equal((await call('/api/enhance', { prompt: 'test' })).status, 503);
});
test('指引 CRUD、认证与来源校验、版本冲突及选定方向真正传给模型', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'prompt-guides-api-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  let sent;
  const { call, login } = await fixture(t, async (url, options) => {
    sent = JSON.parse(options.body);
    return Response.json({ choices: [{ finish_reason: 'stop', message: { content: 'Clearer English prompt.' } }] });
  }, { dataDir: dir, storageKey: 'd'.repeat(64) });
  assert.equal((await call('/api/guides')).status, 401);
  assert.equal((await call('/api/guides/delete', { id: 'guide-clear', revision: 1 })).status, 401);
  await login();
  assert.equal((await (await call('/api/guides')).json()).records.length, 8);
  const fields = { name: '合同措辞', category: '写作', description: '保留双方约束', instructions: '不要增加赔偿承诺。' };
  assert.equal((await call('/api/guides', fields, { Origin: 'https://evil.example' })).status, 403);
  const created = (await (await call('/api/guides', fields)).json()).record;
  const updated = (await (await call('/api/guides/update', { ...created, name: '客户措辞' })).json()).record;
  assert.equal(updated.revision, 2);
  assert.equal((await call('/api/guides/update', { ...created, name: '旧版本' })).status, 409);
  const result = await (await call('/api/enhance', { prompt: 'Write a short email in a friendly tone.', guideId: updated.id })).json();
  assert.equal(result.guideName, '客户措辞');
  assert.equal(result.guideId, updated.id);
  assert.match(sent.messages[0].content, /不要增加赔偿承诺/);
  assert.match(sent.messages[0].content, /原文语言/);
  assert.equal(sent.messages[1].content, 'Write a short email in a friendly tone.');
  assert.equal((await call('/api/guides/delete', { id: updated.id, revision: 1 })).status, 409);
  assert.equal((await call('/api/guides/delete', updated)).status, 200);
  assert.equal((await call('/api/enhance', { prompt: 'test', guideId: updated.id })).status, 409);
  assert.equal((await call('/api/guides', { ...fields, instructions: 'x'.repeat(4001) })).status, 400);
  assert.equal((await call('/api/guides/update', { ...fields, id: '../../x', revision: 1 })).status, 400);
});
test('历史编辑、另存为独立记录、删除与并发冲突保护', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'prompt-history-api-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const { call, login } = await fixture(t, undefined, { dataDir: dir, storageKey: 'e'.repeat(64) });
  await login();
  const record = (await (await call('/api/history', { title: '版本一', original: '原文', result: '正文' })).json()).record;
  const edited = (await (await call('/api/history/update', { ...record, result: '修改后的正文' })).json()).record;
  assert.equal(edited.revision, 2);
  assert.equal((await call('/api/history/update', { ...record, result: '覆盖' })).status, 409);
  const copy = (await (await call('/api/history', { ...edited, asCopy: true })).json()).record;
  assert.notEqual(copy.id, edited.id);
  assert.equal((await call('/api/history/delete', edited, { Origin: 'https://evil.example' })).status, 403);
  assert.equal((await call('/api/history/delete', edited)).status, 200);
  const remaining = (await (await call('/api/history')).json()).records;
  assert.equal(remaining.length, 1); assert.equal(remaining[0].id, copy.id);
});

test('无需模型名即可拉取；列表移除持久化、清空停用、失败保留、旧版本拒绝及来源保护', async t => {
  const dir = await mkdtemp(join(tmpdir(),'prompt-discovery-')); t.after(()=>rm(dir,{recursive:true,force:true}));
  let fail=false, calls=0;
  const {call,login}=await fixture(t,async(url,opts)=>{
    calls++; assert.equal(opts.method,'GET'); assert.equal(url,'https://model.example/v1/models'); assert.equal(opts.headers.Authorization,'Bearer new-private-key');
    if(fail)return Response.json({secret:'new-private-key'},{status:404});
    return Response.json({data:[{id:'model-a'},{id:'model-b'}]});
  },{dataDir:dir,storageKey:'c'.repeat(64),model:'',apiKey:'',modelURL:null});
  const input={revision:1,protocol:'chat',baseURL:'https://model.example/v1',apiKey:'new-private-key'};
  assert.equal((await call('/api/model/discover',input)).status,401); await login();
  assert.equal((await call('/api/model/discover',input,{Origin:'https://evil.example'})).status,403);
  assert.equal((await call('/api/model/discover',{...input,baseURL:'https://127.0.0.1'})).status,400);
  const found=await call('/api/model/discover',input); assert.equal(found.status,200); assert.deepEqual(await found.json(),{models:['model-a','model-b']});
  let config=(await (await call('/api/model')).json()).config; assert.equal(config.hasKey,false); // 拉取不提前写入配置
  let saved=await call('/api/model',{...input,model:'model-b',models:['model-a','model-b']}); assert.equal(saved.status,200);config=(await saved.json()).config;
  assert.ok(!JSON.stringify(config).includes('new-private-key'));
  saved=await call('/api/model',{...input,apiKey:'',revision:config.revision,model:'model-b',models:['model-b']});assert.equal(saved.status,200);config=(await saved.json()).config;
  assert.deepEqual((await (await call('/api/model')).json()).config.models,['model-b']);
  assert.equal((await call('/api/model/discover',{...input,moduleId:config.id})).status,409);
  const unsaved=await call('/api/model/discover',{...input,revision:1});assert.equal(unsaved.status,200);assert.deepEqual(await unsaved.json(),{models:['model-a','model-b']});
  fail=true; const failed=await call('/api/model/discover',{...input,moduleId:config.id,apiKey:'',revision:config.revision});assert.equal(failed.status,502);assert.ok(!(await failed.text()).includes('new-private-key'));
  assert.deepEqual((await (await call('/api/model')).json()).config.models,['model-b']);
  saved=await call('/api/model',{...input,revision:config.revision,apiKey:'',model:'',models:[]});assert.equal(saved.status,200);config=(await saved.json()).config;assert.equal(config.ready,false);assert.deepEqual(config.models,[]);
  assert.equal((await call('/api/enhance',{prompt:'x'})).status,503);assert.equal(calls,3);
});

test('多个 API 模块可保存、自定义名称可回读，增强按 moduleId 调用所选模块', async t => {
  const dir = await mkdtemp(join(tmpdir(),'prompt-modules-')); t.after(()=>rm(dir,{recursive:true,force:true}));
  const used=[];
  const {call,login}=await fixture(t,async(url,opts)=>{ const payload=JSON.parse(opts.body); used.push(payload.model); return Response.json({choices:[{finish_reason:'stop',message:{content:'按所选模块返回'}}]}); },{dataDir:dir,storageKey:'d'.repeat(64),model:'default-model'});
  await login();
  const created=await call('/api/models',{name:'备用模块',protocol:'chat',baseURL:'https://second.example/v1',apiKey:'second-key',model:'second-model',models:['second-model']}); assert.equal(created.status,200); const module=await created.json(); assert.equal(module.module.name,'备用模块'); assert.ok(module.module.id); assert.equal(module.modules.length,2);
  const list=await (await call('/api/models')).json(); assert.deepEqual(list.modules.map(x=>x.name),['备用模块','环境默认模块']);
  assert.equal(list.config, undefined); assert.equal(list.modules.some(item => Object.hasOwn(item, 'models')), false);
  const detail=await (await call(`/api/models?id=${module.module.id}`)).json(); assert.deepEqual(detail.config.models,['second-model']);
  assert.equal((await call('/api/models?id=missing-module')).status,404);
  assert.equal((await call('/api/enhance',{prompt:'使用备用模块',moduleId:module.module.id})).status,200); assert.deepEqual(used,['second-model']);
  const response=await call('/api/enhance',{prompt:'使用默认模块',moduleId:list.modules.find(x=>x.name==='环境默认模块').id}); assert.equal(response.status,200); assert.deepEqual(used,['second-model','default-model']);
  const removals = await Promise.all(list.modules.map(({ id, revision }) => call('/api/models/delete', { id, revision })));
  assert.deepEqual(removals.map(item => item.status).sort(), [200, 409]);
  assert.equal((await (await call('/api/models')).json()).modules.length, 1);
});

test('导出包含三个模块，导入仅覆盖勾选模块且重复执行幂等', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'prompt-transfer-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  let used;
  const { call, login } = await fixture(t, async (url, options) => {
    used = { url, authorization: options.headers.Authorization, model: JSON.parse(options.body).model };
    return Response.json({ choices: [{ finish_reason: 'stop', message: { content: '导入配置已调用' } }] });
  }, { dataDir: dir, storageKey: '6'.repeat(64) });
  assert.equal((await call('/api/data/export')).status, 401);
  assert.equal((await call('/api/data/import', { payload: {}, modules: ['guides'] })).status, 401);
  await login();
  assert.equal((await call('/api/data/export')).status, 405);
  assert.equal((await call('/api/data/export', { password: 'wrong-export-password-123456' })).status, 403);
  await call('/api/history', { title: '', original: '原收藏', result: '原正文' });
  const before = await (await call('/api/data/export', { password })).json();
  assert.equal(before.format, 'mingxi-data-export'); assert.equal(before.version, 1);
  assert.equal(before.data.guides.length, 8); assert.equal(before.data.favorites.length, 1); assert.equal(before.data.models.length, 1);
  assert.equal(before.data.models[0].apiKey, 'secret-server-only');
  assert.equal(Object.hasOwn(before.data.favorites[0], 'guideId'), false);
  assert.ok(!JSON.stringify(before).includes(password));

  const payload = structuredClone(before), now = '2026-09-19T08:00:00.000Z';
  payload.data.guides = [{ id: 'import-guide', revision: 4, createdAt: now, updatedAt: now, name: '恢复指引', category: '导入', description: '导入说明', instructions: '仅保留用户约束。' }];
  payload.data.favorites = [{ id: 'import-favorite', revision: 2, createdAt: now, updatedAt: now, title: '', original: '导入原文', result: '导入正文', guideName: '恢复指引', guideId: 'import-guide' }];
  payload.data.models = [{ id: 'import-model', revision: 3, createdAt: now, updatedAt: now, name: '恢复 API', protocol: 'chat', baseURL: 'https://restored.example/v1', apiKey: 'restored-key', model: 'restored-model', models: ['restored-model'] }];

  let response = await call('/api/data/import', { payload, modules: ['favorites'] }, { Origin: 'https://evil.example' });
  assert.equal(response.status, 403);
  response = await call('/api/data/import', { payload, modules: ['favorites'] });
  assert.equal(response.status, 200); assert.deepEqual((await response.json()).imported, { favorites: 1 });
  let exported = await (await call('/api/data/export', { password })).json();
  assert.deepEqual(exported.data.guides, before.data.guides);
  assert.deepEqual(exported.data.models, before.data.models);
  assert.deepEqual(exported.data.favorites, payload.data.favorites);

  const invalid = structuredClone(payload); invalid.data.guides.push({ ...invalid.data.guides[0] });
  response = await call('/api/data/import', { payload: invalid, modules: ['favorites'] });
  assert.equal(response.status, 400); assert.match(await response.text(), /重复的记录 ID/);
  assert.deepEqual((await (await call('/api/data/export', { password })).json()).data.favorites, payload.data.favorites);

  response = await call('/api/data/import', { payload, modules: ['guides', 'favorites', 'models'] });
  assert.equal(response.status, 200);
  response = await call('/api/data/import', { payload, modules: ['guides', 'favorites', 'models'] });
  assert.equal(response.status, 200);
  exported = await (await call('/api/data/export', { password })).json();
  assert.deepEqual(exported.data, payload.data);
  const modules = await (await call('/api/models')).json();
  assert.equal(modules.modules[0].name, '恢复 API'); assert.equal(modules.modules[0].hasKey, true);
  assert.ok(!JSON.stringify(modules).includes('restored-key'));
  response = await call('/api/enhance', { prompt: '使用恢复模型', moduleId: 'import-model' });
  assert.equal(response.status, 200);
  assert.deepEqual(used, { url: 'https://restored.example/v1/chat/completions', authorization: 'Bearer restored-key', model: 'restored-model' });
});

test('导入在读取正文前拒绝超限请求并限制单并发', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'prompt-import-limit-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const { base, login, getCookie } = await fixture(t, undefined, { dataDir: dir, storageKey: '7'.repeat(64) });
  await login();
  const headers = { Origin: 'https://test.example', 'Content-Type': 'application/json', Cookie: getCookie() };
  const oversized = await new Promise((resolve, reject) => {
    const request = httpRequest(`${base}/api/data/import`, { method: 'POST', headers: { ...headers, 'Content-Length': DATA_IMPORT_MAX_BYTES + 1 } }, response => {
      response.resume(); response.on('end', () => resolve(response));
    });
    request.on('error', reject); request.end();
  });
  assert.equal(oversized.statusCode, 413);

  const target = new URL(base), slow = createConnection({ host: target.hostname, port: Number(target.port) });
  slow.on('error', () => {}); t.after(() => slow.destroy());
  await new Promise(resolve => slow.once('connect', resolve));
  slow.setNoDelay(true);
  slow.write(`POST /api/data/import HTTP/1.1\r\nHost: ${target.host}\r\nOrigin: https://test.example\r\nContent-Type: application/json\r\nCookie: ${getCookie()}\r\nContent-Length: 100\r\nConnection: keep-alive\r\n\r\n{"payload":`);
  await new Promise(resolve => setTimeout(resolve, 25));
  const concurrent = await fetch(`${base}/api/data/import`, { method: 'POST', headers, body: '{}' });
  assert.equal(concurrent.status, 429); assert.match(await concurrent.text(), /已有导入任务/);
  slow.destroy();
});
