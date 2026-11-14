/**
 * 从豆瓣个人主页导入「读过」列表（读书记录）。
 * 入口: fetchCollect(doubanId, { max })
 * 分页抓取 https://book.douban.com/people/{id}/collect
 * 解析书名/作者/封面/豆瓣链接/我的豆瓣评分/读毕日期/我的短评。
 */
const douban = require("./douban.js");

const PAGE_SIZE = 15;

function decodeEntities(s) {
  return String(s || "")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, " ");
}

function cleanTitle(s) {
  return decodeEntities(s).trim();
}

function parseAuthorFromPub(pub) {
  // 豆瓣 .pub 格式通常为「作者 / 出版社 / 出版年」
  const first = String(pub || "").split("/")[0].trim();
  return decodeEntities(first);
}

/** 解析一个 subject-item 块 */
function parseItem(block) {
  const url = (block.match(/<a[^>]*href="(https?:\/\/book\.douban\.com\/subject\/\d+[^"]*)"[^>]*>/) || [])[1] || "";

  // 书名：优先 h2 里 <a> 的 title 属性（真实页面标题链接内嵌 <span>，不能直接取文本）
  let title = "";
  const h2 = (block.match(/<h2>([\s\S]*?)<\/h2>/) || [])[1] || "";
  if (h2) {
    const tAttr = h2.match(/<a[^>]*title="([^"]+)"[^>]*>/);
    if (tAttr) {
      title = cleanTitle(tAttr[1]);
    } else {
      const inner = h2.match(/<a[^>]*>([\s\S]*?)<\/a>/);
      if (inner) {
        title = cleanTitle(inner[1].replace(/<[^>]*>/g, "")).replace(/\s+/g, " ").trim();
      }
    }
  }

  const cover = (block.match(/<img[^>]*src="([^"]+)"/) || [])[1] || "";
  const pub = (block.match(/<div\s+class="pub">([\s\S]*?)<\/div>/) || [])[1] || "";

  // 我的豆瓣评分：rating5-t = 5 星 …… rating1-t = 1 星
  const starMatch = block.match(/class="rating(\d)-t"/);
  const my_rating = starMatch ? Number(starMatch[1]) : null;

  // 读毕日期
  const dateMatch = block.match(/class="date">\s*(\d{4}-\d{2}-\d{2})/);
  const read_at = dateMatch ? dateMatch[1] : "";

  // 我的短评（豆瓣标注里的评论文字）
  let note = "";
  const comment = block.match(/class="comment[^"]*"[^>]*>([\s\S]*?)<\/p>/);
  if (comment) {
    note = comment[1]
      .replace(/<[^>]*>/g, " ")
      .replace(/&quot;/g, '"')
      .replace(/&#34;/g, '"')
      .replace(/&#39;/g, "'")
      .replace(/&amp;/g, "&")
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/\s+/g, " ")
      .trim();
  }

  if (!title) return null;
  return {
    title,
    author: parseAuthorFromPub(pub),
    cover_url: cover,
    douban_url: url,
    isbn: "",
    douban_rating: null,
    my_rating,
    read_at,
    note,
    source: "douban",
  };
}

/** 解析一页 collect HTML，返回书籍条目数组 */
function parseCollectPage(html) {
  const blocks = [];
  const re = /<li[^>]*class="[^"]*subject-item[^"]*"[^>]*>([\s\S]*?)<\/li>/g;
  let m;
  while ((m = re.exec(html))) blocks.push(m[1]);
  if (!blocks.length) return [];
  return blocks.map(parseItem).filter(Boolean);
}

/**
 * 抓取用户「读过」列表。
 * @param {string} doubanId  豆瓣 ID 或完整主页 URL
 * @param {{max?: number, onProgress?: Function}} options
 *   onProgress({processed, total, current}) 每页回调一次
 */
async function fetchCollect(doubanId, { max = 1000, onProgress } = {}) {
  let id = String(doubanId || "").trim();
  const m = id.match(/douban\.com\/people\/([^/?#]+)/);
  if (m) id = m[1];
  if (!id || /[^a-zA-Z0-9_\-.]/.test(id)) {
    return { ok: false, error: "豆瓣 ID 不合法" };
  }

  const all = [];
  let start = 0;
  let page = 0;
  const maxPages = Math.ceil(max / PAGE_SIZE) + 1;

  while (page < maxPages) {
    const url = `https://book.douban.com/people/${encodeURIComponent(id)}/collect?start=${start}&sort=time&max=0`;
    let html;
    try {
      html = await douban.fetchRaw(url);
    } catch (err) {
      return { ok: false, error: `抓取失败: ${err.message}` };
    }

    if (/sec\.douban\.com|验证码|检测到有异常请求|403 Forbidden/i.test(html)) {
      // 中途被拦：保留已抓到的部分，返回 truncated 提示
      if (all.length) {
        return {
          ok: true,
          books: all.slice(0, max),
          truncated: true,
          message: "豆瓣中途拦截了请求，只抓到前 " + all.length + " 本。建议在设置中填入豆瓣登录 Cookie 后重试。",
        };
      }
      return {
        ok: false,
        error: "豆瓣拦截了请求（可能是反爬）。建议在设置中填入豆瓣登录 Cookie 后重试，或稍后再试。",
      };
    }

    const items = parseCollectPage(html);
    if (!items.length) break;

    all.push(...items);
    if (onProgress) onProgress({ processed: all.length, total: null, current: all[all.length - 1].title });
    if (all.length >= max) break;

    // 下一页
    start += PAGE_SIZE;
    page += 1;
    await new Promise((r) => setTimeout(r, 350)); // 轻量限速，防止豆瓣限流
  }

  return { ok: true, books: all.slice(0, max) };
}

module.exports = { fetchCollect };
