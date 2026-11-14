/**
 * 从微信读书导入「已读完」的书（读书记录）。
 *
 * 两种数据源：
 *  1. 网页版 SSR（推荐）：用 wr_vid/wr_skey 等登录 Cookie 抓 https://weread.qq.com/web/shelf，
 *     解析内嵌的 window.__INITIAL_STATE__ 拿书架。可靠、带完整元数据。
 *     注意：只能拿到「当前书架」的书（约 50 本，读完的按 finishReading 标记）；
 *     历史累计读完的书大部分已不在书架，web 拿不到。
 *  2. 官方 agent 网关（降级）：读环境变量 WEREAD_API_KEY，调 /shelf/sync。
 */
const WEREAD_SHELF = "https://weread.qq.com/web/shelf";
const WEREAD_RENEW = "https://weread.qq.com/web/login/renewal";
const GATEWAY = "https://i.weread.qq.com/api/agent/gateway";
const SKILL_VERSION = "1.0.4";

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";

function isConfigured() {
  return !!(process.env.WEREAD_API_KEY || process.env.WEREAD_COOKIE);
}

function parseCookies(str) {
  const out = {};
  String(str || "")
    .split(";")
    .forEach((part) => {
      const i = part.indexOf("=");
      if (i < 0) return;
      const k = part.slice(0, i).trim();
      const v = part.slice(i + 1).trim();
      if (k) out[k] = v;
    });
  return out;
}

function cookieStr(obj) {
  return Object.entries(obj)
    .map(([k, v]) => `${k}=${v}`)
    .join("; ");
}

/** 判定一本书是否「读完」：进度 100% 或官方 finishReading 标记 */
function isFinished(b) {
  if (!b) return false;
  if (b.finishReading === 1) return true;
  const prog = Number(b.progress);
  if (prog >= 1) return true;
  if (b.readingStatus === 2) return true;
  return false;
}

function toCandidate(b) {
  return {
    title: b.title || "",
    author: b.author || "",
    cover_url: b.cover || "",
    douban_url: "",
    isbn: "",
    douban_rating: null,
    read_at: "",
    source: "weread",
  };
}

// ---- Cookie 网页版 SSR 解析 ----

/** 从 HTML 里提取 window.__INITIAL_STATE__={...} 并解析（正确处理字符串内的花括号） */
function extractInitialState(html) {
  const marker = "window.__INITIAL_STATE__=";
  const start = html.indexOf(marker);
  if (start === -1) return null;
  const objStart = start + marker.length;
  let depth = 0, inStr = null, esc = false, end = -1;
  for (let i = objStart; i < html.length; i++) {
    const c = html[i];
    if (inStr) {
      if (esc) { esc = false; continue; }
      if (c === "\\") { esc = true; continue; }
      if (c === inStr) inStr = null;
      continue;
    }
    if (c === '"' || c === "'") { inStr = c; continue; }
    if (c === "{") depth++;
    else if (c === "}") { depth--; if (depth === 0) { end = i + 1; break; } }
  }
  if (end === -1) return null;
  try { return JSON.parse(html.slice(objStart, end)); } catch { return null; }
}

async function renewSkey(cookies) {
  try {
    const res = await fetch(WEREAD_RENEW, {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: cookieStr(cookies), "User-Agent": UA },
    });
    const setC = res.headers.get("set-cookie") || "";
    const m = setC.match(/wr_skey=([^;]+)/);
    if (m) {
      cookies.wr_skey = m[1];
      return true;
    }
  } catch { /* ignore */ }
  return false;
}

async function fetchShelfHtml(cookies) {
  const headers = {
    "User-Agent": UA,
    Cookie: cookieStr(cookies),
    Referer: "https://weread.qq.com/",
    Accept: "text/html,application/xhtml+xml,*/*",
  };
  let res = await fetch(WEREAD_SHELF, { headers });
  if (res.status === 401 || res.status === 403) {
    if (await renewSkey(cookies)) res = await fetch(WEREAD_SHELF, { headers });
  }
  return res;
}

