// src/config.js — DeepSeek Agent 中文版 中央配置
const path = require('path');
const fs   = require('fs');
const os   = require('os');

// ─────────────────────────────────────────────
//  默认配置
// ─────────────────────────────────────────────
const defaults = {
  // 浏览器
  DEEPSEEK_URL   : 'https://chat.deepseek.com',
  SESSION_DIR    : path.join(os.homedir(), '.deepseek-agent-zhcn', 'session'),
  HEADLESS       : false,

  // 时间设置
  RESPONSE_TIMEOUT : 180_000,
  STABLE_DELAY     : 2_500,
  SEND_DELAY       : 400,

  // Agent
  MAX_ITERATIONS   : 60,
  WORKING_DIR      : process.cwd(),

  // 输出
  MAX_OUTPUT_LENGTH : 8_000,
  DEBUG             : false,
};

// ─────────────────────────────────────────────
//  配置加载优先级（高优先级覆盖低优先级）:
//
//  1. ~/.deepseek-agent-zhcn/config.json  — 全局用户配置
//  2. ./deepseek-agent-zhcn.config.json   — 项目级配置
// ─────────────────────────────────────────────

function loadJson(filePath) {
  try {
    if (fs.existsSync(filePath)) {
      return JSON.parse(fs.readFileSync(filePath, 'utf8'));
    }
  } catch {
    console.warn('[deepseek-agent-zhcn] 无法解析配置文件: ' + filePath);
  }
  return {};
}

const globalConfigPath  = path.join(os.homedir(), '.deepseek-agent-zhcn', 'config.json');
const projectConfigPath = path.join(process.cwd(), 'deepseek-agent-zhcn.config.json');

const config = {
  ...defaults,
  ...loadJson(globalConfigPath),   // 全局配置覆盖默认值
  ...loadJson(projectConfigPath),  // 项目配置覆盖全局配置
};

// 移除 JSON 文件中的注释键
delete config._comment;

// 将会话目录解析为绝对路径
if (!path.isAbsolute(config.SESSION_DIR)) {
  config.SESSION_DIR = path.resolve(process.cwd(), config.SESSION_DIR);
}

// 确保必要目录存在
fs.mkdirSync(config.SESSION_DIR, { recursive: true });
fs.mkdirSync(path.join(os.homedir(), '.deepseek-agent-zhcn', 'logs'), { recursive: true });

module.exports = config;
