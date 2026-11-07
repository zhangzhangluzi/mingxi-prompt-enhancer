import { PROTOCOLS, catalogFields, validateModel } from './models.mjs';

export const TRANSFER_FORMAT = 'mingxi-data-export';
export const TRANSFER_VERSION = 1;
export const TRANSFER_MODULES = ['guides', 'favorites', 'models'];

const recordId = /^[a-z0-9-]{1,64}$/;

function fail(message) {
  const error = new Error(message);
  error.status = 400;
  throw error;
}

function text(record, key, label, max, required = true) {
  const value = record[key] ?? (required ? null : '');
  if (typeof value !== 'string') fail(`${label}必须是文本。`);
  if (required && !value.trim()) fail(`${label}不能为空。`);
  if ([...value].length > max) fail(`${label}不能超过 ${max} 个字符。`);
  return value;
}

function timestamp(value, label, fallback) {
  if (value === undefined) return fallback;
  if (typeof value !== 'string' || !Number.isFinite(Date.parse(value))) fail(`${label}必须是有效日期。`);
  return new Date(value).toISOString();
}

function common(record, moduleLabel, index, fallback) {
  const prefix = `${moduleLabel}第 ${index + 1} 条`;
  if (!record || typeof record !== 'object' || Array.isArray(record)) fail(`${prefix}必须是对象。`);
  if (typeof record.id !== 'string' || !recordId.test(record.id)) fail(`${prefix}的记录 ID 无效。`);
  if (!Number.isSafeInteger(record.revision) || record.revision < 1) fail(`${prefix}的版本号无效。`);
  const legacyTime = timestamp(record.updatedAt, `${prefix}的更新时间`, fallback);
  const createdAt = timestamp(record.createdAt, `${prefix}的创建时间`, legacyTime);
  const updatedAt = timestamp(record.updatedAt, `${prefix}的更新时间`, createdAt);
  return { id: record.id, revision: record.revision, createdAt, updatedAt };
}

function unique(records, label) {
  const ids = new Set();
  for (const record of records) {
    if (ids.has(record.id)) fail(`${label}中存在重复的记录 ID：${record.id}。`);
    ids.add(record.id);
  }
  return records;
}

function array(data, key, label) {
  if (!Object.hasOwn(data, key)) return null;
  if (!Array.isArray(data[key])) fail(`${label}必须是数组。`);
  if (data[key].length > 100) fail(`${label}不能超过 100 条。`);
  return data[key];
}

function normalizeGuides(records, fallback) {
  if (records === null) return null;
  return unique(records.map((record, index) => {
    const prefix = `指引第 ${index + 1} 条`;
    return {
      ...common(record, '指引', index, fallback),
      name: text(record, 'name', `${prefix}的名称`, 80).trim(),
      category: text(record, 'category', `${prefix}的分类`, 30).trim(),
      description: text(record, 'description', `${prefix}的说明`, 300),
      instructions: text(record, 'instructions', `${prefix}的内容`, 4000)
    };
  }), '指引');
}

function normalizeFavorites(records, fallback) {
  if (records === null) return null;
  return unique(records.map((record, index) => {
    const prefix = `已收藏第 ${index + 1} 条`;
    const { guideId } = record ?? {};
    if (guideId !== undefined && guideId !== '' && (typeof guideId !== 'string' || !recordId.test(guideId))) fail(`${prefix}的指引 ID 无效。`);
    return {
      ...common(record, '已收藏', index, fallback),
      title: text(record, 'title', `${prefix}的标题`, 100, false),
      original: text(record, 'original', `${prefix}的原文`, 8000),
      result: text(record, 'result', `${prefix}的正文`, 48000),
      guideName: text(record, 'guideName', `${prefix}的指引名称`, 80, false),
      ...(guideId === undefined ? {} : { guideId })
    };
  }), '已收藏');
}

function normalizeModels(records, fallback) {
  if (records === null) return null;
  return unique(records.map((record, index) => {
    const prefix = `模型配置第 ${index + 1} 条`;
    const base = common(record, '模型配置', index, fallback);
    const name = text(record, 'name', `${prefix}的模块名称`, 80).trim();
    if (!PROTOCOLS.includes(record.protocol)) fail(`${prefix}的接口协议无效。`);
    const baseURL = text(record, 'baseURL', `${prefix}的 API 基础地址`, 2048, false);
    const apiKey = text(record, 'apiKey', `${prefix}的 API 密钥`, 4096, false);
    const model = text(record, 'model', `${prefix}的模型名称`, 200, false);
    if (!Array.isArray(record.models)) fail(`${prefix}的模型列表必须是数组。`);
    if (!baseURL && !apiKey && !model) {
      if (record.models.length) fail(`${prefix}未配置连接时模型列表必须为空。`);
      return { ...base, name, protocol: record.protocol, baseURL: '', apiKey: '', model: '', models: [] };
    }
    try {
      const fields = validateModel({ protocol: record.protocol, baseURL, apiKey, model }, { protocol: '', baseURL: '', apiKey: '' }, true);
      return { ...base, name, ...catalogFields({ models: record.models }, { models: [] }, fields) };
    } catch (error) {
      fail(`${prefix}无效：${error.message}`);
    }
  }), '模型配置');
}

export function validateTransfer(payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) fail('导入内容必须是 JSON 对象。');
  if (payload.format !== TRANSFER_FORMAT) fail(`format 必须为 ${TRANSFER_FORMAT}。`);
  if (payload.version !== TRANSFER_VERSION) fail(`仅支持版本 ${TRANSFER_VERSION} 的导入数据。`);
  if (typeof payload.exportedAt !== 'string') fail('导出时间必须是有效日期。');
  if (!payload.data || typeof payload.data !== 'object' || Array.isArray(payload.data)) fail('data 必须是对象。');
  const present = TRANSFER_MODULES.filter(key => Object.hasOwn(payload.data, key));
  if (!present.length) fail('data 中至少需要包含指引、已收藏或模型配置中的一项。');
  const exportedAt = timestamp(payload.exportedAt, '导出时间', '');
  return {
    format: TRANSFER_FORMAT,
    version: TRANSFER_VERSION,
    exportedAt,
    data: {
      guides: normalizeGuides(array(payload.data, 'guides', '指引'), exportedAt),
      favorites: normalizeFavorites(array(payload.data, 'favorites', '已收藏'), exportedAt),
      models: normalizeModels(array(payload.data, 'models', '模型配置'), exportedAt)
    }
  };
}

export function createTransfer(guides, favorites, models) {
  return validateTransfer({
    format: TRANSFER_FORMAT,
    version: TRANSFER_VERSION,
    exportedAt: new Date().toISOString(),
    data: { guides, favorites, models }
  });
}
