/**
 * 加载 / 生成 config.json。
 * 首次运行自动生成随机 secret、adminPath、初始密码，并打印出来。
 */
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const CONFIG_PATH = path.join(__dirname, "config.json");

function randomHex(n) {
  return crypto.randomBytes(n).toString("hex");
}

function makeDefaults() {
  return {
    port: 5000,
    secret: randomHex(32),
    adminPath: "/mgmt-" + randomHex(8),
    admin: { username: "admin", password: randomHex(10) + "!" },
  };
}

function loadConfig() {
  let cfg = null;
  if (fs.existsSync(CONFIG_PATH)) {
    try {
      cfg = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8"));
    } catch (err) {
      console.warn("[config] config.json 解析失败，重新生成:", err.message);
    }
  }

  const defaults = makeDefaults();
  if (!cfg) {
    cfg = defaults;
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2));
    console.log("==============================================");
    console.log("[config] 已生成 config.json");
    console.log(`  后台地址: http://localhost:${cfg.port}${cfg.adminPath}`);
    console.log(`  账号:     ${cfg.admin.username}`);
    console.log(`  密码:     ${cfg.admin.password}`);
    console.log("  请妥善保管，可在 config.json 中修改");
    console.log("==============================================");
  } else {
    // 已有配置：仅补充缺失字段，不覆盖已有值
    cfg = {
      ...defaults,
      ...cfg,
      admin: { ...defaults.admin, ...(cfg.admin || {}) },
    };
  }
  return cfg;
}

module.exports = loadConfig();
