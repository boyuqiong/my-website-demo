/* ================================================================
 * Vercel Serverless Function
 * 路径：/api/analyze
 * 作用：接收前端 base64 图片 → 转发调用智谱 glm-4v-flash → 返回分析文本
 * 密钥：从 Vercel 环境变量 ZHIPU_API_KEY 读取，绝不写死在代码里
 * ================================================================ */

// 固定系统提示词（与前端保持一致，写死在服务端，用户不可修改）
const SYSTEM_PROMPT = [
  '你是专业形象美学顾问，根据用户上传的正面人像照片，严格按照下面5个部分输出分析，使用小标题分段，不要输出代码块：',
  '1.脸型骨骼分析：观察三庭五眼，分析面部骨骼特征，判定脸型（菱形脸/方圆脸等）',
  '2.PCCS色彩季型诊断：判断肤色所属季型，列出适合穿搭颜色、需要避开的颜色',
  '3.气质风格判断：提炼人物气质关键词，例如知性、清冷、少年感等',
  '4.形象方案：推荐适配的穿搭色系、妆容重点、美甲风格',
  '5.发型推荐方案：针对该脸型给出3套具体发型方案（日常通勤、约会社交、正式场合各一套），每套写清长度、刘海类型、卷度或直发、分发线与蓬松度，并说明为什么适合；最后列出需要避开的发型与打理要点。'
].join('\n');

const CONTINUE_PROMPT = '请紧接着上面的内容继续输出，在断点处接续，保持相同的小标题编号与格式，不要重复已经写过的内容。';

const API_URL = 'https://open.bigmodel.cn/api/paas/v4/chat/completions';
const MODEL = 'glm-4v-flash';
const MAX_TOKENS = 1024;                       // glm-4v-flash 输出上限，合法范围 [1,1024]
const MAX_CONTINUE = 2;                        // 输出被截断时最多续写次数
const MAX_IMAGE_CHARS = 4 * 1024 * 1024;       // base64 字符串长度上限（Vercel 请求体上限 4.5MB）
const SINGLE_TIMEOUT = 28000;                  // 单次上游请求超时（毫秒）
const TOTAL_BUDGET = 46000;                    // 总时间预算，避免超过函数 maxDuration

/* ---------------- IP 限流 ----------------
 * 默认：每个 IP 每 1 小时最多 10 次分析
 * 可用环境变量调整：RATE_LIMIT（次数）、RATE_WINDOW_MS（窗口毫秒）
 * 注意：这是单实例内存计数，Vercel 多实例间不共享，属于"软限流"。
 *       若要严格全局限流，需接入 Vercel KV / Upstash Redis。
 * ---------------------------------------- */
const RATE_LIMIT = parseInt(process.env.RATE_LIMIT || '10', 10) || 10;
const RATE_WINDOW = parseInt(process.env.RATE_WINDOW_MS || String(60 * 60 * 1000), 10) || 3600000;
const hits = new Map();                        // ip -> { count, resetAt }

/* ---------------- 同时在线 IP 数限制 ----------------
 * 默认：全站最多同时 10 个 IP 在使用，超出直接拒绝，用于控制额度
 * 可用环境变量调整：MAX_ACTIVE_IPS（人数）、ACTIVE_WINDOW_MS（活跃判定窗口，默认 10 分钟）
 * 判定方式：某 IP 在窗口内有请求即视为"在线"，超时未请求则自动释放名额
 * ---------------------------------------------------- */
const MAX_ACTIVE_IPS = parseInt(process.env.MAX_ACTIVE_IPS || '10', 10) || 10;
const ACTIVE_WINDOW = parseInt(process.env.ACTIVE_WINDOW_MS || String(10 * 60 * 1000), 10) || 600000;
const active = new Map();                      // ip -> lastSeen

// 返回 true 表示名额已满，应拒绝
function activeFull(ip) {
  const now = Date.now();
  for (const [k, t] of active) {
    if (now - t > ACTIVE_WINDOW) active.delete(k);   // 超时释放名额
  }
  if (active.has(ip)) { active.set(ip, now); return false; }  // 老用户刷新在线时间
  if (active.size >= MAX_ACTIVE_IPS) return true;             // 新用户且已满
  active.set(ip, now);
  return false;
}

function clientIp(req) {
  const xff = req.headers && req.headers['x-forwarded-for'];
  if (xff) return String(xff).split(',')[0].trim();
  if (req.headers && req.headers['x-real-ip']) return String(req.headers['x-real-ip']).trim();
  return (req.socket && req.socket.remoteAddress) || 'unknown';
}

// 返回 null 表示放行；否则返回剩余等待秒数
function rateCheck(ip) {
  const now = Date.now();
  // 条目过多时清理已过期的记录，避免内存无限增长
  if (hits.size > 5000) {
    for (const [k, v] of hits) if (v.resetAt <= now) hits.delete(k);
  }
  const rec = hits.get(ip);
  if (!rec || rec.resetAt <= now) {
    hits.set(ip, { count: 1, resetAt: now + RATE_WINDOW });
    return null;
  }
  rec.count += 1;
  if (rec.count > RATE_LIMIT) return Math.ceil((rec.resetAt - now) / 1000);
  return null;
}

function fail(res, status, code, message) {
  res.status(status).json({ ok: false, code: code, message: message });
}

