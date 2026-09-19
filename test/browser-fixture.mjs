// 仅用于浏览器交互验收，不连接模型，不用于生产。
import { createApp } from '../server.mjs';
import { scryptSync, randomBytes } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const dir = await mkdtemp(join(tmpdir(), 'prompt-browser-'));
const salt = 'a'.repeat(32);
const app = await createApp({
  origin: 'http://127.0.0.1:3080', secure: false,
  passwordHash: `${salt}:${scryptSync('local-test-password', salt, 64).toString('hex')}`,
  modelURL: 'https://mock.invalid', apiKey: process.env.TEST_MODEL_UNCONFIGURED ? '' : 'mock', model: 'mock', timeoutMs: 45000,
  dataDir: dir, storageKey: randomBytes(32).toString('hex'), log: () => {}
}, async (url, options) => {
  await new Promise(resolve => setTimeout(resolve, 800));
  if (options.method === 'GET') return Response.json({ data: [{ id: 'demo-text-model' }, { id: 'demo-reasoning-model' }] });
  return Response.json({ choices: [{ finish_reason: 'stop', message: { content: '请撰写一封发给客户的邮件，说明项目将延期两天。语气诚恳，正文控制在 200 字以内，不作赔偿承诺。' } }] });
});
app.listen(3080, '127.0.0.1', () => console.log('仅供交互测试：使用固定模拟响应。'));
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, async () => { app.closeAllConnections(); app.close(); await rm(dir, { recursive: true, force: true }); });
