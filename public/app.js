const $ = id => document.getElementById(id);
const preferenceKeys = { module: 'mingxi.lastApiModule', direction: 'mingxi.lastDirection', guideView: 'mingxi.guideView', historyView: 'mingxi.historyView', modelView: 'mingxi.modelView' };
function readPreference(key) { try { return localStorage.getItem(key) || ''; } catch { return ''; } }
function savePreference(key, value) { try { localStorage.setItem(key, value); } catch {} }
const viewTargets = { guides: ['guide-list', preferenceKeys.guideView], history: ['history-list', preferenceKeys.historyView], models: ['model-summary-list', preferenceKeys.modelView] };
const panelPaths = { editor: '/app', guides: '/app/guides', history: '/app/history', models: '/app/models', data: '/app/data' };
function panelFromPath() { return Object.entries(panelPaths).find(([, path]) => location.pathname === path)?.[0] || 'editor'; }
function setViewMode(scope, mode) {
  const [targetId, storageKey] = viewTargets[scope] || [];
  if (!targetId) return;
  const selected = mode === 'grid' ? 'grid' : 'list';
  $(targetId).dataset.view = selected;
  for (const button of document.querySelectorAll(`[data-view-scope="${scope}"]`)) button.setAttribute('aria-pressed', String(button.dataset.viewMode === selected));
  savePreference(storageKey, selected);
}
for (const button of document.querySelectorAll('[data-view-scope]')) button.addEventListener('click', () => setViewMode(button.dataset.viewScope, button.dataset.viewMode));
for (const [scope, [, storageKey]] of Object.entries(viewTargets)) setViewMode(scope, readPreference(storageKey));
let maxInput = 8000;
let busy = false;
let request;
let expiresTimer;
let undoStack = [];
let source = '';
let applied = false;
let authenticated = false;
let initialized = true;
let historyEnabled = false;
let saving = false;
let epoch = 0;
let currentPanel = 'editor';
let guides = [];
let records = [];
let activeRecord = null;
let resultGuide = '';
let editingGuide = null;
let editingHistory = null;
let modalBusy = false;
let modalSnapshot = '';
let libraryBusy = false;
let confirmResolve;
let modelConfig = null;
let modelProviders = [];
let modelBusy = false;
let modelCatalog = [];
let modelModules = [];
const DATA_IMPORT_MAX_BYTES = 16 * 1024 * 1024;
let selectedModuleId = readPreference(preferenceKeys.module);
let modelSnapshot = '';
let modelTransitioning = false;
let statusTimer;
let transferPayload = null;
let exportBusy = false;
let importBusy = false;
let exportStatusTimer;
let importStatusTimer;

