import { test } from 'node:test';
import assert from 'node:assert/strict';
import { scryptSync } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp, configFromEnv } from '../server.mjs';

const password = 'test-password-123456789';
const salt = 'a'.repeat(32);
const passwordHash = `${salt}:${scryptSync(password, salt, 64).toString('hex')}`;
async function fixture(t, upstream, overrides = {}) {
  const config = { origin: 'https://test.example', secure: true, passwordHash, modelURL: 'https://model.example/v1/chat/completions', apiKey: 'secret-server-only', model: 'test', timeoutMs: 100, ...overrides };
  const server = await createApp(config, upstream);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  const base = `http://127.0.0.1:${server.address().port}`;
  let cookie = '';
  const call = (path, data, headers = {}) => fetch(base + path, { method: data === undefined ? 'GET' : 'POST', headers: { Origin: config.origin, 'Content-Type': 'application/json', Cookie: cookie, ...headers }, body: data === undefined ? undefined : JSON.stringify(data) });
  const login = async () => { const r = await call('/api/login', { password }); cookie = r.headers.get('set-cookie')?.split(';')[0]; return r; };
  return { call, login };
}
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
  const env = { PUBLIC_ORIGIN: 'https://prompt.example', PASSWORD_HASH: passwordHash, MODEL_BASE_URL: 'https://model.example/v1', MODEL_API_KEY: 'key', MODEL_NAME: 'model' };
  assert.equal(configFromEnv(env).secure, true);
  assert.throws(() => configFromEnv({ ...env, PUBLIC_ORIGIN: 'http://prompt.example' }));
  assert.throws(() => configFromEnv({ ...env, HOST: '0.0.0.0' }));
  assert.throws(() => configFromEnv({ ...env, MODEL_BASE_URL: 'http://model.example' }));
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
  assert.equal((await call('/api/enhance',{prompt:'使用备用模块',moduleId:module.module.id})).status,200); assert.deepEqual(used,['second-model']);
  const response=await call('/api/enhance',{prompt:'使用默认模块',moduleId:list.modules.find(x=>x.name==='环境默认模块').id}); assert.equal(response.status,200); assert.deepEqual(used,['second-model','default-model']);
  const deleted=await call('/api/models/delete',{id:module.module.id,revision:module.module.revision}); assert.equal(deleted.status,200); assert.equal((await (await call('/api/models')).json()).modules.length,1);
});
