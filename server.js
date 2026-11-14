/**
 * 个人书架 - Express 主程序
 * 启动: npm start  /  node server.js
 * 前台: http://localhost:PORT    后台: http://localhost:PORT{adminPath}
 */
const path = require("path");
const fs = require("fs");
const crypto = require("crypto");
const express = require("express");
const multer = require("multer");

const config = require("./config.js");
const db = require("./db.js");
const auth = require("./auth.js");
const douban = require("./douban.js");
const importDouban = require("./import-douban.js");
const importWeread = require("./import-weread.js");
const importPdf = require("./import-pdf.js");

const app = express();
app.use(express.json({ limit: "2mb" }));

const PUBLIC_DIR = path.join(__dirname, "public");
const COVER_DIR = path.join(__dirname, "data", "covers");
const UPLOAD_DIR = path.join(__dirname, "data", "uploads");
for (const d of [COVER_DIR, UPLOAD_DIR]) {
  if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
}

// 本地封面图片上传（限制 5MB，仅常见图片格式）
const upload = multer({
  storage: multer.diskStorage({
    destination: UPLOAD_DIR,
    filename: (req, file, cb) => {
      const ext = (path.extname(file.originalname) || ".jpg").toLowerCase();
      cb(null, `${Date.now()}_${crypto.randomBytes(4).toString("hex")}${ext}`);
    },
  }),
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const ok = /\.(jpg|jpeg|png|webp|gif)$/i.test(file.originalname);
    cb(ok ? null : new Error("仅支持 jpg/png/webp/gif 图片"), ok);
  },
});

auth.initAuth();

// 从设置加载豆瓣 Cookie 并注入抓取器
douban.setCookie(db.getSetting("doubanCookie"));

// ---- 极简 cookie 解析中间件 ----
app.use((req, res, next) => {
  req.cookies = {};
  const raw = req.headers.cookie || "";
  for (const part of raw.split(";")) {
    const i = part.indexOf("=");
    if (i < 0) continue;
    const k = part.slice(0, i).trim();
    const v = part.slice(i + 1).trim();
    if (!k) continue;
    try {
      req.cookies[decodeURIComponent(k)] = decodeURIComponent(v);
    } catch {
      /* 忽略坏 cookie */
    }
  }
  next();
});

// ---- 静态资源 ----
app.use(express.static(PUBLIC_DIR));
app.get(config.adminPath, (req, res) => res.sendFile(path.join(PUBLIC_DIR, "admin.html")));
app.use("/uploads", express.static(UPLOAD_DIR));

// ================= 前台接口（只读） =================

/** 书架列表：支持 view / read / own / rated / q / sort */
app.get("/api/books", (req, res) => {
  const books = db.queryBooks({
    view: String(req.query.view || "all"),
    read: String(req.query.read || ""),
    own: String(req.query.own || ""),
    rated: String(req.query.rated || ""),
    q: String(req.query.q || ""),
    sort: String(req.query.sort || ""),
  });
  res.json({ books, total: books.length });
});

/** 书架统计（各视图数量） */
app.get("/api/books/stats", (req, res) => {
  res.json(db.getStats());
});

/** 单本书详情 */
app.get("/api/books/:id", (req, res) => {
  const book = db.getBook(Number(req.params.id));
  if (!book) return res.status(404).json({ error: "书籍不存在" });
  res.json({ book });
});

/** 豆瓣搜索（供后台添加书） */
app.get(
  "/api/douban/search",
  auth.rateLimit({ name: "douban", windowMs: 3600_000, max: 200, message: "请求太频繁，请稍后再试" }),
  async (req, res) => {
    const results = await douban.searchBooks(req.query.q);
    res.json({ results });
  }
);

/** 按豆瓣链接获取完整信息（含 ISBN） */
app.get(
  "/api/douban/info",
  auth.rateLimit({ name: "douban", windowMs: 3600_000, max: 200, message: "请求太频繁，请稍后再试" }),
  async (req, res) => {
    const info = await douban.getBookByUrl(req.query.url);
    if (!info) return res.status(404).json({ error: "获取书籍信息失败，请重试" });
    res.json(info);
  }
);

// ================= 封面代理 / 缓存 =================

