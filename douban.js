/**
 * 豆瓣书籍信息抓取。
 * 支持三种输入：ISBN、豆瓣链接、书名/关键词。
 * 用 Node 内置 fetch，正则解析，失败时优雅降级（返回 null，不抛异常）。
 *
 * 相对 reading-notes 的 douban.js 增加了：
 *  - 解析豆瓣评分 douban_rating
 *  - 可选注入豆瓣 Cookie（setCookie，降低 403 / 投毒概率）
 */
const DOUBAN_BASE = "https://book.douban.com";

let cookie = ""; // 可选：dbcl2=xxx; ck=xxx 等登录 Cookie

function setCookie(c) {
  cookie = String(c || "").trim();
}

const HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36",
  Referer: "https://book.douban.com/",
  Accept: "application/json, text/html, */*",
};

/** fetch 带超时、Referer、可选 Cookie */
async function fetchText(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15000);
  const headers = { ...HEADERS };
  if (cookie) headers.Cookie = cookie;
  try {
    const res = await fetch(url, { headers, signal: controller.signal, redirect: "follow" });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.text();
  } finally {
    clearTimeout(timer);
  }
}

function decodeEntities(s) {
  return s
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, " ");
}

function isIsbn(q) {
  const digits = String(q).replace(/[-\s]/g, "");
  return /^\d{10}(\d{3})?$/.test(digits);
}

function isDoubanUrl(q) {
  return /book\.douban\.com/.test(String(q));
}

/** 从书籍页 HTML 提取信息 */
function parseBookPage(html) {
  const get = (re) => {
    const m = html.match(re);
    return m ? decodeEntities(m[1].trim()) : "";
  };
  const title =
    get(/<meta\s+property="og:title"\s+content="([^"]+)"/) ||
    get(/<title>([^<]{1,80})<\/title>/).replace(/\(豆瓣\)/, "").trim();
  const cover = get(/<meta\s+property="og:image"\s+content="([^"]+)"/);
  const url =
    get(/<meta\s+property="og:url"\s+content="([^"]+)"/) ||
    get(/<link\s+rel="canonical"\s+href="([^"]+)"/);
  const isbn = get(/ISBN[:：]<\/span>\s*([\d\s\-Xx]{10,17})/).replace(/[\s-]/g, "");
  const douban_rating = get(/<strong\s+class="ll\s+rating_num"[^>]*>\s*([\d.]+)/) ||
    get(/<span\s+property="v:average">\s*([\d.]+)\s*<\/span>/);

  // 作者：取 #info 中“作者:”后的第一个链接文本
  let author = "";
  const infoMatch = html.match(/<div\s+id="info">([\s\S]*?)<\/div>/);
  if (infoMatch) {
    const info = infoMatch[1];
    const authorMatch = info.match(/作者<\/span>\s*[:：][\s\S]*?<a[^>]*>([^<]+)<\/a>/);
    if (authorMatch) author = decodeEntities(authorMatch[1].trim());
  }

  return { title, author, isbn, cover_url: cover, url, douban_rating: douban_rating ? Number(douban_rating) : null };
}

/** 通过 ISBN 页 / 豆瓣链接抓取 */
async function fetchFromPage(q) {
  const url = isDoubanUrl(q) ? q : `${DOUBAN_BASE}/isbn/${q.replace(/[-\s]/g, "")}`;
  const html = await fetchText(url);
  return parseBookPage(html);
}

/**
 * 搜索书籍，返回候选列表（可能有多个版本/译本）。
 * 输入书名/关键词 -> suggest 接口列表；输入 ISBN/豆瓣链接 -> 单个结果。
 * @returns {Array<{title, author, year, url, cover_url}>}
 */
async function searchBooks(q) {
  const query = String(q || "").trim();
  if (!query) return [];
  try {
    if (isIsbn(query) || isDoubanUrl(query)) {
      const info = await fetchFromPage(query);
      return info && (info.title || info.cover_url) ? [info] : [];
    }
    const url = `${DOUBAN_BASE}/j/subject_suggest?q=${encodeURIComponent(query)}`;
    const text = await fetchText(url);
    const list = JSON.parse(text);
    if (!Array.isArray(list)) return [];
    return list
      .filter((b) => b.type === "b")
      .map((b) => ({
        title: b.title || "",
        author: b.author_name || "",
        year: b.year || "",
        url: b.url || "",
        cover_url: b.pic || "",
      }));
  } catch (err) {
    console.warn(`[douban] 搜索失败: ${query} -> ${err.message}`);
    return [];
  }
}

/** 按豆瓣书籍链接抓取完整信息（含 ISBN、豆瓣评分）。 */
async function getBookByUrl(url) {
  if (!isDoubanUrl(url)) return null;
  try {
    const info = await fetchFromPage(url);
    return info && (info.title || info.cover_url) ? info : null;
  } catch (err) {
    console.warn(`[douban] 详情抓取失败: ${url} -> ${err.message}`);
    return null;
  }
}

/**
 * 统一入口（提交时兜底补全）。返回第一条或 null。
 */
async function fetchBookInfo(q) {
  const results = await searchBooks(q);
  return results[0] || null;
}

module.exports = {
  setCookie,
  searchBooks,
  getBookByUrl,
  fetchBookInfo,
  isDoubanUrl,
  isIsbn,
  fetchRaw: fetchText, // 供导入模块复用（带 UA/Cookie/超时）
};
