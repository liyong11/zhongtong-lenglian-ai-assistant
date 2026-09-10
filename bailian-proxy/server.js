/**
 * 中通冷链 AI 智能助理 —— 百炼模型代理服务器
 *
 * 作用：
 *  1. 解决浏览器 CORS 限制（浏览器不允许直接请求 dashscope.aliyuncs.com）
 *  2. 保护 API Key（Key 只存在本文件同目录的 config.json，绝不下发到前端）
 *  3. 静态托管 Vue 构建产物，提供气泡组件、管理后台与嵌入脚本
 *
 * 用法：
 *  node server.js          （端口默认 8787，可用环境变量 PORT 覆盖）
 *  然后浏览器打开 http://localhost:8787/
 *
 * 支持两种百炼接入模式（config.json 二选一填写）：
 *  A. 智能体应用（推荐）：填 appId —— 走 /api/v1/apps/{appId}/completion
 *     百炼控制台上配置了人设/知识库的应用，支持 session_id 云端多轮记忆
 *  B. 模型直调：填 model（如 qwen-plus）—— 走 OpenAI 兼容接口
 *     由代理层拼 system 提示词维护人设，多轮历史由前端传入
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DIST_ROOT = path.resolve(__dirname, '../dist');
const PORT = process.env.PORT || 8787;
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || '';
const CFG_PATH = path.join(__dirname, 'config.json');
const SIDEBAR_PATH = path.join(__dirname, 'sidebar.json');

// JSON 配置读写：损坏时备份并回退空配置；写入走临时文件 + rename，避免写入中途崩溃留下截断 JSON
function loadJson(filePath, label) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
  } catch (e) {
    if (e.code !== 'ENOENT') {
      const backup = filePath + '.corrupt-' + Date.now();
      try {
        fs.renameSync(filePath, backup);
        console.error('[' + label + '] 配置解析失败，已把损坏文件备份为 ' + backup + '，本次按空配置处理');
      } catch (e2) {
        console.error('[' + label + '] 配置解析失败且备份失败：' + (e2.message || e2));
      }
    }
    return {};
  }
}
function writeJsonAtomic(filePath, obj) {
  const tmp = filePath + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2), 'utf-8');
  fs.renameSync(tmp, filePath);
}

// 侧边栏配置（值班表 / 下载汇总 / 常见问题 / 人员 / 机器人形象）—— 配置中台读写
function loadSidebar() {
  return loadJson(SIDEBAR_PATH, 'sidebar');
}

const WEEK_MAP = { 0: '周日', 1: '周一', 2: '周二', 3: '周三', 4: '周四', 5: '周五', 6: '周六' };

// 计算今日值班：优先精确日期匹配，其次按星期
function todayDuty(sb) {
  const now = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  const dateStr = now.getFullYear() + '-' + pad(now.getMonth() + 1) + '-' + pad(now.getDate());
  const weekday = WEEK_MAP[now.getDay()];
  const byDate = (sb.onDuty && sb.onDuty.byDate) || {};
  const byWeekday = (sb.onDuty && sb.onDuty.byWeekday) || {};
  const staff = byDate[dateStr] || byWeekday[weekday] || [];
  return { date: dateStr, weekday: weekday, staff: staff };
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.webp': 'image/webp',
  '.woff2': 'font/woff2'
};

function loadConfig() {
  return loadJson(CFG_PATH, 'config');
}

function publicSettings(cfg) {
  return {
    mode: cfg.appId ? 'app' : 'model',
    appId: cfg.appId || '',
    model: cfg.model || '',
    systemPrompt: cfg.systemPrompt || '',
    hasApiKey: Boolean(cfg.apiKey)
  };
}

function cleanText(value, maxLength) {
  return String(value == null ? '' : value).trim().slice(0, maxLength);
}

function isAdmin(req) {
  if (!ADMIN_TOKEN) return true;
  const supplied = Buffer.from(String(req.headers['x-admin-token'] || ''));
  const expected = Buffer.from(ADMIN_TOKEN);
  return supplied.length === expected.length && crypto.timingSafeEqual(supplied, expected);
}

function requireAdmin(req, res) {
  if (isAdmin(req)) return true;
  send(res, 401, { success: false, error: '需要有效的管理令牌' });
  return false;
}

function send(res, status, obj) {
  const body = JSON.stringify(obj);
  // 不下发跨域头：聊天组件经 iframe 加载、与代理同源；跨域直接调 API 会烧百炼配额，明确不允许
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    // 先按字节收集、最后一次性解码：请求体里的中文被 TCP 分包切开时，
    // 逐段 += Buffer 会触发逐段 toString('utf8')，把切开的多字节字符替换成 �
    const parts = [];
    let size = 0;
    req.on('data', (c) => {
      parts.push(c);
      size += c.length;
      if (size > 8 * 1024 * 1024) { reject(new Error('body too large')); req.destroy(); }
    });
    req.on('end', () => {
      try {
        const raw = Buffer.concat(parts).toString('utf8');
        resolve(raw ? JSON.parse(raw) : {});
      }
      catch (e) { reject(new Error('invalid JSON body')); }
    });
    req.on('error', reject);
  });
}

// ---------- 百炼调用：A. 智能体应用 ----------
async function callApp(cfg, prompt, sessionId) {
  const url = 'https://dashscope.aliyuncs.com/api/v1/apps/' + encodeURIComponent(cfg.appId) + '/completion';
  const input = { prompt: prompt };
  if (sessionId) input.session_id = sessionId; // 云端会话记忆（1 小时内有效）
  const resp = await fetch(url, {
    method: 'POST',
    headers: {
      'Authorization': 'Bearer ' + cfg.apiKey,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ input: input, parameters: {} })
  });
  const data = await resp.json();
  if (!resp.ok) {
    throw new Error(mapErr(resp.status, data));
  }
  const out = data.output || {};
  return {
    reply: out.text || '',
    sessionId: out.session_id || sessionId || null,
    usage: data.usage || null
  };
}

function writeSse(res, event, data) {
  res.write('event: ' + event + '\ndata: ' + JSON.stringify(data) + '\n\n');
}

function parseSseBlock(block) {
  const lines = block.split(/\r?\n/);
  const event = (lines.find((line) => line.startsWith('event:')) || 'event: message').slice(6).trim();
  const data = lines.filter((line) => line.startsWith('data:')).map((line) => line.slice(5).trim()).join('\n');
  if (!data || data === '[DONE]') return { event, done: true };
  try { return { event, data: JSON.parse(data) }; }
  catch (e) { return null; }
}

async function callAppStream(cfg, prompt, sessionId, res) {
  const url = 'https://dashscope.aliyuncs.com/api/v1/apps/' + encodeURIComponent(cfg.appId) + '/completion';
  const input = { prompt: prompt };
  if (sessionId) input.session_id = sessionId;
  const post = (parameters) => fetch(url, {
    method: 'POST',
    headers: {
      'Authorization': 'Bearer ' + cfg.apiKey,
      'Content-Type': 'application/json',
      'X-DashScope-SSE': 'enable'
    },
    body: JSON.stringify({ input: input, parameters: parameters })
  });
  // has_thoughts 请求返回思考过程；少数旧应用不支持该参数时会报 InvalidParameter，去掉后重试一次
  let resp = await post({ incremental_output: true, has_thoughts: true });
  if (!resp.ok) {
    const errData = await resp.json();
    if (/has_thoughts|InvalidParameter/i.test(String(errData.code || '') + String(errData.message || ''))) {
      resp = await post({ incremental_output: true });
      if (!resp.ok) throw new Error(mapErr(resp.status, await resp.json()));
    } else {
      throw new Error(mapErr(resp.status, errData));
    }
  }

  // 用 stream 模式做流式 UTF-8 解码：中文等多字节字符被 TCP 分包切开时，
  // 逐 chunk toString('utf8') 会把切开的字节替换成 � 甚至弄坏 JSON 导致整块被丢。
  // TextDecoder 的 stream:true 会把不完整的字节序列留到下一个 chunk 再拼。
  const decoder = new TextDecoder('utf-8');
  let buffer = '';
  let currentSession = sessionId || null;
  let usage = null;
  let chunkCount = 0;
  let charCount = 0;
  let finishReason = '';
  let sentThought = '';
  let clientGone = false;
  res.on('close', () => {
    if (!res.writableEnded) {
      clientGone = true;
      try { resp.body.cancel(); } catch (e) { /* 上游已结束则忽略 */ }
    }
  });

  const handleBlock = (parsed, raw) => {
    if (!parsed) {
      // 报文损坏不能静默丢弃：记下原始块，便于排查“回复被截断”类问题
      console.error('[chat] SSE 块解析失败，已丢弃:', JSON.stringify(raw));
      return;
    }
    if (parsed.done || !parsed.data) return;
    const out = parsed.data.output || {};
    // 上游在流中以 code+message 报错（限流、内容审核、应用异常等），必须透出而不是吞掉
    if (parsed.data.code && parsed.data.message) throw new Error(parsed.data.message);
    const text = out.text || '';
    if (out.session_id) currentSession = out.session_id;
    if (parsed.data.usage) usage = parsed.data.usage;
    if (out.finish_reason) finishReason = out.finish_reason;
    // 思考过程：thoughts 可能整段重发也可能增量，按前缀对齐后只发增量，对不齐则整段替换
    const thoughts = Array.isArray(out.thoughts) ? out.thoughts.map((t) => (t && t.thought) || '').join('') : '';
    if (thoughts) {
      if (thoughts.startsWith(sentThought)) {
        const suffix = thoughts.slice(sentThought.length);
        if (suffix) { writeSse(res, 'thought', { text: suffix }); sentThought = thoughts; }
      } else {
        writeSse(res, 'thought', { text: thoughts, replace: true });
        sentThought = thoughts;
      }
    }
    if (text) {
      writeSse(res, 'chunk', { text: text, session_id: currentSession });
      chunkCount++;
      charCount += text.length;
    }
  };

  for await (const chunk of resp.body) {
    if (clientGone) break;
    buffer += decoder.decode(chunk, { stream: true });
    let end;
    while ((end = buffer.indexOf('\n\n')) !== -1) {
      const block = buffer.slice(0, end);
      buffer = buffer.slice(end + 2);
      handleBlock(parseSseBlock(block), block);
    }
  }
  buffer += decoder.decode(); // 冲刷残留的不完整多字节字符
  if (buffer.trim()) handleBlock(parseSseBlock(buffer), buffer);
  writeSse(res, 'done', { session_id: currentSession, usage: usage });
  console.log('[chat] 完成 session=' + currentSession + ' 分片=' + chunkCount
    + ' 字符=' + charCount + ' finish=' + (finishReason || '-'));
}