async function fetchFinishedByCookie(cookie) {
  const cookies = parseCookies(cookie);
  if (!cookies.wr_vid || !cookies.wr_skey) {
    return { ok: false, error: "微信读书 Cookie 缺少 wr_vid / wr_skey。请用 F12 → 网络面板复制完整 Cookie 字段。" };
  }

  const res = await fetchShelfHtml(cookies);
  if (res.status === 401 || res.status === 403) {
    return {
      ok: false,
      error:
        "微信读书拒绝了这套 Cookie（登录超时）。请在电脑浏览器打开 weread.qq.com 登录后，" +
        "F12 → 网络 → 任意请求的「请求头」里复制完整 Cookie 字段。注意别用微信 App/公众号里抓的。",
    };
  }
  const html = await res.text();
  const state = extractInitialState(html);
  if (!state || !state.shelf || !Array.isArray(state.shelf.booksAndArchives)) {
    return { ok: false, error: "微信读书书架解析失败（可能页面结构变了或 Cookie 无效）。" };
  }

  const all = state.shelf.booksAndArchives;
  const books = all.map((b) => ({
    title: b.title || "",
    author: b.author || "",
    cover_url: b.cover || "",
    douban_url: "",
    isbn: "",
    douban_rating: null,
    read_at: "",
    source: "weread",
    defaultRead: b.finishReading === 1 ? 1 : 0, // finishReading 才是「我读完」标记
  }));
  const finishedCount = books.filter((b) => b.defaultRead === 1).length;
  return {
    ok: true,
    books,
    source: "cookie",
    totalShelf: all.length,
    message: `共拉取当前书架 ${all.length} 本（读完 ${finishedCount} 本）。注意：历史累计读完的书大多已不在当前书架，网页版只能拿到书架里的。`,
  };
}

// ---- 网关模式（降级） ----

async function fetchFinishedByGateway() {
  const key = process.env.WEREAD_API_KEY;
  if (!key) return { ok: false, error: "未配置 WEREAD_API_KEY。" };

  let res;
  try {
    res = await fetch(GATEWAY, {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({ api_name: "/shelf/sync", skill_version: SKILL_VERSION }),
    });
  } catch (err) {
    return { ok: false, error: "连接微信读书网关失败: " + err.message };
  }
  if (!res.ok) return { ok: false, error: "微信读书网关 HTTP " + res.status };

  let data;
  try {
    data = await res.json();
  } catch {
    return { ok: false, error: "微信读书网关返回异常" };
  }
  if (data.errcode !== undefined && data.errcode !== 0) {
    return { ok: false, error: "微信读书返回错误: " + (data.errmsg || `errcode ${data.errcode}`) };
  }

  const books = (data.books || []).filter(isFinished).map(toCandidate);
  return {
    ok: true,
    books,
    source: "gateway",
    totalShelf: (data.books || []).length,
    message: `网关只返回当前书架的 ${(data.books || []).length} 本（其中读完 ${books.length} 本）。要拉全量历史读完，请在设置中填微信读书 Cookie。`,
  };
}

/**
 * 读取已读完的书。优先原生 Cookie，其次网关。
 * @param {string} [cookie] 微信读书 Cookie（wr_vid/wr_skey/wr_uid/wr_name 等）
 */
async function fetchFinishedBooks(cookie) {
  if (cookie || process.env.WEREAD_COOKIE) {
    return fetchFinishedByCookie(cookie || process.env.WEREAD_COOKIE);
  }
  if (process.env.WEREAD_API_KEY) {
    return fetchFinishedByGateway();
  }
  return { ok: false, error: "未配置微信读书：请在设置中填微信读书 Cookie（推荐），或配置 WEREAD_API_KEY 环境变量。" };
}

module.exports = { fetchFinishedBooks, isConfigured };
