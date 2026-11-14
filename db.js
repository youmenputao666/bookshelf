/**
 * 数据库初始化与常用查询（SQLite，better-sqlite3 同步 API）
 */
const path = require("path");
const fs = require("fs");
const Database = require("better-sqlite3");

const DATA_DIR = path.join(__dirname, "data");
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

const db = new Database(path.join(DATA_DIR, "books.db"));
db.pragma("journal_mode = WAL");

// ---- 建表 ----
db.exec(`
CREATE TABLE IF NOT EXISTS books (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  title         TEXT NOT NULL,
  author        TEXT NOT NULL DEFAULT '',
  isbn          TEXT NOT NULL DEFAULT '',
  douban_url    TEXT NOT NULL DEFAULT '',
  cover_url     TEXT NOT NULL DEFAULT '',
  douban_rating REAL,                       -- 豆瓣评分（参考展示）
  physical      INTEGER NOT NULL DEFAULT 0, -- 实体有
  ebook         INTEGER NOT NULL DEFAULT 0, -- 电子有
  read          INTEGER NOT NULL DEFAULT 0, -- 已读
  rating        INTEGER,                    -- 我的评分 1-5，NULL=未评
  note          TEXT NOT NULL DEFAULT '',   -- 我的短评/备注
  read_at       TEXT,                       -- 读毕日期 YYYY-MM-DD
  source        TEXT NOT NULL DEFAULT 'manual', -- manual / douban / weread / pdf
  created_at    TEXT NOT NULL DEFAULT (datetime('now','localtime')),
  updated_at    TEXT
);
CREATE INDEX IF NOT EXISTS idx_books_status ON books(physical, ebook, read);

CREATE TABLE IF NOT EXISTS sessions (
  token      TEXT PRIMARY KEY,
  created_at TEXT NOT NULL DEFAULT (datetime('now','localtime')),
  expires_at TEXT NOT NULL,
  account_id INTEGER
);

CREATE TABLE IF NOT EXISTS accounts (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  username      TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  salt          TEXT NOT NULL,
  created_at    TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);

CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL DEFAULT ''
);
`);

// ---- 书籍查询 ----

/** 前台书架查询：view 决定基础条件，read/own/rated/q 进一步筛选 */
function queryBooks({ view, read, own, rated, douban, q, sort } = {}) {
  const where = [];
  const params = [];
  if (view === "physical") where.push("physical = 1");
  else if (view === "ebook") where.push("ebook = 1");
  else if (view === "read") where.push("read = 1");
  else if (view === "unread") where.push("read = 0");
  else if (view === "read-no-own") where.push("read = 1 AND physical = 0 AND ebook = 0");

  if (read === "1") where.push("read = 1");
  else if (read === "0") where.push("read = 0");

  if (own === "physical") where.push("physical = 1");
  else if (own === "ebook") where.push("ebook = 1");
  else if (own === "none") where.push("physical = 0 AND ebook = 0");

  if (rated === "1") where.push("rating IS NOT NULL");
  else if (rated === "0") where.push("rating IS NULL");
  if (douban === "1") where.push("douban_url <> ''");
  else if (douban === "0") where.push("douban_url = ''");
  if (q) {
    where.push("(title LIKE ? OR author LIKE ?)");
    params.push(`%${q}%`, `%${q}%`);
  }

  const whereSql = where.length ? "WHERE " + where.join(" AND ") : "";
  let order = "id DESC";
  if (sort === "rating") order = "COALESCE(rating, 0) DESC, id DESC";
  else if (sort === "read_at") order = "COALESCE(read_at, '') DESC, id DESC";
  else if (sort === "title") order = "title COLLATE NOCASE ASC, id ASC";

  return db.prepare(`SELECT * FROM books ${whereSql} ORDER BY ${order}`).all(...params);
}

function createBook(data) {
  const stmt = db.prepare(`
    INSERT INTO books (title, author, isbn, douban_url, cover_url, douban_rating,
                       physical, ebook, read, rating, note, read_at, source)
    VALUES (@title, @author, @isbn, @douban_url, @cover_url, @douban_rating,
            @physical, @ebook, @read, @rating, @note, @read_at, @source)
  `);
  return stmt.run(data).lastInsertRowid;
}

function getBook(id) {
  return db.prepare("SELECT * FROM books WHERE id = ?").get(id);
}

