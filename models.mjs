import https from 'node:https';
import { lookup } from 'node:dns';
import { isIP } from 'node:net';

export const PROTOCOLS = ['chat', 'responses', 'anthropic', 'gemini'];
export const PROVIDERS = [
  ['openai', 'OpenAI', 'responses', 'https://api.openai.com/v1'],
  ['anthropic', 'Claude', 'anthropic', 'https://api.anthropic.com/v1'],
  ['gemini', 'Gemini', 'gemini', 'https://generativelanguage.googleapis.com/v1beta'],
  ['deepseek', 'DeepSeek', 'chat', 'https://api.deepseek.com/v1'],
  ['dashscope', '通义千问 / 百炼', 'chat', 'https://dashscope.aliyuncs.com/compatible-mode/v1'],
  ['siliconflow', '硅基流动', 'chat', 'https://api.siliconflow.cn/v1'],
  ['zhipu', '智谱 GLM', 'chat', 'https://open.bigmodel.cn/api/paas/v4'],
  ['openrouter', 'OpenRouter', 'chat', 'https://openrouter.ai/api/v1'],
  ['grok', 'Grok', 'chat', 'https://api.x.ai/v1'],
  ['minimax', 'MiniMax 国内', 'chat', 'https://api.minimaxi.com/v1'],
  ['minimax-global', 'MiniMax 国际', 'chat', 'https://api.minimax.io/v1'],
  ['modelscope', '魔搭', 'chat', 'https://api-inference.modelscope.cn/v1'],
  ['custom', '自定义兼容服务', 'chat', '']
].map(([id, name, protocol, baseURL]) => ({ id, name, protocol, baseURL }));
export class ModelError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}
export function publicIP(address) {
  if (isIP(address) === 4) {
    const [a,b,c] = address.split('.').map(Number);
    return !(a === 0 || a === 10 || a === 127 || a >= 224 || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && (b === 168 || b === 0 || (b === 88 && c === 99))) || (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100))) || (a === 203 && b === 0 && c === 113));
  }
  // 仅允许全球单播；排除映射地址、NAT64、隧道和文档网段。
  return isIP(address) === 6 && /^[23]/i.test(address) && !/^(2001:|2002:|3fff:)/i.test(address);
}
export function validateBase(value) {
  if (typeof value !== 'string' || value.length > 2048) throw new ModelError(400, 'API 基础地址无效或过长。');
  let url;
  try { url = new URL(value); } catch { throw new ModelError(400, '请填写有效的 HTTPS API 基础地址。'); }
  const host = url.hostname.replace(/^\[|\]$/g, '');
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || (url.port && url.port !== '443') || (isIP(host) && !publicIP(host)) || host === 'localhost' || !host.includes('.')) throw new ModelError(400, '模型地址必须是公网 HTTPS 地址，不得包含凭据、参数或非 443 端口。');
  if (/\/(chat\/completions|responses|messages|generateContent)\/?$/.test(url.pathname)) throw new ModelError(400, '请填写 API 基础地址，不要填写完整调用路径。');
  return url.href.replace(/\/+$/, '');
}
export function validateModel(input, previous, allowEmpty = false) {
  if (!PROTOCOLS.includes(input.protocol)) throw new ModelError(400, '请选择有效的接口协议。');
  const baseURL = validateBase(input.baseURL);
  if (typeof input.model !== 'string' || (!allowEmpty && !input.model.trim()) || input.model.length > 200 || /[\s\x00-\x1f]/.test(input.model.trim())) throw new ModelError(400, '模型名称不能为空、包含空白或超过 200 字符。');
  if (typeof input.apiKey !== 'string' || input.apiKey.length > 4096 || /[\x00-\x20\x7f]/.test(input.apiKey)) throw new ModelError(400, 'API 密钥格式无效。');
  const unchanged = previous.baseURL === baseURL && previous.protocol === input.protocol;
  const apiKey = input.apiKey || (unchanged ? previous.apiKey : '');
  if (!apiKey) throw new ModelError(400, '请填写 API 密钥；更换地址或协议时需重新填写。');
  return { protocol: input.protocol, baseURL, model: input.model.trim(), apiKey };
}
export const modelReady = c => !!(c.baseURL && c.model && c.apiKey);
export const publicModel = c => ({ protocol: c.protocol, baseURL: c.baseURL, model: c.model, hasKey: !!c.apiKey, revision: c.revision, ready: modelReady(c), models: c.models || (c.model ? [c.model] : []) });
export function modelRequest(c, system, prompt) {
  const headers = { 'Content-Type': 'application/json' };
  let suffix, payload;
  if (c.protocol === 'anthropic') {
    suffix = '/messages'; headers['x-api-key'] = c.apiKey; headers['anthropic-version'] = '2023-06-01';
    payload = { model: c.model, system, max_tokens: 8192, messages: [{ role: 'user', content: prompt }] };
  } else if (c.protocol === 'gemini') {
    suffix = `/models/${encodeURIComponent(c.model.replace(/^models\//, ''))}:generateContent`; headers['x-goog-api-key'] = c.apiKey;
    payload = { systemInstruction: { parts: [{ text: system }] }, contents: [{ role: 'user', parts: [{ text: prompt }] }] };
  } else {
    headers.Authorization = `Bearer ${c.apiKey}`;
    if (c.protocol === 'responses') { suffix = '/responses'; payload = { model: c.model, instructions: system, input: prompt, store: false, stream: false }; }
    else { suffix = '/chat/completions'; payload = { model: c.model, messages: [{ role: 'system', content: system }, { role: 'user', content: prompt }], stream: false }; }
  }
  return { url: c.baseURL + suffix, headers, body: JSON.stringify(payload) };
}
export function modelOutput(protocol, data) {
  let output;
  if (protocol === 'responses') {
    if (data.status === 'completed' && !data.error && !data.incomplete_details && Array.isArray(data.output)) {
      const messages = data.output.filter(x => x.type === 'message');
      if (messages.length && messages.every(x => x.status === 'completed' && x.role === 'assistant' && Array.isArray(x.content) && x.content.every(p => p.type === 'output_text' && typeof p.text === 'string'))) output = messages.flatMap(x => x.content).map(p => p.text).join('\n');
    }
  } else if (protocol === 'anthropic') {
    if (data.stop_reason === 'end_turn' && Array.isArray(data.content) && !data.content.some(p => p.type === 'tool_use')) output = data.content.filter(p => p.type === 'text').map(p => p.text).join('\n');
  } else if (protocol === 'gemini') {
    const candidate = data.candidates?.[0];
    if (!data.promptFeedback?.blockReason && candidate?.finishReason === 'STOP' && Array.isArray(candidate.content?.parts) && !candidate.content.parts.some(p => p.functionCall)) output = candidate.content.parts.filter(p => !p.thought && typeof p.text === 'string').map(p => p.text).join('\n');
  } else {
    const choice = data.choices?.[0];
    if (choice?.finish_reason === 'stop' && !choice.message?.refusal && !choice.message?.tool_calls) output = choice.message?.content;
  }
  if (typeof output !== 'string' || !output.trim() || output.length > 48000) throw new ModelError(502, '模型未返回完整正文，请缩短输入或检查模型配置后重试。');
  return output.trim();
}
// 在真实建立连接时校验 DNS，避免校验与请求之间的 DNS 重绑定；不跟随重定向。
export function safeModelFetch(url, options) {
  validateBase(new URL(url).origin);
  return new Promise((resolve, reject) => {
    const request = https.request(url, { method: options.method || 'POST', headers: options.headers, signal: options.signal, agent: false,
      lookup(host, opts, callback) {
        lookup(host, { all: true, verbatim: true }, (error, addresses) => {
          if (error) return callback(error);
          if (!addresses.length || addresses.some(a => !publicIP(a.address))) return callback(new Error('非公网模型地址'));
          if (opts.all) callback(null, addresses); else callback(null, addresses[0].address, addresses[0].family);
        });
      }
    }, response => {
      const chunks = []; let size = 0;
      response.on('data', chunk => { size += chunk.length; if (size > Math.min(options.maxBytes || 262144, 2097152)) { response.destroy(); reject(new ModelError(502, '模型响应过大，请缩短输入后重试。')); } else chunks.push(chunk); });
      response.on('error', reject);
      response.on('end', () => resolve(new Response([204, 205, 304].includes(response.statusCode) ? null : Buffer.concat(chunks), { status: response.statusCode })));
    });
    request.on('error', reject); request.end(options.body);
  });
}