// 把智谱返回的状态码翻译成中文提示
function zhMessage(status, detail) {
  const tail = detail ? '（' + String(detail).slice(0, 200) + '）' : '';
  if (status === 401 || status === 403) {
    return '服务端 API 密钥无效或已失效（' + status + '），请联系站点管理员更新 Vercel 环境变量 ZHIPU_API_KEY。' + tail;
  }
  if (status === 429) return '调用频率超限或免费额度已用完（429）。请稍后再试，或到控制台查看额度。';
  if (status === 400) return '请求参数有误（400）' + (tail || '：请换一张 JPG / PNG 图片重试。');
  if (status === 413) return '图片过大，已被服务端拒绝（413）。请换一张更小的图片。';
  if (status >= 500) return '智谱服务端暂时异常（' + status + '），请稍后重试。';
  return '接口调用失败（HTTP ' + status + '）。' + tail;
}

// 调用智谱接口，返回 { content, finish }
async function callZhipu(key, messages) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), SINGLE_TIMEOUT);
  try {
    const resp = await fetch(API_URL, {
      method: 'POST',
      signal: controller.signal,
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + key
      },
      body: JSON.stringify({
        model: MODEL,
        temperature: 0.6,
        max_tokens: MAX_TOKENS,
        messages: messages
      })
    });

    const text = await resp.text();
    let data = null;
    try { data = JSON.parse(text); } catch (e) { /* 非 JSON 响应 */ }

    const detail = data && data.error && data.error.message
      ? data.error.message
      : String(text || '').slice(0, 200);

    if (!resp.ok) {
      const err = new Error(detail);
      err.status = resp.status;
      throw err;
    }

    const choice = data && data.choices && data.choices[0];
    const content = choice && choice.message && choice.message.content;
    if (!content) {
      const err = new Error('AI 未返回内容');
      err.status = 0;
      throw err;
    }
    return { content: content, finish: choice.finish_reason };
  } finally {
    clearTimeout(timer);
  }
}

module.exports = async function handler(req, res) {
  res.setHeader('Content-Type', 'application/json; charset=utf-8');

  if (req.method === 'OPTIONS') { res.status(204).end(); return; }
  if (req.method !== 'POST') {
    return fail(res, 405, 'method', '仅支持 POST 请求。');
  }

  // 0) 同时在线 IP 数限制（控制额度）
  const ip = clientIp(req);
  if (activeFull(ip)) {
    return fail(res, 503, 'site_full',
      '当前使用人数已达上限（最多同时 ' + MAX_ACTIVE_IPS + ' 人），请稍后再试。');
  }

  // 0.1) 单 IP 请求次数限流
  const waitSec = rateCheck(ip);
  res.setHeader('X-RateLimit-Limit', String(RATE_LIMIT));
  if (waitSec !== null) {
    res.setHeader('Retry-After', String(waitSec));
    return fail(res, 429, 'rate_limit',
      '请求过于频繁：每个 IP 每小时最多分析 ' + RATE_LIMIT + ' 次。请约 ' +
      Math.ceil(waitSec / 60) + ' 分钟后再试。');
  }

  // 1) 读取环境变量中的密钥
  const key = (process.env.ZHIPU_API_KEY || '').trim();
  if (!key) {
    return fail(res, 500, 'no_key',
      '服务端未配置智谱 API 密钥。请在 Vercel 项目 Settings → Environment Variables 中添加 ZHIPU_API_KEY，然后重新部署。');
  }

  // 2) 解析并校验图片
  let body = req.body;
  if (typeof body === 'string') {
    try { body = JSON.parse(body); } catch (e) { body = null; }
  }
  const image = body && typeof body.image === 'string' ? body.image : '';

  if (!image) {
    return fail(res, 400, 'no_image', '未收到图片数据，请重新上传图片。');
  }
  if (!/^data:image\/(jpeg|png|webp);base64,/i.test(image)) {
    return fail(res, 400, 'bad_image', '图片格式有误，仅支持 JPG / PNG 格式。');
  }
  if (image.length > MAX_IMAGE_CHARS) {
    const mb = (image.length / 1024 / 1024).toFixed(1);
    return fail(res, 413, 'too_large', '图片过大（约 ' + mb + 'MB），请换一张更小的图片或先截图再上传。');
  }

  // 3) 调用智谱（输出超限时自动续写补齐）
  const started = Date.now();
  const messages = [
    {
      role: 'user',
      content: [
        { type: 'image_url', image_url: { url: image } },
        { type: 'text', text: SYSTEM_PROMPT }
      ]
    }
  ];

  let acc = '';
  let lastFinish = null;

  try {
    for (let i = 0; i <= MAX_CONTINUE; i++) {
      const r = await callZhipu(key, messages);
      acc += (acc ? '\n' : '') + r.content;
      lastFinish = r.finish;

      if (r.finish !== 'length') break;                                  // 已完整输出
      if (i === MAX_CONTINUE) break;                                     // 续写次数用尽
      if (Date.now() - started > TOTAL_BUDGET) break;                    // 时间预算用尽

      messages.push({ role: 'assistant', content: r.content });
      messages.push({ role: 'user', content: CONTINUE_PROMPT });
    }

    return res.status(200).json({
      ok: true,
      content: acc,
      truncated: lastFinish === 'length'   // 仍被截断时告知前端
    });
  } catch (err) {
    if (err && err.name === 'AbortError') {
      return fail(res, 504, 'timeout', 'AI 分析超时，请稍后重试或换一张更小的图片。');
    }
    if (err && err.status) {
      // 密钥类问题直接暴露 500，方便管理员排查；其余按上游错误返回
      const status = (err.status === 401 || err.status === 403) ? 500 : 502;
      return fail(res, status, 'upstream', zhMessage(err.status, err.message));
    }
    return fail(res, 502, 'network', '无法连接智谱接口，请检查网络后稍后重试。');
  }
};
