/**
 * 扫描本地目录中的电子书文件（pdf/epub/mobi/azw3/txt/djvu），
 * 用文件名解析书名，去豆瓣搜索匹配，生成候选列表。
 * 注意：只读文件名，不读文件内容。
 */
const fs = require("fs");
const path = require("path");
const douban = require("./douban.js");

const BOOK_EXTS = ["pdf", "epub", "mobi", "azw3", "txt", "djvu"];

/** 从文件名解析书名：去扩展名、清理括号/中括号/破折号等 */
function parseTitleFromFile(filename) {
  let base = path.basename(String(filename || "")).replace(/\.[^.]+$/, "");
  base = base
    .replace(/[【\[\{\(（]\s*[^】\]\}\)）]*[】\]\}\)）]/g, " ") // 去掉括号内容
    .replace(/[_-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  // 去掉常见的版本/格式后缀
  base = base.replace(/\s*(修订版|典藏版|精装|完整版|TXT|EPUB|PDF|MOBI|AZW3)\s*$/i, "").trim();
  return base;
}

/** 归一化用于比较 */
function norm(s) {
  return String(s || "")
    .toLowerCase()
    .replace(/[\s　·.—_,，。！？!?：:;；"'“”‘’()（）\[\]【】《》]/g, "");
}

/** 标题相似度：0~1，子串包含得分高 */
function similarity(a, b) {
  const na = norm(a);
  const nb = norm(b);
  if (!na || !nb) return 0;
  if (na === nb) return 1;
  if (na.includes(nb) || nb.includes(na)) {
    return 0.8 + Math.min(na.length, nb.length) / 200;
  }
  // 前 2 个字符相同给一点分
  if (na.slice(0, 2) === nb.slice(0, 2) && na.length >= 2) return 0.4;
  return 0;
}

/** 递归扫描目录内电子书文件（含子目录，带深度/数量上限） */
function scanDir(dir, { maxFiles = 5000 } = {}) {
  if (!fs.existsSync(dir)) return { ok: false, error: "目录不存在: " + dir };
  const files = [];
  const MAX_DEPTH = 10;
  function walk(cur, depth) {
    if (depth > MAX_DEPTH || files.length >= maxFiles) return;
    let entries;
    try {
      entries = fs.readdirSync(cur, { withFileTypes: true });
    } catch {
      return; // 跳过无权限/无法读取的子目录
    }
    for (const e of entries) {
      if (files.length >= maxFiles) return;
      if (e.isDirectory()) {
        walk(path.join(cur, e.name), depth + 1);
      } else if (e.isFile()) {
        const ext = path.extname(e.name).slice(1).toLowerCase();
        if (BOOK_EXTS.includes(ext)) files.push(path.join(cur, e.name));
      }
    }
  }
  walk(dir, 0);
  files.sort();
  return { ok: true, files, truncated: files.length >= maxFiles };
}

/** 在书架已有书里找匹配：先精确归一化，再相似度（前 2 字过滤） */
function findShelfBook(title, shelfBooks) {
  const key = norm(title);
  if (!key || !Array.isArray(shelfBooks) || !shelfBooks.length) return null;
  const prefix = key.slice(0, 2);
  let best = null, bestScore = 0;
  for (const eb of shelfBooks) {
    if (!eb || !eb.title) continue;
    const ebNorm = norm(eb.title);
    if (ebNorm === key) return eb; // 精确匹配直接命中
    if (ebNorm.slice(0, 2) !== prefix) continue;
    const s = similarity(eb.title, title);
    if (s > bestScore) { bestScore = s; best = eb; }
  }
  return bestScore >= 0.85 ? best : null;
}

/**
 * 扫描并匹配：优先匹配书架已有书（existing，通常是豆瓣已读的），
 * 匹配不上再去豆瓣搜索。
 * @param {string} dir 目录
 * @param {{max?: number, fetchDetail?: boolean, existing?: Array, onProgress?: Function}} options
 *   onProgress({processed, total, current, matched}) 每处理一本回调一次
 */
async function matchDir(dir, { max = 300, fetchDetail = false, existing = [], onProgress } = {}) {
  const scan = scanDir(dir);
  if (!scan.ok) return scan;

  const results = [];
  const list = scan.files.slice(0, max);
  let matchedCount = 0;
  for (let i = 0; i < list.length; i++) {
    const file = list[i];
    const title = parseTitleFromFile(file);
    let best = null;
    let score = 0;
    let shelfHit = null;

    if (title) {
      // 1. 优先匹配书架已有书
      shelfHit = findShelfBook(title, existing);
      if (shelfHit) {
        best = {
          title: shelfHit.title,
          author: shelfHit.author || "",
          cover_url: shelfHit.cover_url || "",
          url: shelfHit.douban_url || "",
        };
        score = 1;
      }
    }

    // 2. 书架没匹配到，再去豆瓣搜
    if (!best && title) {
      const hits = await douban.searchBooks(title);
      if (hits.length) {
        for (const h of hits.slice(0, 3)) {
          const s = similarity(h.title, title);
          if (s > score) { score = s; best = h; }
        }
      }
      // 降低匹配难度：也尝试不含空格的整名（无空格书名）
      if (!best && title.includes(" ")) {
        const compact = title.replace(/\s+/g, "");
        const hits2 = await douban.searchBooks(compact);
        if (hits2.length) {
          const s = similarity(hits2[0].title, compact);
          if (s > score) { score = s; best = hits2[0]; }
        }
      }
    }

    const matched = !!best && score >= 0.8;
    let item = {
      title: matched ? best.title : title,
      author: matched ? best.author || "" : "",
      cover_url: matched ? best.cover_url || "" : "",
      douban_url: matched ? best.url || "" : "",
      isbn: shelfHit && shelfHit.isbn ? shelfHit.isbn : "",
      douban_rating: shelfHit && shelfHit.douban_rating != null ? shelfHit.douban_rating : null,
      read_at: "",
      source: "pdf",
      file: path.relative(dir, file).split(path.sep).join("/"),
      matched,
      score: Math.round(score * 100),
      matchedFromShelf: !!shelfHit,
      // 「未读书」等子目录里的默认标未读，其余默认已读
      defaultRead: /未读/.test(file) ? 0 : 1,
    };

    // 豆瓣搜索匹配到且开了补全时，才逐个访问豆瓣详情补 ISBN（书架命中的已有信息，跳过）
    if (fetchDetail && !shelfHit && best && best.url && score >= 0.8) {
      try {
        const full = await douban.getBookByUrl(best.url);
        if (full) {
          item.isbn = full.isbn || "";
          item.author = full.author || item.author;
          item.cover_url = full.cover_url || item.cover_url;
          item.douban_rating = full.douban_rating != null ? full.douban_rating : item.douban_rating;
        }
      } catch {
        /* 忽略单本补全失败 */
      }
    }

    if (item.matched) matchedCount += 1;
    results.push(item);
    // 每本之间轻量限速，防止连续请求豆瓣被限流
    if (onProgress) onProgress({ processed: i + 1, total: list.length, current: item.title, matched: matchedCount });
    await new Promise((r) => setTimeout(r, 180));
  }

  return { ok: true, books: results, totalFiles: scan.files.length, truncated: scan.truncated };
}

module.exports = { matchDir, scanDir, parseTitleFromFile };