export function catalogFields(input, previous, fields) {
  const same = previous.baseURL === fields.baseURL && previous.protocol === fields.protocol;
  const models = input.models ?? (same ? previous.models || (previous.model ? [previous.model] : []) : []);
  if (!Array.isArray(models) || models.length > 2000 || models.some(id => typeof id !== 'string' || !id || id.length > 200 || /[\s\x00-\x1f\x7f]/.test(id))) throw new ModelError(400, '模型列表格式无效或超过 2000 条。');
  if (input.models && fields.model && !models.includes(fields.model)) throw new ModelError(400, '请从列表选择模型，或先手动添加。');
  return { ...fields, models: [...new Set([...models, ...(fields.model ? [fields.model] : [])])] };
}
export async function discoverModels(config, fetcher, signal, readJSON) {
  const headers = {};
  if (config.protocol === 'anthropic') { headers['x-api-key'] = config.apiKey; headers['anthropic-version'] = '2023-06-01'; }
  else if (config.protocol === 'gemini') headers['x-goog-api-key'] = config.apiKey;
  else headers.Authorization = `Bearer ${config.apiKey}`;
  const ids = new Set(), cursors = new Set(); let cursor = '';
  for (let page = 0; page < 20; page++) {
    const url = new URL(config.baseURL + '/models');
    if (config.protocol === 'gemini') { url.searchParams.set('pageSize', '1000'); if (cursor) url.searchParams.set('pageToken', cursor); }
    if (config.protocol === 'anthropic') { url.searchParams.set('limit', '1000'); if (cursor) url.searchParams.set('after_id', cursor); }
    const response = await fetcher(url.href, { method: 'GET', headers, signal, redirect: 'error', maxBytes: 2097152 });
    if (!response.ok) {
      await response.body?.cancel();
      throw new ModelError(502, [401,403].includes(response.status) ? '拉取失败，请检查密钥、权限或地区限制。' : [404,405].includes(response.status) ? '此地址不支持模型列表接口，请检查基础地址，或使用手动添加。' : '模型列表拉取失败，请稍后重试；已有列表未改变。');
    }
    const data = await readJSON(response, 2097152);
    const items = config.protocol === 'gemini' ? data.models : data.data;
    if (!Array.isArray(items)) throw new ModelError(502, '服务商返回的模型列表格式不兼容。');
    for (const item of items) {
      if (!item || typeof item !== 'object') continue;
      if (config.protocol === 'gemini' && !item.supportedGenerationMethods?.includes('generateContent')) continue;
      const id = config.protocol === 'gemini' ? item.name?.replace(/^models\//, '') : item.id;
      if (typeof id === 'string' && id && id.length <= 200 && !/[\s\x00-\x1f\x7f]/.test(id)) ids.add(id);
      if (ids.size > 2000) throw new ModelError(502, '模型列表超过 2000 条，请使用范围更小的服务地址。');
    }
    const next = config.protocol === 'gemini' ? data.nextPageToken : config.protocol === 'anthropic' && data.has_more ? data.last_id : '';
    if (!next) {
      if (config.protocol === 'anthropic' && data.has_more) throw new ModelError(502, '服务商分页信息不完整，请稍后重试。');
      return [...ids].sort((a,b) => a.localeCompare(b));
    }
    if (typeof next !== 'string' || next.length > 2048 || cursors.has(next)) throw new ModelError(502, '服务商分页信息无效。');
    cursors.add(next); cursor = next;
  }
  throw new ModelError(502, '模型列表分页过多，请使用范围更小的服务地址。');
}
