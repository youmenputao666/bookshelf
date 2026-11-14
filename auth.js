/**
 * 后台登录鉴权（单人管理员）
 * - 账号存 accounts 表，密码 scrypt + 随机盐
 * - 登录签发 token 存 sessions，httpOnly cookie，重启不失效
 * 另提供简单的内存限流，防止公开接口被刷。
 */
const crypto = require("crypto");
const config = require("./config.js");
const db = require("./db.js");

const TOKEN_COOKIE = "admin_token";
const SESSION_TTL_HOURS = 24 * 30; // 30 天

// ---- 密码 ----
function hashPassword(password, salt) {
  return crypto.scryptSync(String(password), salt, 64).toString("hex");
}

function randomSalt() {
  return crypto.randomBytes(16).toString("hex");
}

// ---- 初始化：确保初始管理员账号存在 ----
function initAuth() {
  if (db.countAccounts() === 0) {
    const salt = randomSalt();
    db.createAccount({
      username: config.admin.username,
      password_hash: hashPassword(config.admin.password, salt),
      salt,
    });
    console.log("[auth] 已创建初始管理员账号: " + config.admin.username);
  }
}

// ---- 登录 ----
function login(username, password) {
  if (!username || !password) return null;
  const account = db.getAccountByUsername(String(username).trim());
  if (!account) return null;
  const hash = hashPassword(String(password), account.salt);
  if (!crypto.timingSafeEqual(Buffer.from(hash, "hex"), Buffer.from(account.password_hash, "hex"))) {
    return null;
  }
  const token = crypto.randomBytes(32).toString("hex");
  const expiresAt = new Date(Date.now() + SESSION_TTL_HOURS * 3600 * 1000);
  db.createSession(token, expiresAt.toISOString(), account.id);
  return { token, expiresAt, account };
}

/** 解析请求，返回 account 或 null */
function authenticate(req) {
  const token = req.cookies?.[TOKEN_COOKIE];
  if (!token) return null;
  const session = db.getSession(token);
  if (!session) return null;
  if (new Date(session.expires_at) < new Date()) {
    db.deleteSession(token);
    return null;
  }
  const account = db.getAccount(session.account_id);
  if (!account) return null;
  return { account };
}

function logout(token) {
  if (token) db.deleteSession(token);
}

/** 登录即可访问的中间件，附加 req.auth */
function requireAuth(req, res, next) {
  const auth = authenticate(req);
  if (!auth) return res.status(401).json({ error: "未登录或登录已过期" });
  req.auth = auth;
  next();
}

// ---- 简单限流：每 IP 每窗口最多 count 次 ----
const buckets = new Map(); // key: `${name}:${ip}` -> { count, windowStart }

function rateLimit({ name, windowMs, max, message }) {
  return (req, res, next) => {
    const ip = req.ip || "unknown";
    const key = `${name}:${ip}`;
    const now = Date.now();
    let b = buckets.get(key);
    if (!b || now - b.windowStart >= windowMs) {
      b = { count: 0, windowStart: now };
      buckets.set(key, b);
    }
    b.count += 1;
    if (b.count > max) {
      return res.status(429).json({ error: message || "请求过于频繁，请稍后再试" });
    }
    next();
  };
}

// 定期清理限流桶，防止内存增长
setInterval(() => {
  const now = Date.now();
  for (const [k, b] of buckets) {
    if (now - b.windowStart >= 3600_000) buckets.delete(k);
  }
}, 600_000).unref();

// 定期清理过期会话
setInterval(() => db.cleanExpiredSessions(), 3600_000).unref();

module.exports = {
  TOKEN_COOKIE,
  hashPassword,
  randomSalt,
  initAuth,
  login,
  logout,
  authenticate,
  requireAuth,
  rateLimit,
};