const PLACEHOLDER_SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="200" height="280" viewBox="0 0 200 280">
  <rect width="200" height="280" rx="8" fill="#e9e2d4"/>
  <rect x="20" y="30" width="160" height="220" rx="4" fill="#fff" stroke="#d8cfbc"/>
  <text x="100" y="150" text-anchor="middle" font-size="64" fill="#c9bfa8">📖</text>
  <text x="100" y="190" text-anchor="middle" font-size="16" fill="#a89f88">暂无封面</text>
</svg>`;

function contentTypeToExt(type) {
  const t = String(type || "").toLowerCase();
  if (t.includes("png")) return "png";
  if (t.includes("webp")) return "webp";
  if (t.includes("gif")) return "gif";
  return "jpg";
}

function imageHeadersFor(url) {
  // 豆瓣 / 微信读书的封面 CDN，按 host 给对应 Referer，绕过防盗链
  const host = String(url || "").toLowerCase();
  if (host.includes("weread.qq.com") || host.includes("weread")) {
    return {
      "User-Agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36",
      Referer: "https://weread.qq.com/",
    };
  }
  return {
    "User-Agent":
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36",
    Referer: "https://book.douban.com/",
  };
}

app.get("/covers", async (req, res) => {
  const u = req.query.u;
  if (!u) return res.type("image/svg+xml").send(PLACEHOLDER_SVG);

  // SSRF 防护：只允许豆瓣 / 微信读书图片域名
  try {
    const host = new URL(String(u)).hostname.toLowerCase();
    if (!/(^|\.)douban(io)?\.com$/i.test(host) && !/(^|\.)weread\.qq\.com$/i.test(host)) {
      return res.type("image/svg+xml").send(PLACEHOLDER_SVG);
    }
  } catch {
    return res.type("image/svg+xml").send(PLACEHOLDER_SVG);
  }

  const hash = crypto.createHash("md5").update(String(u)).digest("hex");
  const cached = fs.readdirSync(COVER_DIR).find((f) => f.startsWith(hash + "."));
  if (cached) {
    return res.sendFile(path.join(COVER_DIR, cached));
  }

  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 8000);
    const r = await fetch(String(u), {
      headers: imageHeadersFor(String(u)),
      signal: controller.signal,
      redirect: "follow",
    });
    clearTimeout(timer);
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const buf = Buffer.from(await r.arrayBuffer());
    if (buf.length > 5 * 1024 * 1024) throw new Error("图片过大");
    const ext = contentTypeToExt(r.headers.get("content-type"));
    fs.writeFileSync(path.join(COVER_DIR, `${hash}.${ext}`), buf);
    res.set("Content-Type", r.headers.get("content-type") || "image/jpeg");
    res.set("Cache-Control", "public, max-age=86400");
    return res.send(buf);
  } catch (err) {
    console.warn(`[covers] 拉取失败: ${err.message}`);
    return res.type("image/svg+xml").send(PLACEHOLDER_SVG);
  }
});

// ================= 管理后台接口 =================

/** 登录 */
app.post("/api/admin/login", (req, res) => {
  const b = req.body || {};
  const result = auth.login(b.username, b.password);
  if (!result) return res.status(401).json({ error: "用户名或密码错误" });
  res.cookie(auth.TOKEN_COOKIE, result.token, {
    httpOnly: true,
    sameSite: "lax",
    expires: result.expiresAt,
    path: "/",
  });
  res.json({ ok: true, account: result.account.username });
});

app.post("/api/admin/logout", (req, res) => {
  auth.logout(req.cookies[auth.TOKEN_COOKIE]);
  res.clearCookie(auth.TOKEN_COOKIE, { path: "/" });
  res.json({ ok: true });
});

app.get("/api/admin/me", auth.requireAuth, (req, res) => {
  res.json({ account: { id: req.auth.account.id, username: req.auth.account.username } });
});

/** 后台书籍列表（支持 q 搜索 + read/own/rated/douban 筛选 + sort 排序），默认按评分 */
app.get("/api/admin/books", auth.requireAuth, (req, res) => {
  const sort = String(req.query.sort || "rating");
  const rows = db.queryBooks({
    q: String(req.query.q || "") || undefined,
    read: String(req.query.read || ""),
    own: String(req.query.own || ""),
    rated: String(req.query.rated || ""),
    douban: String(req.query.douban || ""),
    sort: ["id", "read_at", "title", "rating"].includes(sort) ? sort : "rating",
  });
  res.json({ books: rows, total: db.getStats().total });
});

// ---- 书籍字段清洗 ----
const SOURCES = ["manual", "douban", "weread", "pdf"];

function sanitizeBookBody(b) {
  const ratingRaw = b.rating;
  let rating = null;
  if (ratingRaw !== undefined && ratingRaw !== null && ratingRaw !== "") {
    const n = Math.round(Number(ratingRaw));
    if (Number.isInteger(n) && n >= 1 && n <= 5) rating = n;
  }
  const dbRatingRaw = b.douban_rating;
  let douban_rating = null;
  if (dbRatingRaw !== undefined && dbRatingRaw !== null && dbRatingRaw !== "") {
    const n = Number(dbRatingRaw);
    if (isFinite(n)) douban_rating = Math.round(n * 10) / 10;
  }
  const read_at = /^\d{4}-\d{2}-\d{2}$/.test(String(b.read_at || "")) ? String(b.read_at) : "";
  return {
    title: String(b.title || "").trim(),
    author: String(b.author || "").trim(),
    isbn: String(b.isbn || "").trim(),
    douban_url: String(b.douban_url || "").trim(),
    cover_url: String(b.cover_url || "").trim(),
    douban_rating,
    physical: b.physical ? 1 : 0,
    ebook: b.ebook ? 1 : 0,
    read: b.read ? 1 : 0,
    rating,
    note: String(b.note || "").trim(),
    read_at,
    source: SOURCES.includes(String(b.source)) ? String(b.source) : "manual",
  };
}

/** 新增书：若书架已有同链接（或无链接同书名+作者）的书，则更新它而不是重复添加 */
app.post("/api/admin/books", auth.requireAuth, (req, res) => {
  const data = sanitizeBookBody(req.body || {});
  if (!data.title) return res.status(400).json({ error: "请填写书名" });
  const dup = db.findDuplicate(data);
  if (dup) {
    db.updateBook(dup, data);
    return res.json({ ok: true, id: dup, updated: true });
  }
  const id = db.createBook(data);
  res.json({ ok: true, id });
});

/** 编辑书 */
app.put("/api/admin/books/:id", auth.requireAuth, (req, res) => {
  const id = Number(req.params.id);
  if (!db.getBook(id)) return res.status(404).json({ error: "书籍不存在" });
  const data = sanitizeBookBody(req.body || {});
  if (!data.title) return res.status(400).json({ error: "请填写书名" });
  db.updateBook(id, data);
  res.json({ ok: true });
});

/** 删除书 */
app.delete("/api/admin/books/:id", auth.requireAuth, (req, res) => {
  const id = Number(req.params.id);
  if (!db.getBook(id)) return res.status(404).json({ error: "书籍不存在" });
  db.deleteBook(id);
  res.json({ ok: true });
});

/** 本地上传封面图片 */
app.post("/api/admin/upload", auth.requireAuth, (req, res) => {
  upload.single("file")(req, res, (err) => {
    if (err) return res.status(400).json({ error: err.message || "上传失败" });
    if (!req.file) return res.status(400).json({ error: "请选择图片文件" });
    res.json({ ok: true, url: "/uploads/" + req.file.filename });
  });
});

/** 后台统计 */
app.get("/api/admin/stats", auth.requireAuth, (req, res) => {
  res.json(db.getStats());
});

// ---- 导入（长任务用 job 轮询展示进度） ----

const importJobs = new Map();
let jobSeq = 0;

function startImportJob(type, runFn) {
  const id = "job-" + ++jobSeq;
  const job = {
    id, type, status: "running",
    processed: 0, total: 0, matched: 0, current: "",
    message: "", books: null, error: null,
    startTime: Date.now(),
  };
  importJobs.set(id, job);
  (async () => {
    try {
      const result = await runFn(job);
      if (result && result.ok === false) {
        job.status = "error";
        job.error = result.error || "导入失败";
      } else {
        job.status = "done";
        job.books = (result && result.books) || null;
        job.message = (result && result.message) || "";
      }
    } catch (e) {
      job.status = "error";
      job.error = e.message || "导入失败";
    }
  })();
  return id;
}

function getImportJob(id) {
  const j = importJobs.get(id);
  if (!j) return null;
  if (j.status !== "running" && Date.now() - j.startTime > 15 * 60 * 1000) {
    importJobs.delete(id); // 完成 15 分钟后清理
  }
  return j;
}

/** 任务状态（轮询用） */
app.get("/api/admin/import/status", auth.requireAuth, (req, res) => {
  const job = getImportJob(String(req.query.job || ""));
  if (!job) return res.status(404).json({ error: "任务不存在或已过期" });
  res.json({ job });
});

/** 豆瓣读书记录导入（后台任务）：POST { id, max } -> { jobId } */
app.post(
  "/api/admin/import/douban",
  auth.requireAuth,
  auth.rateLimit({ name: "import-douban", windowMs: 3600_000, max: 10, message: "导入太频繁，请稍后再试" }),
  (req, res) => {
    const idStr = String((req.body || {}).id || "").trim();
    if (!idStr) return res.status(400).json({ error: "请填写豆瓣 ID" });
    const max = Math.min(Math.max(Number((req.body || {}).max) || 1000, 1), 2000);
    const jobId = startImportJob("douban", async (job) => {
      const result = await importDouban.fetchCollect(idStr, {
        max,
        onProgress: (p) => {
          job.processed = p.processed;
          job.total = p.total || job.total;
          job.current = p.current || "";
        },
      });
      return result;
    });
    res.json({ ok: true, jobId });
  }
);

/** 微信读书读完导入：无参数 -> 候选列表（快，直接返回） */
app.post(
  "/api/admin/import/weread",
  auth.requireAuth,
  auth.rateLimit({ name: "import-weread", windowMs: 3600_000, max: 10, message: "导入太频繁，请稍后再试" }),
  async (req, res) => {
    const cookie = db.getSetting("wereadCookie");
    const result = await importWeread.fetchFinishedBooks(cookie);
    if (!result.ok) return res.status(400).json({ error: result.error });
    res.json({ books: result.books, message: result.message || "", source: result.source || "" });
  }
);

/** 本地电子书扫描导入（后台任务）：POST { dir, fetchDetail, max } -> { jobId } */
app.post(
  "/api/admin/import/pdf",
  auth.requireAuth,
  auth.rateLimit({ name: "import-pdf", windowMs: 3600_000, max: 10, message: "导入太频繁，请稍后再试" }),
  (req, res) => {
    const b = req.body || {};
    const dir = String(b.dir || "").trim();
    if (!dir) return res.status(400).json({ error: "请填写电子书目录" });
    const max = Math.min(Math.max(Number(b.max) || 300, 1), 1000);
    const fetchDetail = b.fetchDetail === true;
    const jobId = startImportJob("pdf", async (job) => {
      const scan = importPdf.scanDir(dir, { maxFiles: 10000 });
      if (!scan.ok) return { ok: false, error: scan.error };
      job.total = scan.files.length;
      const existing = db.queryBooks({ sort: "id" }); // 书架已有书（含豆瓣导入），本地书优先匹配
      const result = await importPdf.matchDir(dir, {
        max,
        fetchDetail,
        existing,
        onProgress: (p) => {
          job.processed = p.processed;
          job.total = p.total || job.total;
          job.matched = p.matched;
          job.current = p.current || "";
        },
      });
      return result;
    });
    res.json({ ok: true, jobId });
  }
);

/** 确认导入：POST { books: [...] } -> 入库，跳过重复 */
app.post("/api/admin/import/confirm", auth.requireAuth, async (req, res) => {
  const list = Array.isArray((req.body || {}).books) ? req.body.books : [];
  if (!list.length) return res.status(400).json({ error: "没有要导入的书" });

  let added = 0;
  const skipped = [];
  for (const item of list) {
    const data = sanitizeBookBody(item);
    if (!data.title) continue;
    // 导入的是读书记录：默认标记已读
    if (item.read === undefined || item.read === null || item.read === "") data.read = 1;
    data.source = SOURCES.includes(String(item.source)) ? String(item.source) : data.source;

    if (db.findDuplicate(data)) {
      skipped.push(data.title);
      continue;
    }
    db.createBook(data);
    added += 1;
  }
  res.json({ ok: true, added, skipped });
});

/**
 * 批量补全豆瓣信息：有豆瓣链接但缺 ISBN/评分/封面/作者/书名的书，
 * 逐个去豆瓣抓取并回填所有能拿到的信息（后台任务 + 进度）。
 * 已存在的字段不覆盖（避免把用户手动改的内容冲掉）。
 */
app.post(
  "/api/admin/books/fill-isbn",
  auth.requireAuth,
  auth.rateLimit({ name: "fill-isbn", windowMs: 3600_000, max: 5, message: "操作太频繁，请稍后再试" }),
  (req, res) => {
    const jobId = startImportJob("fill-isbn", async (job) => {
      const books = db.getBooksNeedingDoubanInfo();
      job.total = books.length;
      let updated = 0;
      for (let i = 0; i < books.length; i++) {
        const b = books[i];
        try {
          const info = await douban.getBookByUrl(b.douban_url);
          if (info) {
            const fields = {};
            if (info.isbn && !b.isbn) fields.isbn = info.isbn;
            if (info.author && !b.author) fields.author = info.author;
            if (info.cover_url && !b.cover_url) fields.cover_url = info.cover_url;
            if (info.title && !b.title) fields.title = info.title;
            if (info.douban_rating != null && (b.douban_rating == null || b.douban_rating !== info.douban_rating)) {
              fields.douban_rating = info.douban_rating;
            }
            if (Object.keys(fields).length) {
              db.updateBook(b.id, fields);
              updated += 1;
            }
          }
        } catch { /* 单本失败跳过 */ }
        job.processed = i + 1;
        job.current = b.title;
        job.matched = updated;
        await new Promise((r) => setTimeout(r, 300)); // 轻量限速
      }
      return {
        ok: true,
        message: `补全完成：共 ${books.length} 本待补，更新了 ${updated} 本` +
          (updated < books.length ? "（其余可能页面无新信息或抓取失败）" : ""),
      };
    });
    res.json({ ok: true, jobId });
  }
);

// ---- 设置 ----

app.get("/api/admin/settings", auth.requireAuth, (req, res) => {
  const doubanCookie = db.getSetting("doubanCookie");
  const wereadCookie = db.getSetting("wereadCookie");
  res.json({
    // 完整值返回给后台（仅登录可见），用于回填输入框
    doubanCookie,
    doubanCookieSet: !!doubanCookie,
    wereadCookie,
    wereadCookieSet: !!wereadCookie,
    pdfDir: db.getSetting("pdfDir"),
    wereadConfigured: importWeread.isConfigured(),
  });
});

app.put("/api/admin/settings", auth.requireAuth, (req, res) => {
  const b = req.body || {};
  if (b.doubanCookie !== undefined) {
    db.setSetting("doubanCookie", String(b.doubanCookie || "").trim());
    douban.setCookie(db.getSetting("doubanCookie"));
  }
  if (b.wereadCookie !== undefined) {
    db.setSetting("wereadCookie", String(b.wereadCookie || "").trim());
  }
  if (b.pdfDir !== undefined) {
    db.setSetting("pdfDir", String(b.pdfDir || "").trim());
  }
  res.json({ ok: true });
});

// ---- 404 兜底 ----
app.use("/api", (req, res) => res.status(404).json({ error: "接口不存在" }));

// ---- 启动（端口自动顺延） ----
function listen(port) {
  const server = app.listen(port, () => {
    console.log("==============================================");
    console.log("  个人书架已启动");
    console.log(`  前台:  http://localhost:${port}`);
    console.log(`  后台:  http://localhost:${port}${config.adminPath}`);
    console.log("  按 Ctrl+C 停止");
    console.log("==============================================");
  });
  server.on("error", (err) => {
    if (err.code === "EADDRINUSE") {
      console.log(`[启动] 端口 ${port} 被占用，尝试 ${port + 1} ...`);
      listen(port + 1);
    } else {
      throw err;
    }
  });
}

listen(Number(process.env.PORT) || config.port);