// ---------- 百炼调用：B. 模型直调（OpenAI 兼容） ----------
async function callModel(cfg, messages) {
  const url = 'https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions';
  const msgs = cfg.systemPrompt
    ? [{ role: 'system', content: cfg.systemPrompt }].concat(messages)
    : messages;
  const resp = await fetch(url, {
    method: 'POST',
    headers: {
      'Authorization': 'Bearer ' + cfg.apiKey,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ model: cfg.model, messages: msgs })
  });
  const data = await resp.json();
  if (!resp.ok) {
    throw new Error(mapErr(resp.status, data));
  }
  const ch = (data.choices && data.choices[0]) || {};
  return {
    reply: (ch.message && ch.message.content) || '',
    sessionId: null,
    usage: data.usage || null
  };
}

// 模型直调的流式版本：OpenAI 兼容接口 stream:true；思考模型（qwen3 等）额外请求
// enable_thinking 并转发 delta.reasoning_content，不支持的模型报错时去掉该参数重试
async function callModelStream(cfg, messages, res) {
  const url = 'https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions';
  const msgs = cfg.systemPrompt
    ? [{ role: 'system', content: cfg.systemPrompt }].concat(messages)
    : messages;
  const post = (withThinking) => {
    const body = withThinking
      ? { model: cfg.model, messages: msgs, stream: true, enable_thinking: true }
      : { model: cfg.model, messages: msgs, stream: true };
    return fetch(url, {
      method: 'POST',
      headers: {
        'Authorization': 'Bearer ' + cfg.apiKey,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(body)
    });
  };
  let resp = await post(true);
  if (!resp.ok) {
    const errData = await resp.json();
    if (/enable_thinking|InvalidParameter/i.test(String(errData.code || '') + String(errData.message || ''))) {
      resp = await post(false);
      if (!resp.ok) throw new Error(mapErr(resp.status, await resp.json()));
    } else {
      throw new Error(mapErr(resp.status, errData));
    }
  }

  const decoder = new TextDecoder('utf-8');
  let buffer = '';
  let usage = null;
  let chunkCount = 0;
  let clientGone = false;
  res.on('close', () => {
    if (!res.writableEnded) {
      clientGone = true;
      try { resp.body.cancel(); } catch (e) { /* 上游已结束则忽略 */ }
    }
  });
  const handleBlock = (block) => {
    const parsed = parseSseBlock(block);
    if (!parsed) {
      console.error('[chat] SSE 块解析失败，已丢弃:', JSON.stringify(block));
      return;
    }
    if (parsed.done || !parsed.data) return;
    if (parsed.data.usage) usage = parsed.data.usage;
    const choice = (parsed.data.choices && parsed.data.choices[0]) || {};
    const reasoning = (choice.delta && choice.delta.reasoning_content) || '';
    if (reasoning) writeSse(res, 'thought', { text: reasoning });
    const text = (choice.delta && choice.delta.content) || '';
    if (text) {
      writeSse(res, 'chunk', { text: text, session_id: null });
      chunkCount++;
    }
  };
  for await (const chunk of resp.body) {
    if (clientGone) break;
    buffer += decoder.decode(chunk, { stream: true });
    let end;
    while ((end = buffer.indexOf('\n\n')) !== -1) {
      const block = buffer.slice(0, end);
      buffer = buffer.slice(end + 2);
      handleBlock(block);
    }
  }
  buffer += decoder.decode();
  if (buffer.trim()) handleBlock(buffer);
  writeSse(res, 'done', { session_id: null, usage: usage });
  console.log('[chat] 完成 mode=model 分片=' + chunkCount);
}

function mapErr(status, data) {
  const code = (data && (data.code || data.error && data.error.code)) || '';
  const msg = (data && (data.message || data.error && data.error.message)) || '';
  if (status === 401 || /InvalidApiKey|Unauthorized/i.test(String(code))) {
    return 'API Key 无效或已失效，请到百炼控制台「API-KEY 管理」重新创建';
  }
  if (/Arrearage|Forbidden/i.test(String(code) + String(msg))) {
    return '账户欠费或额度不足，请检查百炼控制台余额';
  }
  if (/AppNotFound|app.*not.*exist|InvalidParameter/i.test(String(code) + String(msg))) {
    return '应用 ID 不正确，或应用尚未发布（Agent 2.0 应用需先发布才能 API 调用）';
  }
  return '百炼服务返回错误（' + status + '）' + (code ? '：' + code : '') + (msg ? ' - ' + msg : '');
}

// ---------- 对话接口限流：按 IP 滑动窗口，防止第三方页面直接刷对话接口烧百炼配额 ----------
const RATE_WINDOW_MS = 60 * 1000;
const RATE_LIMIT = Number(process.env.CHAT_RATE_LIMIT || 30);
const rateBuckets = new Map(); // ip -> 最近请求时间戳
function tooManyRequests(req) {
  if (!(RATE_LIMIT > 0)) return false;
  const ip = (req.socket && req.socket.remoteAddress) || 'unknown';
  const now = Date.now();
  if (rateBuckets.size > 10000) {
    for (const [key, list] of rateBuckets) {
      const alive = list.filter((t) => now - t < RATE_WINDOW_MS);
      if (alive.length) rateBuckets.set(key, alive); else rateBuckets.delete(key);
    }
  }
  const list = (rateBuckets.get(ip) || []).filter((t) => now - t < RATE_WINDOW_MS);
  if (list.length >= RATE_LIMIT) {
    rateBuckets.set(ip, list);
    return true;
  }
  list.push(now);
  rateBuckets.set(ip, list);
  return false;
}

// ---------- 图片代理防护：拒绝本机/内网目标，避免代理被当作 SSRF 跳板 ----------
// 按主机名/IP 字面量判断；域名解析到内网 IP 的绕过手法防不住，严格场景应在反向代理层再做限制
function isBlockedHost(hostname) {
  const host = String(hostname || '').toLowerCase().replace(/^\[|\]$/g, '');
  if (host === 'localhost' || host.endsWith('.local') || host.endsWith('.internal')) return true;
  const ipv4 = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (ipv4) {
    const a = Number(ipv4[1]);
    const b = Number(ipv4[2]);
    if (a === 0 || a === 10 || a === 127 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168)) return true;
  }
  if (host === '::1' || host.startsWith('fc') || host.startsWith('fd') || host.startsWith('fe80')) return true;
  return false;
}

