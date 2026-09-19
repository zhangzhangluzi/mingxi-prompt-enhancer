import { test } from 'node:test';
import assert from 'node:assert/strict';
import { scryptSync, randomBytes } from 'node:crypto';
import { mkdtemp, rm, readFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { modelRequest, modelOutput, validateBase, publicIP, safeModelFetch } from '../models.mjs';
import { createApp } from '../server.mjs';
const outputs = {
  chat: { choices: [{ finish_reason: 'stop', message: { content: '  完整正文  ', reasoning_content: '不显示' } }] },
  responses: { status: 'completed', output: [{ type: 'reasoning', summary: [] }, { type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: '完整正文' }] }] },
  anthropic: { stop_reason: 'end_turn', content: [{ type: 'thinking', thinking: '不显示' }, { type: 'text', text: '完整正文' }] },
  gemini: { candidates: [{ finishReason: 'STOP', content: { parts: [{ thought: true, text: '不显示' }, { text: '完整正文' }] } }] }
};
test('四种文本协议正确传入原文与指引，提取正文并拒绝截断或拒绝响应', () => {
  for (const protocol of Object.keys(outputs)) {
    const req = modelRequest({ protocol, baseURL: 'https://model.example/v1', apiKey: 'secret', model: 'org/model' }, '系统规则', 'Original prompt');
    assert.ok(!req.url.includes('secret')); assert.ok(req.body.includes('Original prompt')); assert.ok(req.body.includes('系统规则'));
    assert.equal(modelOutput(protocol, outputs[protocol]), '完整正文');
    assert.throws(() => modelOutput(protocol, {}));
  }
  const c = { baseURL: 'https://model.example/v1', apiKey: 'secret', model: 'org/model' };
  assert.equal(modelRequest({ ...c, protocol: 'anthropic' }, 's', 'p').headers['anthropic-version'], '2023-06-01');
  assert.equal(JSON.parse(modelRequest({ ...c, protocol: 'responses' }, 's', 'p').body).store, false);
  assert.match(modelRequest({ ...c, protocol: 'gemini' }, 's', 'p').url, /models\/org%2Fmodel:generateContent$/);
  assert.throws(() => modelOutput('chat', { choices: [{ finish_reason: 'length', message: { content: '部分正文' } }] }));
  assert.throws(() => modelOutput('responses', { ...outputs.responses, status: 'incomplete' }));
  assert.throws(() => modelOutput('responses', { status: 'completed', output: [{ type: 'message', status: 'completed', role: 'assistant', content: [{ type: 'refusal', refusal: 'no' }] }] }));
  assert.throws(() => modelOutput('anthropic', { ...outputs.anthropic, stop_reason: 'max_tokens' }));
  assert.throws(() => modelOutput('gemini', { candidates: [{ finishReason: 'SAFETY', content: { parts: [{ text: '部分' }] } }] }));
});
test('公网 HTTPS 校验和实际连接时 DNS 校验阻止访问本地地址', async () => {
  for (const value of ['http://example.com/v1','https://localhost/v1','https://127.0.0.1/v1','https://2130706433/v1','https://[::1]/v1','https://10.0.0.1/v1','https://example.com:8443/v1','https://user:pass@example.com/v1','https://example.com/v1?key=x','https://example.com/v1/chat/completions']) assert.throws(() => validateBase(value));
  for (const ip of ['127.0.0.1','10.1.1.1','172.16.2.3','192.168.1.1','169.254.169.254','100.64.0.1','::1','::ffff:127.0.0.1','fc00::1','fe80::1','2001:db8::1']) assert.equal(publicIP(ip),false,ip);
  assert.equal(publicIP('1.1.1.1'),true); assert.equal(publicIP('2606:4700:4700::1111'),true);
  await assert.rejects(safeModelFetch('https://localhost./v1', { headers: {}, body: '{}', signal: AbortSignal.timeout(3000) }));
});
test('配置鉴权、密钥不回传、加密落盘及重启、版本冲突、服务商切换、四协议真实路由', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'prompt-model-test-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const salt = 'b'.repeat(32), password = 'test-model-password';
  const config = { origin: 'https://test.example', secure: true, passwordHash: `${salt}:${scryptSync(password, salt, 64).toString('hex')}`, timeoutMs: 500, dataDir: dir, storageKey: randomBytes(32).toString('hex') };
  let expectedProtocol = 'chat', calls = 0;
  const upstream = async (url, opts) => {
    calls++;
    const payload = JSON.parse(opts.body);
    assert.ok(!opts.body.includes('stored-api-secret'));
    const auth = opts.headers.Authorization || opts.headers['x-api-key'] || opts.headers['x-goog-api-key'];
    assert.ok(auth.includes('stored-api-secret'));
    assert.ok(payload.model === 'test' || expectedProtocol === 'gemini');
    assert.match(url, { chat: /chat\/completions$/, responses: /responses$/, anthropic: /messages$/, gemini: /:generateContent$/ }[expectedProtocol]);
    return Response.json(outputs[expectedProtocol]);
  };
  async function start() {
    const app = await createApp(config, upstream); await new Promise(resolve => app.listen(0,'127.0.0.1',resolve));
    t.after(() => { app.closeAllConnections(); app.close(); });
    let cookie = '';
    const call = (path, body, headers = {}) => fetch(`http://127.0.0.1:${app.address().port}${path}`, { method: body === undefined ? 'GET' : 'POST', headers: { Origin: config.origin, 'Content-Type': 'application/json', Cookie: cookie, ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
    assert.equal((await call('/api/model')).status,401);
    const login = await call('/api/login',{ password }); cookie=login.headers.get('set-cookie').split(';')[0];
    return { app, call };
  }
  let { app, call } = await start();
  let current = (await (await call('/api/model')).json()).config;
  assert.equal(current.ready,false); assert.equal(current.apiKey,undefined);
  let input = { revision: current.revision, protocol: 'chat', baseURL: 'https://model.example/v1', apiKey: 'stored-api-secret', model: 'test' };
  assert.equal((await call('/api/model',input,{ Origin:'https://evil.example' })).status,403);
  for (const protocol of Object.keys(outputs)) {
    expectedProtocol = protocol; input = { ...input, protocol, revision: current.revision };
    const saved = await call('/api/model',input); assert.equal(saved.status,200); const body = await saved.text(); assert.ok(!body.includes('stored-api-secret')); current=JSON.parse(body).config;
    assert.equal((await call('/api/model',input)).status,409);
    assert.equal((await call('/api/enhance',{prompt:'保留原文'})).status,200);
    const tested = await call('/api/model/test',{revision:current.revision}); assert.equal(tested.status,200); assert.deepEqual(await tested.json(),{ok:true,revision:current.revision});
  }
  assert.equal(calls,8);
  assert.equal((await call('/api/model/test',{revision:1})).status,409);
  assert.equal((await call('/api/model',{...input, revision:current.revision,baseURL:'https://other.example/v1',apiKey:''})).status,400);
  const kept=await call('/api/model',{...input,revision:current.revision,apiKey:''}); assert.equal(kept.status,200); current=(await kept.json()).config;
  assert.equal((await call('/api/model',{...input,revision:current.revision,baseURL:'https://127.0.0.1'})).status,400);
  const bytes=await readFile(join(dir,'model.enc')); assert.ok(!bytes.includes(Buffer.from('stored-api-secret'))); assert.equal((await stat(join(dir,'model.enc'))).mode & 0o777,0o600);
  app.closeAllConnections(); await new Promise(resolve=>app.close(resolve));
  ({ app, call }=await start());
  const restored=await (await call('/api/model')).json(); assert.deepEqual(restored.config,current);
  assert.equal((await call('/api/enhance',{prompt:'重启继续增强'})).status,200);
});

test('模型列表协议、分页、去重、错误及 Gemini 生成能力过滤', async () => {
  const { discoverModels } = await import('../models.mjs');
  const base = { baseURL:'https://model.example/v1',apiKey:'private-key' };
  for (const protocol of ['chat','responses','anthropic','gemini']) {
    let n=0;
    const ids=await discoverModels({...base,protocol},async(url,options)=>{
      assert.equal(options.method,'GET'); assert.equal(options.body,undefined); assert.ok(!url.includes('private-key')); n++;
      if(protocol==='anthropic') {
        assert.equal(options.headers['x-api-key'],'private-key');
        if(n===1)return Response.json({data:[{id:'a'}],has_more:true,last_id:'a'});
        assert.match(url,/after_id=a/); return Response.json({data:[{id:'b'},{id:'a'}],has_more:false});
      }
      if(protocol==='gemini') {
        assert.equal(options.headers['x-goog-api-key'],'private-key');
        if(n===1)return Response.json({models:[{name:'models/embed',supportedGenerationMethods:['embedContent']},{name:'models/a',supportedGenerationMethods:['generateContent']}],nextPageToken:'next'});
        assert.match(url,/pageToken=next/);return Response.json({models:[{name:'models/b',supportedGenerationMethods:['generateContent']}]});
      }
      assert.equal(options.headers.Authorization,'Bearer private-key');
      return Response.json({data:[{id:'b'},{id:'a'},{id:'a'},{id:'bad name'},null]});
    },AbortSignal.timeout(1000),r=>r.json());
    assert.deepEqual(ids,['a','b']);
  }
  await assert.rejects(discoverModels({...base,protocol:'chat'},async()=>Response.json({secret:'never display'}, {status:401}),AbortSignal.timeout(1000),r=>r.json()), /权限/);
  await assert.rejects(discoverModels({...base,protocol:'anthropic'},async()=>Response.json({data:[],has_more:true,last_id:'same'}),AbortSignal.timeout(1000),r=>r.json()), /分页/);
  assert.deepEqual(await discoverModels({...base,protocol:'chat'},async()=>Response.json({data:[]}),AbortSignal.timeout(1000),r=>r.json()),[]);
});