function updateBook(id, fields) {
  const keys = Object.keys(fields);
  if (!keys.length) return;
  const sets = keys.map((k) => `${k} = @${k}`).join(", ");
  db.prepare(`UPDATE books SET ${sets}, updated_at = datetime('now','localtime') WHERE id = @id`).run({
    ...fields,
    id,
  });
}

function deleteBook(id) {
  db.prepare("DELETE FROM books WHERE id = ?").run(id);
}

/**
 * 已存在判定：
 *  - 有豆瓣链接时，只按豆瓣链接判重（同书名不同版本的链接不算同一本）。
 *  - 无豆瓣链接时，退回按书名+作者判重（手动添加/本地导入的书）。
 */
function findDuplicate(b) {
  if (b.douban_url) {
    const byUrl = db.prepare("SELECT id FROM books WHERE douban_url = ? LIMIT 1").get(b.douban_url);
    return byUrl ? byUrl.id : null;
  }
  const byTitle = db
    .prepare("SELECT id FROM books WHERE title = ? AND author = ? LIMIT 1")
    .get(b.title, b.author || "");
  return byTitle ? byTitle.id : null;
}

/** 有豆瓣链接但 ISBN 为空的书（用于批量补全 ISBN） */
function getBooksMissingIsbn() {
  return db.prepare("SELECT * FROM books WHERE douban_url <> '' AND isbn = '' ORDER BY id").all();
}

/** 有豆瓣链接但缺任一信息（ISBN/评分/封面/作者/书名）的书，用于批量补全豆瓣信息 */
function getBooksNeedingDoubanInfo() {
  return db
    .prepare(
      `SELECT * FROM books WHERE douban_url <> ''
       AND (isbn = '' OR douban_rating IS NULL OR cover_url = '' OR author = '')
       ORDER BY id`
    )
    .all();
}

function getStats() {
  const one = (sql) => db.prepare(sql).get().c;
  return {
    total: one("SELECT COUNT(*) AS c FROM books"),
    physical: one("SELECT COUNT(*) AS c FROM books WHERE physical = 1"),
    ebook: one("SELECT COUNT(*) AS c FROM books WHERE ebook = 1"),
    read: one("SELECT COUNT(*) AS c FROM books WHERE read = 1"),
    unread: one("SELECT COUNT(*) AS c FROM books WHERE read = 0"),
    readNoOwn: one("SELECT COUNT(*) AS c FROM books WHERE read = 1 AND physical = 0 AND ebook = 0"),
    rated: one("SELECT COUNT(*) AS c FROM books WHERE rating IS NOT NULL"),
  };
}

// ---- 设置 ----

function getSetting(key) {
  const row = db.prepare("SELECT value FROM settings WHERE key = ?").get(key);
  return row ? row.value : "";
}

function setSetting(key, value) {
  db.prepare(
    "INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)"
  ).run(key, String(value == null ? "" : value));
}

// ---- 会话 ----

function createSession(token, expiresAt, accountId) {
  db.prepare("INSERT OR REPLACE INTO sessions (token, expires_at, account_id) VALUES (?, ?, ?)").run(
    token,
    expiresAt,
    accountId
  );
}

function getSession(token) {
  return db.prepare("SELECT * FROM sessions WHERE token = ?").get(token);
}

function deleteSession(token) {
  db.prepare("DELETE FROM sessions WHERE token = ?").run(token);
}

function cleanExpiredSessions() {
  db.prepare("DELETE FROM sessions WHERE expires_at < datetime('now','localtime')").run();
}

// ---- 账号 ----

function createAccount({ username, password_hash, salt }) {
  return db
    .prepare("INSERT INTO accounts (username, password_hash, salt) VALUES (?, ?, ?)")
    .run(username, password_hash, salt).lastInsertRowid;
}

function getAccount(id) {
  return db.prepare("SELECT * FROM accounts WHERE id = ?").get(id);
}

function getAccountByUsername(username) {
  return db.prepare("SELECT * FROM accounts WHERE username = ?").get(username);
}

function countAccounts() {
  return db.prepare("SELECT COUNT(*) AS c FROM accounts").get().c;
}

module.exports = {
  db,
  queryBooks,
  createBook,
  getBook,
  updateBook,
  deleteBook,
  findDuplicate,
  getStats,
  getBooksMissingIsbn,
  getBooksNeedingDoubanInfo,
  getSetting,
  setSetting,
  createSession,
  getSession,
  deleteSession,
  cleanExpiredSessions,
  createAccount,
  getAccount,
  getAccountByUsername,
  countAccounts,
};