// ---------- 静态文件 ----------
function serveFile(res, filePath) {
  fs.readFile(filePath, (err, buf) => {
    if (err) { send(res, 404, { error: 'not found' }); return; }
    const ext = path.extname(filePath).toLowerCase();
    res.writeHead(200, {
      'Content-Type': MIME[ext] || 'application/octet-stream',
      'Cache-Control': 'no-cache'
    });
    res.end(buf);
  });
}

// ---------- 主服务 ----------
const server = http.createServer(async (req, res) => {
  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  // 健康检查 / 前端探测连接状态
  if (req.method === 'GET' && req.url.split('?')[0] === '/api/ping') {
    const cfg = loadConfig();
    send(res, 200, {
      success: true,
      mode: cfg.appId ? 'app' : (cfg.model ? 'model' : 'none'),
      configured: Boolean(cfg.apiKey && (cfg.appId || cfg.model)),
      appReady: Boolean(cfg.appId),
      modelReady: Boolean(cfg.model)
    });
    return;
  }

  // ---------- 管理后台：模型设置（API Key 只写不读） ----------
  if (req.method === 'GET' && req.url.split('?')[0] === '/api/admin/settings') {
    if (!requireAdmin(req, res)) return;
    send(res, 200, { success: true, settings: publicSettings(loadConfig()) });
    return;
  }
  if (req.method === 'POST' && req.url.split('?')[0] === '/api/admin/settings') {
    if (!requireAdmin(req, res)) return;
    let body;
    try { body = await readBody(req); }
    catch (e) { send(res, 400, { success: false, error: e.message }); return; }
    const cfg = loadConfig();
    const mode = body.mode === 'model' ? 'model' : 'app';
    const appId = cleanText(body.appId, 200);
    const model = cleanText(body.model, 200);
    if (mode === 'app' && !appId) { send(res, 400, { success: false, error: '智能体模式必须填写应用 ID' }); return; }
    if (mode === 'model' && !model) { send(res, 400, { success: false, error: '模型直调模式必须填写模型名称' }); return; }
    cfg.appId = mode === 'app' ? appId : '';
    cfg.model = mode === 'model' ? model : '';
    cfg.systemPrompt = cleanText(body.systemPrompt, 20000);
    const apiKey = cleanText(body.apiKey, 500);
    if (apiKey) cfg.apiKey = apiKey;
    if (body.clearApiKey === true) cfg.apiKey = '';
    try {
      writeJsonAtomic(CFG_PATH, cfg);
      send(res, 200, { success: true, settings: publicSettings(cfg) });
    } catch (e) {
      send(res, 500, { success: false, error: '保存失败: ' + (e.message || e) });
    }
    return;
  }

  // ---------- 侧边栏配置中台 ----------
  if (req.method === 'GET' && req.url.split('?')[0] === '/api/sidebar') {
    const sb = loadSidebar();
    send(res, 200, { success: true, config: sb, today: todayDuty(sb) });
    return;
  }
  if (req.method === 'POST' && req.url.split('?')[0] === '/api/sidebar') {
    if (!requireAdmin(req, res)) return;
    let body;
    try { body = await readBody(req); }
    catch (e) { send(res, 400, { success: false, error: e.message }); return; }
    const sb = body.config || {};
    sb.onDuty = sb.onDuty || { byDate: {}, byWeekday: {} };
    sb.downloads = Array.isArray(sb.downloads) ? sb.downloads : [];
    sb.faq = Array.isArray(sb.faq) ? sb.faq : [];
    // 人员设置：姓名与钉钉号，前端聊天窗口据此唤起钉钉单聊
    sb.staff = Array.isArray(sb.staff)
      ? sb.staff.map((item) => ({ name: cleanText(item && item.name, 50), dingtalkId: cleanText(item && item.dingtalkId, 100) }))
        .filter((item) => item.name || item.dingtalkId)
      : [];
    // 机器人形象：名称与头像（头像可为图片 URL 或文字/表情）
    const brand = (sb.brand && typeof sb.brand === 'object') ? sb.brand : {};
    sb.brand = { name: cleanText(brand.name, 30), avatar: cleanText(brand.avatar, 500) };
    try {
      writeJsonAtomic(SIDEBAR_PATH, sb);
      send(res, 200, { success: true, config: sb, today: todayDuty(sb) });
    } catch (e) {
      send(res, 500, { success: false, error: '保存失败: ' + (e.message || e) });
    }
    return;
  }

  // 对话流式接口：智能体应用与模型直调两种模式均支持
  if (req.method === 'POST' && req.url.split('?')[0] === '/api/chat/stream') {
    if (tooManyRequests(req)) { send(res, 429, { success: false, error: '请求过于频繁，请稍后再试' }); return; }
    const cfg = loadConfig();
    let body;
    try { body = await readBody(req); }
    catch (e) { send(res, 400, { success: false, error: e.message }); return; }
    const prompt = body.prompt || (body.messages && body.messages.length
      ? body.messages[body.messages.length - 1].content : '');
    if (!prompt) { send(res, 400, { success: false, error: '缺少提问内容' }); return; }
    const mode = cfg.appId ? 'app' : (cfg.model ? 'model' : 'none');
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      'Connection': 'keep-alive'
    });
    writeSse(res, 'ready', { mode: mode });
    console.log('[chat] 收到提问 (' + mode + '):', prompt.slice(0, 120).replace(/\s+/g, ' '));
    try {
      if (!cfg.apiKey) throw new Error('未配置 API Key，请在管理后台或 bailian-proxy/config.json 中填写 apiKey');
      if (mode === 'app') {
        await callAppStream(cfg, prompt, body.session_id || null, res);
      } else if (mode === 'model') {
        const messages = (Array.isArray(body.messages) && body.messages.length)
          ? body.messages
          : [{ role: 'user', content: prompt }];
        await callModelStream(cfg, messages, res);
      } else {
        throw new Error('config.json 中 appId 与 model 均未配置，请在管理后台选择接入模式');
      }
    } catch (e) {
      console.error('[chat] 流式请求失败:', e.message);
      writeSse(res, 'error', { error: e.message || '请求百炼失败' });
    }
    res.end();
    return;
  }

  // 对话接口
  if (req.method === 'POST' && req.url.split('?')[0] === '/api/chat') {
    if (tooManyRequests(req)) { send(res, 429, { success: false, error: '请求过于频繁，请稍后再试' }); return; }
    const cfg = loadConfig();
    if (!cfg.apiKey) {
      send(res, 200, { success: false, error: '未配置 API Key，请在 bailian-proxy/config.json 中填写 apiKey' });
      return;
    }
    let body;
    try { body = await readBody(req); }
    catch (e) { send(res, 400, { success: false, error: e.message }); return; }

    const prompt = body.prompt || (body.messages && body.messages.length
      ? body.messages[body.messages.length - 1].content : '');
    if (!prompt) { send(res, 400, { success: false, error: '缺少提问内容' }); return; }

    try {
      let out;
      if (cfg.appId) {
        out = await callApp(cfg, prompt, body.session_id || null);
      } else if (cfg.model) {
        out = await callModel(cfg, body.messages || [{ role: 'user', content: prompt }]);
      } else {
        send(res, 200, { success: false, error: 'config.json 中 appId 与 model 均未配置，请二选一填写' });
        return;
      }
      send(res, 200, {
        success: true,
        reply: out.reply,
        session_id: out.sessionId,
        mode: cfg.appId ? 'app' : 'model',
        usage: out.usage
      });
    } catch (e) {
      send(res, 200, { success: false, error: e.message || '请求百炼失败' });
    }
    return;
  }

  // 图片代理下载（本地开发用）：浏览器跨域拉图受限，由服务端转发解决
  if (req.method === 'GET' && req.url.split('?')[0] === '/api/imgproxy') {
    let target;
    try { target = new URL(new URL(req.url, 'http://localhost').searchParams.get('url') || ''); }
    catch (e) { target = null; }
    if (!target || !/^https?:$/.test(target.protocol)) { send(res, 400, { error: 'url 参数缺失或非法' }); return; }
    const port = target.port ? Number(target.port) : (target.protocol === 'https:' ? 443 : 80);
    if (port !== 80 && port !== 443) { send(res, 403, { error: '仅允许代理 80/443 端口的图片' }); return; }
    if (isBlockedHost(target.hostname)) { send(res, 403, { error: '不允许代理内网或本机地址' }); return; }
    try {
      const r = await fetch(target, { redirect: 'follow', headers: { 'User-Agent': 'Mozilla/5.0 bailian-proxy' } });
      if (!r.ok) { send(res, 502, { error: '源站返回 ' + r.status }); return; }
      const ct = r.headers.get('content-type') || 'application/octet-stream';
      const buf = Buffer.from(await r.arrayBuffer());
      res.writeHead(200, {
        'Content-Type': ct,
        'Content-Length': buf.length,
        'Cache-Control': 'public, max-age=3600',
        'X-Img-Proxy': 'bailian'
      });
      res.end(buf);
    } catch (e) {
      send(res, 502, { error: '拉取图片失败: ' + (e.message || e) });
    }
    return;
  }

  // Vue SPA 与 embed.js
  if (req.method === 'GET') {
    let pathname;
    try { pathname = decodeURIComponent(new URL(req.url, 'http://localhost').pathname); }
    catch (e) { send(res, 400, { error: 'invalid URL' }); return; }
    if (pathname.startsWith('/api/')) { send(res, 404, { error: 'not found' }); return; }
    const relative = path.normalize(pathname).replace(/^([/\\])+/, '');
    const filePath = path.join(DIST_ROOT, relative);
    if (!filePath.startsWith(DIST_ROOT + path.sep) && filePath !== DIST_ROOT) {
      send(res, 403, { error: 'forbidden' });
      return;
    }
    if (fs.existsSync(filePath) && fs.statSync(filePath).isFile()) {
      serveFile(res, filePath);
      return;
    }
    if (path.extname(pathname)) { send(res, 404, { error: 'not found' }); return; }
    const indexPath = path.join(DIST_ROOT, 'index.html');
    if (!fs.existsSync(indexPath)) {
      send(res, 503, { error: '前端尚未构建，请先运行 pnpm build' });
      return;
    }
    serveFile(res, indexPath);
    return;
  }

  send(res, 404, { error: 'not found' });
});

server.listen(PORT, () => {
  const cfg = loadConfig();
  const mode = cfg.appId ? '智能体应用 ' + cfg.appId
    : cfg.model ? '模型直调 ' + cfg.model : '未配置（等待填写 config.json）';
  console.log('');
  console.log('  中通冷链 AI 智能助理 · 百炼代理已启动');
  console.log('  ─────────────────────────────────────────');
  console.log('  气泡地址 : http://localhost:' + PORT + '/');
  console.log('  管理后台 : http://localhost:' + PORT + '/admin');
  console.log('  嵌入脚本 : http://localhost:' + PORT + '/embed.js');
  console.log('  接入模式 : ' + mode);
  console.log('  Key 状态 : ' + (cfg.apiKey ? '已配置' : '未配置'));
  console.log('  ─────────────────────────────────────────');
  console.log('  管理鉴权 : ' + (ADMIN_TOKEN ? '已启用 ADMIN_TOKEN' : '未启用（仅建议本地/内网使用）'));
  console.log('  对话限流 : ' + (RATE_LIMIT > 0 ? '每 IP ' + RATE_LIMIT + ' 次/分钟' : '未启用'));
  console.log('');
});