async function api(path, data, signal) {
  const generation = epoch;
  const response = await fetch(path, { method: data === undefined ? 'GET' : 'POST', credentials: 'same-origin', headers: data === undefined ? {} : { 'Content-Type': 'application/json' }, body: data === undefined ? undefined : JSON.stringify(data), signal, cache: 'no-store' });
  const json = await response.json();
  if (generation !== epoch) throw new Error('会话已改变，请重试。');
  if (!response.ok) {
    if (response.status === 401 && !['/api/login', '/api/password'].includes(path)) lock(true);
    throw new Error(json.error || '请求失败，请稍后重试。');
  }
  return json;
}
function showError(message = '') { $('error').textContent = message; }
function clearStatus() { clearTimeout(statusTimer); statusTimer = undefined; $('status').textContent = ''; }
function showStatus(message, delay = 3000) {
  clearStatus();
  $('status').textContent = message;
  if (message && delay > 0) statusTimer = setTimeout(clearStatus, delay);
}
function update() {
  const count = [...$('prompt').value].length;
  const overLimit = count > maxInput;
  $('counter').textContent = `${count.toLocaleString()} / ${maxInput.toLocaleString()}`;
  $('counter').classList.toggle('over-limit', overLimit);
  $('prompt').setAttribute('aria-invalid', String(overLimit));
  $('prompt').setAttribute('aria-describedby', overLimit ? 'input-help counter error' : 'input-help counter');
  $('enhance').disabled = busy;
  $('undo').disabled = busy || !undoStack.length;
  $('replace').disabled = busy || !$('result').value || applied;
  $('copy').disabled = busy || !$('result').value;
  $('save').disabled = busy || saving || !$('result').value;
  $('prompt').readOnly = busy; $('result').readOnly = busy || saving;
  $('result-title').disabled = busy || saving; $('direction').disabled = busy;
  $('save').textContent = saving ? '正在保存…' : activeRecord ? '保存修改' : '保存到已收藏';
  $('save-copy').hidden = !historyEnabled || !activeRecord; $('save-copy').disabled = busy || saving;
  $('cancel').hidden = !busy;
  $('result-card').setAttribute('aria-busy', String(busy));
  $('enhance').textContent = busy ? '正在增强…' : '增强提示语 ↗';
}
function lock(isInitialized = true, updatePath = true) {
  authenticated = false; initialized = isInitialized; epoch++;
  modelConfig = null; modelProviders = []; modelCatalog = []; modelModules = []; selectedModuleId = readPreference(preferenceKeys.module); modelSnapshot = ''; modelTransitioning = false; renderModelCatalog(); renderModuleSelectors(); $('model-form').reset(); $('model-provider').replaceChildren(); $('model-key-status').textContent = ''; $('model-feedback').textContent = ''; $('model-fields').disabled = true; $('model-editor').hidden = true;
  settleConfirmation(false);
  for (const id of ['guide-dialog', 'history-dialog', 'password-dialog']) $(id).close();
  $('guide-form').reset(); $('history-form').reset(); $('password-form').reset();
  guides = []; records = []; activeRecord = null; resultGuide = ''; editingGuide = null; editingHistory = null;
  $('guide-list').replaceChildren(); $('history-list').replaceChildren();
  $('direction').replaceChildren(new Option('通用增强 · 不指定方向', ''));
  $('result-title').value = ''; $('result-title-wrap').hidden = true;
  request?.abort();
  clearTimeout(expiresTimer);
  $('prompt').value = ''; $('result').value = ''; $('password').value = ''; $('setup-form').reset();
  transferPayload = null; exportBusy = false; importBusy = false;
  clearTimeout(exportStatusTimer); clearTimeout(importStatusTimer);
  $('export-json').value = ''; $('import-json').value = ''; $('export-status').textContent = ''; $('import-status').textContent = '';
  $('import-modules').hidden = true; $('import-submit-wrap').hidden = true; $('export-copy').disabled = true;
  undoStack = []; source = ''; applied = false;
  $('result').hidden = true; $('empty-result').hidden = false;
  $('result-tag').textContent = '等待你的想法';

  clearStatus(); showError();
  $('workspace').hidden = true; $('logout').hidden = true; $('change-password').hidden = true;
  $('login-view').hidden = !isInitialized; $('setup-view').hidden = isInitialized;
  if (updatePath) history.replaceState(null, '', isInitialized ? '/login' : '/setup');
  update();
}
function unlock(session) {
  authenticated = true; initialized = true; epoch++;
  maxInput = session.maxInput;
  historyEnabled = session.historyEnabled;
  $('save').hidden = !historyEnabled; $('new-guide').disabled = !historyEnabled;
  $('password').value = ''; $('login-error').textContent = ''; $('setup-error').textContent = '';
  $('login-view').hidden = true; $('setup-view').hidden = true; $('workspace').hidden = false; $('logout').hidden = false; $('change-password').hidden = false;
  const panel = panelFromPath();
  if (!location.pathname.startsWith('/app')) history.replaceState(null, '', panelPaths[panel]);
  clearTimeout(expiresTimer);
  expiresTimer = setTimeout(() => { lock(true); $('login-error').textContent = '会话已过期，页面内容已清除，请重新登录。'; }, Math.max(0, session.expiresAt - Date.now()));
  update(); $('prompt').focus();
  $('model-notice').hidden = session.modelReady;
  showPanel(panel, false); if (panel !== 'guides') loadGuides(); loadModuleSelectors();
}
$('setup-form').addEventListener('submit', async event => {
  event.preventDefault();
  const password = $('setup-password').value, confirmation = $('setup-confirmation').value;
  $('setup-error').textContent = '';
  if ([...password].length < 16 || [...password].length > 256) { $('setup-error').textContent = '密码必须为 16–256 个字符。'; return; }
  if (password !== confirmation) { $('setup-error').textContent = '两次输入的密码不一致。'; return; }
  $('setup-button').disabled = true; $('setup-button').textContent = '正在初始化…';
  try { unlock(await api('/api/auth/initialize', { password, confirmation }, AbortSignal.timeout(20000))); }
  catch (error) { $('setup-error').textContent = error.name === 'TimeoutError' ? '初始化超时，请重试。' : error.message; }
  finally { $('setup-button').disabled = false; $('setup-button').textContent = '完成初始化 →'; }
});
$('login-form').addEventListener('submit', async event => {
  event.preventDefault(); $('login-button').disabled = true; $('login-button').textContent = '正在验证…'; $('login-error').textContent = '';
  try { unlock(await api('/api/login', { password: $('password').value }, AbortSignal.timeout(15000))); }
  catch (error) { $('login-error').textContent = error.name === 'TimeoutError' ? '登录超时，请重试。' : error.message; }
  finally { $('login-button').disabled = false; $('login-button').textContent = '进入工作台 →'; }
});
$('logout').addEventListener('click', async () => {
  $('logout').disabled = true;
  try { await api('/api/logout', {}, AbortSignal.timeout(15000)); lock(true); $('password').focus(); }
  catch { showError('退出失败，请检查网络后重试。'); }
  finally { $('logout').disabled = false; }
});
$('change-password').addEventListener('click', () => {
  $('password-form').reset(); $('password-error').textContent = ''; $('password-dialog').showModal(); $('current-password').focus();
});
$('password-form').addEventListener('submit', async event => {
  event.preventDefault();
  const currentPassword = $('current-password').value, newPassword = $('new-password').value, confirmation = $('new-password-confirmation').value;
  $('password-error').textContent = '';
  if ([...newPassword].length < 16 || [...newPassword].length > 256) { $('password-error').textContent = '新密码必须为 16–256 个字符。'; return; }
  if (newPassword !== confirmation) { $('password-error').textContent = '两次输入的新密码不一致。'; return; }
  $('password-submit').disabled = true; $('password-submit').textContent = '正在更新…';
  try {
    await api('/api/password', { currentPassword, newPassword, confirmation }, AbortSignal.timeout(20000));
    $('password-dialog').close(); lock(true); $('login-error').textContent = '密码已更新，请使用新密码重新登录。'; $('password').focus();
  } catch (error) { if (authenticated) $('password-error').textContent = error.name === 'TimeoutError' ? '更新超时，请重试。' : error.message; }
  finally { $('password-submit').disabled = false; $('password-submit').textContent = '更新密码'; }
});
function renderModuleSelectors() { const select = $('api-module-select'); select.replaceChildren(new Option(modelModules.length ? '请选择 API 模块' : '默认 API 模块', '')); for (const item of modelModules) select.add(new Option(`${item.name} · ${item.model || '未选择模型'}`, item.id)); select.value = selectedModuleId; }
$('api-module-select').addEventListener('change', () => { selectedModuleId = $('api-module-select').value; savePreference(preferenceKeys.module, selectedModuleId); });
async function loadModuleSelectors() { try { const data = await api('/api/models', undefined, AbortSignal.timeout(15000)); modelModules = data.modules || []; if (!selectedModuleId || !modelModules.some(m => m.id === selectedModuleId)) selectedModuleId = modelModules[0]?.id || ''; savePreference(preferenceKeys.module, selectedModuleId); renderModuleSelectors(); } catch (error) { if (authenticated) showError(error.message); } }
async function enhance() {
  if (busy || !authenticated) return;
  showError(); clearStatus();
  const prompt = $('prompt').value;
  if (!prompt.trim()) { showError('请先输入需要增强的提示语。'); $('prompt').setAttribute('aria-invalid', 'true'); $('prompt').setAttribute('aria-describedby', 'input-help counter error'); $('prompt').focus(); return; }
  if ([...prompt].length > maxInput) { showError(`输入超过 ${maxInput.toLocaleString()} 个字符，请缩短后重试。`); $('prompt').focus(); return; }
  busy = true; request = new AbortController(); update();
  const timer = setTimeout(() => request.abort('timeout'), 55000);
  try {
    if (modelModules.length && !selectedModuleId) { showError('请先选择一个 API 模块。'); busy = false; request = null; update(); return; }
    const data = await api('/api/enhance', { prompt, guideId: $('direction').value, moduleId: selectedModuleId }, request.signal);
    if (!authenticated || request.signal.aborted) return;
    source = prompt; applied = false; activeRecord = null; resultGuide = data.guideName || '';
    $('result-title').value = ''; $('result-title-wrap').hidden = true;
    $('result').value = data.result; $('result').hidden = false; $('empty-result').hidden = true;
    $('result-tag').textContent = '可直接使用';
    showStatus('增强完成。');
  } catch (error) {
    if (!authenticated) { $('login-error').textContent = '登录已过期，请重新登录。'; return; }
    if (request.signal.aborted) showStatus(request.signal.reason === 'timeout' ? '请求超时，原文已保留。请重试。' : '已取消，原文已保留。');
    else { clearStatus(); showError(error.message || '网络连接失败，请重试。'); }
  } finally { clearTimeout(timer); busy = false; request = null; update(); }
}
$('enhance').addEventListener('click', enhance);
$('cancel').addEventListener('click', () => request?.abort());
$('prompt').addEventListener('input', () => { applied = false; update(); showError(); });
$('result').addEventListener('input', () => { applied = false; update(); });
$('replace').addEventListener('click', async () => {
  if (!$('result').value || busy || applied) return;
  if ($('prompt').value !== source && !await askConfirm('原文在增强后已修改，是否用增强结果替换？可通过“撤销替换”恢复当前内容。')) return;
  undoStack.push($('prompt').value); if (undoStack.length > 10) undoStack.shift();
  $('prompt').value = $('result').value; applied = true; update(); showError();
  showStatus('已替换，可撤销。'); $('prompt').focus();
});
$('undo').addEventListener('click', () => {
  if (!undoStack.length || busy) return;
  $('prompt').value = undoStack.pop(); applied = false; update(); showError();
  showStatus('已恢复原文。'); $('prompt').focus();
});
$('copy').addEventListener('click', async () => {
  try { await navigator.clipboard.writeText($('result').value); showStatus('复制成功', 1800); }
  catch { $('result').focus(); $('result').select(); showError('浏览器未允许自动复制，已选中正文，请按 Ctrl+C 或 ⌘C 复制。'); }
});
async function saveResult(asCopy = false) {
  if (!historyEnabled || saving || busy) return;
  if (!$('result').value.trim()) return showError('请填写需要保存的提示语正文。');
  saving = true; update(); showError();
  const previous = activeRecord;
  try {
    const fields = { title: $('result-title').value, original: source, result: $('result').value, guideName: resultGuide, asCopy };
    const data = await api(previous && !asCopy ? '/api/history/update' : '/api/history', { ...fields, ...(previous && !asCopy ? { id: previous.id, revision: previous.revision } : {}) }, AbortSignal.timeout(15000));
    activeRecord = data.record;
    showStatus(previous && !asCopy ? '收藏已更新。' : '已保存到收藏。');
  } catch (error) { if (authenticated) showError(error.message); }
  finally { saving = false; update(); }
}
$('save').addEventListener('click', () => saveResult());
$('save-copy').addEventListener('click', () => saveResult(true));
function showPanel(panel, updatePath = true) {
  if (currentPanel === 'data' && panel !== 'data') {
    $('export-json').value = ''; $('import-json').value = ''; $('export-copy').disabled = true;
    transferFeedback('export'); resetImportSelection();
  }
  currentPanel = panel;
  for (const name of ['editor', 'guides', 'history', 'models', 'data']) $(name + '-panel').hidden = name !== panel;
  for (const button of document.querySelectorAll('[data-panel]')) {
    if (button.dataset.panel === panel) button.setAttribute('aria-current', 'page'); else button.removeAttribute('aria-current');
  }
  showError();
  if (updatePath && location.pathname !== panelPaths[panel]) history.pushState(null, '', panelPaths[panel]);
  if (panel === 'guides') loadGuides();
  if (panel === 'history') loadHistory();
  if (panel === 'models' && !modelConfig && !modelBusy) loadModel();
  if (panel === 'data' && !$('export-json').value && !exportBusy) loadDataExport();
}
for (const button of document.querySelectorAll('[data-panel]')) button.addEventListener('click', () => showPanel(button.dataset.panel));
window.addEventListener('popstate', () => { if (authenticated) showPanel(panelFromPath(), false); });
function transferFeedback(kind, message = '', error = false, delay = 0) {
  const timerName = kind === 'export' ? 'exportStatusTimer' : 'importStatusTimer';
  if (timerName === 'exportStatusTimer') { clearTimeout(exportStatusTimer); exportStatusTimer = undefined; }
  else { clearTimeout(importStatusTimer); importStatusTimer = undefined; }
  const node = $(`${kind}-status`);
  node.textContent = message;
  node.classList.toggle('error', error);
  if (message && delay > 0) {
    const timer = setTimeout(() => { node.textContent = ''; node.classList.remove('error'); }, delay);
    if (timerName === 'exportStatusTimer') exportStatusTimer = timer; else importStatusTimer = timer;
  }
}
async function loadDataExport() {
  if (!authenticated || exportBusy) return;
  exportBusy = true; $('export-refresh').disabled = true; $('export-copy').disabled = true;
  transferFeedback('export', '正在生成…');
  try {
    const payload = await api('/api/data/export', undefined, AbortSignal.timeout(20000));
    $('export-json').value = JSON.stringify(payload, null, 2);
    $('export-copy').disabled = false;
    transferFeedback('export', `已生成：指引 ${payload.data.guides.length} 条，已收藏 ${payload.data.favorites.length} 条，模型配置 ${payload.data.models.length} 条。`);
  } catch (error) {
    if (authenticated) transferFeedback('export', error.name === 'TimeoutError' ? '生成超时，请重试。' : error.message, true);
  } finally { exportBusy = false; $('export-refresh').disabled = false; }
}
$('export-refresh').addEventListener('click', loadDataExport);
$('export-copy').addEventListener('click', async () => {
  if (!$('export-json').value) return;
  try {
    await navigator.clipboard.writeText($('export-json').value);
    transferFeedback('export', 'JSON 已复制。', false, 1800);
  } catch {
    $('export-json').focus(); $('export-json').select();
    transferFeedback('export', '浏览器未允许自动复制，已选中 JSON，请手动复制。', true);
  }
});
function resetImportSelection(clearFeedback = true) {
  transferPayload = null;
  $('import-modules').hidden = true; $('import-submit-wrap').hidden = true; $('import-submit').disabled = true;
  if (clearFeedback) transferFeedback('import');
}
$('import-json').addEventListener('input', () => resetImportSelection());
$('import-parse').addEventListener('click', () => {
  resetImportSelection(false);
  const source = $('import-json').value;
  if (!source.trim()) return transferFeedback('import', '请先粘贴 JSON 内容。', true);
  if (new Blob([source]).size > DATA_IMPORT_MAX_BYTES) return transferFeedback('import', 'JSON 超过 16 MiB 导入上限，请缩减数据后重试。', true);
  let payload;
  try { payload = JSON.parse(source); }
  catch (error) { return transferFeedback('import', `JSON 格式错误：${error.message}`, true); }
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return transferFeedback('import', '导入内容必须是 JSON 对象。', true);
  if (payload.format !== 'mingxi-data-export') return transferFeedback('import', 'format 必须为 mingxi-data-export。', true);
  if (payload.version !== 1) return transferFeedback('import', '仅支持版本 1 的导入数据。', true);
  if (typeof payload.exportedAt !== 'string' || !Number.isFinite(Date.parse(payload.exportedAt))) return transferFeedback('import', '导出时间必须是有效日期。', true);
  if (!payload.data || typeof payload.data !== 'object' || Array.isArray(payload.data)) return transferFeedback('import', 'data 必须是对象。', true);
  const labels = { guides: '指引', favorites: '已收藏', models: '模型配置' };
  let available = 0;
  for (const input of $('import-modules').querySelectorAll('input[type="checkbox"]')) {
    const value = payload.data[input.value];
    const present = Object.hasOwn(payload.data, input.value);
    if (present && !Array.isArray(value)) return transferFeedback('import', `${labels[input.value]}必须是数组。`, true);
    if (present && value.length > 100) return transferFeedback('import', `${labels[input.value]}不能超过 100 条。`, true);
    input.parentElement.hidden = !present; input.checked = present;
    if (present) { available++; $(`import-${input.value}-count`).textContent = `${value.length} 条`; }
  }
  if (!available) return transferFeedback('import', 'data 中至少需要包含指引、已收藏或模型配置中的一项。', true);
  transferPayload = payload; $('import-modules').hidden = false; $('import-submit-wrap').hidden = false; $('import-submit').disabled = false;
  transferFeedback('import', '格式已解析，请选择要导入的模块。');
});
for (const input of $('import-modules').querySelectorAll('input[type="checkbox"]')) input.addEventListener('change', () => {
  $('import-submit').disabled = importBusy || !$('import-modules').querySelector('input:checked');
});
$('import-submit').addEventListener('click', async () => {
  if (!transferPayload || importBusy) return;
  const modules = [...$('import-modules').querySelectorAll('input:checked')].map(input => input.value);
  if (!modules.length) return transferFeedback('import', '请至少选择一个模块。', true);
  const names = { guides: '指引', favorites: '已收藏', models: '模型配置' };
  if (!await askConfirm(`导入将完整覆盖${modules.map(name => names[name]).join('、')}的当前数据，未选模块保持不变。是否继续？`)) return;
  importBusy = true; $('import-parse').disabled = true; $('import-submit').disabled = true;
  transferFeedback('import', '正在校验并导入…');
  try {
    const result = await api('/api/data/import', { payload: transferPayload, modules }, AbortSignal.timeout(60000));
    if (modules.includes('guides')) await loadGuides();
    if (modules.includes('favorites')) { activeRecord = null; await loadHistory(); update(); }
    if (modules.includes('models')) { modelConfig = null; await loadModel(); await loadModuleSelectors(); }
    await loadDataExport();
    const summary = modules.map(name => `${names[name]} ${result.imported[name]} 条`).join('，');
    transferFeedback('import', `导入完成：${summary}。`, false, 4000);
  } catch (error) {
    if (authenticated) transferFeedback('import', error.name === 'TimeoutError' ? '导入超时，请刷新后核对数据。' : error.message, true);
  } finally {
    importBusy = false; $('import-parse').disabled = false;
    $('import-submit').disabled = !$('import-modules').querySelector('input:checked');
  }
});
function element(tag, text, className) {
  const node = document.createElement(tag); if (text) node.textContent = text; if (className) node.className = className; return node;
}
function action(text, onClick, className = 'secondary') {
  const button = element('button', text, className); button.type = 'button'; button.addEventListener('click', onClick); return button;
}
function directions() {
  const selected = $('direction').value || readPreference(preferenceKeys.direction);
  $('direction').replaceChildren(new Option('通用增强 · 不指定方向', ''), ...guides.map(g => new Option(`${g.category} · ${g.name}`, g.id)));
  $('direction').value = guides.some(g => g.id === selected) ? selected : '';
  savePreference(preferenceKeys.direction, $('direction').value);
  const category = $('guide-category').value;
  const categories = [...new Set(guides.map(g => g.category))];
  $('guide-category').replaceChildren(new Option('全部分类', ''), ...categories.map(c => new Option(c, c)));
  if (categories.includes(category)) $('guide-category').value = category;
  $('guide-categories').replaceChildren(...categories.map(c => new Option(c, c)));
}
$('direction').addEventListener('change', () => savePreference(preferenceKeys.direction, $('direction').value));
async function loadGuides() {
  $('refresh-guides').disabled = true;
  try { const data = await api('/api/guides', undefined, AbortSignal.timeout(15000)); guides = data.records; directions(); renderGuides(); }
  catch (error) { if (authenticated) showError(error.message); }
  finally { $('refresh-guides').disabled = false; }
}
async function loadHistory() {
  $('refresh-history').disabled = true;
  try { const data = await api('/api/history', undefined, AbortSignal.timeout(15000)); records = data.records; renderHistory(); }
  catch (error) { if (authenticated) showError(error.message); }
  finally { $('refresh-history').disabled = false; }
}
$('refresh-guides').addEventListener('click', loadGuides);
$('refresh-history').addEventListener('click', loadHistory);
$('guide-search').addEventListener('input', renderGuides);
$('guide-category').addEventListener('change', renderGuides);
$('history-search').addEventListener('input', renderHistory);
function renderGuides() {
  const query = $('guide-search').value.toLocaleLowerCase().trim(); const category = $('guide-category').value;
  const filtered = guides.filter(g => (!category || g.category === category) && [g.name, g.category, g.description, g.instructions].some(v => v.toLocaleLowerCase().includes(query)));
  $('guide-count').textContent = `${filtered.length} 条指引 / 共 ${guides.length} 条`;
  const list = $('guide-list'); list.replaceChildren();
  if (!filtered.length) list.append(element('p', guides.length ? '没有匹配的指引，试试其他关键词。' : '暂无指引，点击“新增指引”创建你的第一条优化方法。', 'empty-list'));
  for (const g of filtered) {
    const card = element('article', '', 'record-card'); const top = element('div', '', 'record-top');
    top.append(element('h3', g.name), element('span', g.category, 'category-badge'));
    const actions = element('div', '', 'record-actions');
    actions.append(action('使用指引', () => { if (busy) return showError('请等待当前增强完成。'); $('direction').value = g.id; savePreference(preferenceKeys.direction, g.id); showPanel('editor'); $('prompt').focus(); }), action('编辑', () => openGuide(g)), action('删除', () => removeRecord('guides', g), 'danger-button'));
    card.append(top, element('p', g.description, 'record-preview'), element('p', g.instructions, 'record-preview'), actions); list.append(card);
  }
}
function renderHistory() {
  const query = $('history-search').value.toLocaleLowerCase().trim();
  const filtered = records.filter(r => [r.title || '', r.original, r.result].some(v => v.toLocaleLowerCase().includes(query))).sort((a, b) => (b.updatedAt || b.createdAt).localeCompare(a.updatedAt || a.createdAt));
  $('history-count').textContent = `${filtered.length} 条记录 / 共 ${records.length} 条`;
  const list = $('history-list'); list.replaceChildren();
  if (!filtered.length) list.append(element('p', records.length ? '没有匹配的收藏，试试其他关键词。' : '还没有收藏。增强后点击“保存到已收藏”，才会保存这条结果。', 'empty-list'));
  for (const r of filtered) {
    const card = element('article', '', 'record-card'); const top = element('div', '', 'record-top');
    top.append(element('h3', r.title || '未命名收藏'), element('span', r.guideName || '通用增强', 'category-badge'));
    const actions = element('div', '', 'record-actions');
    const copyButton = action('复制正文', async () => { try { await navigator.clipboard.writeText(r.result); const label = copyButton.textContent; copyButton.textContent = '已复制'; copyButton.disabled = true; setTimeout(() => { copyButton.textContent = label; copyButton.disabled = false; }, 1800); } catch { openHistory(r); $('history-result').select(); $('history-form-error').textContent = '自动复制未获允许，已选中正文，请手动复制。'; } });
    actions.append(action('载入迭代', () => restoreRecord(r)), action('编辑', () => openHistory(r)), copyButton, action('删除', () => removeRecord('history', r), 'danger-button'));
    card.append(top, element('p', `${new Date(r.updatedAt || r.createdAt).toLocaleString()} · 版本 ${r.revision}`, 'small muted'), element('p', r.result.length > 220 ? r.result.slice(0, 220) + '…' : r.result, 'record-preview'), actions); list.append(card);
  }
}
async function restoreRecord(record) {
  if (busy || saving) return showError('请等待当前操作完成。');
  if (($('prompt').value || $('result').value) && !await askConfirm('载入将替换工作台内容。尚未保存的结果请先保存，是否继续？')) return;
  undoStack.push($('prompt').value); if (undoStack.length > 10) undoStack.shift();
  $('prompt').value = record.original; source = record.original; $('result').value = record.result; activeRecord = record; resultGuide = record.guideName || '';
  $('result-title').value = record.title || ''; $('result-title-wrap').hidden = true; applied = false;
  $('result').hidden = false; $('empty-result').hidden = true; $('result-tag').textContent = '可编辑 · 已保存记录';
  showPanel('editor'); update(); showStatus('已载入收藏。'); $('prompt').focus();
}
async function removeRecord(kind, record) {
  if (libraryBusy) return;
  if (!await askConfirm(`确定删除“${record.name || record.title || record.original.slice(0, 40)}”？删除后无法恢复。`)) return;
  libraryBusy = true;
  try {
    await api(`/api/${kind}/delete`, { id: record.id, revision: record.revision }, AbortSignal.timeout(15000));
    if (kind === 'history' && activeRecord?.id === record.id) { activeRecord = null; update(); }
    if (kind === 'guides') await loadGuides(); else await loadHistory();
  } catch (error) { if (authenticated) showError(error.message); }
  finally { libraryBusy = false; }
}
function askConfirm(message) {
  if (confirmResolve) return Promise.resolve(false);
  $('confirm-message').textContent = message; $('confirm-dialog').showModal();
  return new Promise(resolve => { confirmResolve = resolve; });
}
function settleConfirmation(accepted) {
  $('confirm-dialog').close(); $('confirm-message').textContent = '';
  const resolve = confirmResolve; confirmResolve = null; resolve?.(accepted);
}
$('confirm-accept').addEventListener('click', () => settleConfirmation(true));
$('confirm-cancel').addEventListener('click', () => settleConfirmation(false));
$('confirm-dialog').addEventListener('cancel', event => { event.preventDefault(); settleConfirmation(false); });
function guideFields() { return { name: $('guide-name').value, category: $('guide-kind').value, description: $('guide-description').value, instructions: $('guide-instructions').value }; }
function historyFields() { return { title: $('history-title').value, original: $('history-original').value, result: $('history-result').value, guideName: editingHistory?.guideName || '' }; }
function openGuide(record = null) {
  if (!historyEnabled) return showError('管理员尚未启用持久化存储。');
  editingGuide = record; $('guide-form').reset(); $('guide-form-error').textContent = '';
  $('guide-dialog-title').textContent = record ? '编辑指引' : '新增指引';
  if (record) { $('guide-name').value = record.name; $('guide-kind').value = record.category; $('guide-description').value = record.description; $('guide-instructions').value = record.instructions; }
  modalSnapshot = JSON.stringify(guideFields()); $('guide-dialog').showModal();
}
function openHistory(record) {
  editingHistory = record; $('history-form-error').textContent = '';
  $('history-title').value = record.title || ''; $('history-original').value = record.original; $('history-result').value = record.result;
  modalSnapshot = JSON.stringify(historyFields()); $('history-dialog').showModal();
}
$('new-guide').addEventListener('click', () => openGuide());
async function closeDialog(id) {
  if (modalBusy) return;
  if (id === 'password-dialog') { $('password-form').reset(); $('password-error').textContent = ''; $(id).close(); return; }
  const fields = id === 'guide-dialog' ? guideFields() : historyFields();
  if (modalSnapshot !== JSON.stringify(fields) && !await askConfirm('修改尚未保存，确定放弃？')) return;
  $(id).close();
}
for (const button of document.querySelectorAll('[data-close]')) button.addEventListener('click', () => closeDialog(button.dataset.close));
for (const id of ['guide-dialog', 'history-dialog', 'password-dialog']) $(id).addEventListener('cancel', event => { event.preventDefault(); closeDialog(id); });
async function submitDialog(kind, event) {
  event.preventDefault(); if (modalBusy) return;
  const prefix = kind === 'guides' ? 'guide' : 'history';
  const fields = kind === 'guides' ? guideFields() : historyFields();
  const record = kind === 'guides' ? editingGuide : editingHistory;
  const errorBox = $(prefix + '-form-error'); errorBox.textContent = '';
  if (kind === 'history' && [...fields.original].length > maxInput) { errorBox.textContent = `原文不能超过 ${maxInput} 个字符。`; return; }
  modalBusy = true; $(prefix + '-submit').disabled = true;
  try {
    await api(`/api/${kind}${record ? '/update' : ''}`, { ...fields, ...(record ? { id: record.id, revision: record.revision } : {}) }, AbortSignal.timeout(15000));
    $(prefix + '-dialog').close();
    if (kind === 'guides') await loadGuides(); else { if (activeRecord?.id === record.id) { activeRecord = null; update(); } await loadHistory(); }
  } catch (error) { if (authenticated) errorBox.textContent = error.message; }
  finally { modalBusy = false; $(prefix + '-submit').disabled = false; }
}
$('guide-form').addEventListener('submit', event => submitDialog('guides', event));
$('history-form').addEventListener('submit', event => submitDialog('history', event));
function modelFeedback(message, error = false) {
  $('model-feedback').textContent = message; $('model-feedback').classList.toggle('error', error);
}
function modelDraft() {
  return {
    id: modelConfig?.id || '',
    name: $('model-module-name').value.trim(),
    protocol: $('model-protocol').value,
    baseURL: $('model-base').value.trim(),
    apiKey: $('model-key').value.trim(),
    model: $('model-name').value.trim(),
    models: modelCatalog
  };
}
function rememberModelDraft() { modelSnapshot = JSON.stringify(modelDraft()); }
function modelDraftDirty() { return !!modelSnapshot && modelSnapshot !== JSON.stringify(modelDraft()); }
async function guardModelDraft(action) {
  if (modelBusy || modelTransitioning) return false;
  modelTransitioning = true;
  try {
    if (modelDraftDirty() && !await askConfirm('当前模型配置尚未保存，确定放弃修改？')) return false;
    await action(); return true;
  } finally { modelTransitioning = false; }
}
function renderSavedModules() {
  const select = $('model-module'); select.replaceChildren(...modelModules.map(item => new Option(item.name, item.id))); select.value = modelConfig?.id || '';
  const list = $('model-summary-list'); list.replaceChildren();
  for (const item of modelModules) {
    const row = element('div', '', 'model-summary-row'), info = element('div', '', 'model-summary-info'), buttons = element('div', '', 'record-actions');
    info.append(element('strong', item.name), element('small', `${item.protocol} · ${item.model || '未选择模型'} · ${item.ready ? '已配置' : '待配置'}`));
    buttons.append(action('编辑配置', () => openModel(item)), action('测试连接', () => openModel(item, true)));
    row.append(info, buttons); list.append(row);
  }
}
async function openModel(item, test = false) {
  try {
    await guardModelDraft(async () => {
      const data = await api(`/api/models?id=${encodeURIComponent(item.id)}`, undefined, AbortSignal.timeout(15000));
      displayModel(data.config); $('model-editor').hidden = false; $('model-editor').open = true;
      if (test) $('model-test').click();
    });
  } catch (error) { if (authenticated) modelFeedback(error.message, true); }
}
function displayModel(config) {
  modelConfig = config; renderSavedModules();
  $('model-module-name').value = config.name || '';
  modelCatalog = config.models || (config.model ? [config.model] : []); renderModelCatalog(config.model);
  $('model-protocol').value = config.protocol; $('model-base').value = config.baseURL; $('model-name').value = config.model; $('model-key').value = '';
  $('model-provider').value = modelProviders.find(p => p.baseURL === config.baseURL && p.protocol === config.protocol)?.id || 'custom';
  $('model-key-status').textContent = config.hasKey ? '密钥已保存。留空可保留；更换地址或协议时需重新填写。' : '尚未保存密钥。';
  $('model-notice').hidden = config.ready;
  rememberModelDraft();
}
function displayNewModel() {
  modelConfig = null; renderSavedModules(); modelCatalog = [];
  $('model-module-name').value = ''; $('model-provider').value = 'custom'; $('model-protocol').value = 'chat'; $('model-base').value = ''; $('model-key').value = ''; $('model-key-status').textContent = '尚未保存密钥。';
  renderModelCatalog(); rememberModelDraft();
  modelFeedback('正在新建 API 模块，请填写名称、地址和密钥。');
}
async function createModel() {
  await guardModelDraft(() => { $('model-editor').hidden = false; $('model-editor').open = true; displayNewModel(); $('model-module-name').focus(); });
}
$('model-create').addEventListener('click', createModel);
$('model-new').addEventListener('click', createModel);
$('model-module').addEventListener('change', async () => {
  const item = modelModules.find(m => m.id === $('model-module').value);
  if (!item) return;
  let changed = false;
  try {
    changed = await guardModelDraft(async () => {
      const data = await api(`/api/models?id=${encodeURIComponent(item.id)}`, undefined, AbortSignal.timeout(15000));
      displayModel(data.config);
    });
  } catch (error) { if (authenticated) modelFeedback(error.message, true); }
  if (!changed) $('model-module').value = modelConfig?.id || '';
});
async function loadModel() {
  if (modelBusy) return;
  modelBusy = true; $('model-editor').hidden = true; $('refresh-model').disabled = true; $('model-fields').disabled = true; modelFeedback('正在读取配置…');
  try {
    const data = await api('/api/models?detail=first', undefined, AbortSignal.timeout(15000));
    modelProviders = data.providers; modelModules = data.modules || []; renderSavedModules(); if (!selectedModuleId || !modelModules.some(m => m.id === selectedModuleId)) selectedModuleId = modelModules[0]?.id || ''; savePreference(preferenceKeys.module, selectedModuleId); renderModuleSelectors(); $('model-provider').replaceChildren(...modelProviders.map(p => new Option(p.name, p.id)));
    displayModel(data.config); $('model-fields').disabled = !data.editable;
    modelFeedback(data.editable ? '填写地址与密钥后拉取模型，选择并保存即可使用。' : '管理员尚未启用持久化配置。');
  } catch (error) { if (authenticated) modelFeedback(error.message, true); }
  finally { modelBusy = false; $('refresh-model').disabled = false; }
}
$('refresh-model').addEventListener('click', async () => {
  await guardModelDraft(loadModel);
});
$('model-delete').addEventListener('click', async () => { if (!modelConfig || modelBusy) return; if (!await askConfirm(`确定删除 API 模块“${modelConfig.name || '未命名'}”？`)) return; const deletedId = modelConfig.id; modelBusy = true; try { const data = await api('/api/models/delete', { id: deletedId, revision: modelConfig.revision }, AbortSignal.timeout(15000)); modelModules = data.modules || []; if (selectedModuleId === deletedId || !modelModules.some(item => item.id === selectedModuleId)) selectedModuleId = modelModules[0]?.id || ''; savePreference(preferenceKeys.module, selectedModuleId); renderModuleSelectors(); modelConfig = null; $('model-form').reset(); modelCatalog = []; renderModelCatalog(); rememberModelDraft(); $('model-editor').hidden = true; modelFeedback('API 模块已删除。'); } catch (error) { modelFeedback(error.message, true); } finally { modelBusy = false; } });
$('model-provider').addEventListener('change', () => {
  const preset = modelProviders.find(p => p.id === $('model-provider').value);
  if (preset) { $('model-base').value = preset.baseURL; $('model-protocol').value = preset.protocol; modelCatalog = []; renderModelCatalog(); $('model-key').value = ''; modelFeedback('请填写密钥，再点击“拉取模型列表”。'); }
});
for (const id of ['model-base', 'model-protocol']) $(id).addEventListener('input', () => { $('model-provider').value = 'custom'; $('model-key').value = ''; modelCatalog = []; renderModelCatalog(); modelFeedback('接口已修改，请填写密钥并重新拉取模型列表。'); });
function renderModelCatalog(selected = '') {
  $('model-name').replaceChildren(new Option(modelCatalog.length ? '请选择用于增强的模型' : '请先拉取模型，再选择', ''), ...modelCatalog.map(id => new Option(id, id)));
  $('model-name').value = modelCatalog.includes(selected) ? selected : '';
  $('model-count').textContent = modelCatalog.length ? `共 ${modelCatalog.length} 个模型` : '列表为空';
  $('model-remove').disabled = !$('model-name').value;
}
$('model-name').addEventListener('change', () => { $('model-remove').disabled = !$('model-name').value; });
$('model-remove').addEventListener('click', () => {
  const selected = $('model-name').value;
  if (!selected || modelBusy) return;
  modelCatalog = modelCatalog.filter(id => id !== selected); renderModelCatalog();
  modelFeedback('已从待保存列表移除。请选择其他模型并保存；重新拉取可恢复。');
});
$('model-add').addEventListener('click', () => {
  const id = $('model-manual-id').value.trim();
  if (!id || id.length > 200 || /[\s\x00-\x1f\x7f]/.test(id)) return modelFeedback('请填写有效模型 ID。', true);
  if (!modelCatalog.includes(id)) {
    if (modelCatalog.length >= 2000) return modelFeedback('列表最多 2000 个模型。', true);
    modelCatalog.push(id);
  }
  renderModelCatalog(id); $('model-manual-id').value = ''; modelFeedback('已添加并选中，请保存配置。');
});
$('model-fetch').addEventListener('click', async () => {
  if (modelBusy) return;
  const input = { ...(modelConfig?.id ? { id: modelConfig.id } : {}), moduleId: modelConfig?.id || '', name: $('model-module-name').value.trim(), revision: modelConfig?.revision || 1, protocol: $('model-protocol').value, baseURL: $('model-base').value.trim(), apiKey: $('model-key').value.trim() };
  const selected = $('model-name').value;
  modelBusy = true; $('model-fields').disabled = true; $('refresh-model').disabled = true; $('model-fetch').textContent = '正在拉取…'; modelFeedback('正在向服务商读取模型列表…');
  try {
    const data = await api('/api/model/discover', input, AbortSignal.timeout(55000));
    modelCatalog = data.models; renderModelCatalog(selected);
    modelFeedback(data.models.length ? `已拉取 ${data.models.length} 个模型，请选择模型并保存。` : '服务商返回空列表。请检查账户权限，或使用手动添加。');
  } catch (error) { if (authenticated) modelFeedback(error.name === 'TimeoutError' ? '拉取超时，已有列表未改变。' : error.message, true); }
  finally { modelBusy = false; $('model-fields').disabled = !authenticated; $('refresh-model').disabled = false; $('model-fetch').textContent = '拉取模型列表'; }
});
$('model-form').addEventListener('submit', async event => {
  event.preventDefault(); if (modelBusy) return;
  const input = { ...(modelConfig?.id ? { id: modelConfig.id } : {}), revision: modelConfig?.revision || 1, name: $('model-module-name').value.trim(), protocol: $('model-protocol').value, baseURL: $('model-base').value.trim(), model: $('model-name').value.trim(), apiKey: $('model-key').value.trim(), models: modelCatalog };
  modelBusy = true; $('model-fields').disabled = true; $('refresh-model').disabled = true; modelFeedback('正在加密保存…');
  try { const data = await api(modelConfig?.id ? '/api/models/update' : '/api/models', input, AbortSignal.timeout(15000)); const saved = data.module || data.config; displayModel(saved); modelModules = data.modules || modelModules; renderSavedModules(); selectedModuleId = saved?.id || selectedModuleId; savePreference(preferenceKeys.module, selectedModuleId); renderModuleSelectors(); modelFeedback(saved.ready ? '配置和模型列表已保存。可测试连接后开始增强。' : '连接信息和列表已保存。选择模型并保存后才能增强。'); }
  catch (error) { if (authenticated) modelFeedback(error.message, true); }
  finally { $('model-key').value = ''; modelBusy = false; $('model-fields').disabled = !authenticated; $('refresh-model').disabled = false; }
});
$('model-test').addEventListener('click', async () => {
  if (modelBusy || !modelConfig) return;
  if (modelDraftDirty()) return modelFeedback('请先保存当前修改，再测试连接。', true);
  modelBusy = true; $('model-fields').disabled = true; $('refresh-model').disabled = true; modelFeedback('正在测试已保存配置…');
  try { await api('/api/model/test', { revision: modelConfig.revision, moduleId: modelConfig.id }, AbortSignal.timeout(55000)); modelFeedback('连接成功，模型已返回完整文本，可开始增强。'); }
  catch (error) { if (authenticated) modelFeedback(error.name === 'TimeoutError' ? '连接测试超时，请稍后重试。' : error.message, true); }
  finally { modelBusy = false; $('model-fields').disabled = !authenticated; $('refresh-model').disabled = false; }
});
// 后退缓存恢复时重新验证，不恢复上一会话的敏感文本。
window.addEventListener('pagehide', () => lock(initialized, false));
window.addEventListener('pageshow', event => { if (event.persisted) location.reload(); });
try { const session = await api('/api/session', undefined, AbortSignal.timeout(15000)); if (session.authenticated) unlock(session); else lock(session.initialized, false); }
catch { lock(true, false); $('login-error').textContent = '无法连接服务器，请检查网络后重试。'; }
finally { $('initial-status').hidden = true; }
