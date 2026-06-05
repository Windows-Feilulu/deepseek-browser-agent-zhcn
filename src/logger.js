// src/logger.js — 终端彩色输出模块（中文版）
'use strict';

const A = {
  reset   : '\x1b[0m',
  bold    : '\x1b[1m',
  dim     : '\x1b[2m',
  red     : '\x1b[31m',
  green   : '\x1b[32m',
  yellow  : '\x1b[33m',
  blue    : '\x1b[34m',
  magenta : '\x1b[35m',
  cyan    : '\x1b[36m',
  white   : '\x1b[37m',
  gray    : '\x1b[90m',
  lred    : '\x1b[91m',
  lgreen  : '\x1b[92m',
  lyellow : '\x1b[93m',
  lblue   : '\x1b[94m',
  lmagenta: '\x1b[95m',
  lcyan   : '\x1b[96m',
};

const c  = (code, text) => `${A[code]}${text}${A.reset}`;
const cb = (code, text) => `${A.bold}${A[code]}${text}${A.reset}`;

// ── 辅助函数 ──────────────────────────────────────────────────────────────────

/**
 * 截断过长的字符串以便显示
 * @param {string} str - 要截断的字符串
 * @param {number} max - 最大字符数
 * @returns {string} 截断后的字符串
 */
function truncDisplay(str, max = 400) {
  if (!str) return '';
  const s = String(str);
  if (s.length <= max) return s;
  return s.slice(0, max) + c('gray', `… (+${s.length - max} 字符)`);
}

/**
 * JSON 对象预览
 * @param {object} obj - 要预览的对象
 * @param {number} max - 最大字符数
 * @returns {string} 预览字符串
 */
function jsonPreview(obj, max = 350) {
  const s = JSON.stringify(obj, null, 2);
  return truncDisplay(s, max);
}

// ── 公开日志 API ──────────────────────────────────────────────────────────────
const logger = {
  /**
   * 打印启动横幅
   */
  banner() {
    console.log(`
${c('cyan','╔══════════════════════════════════════════════════╗')}
${c('cyan','║')}   ${cb('lcyan','🤖  DeepSeek 浏览器助手（中文版）')}            ${c('cyan','║')}
${c('cyan','║')}   ${c('gray','基于浏览器自动化的AI编程助手')}              ${c('cyan','║')}
${c('cyan','║')}   ${c('gray','无需API密钥 — 使用 chat.deepseek.com')}       ${c('cyan','║')}
${c('cyan','╚══════════════════════════════════════════════════╝')}
`);
  },

  /**
   * 打印带样式的标题
   * @param {string} msg - 标题文本
   */
  header(msg) {
    const line = '─'.repeat(50);
    console.log(`\n${c('blue', line)}`);
    console.log(`${c('bold','📋 ')}${cb('white', msg)}`);
    console.log(`${c('blue', line)}\n`);
  },

  /**
   * 打印信息消息
   * @param {string} msg - 信息文本
   */
  info(msg)    { console.log(`${c('lblue','  ℹ ')} ${msg}`); },

  /**
   * 打印成功消息
   * @param {string} msg - 成功文本
   */
  success(msg) { console.log(`${c('lgreen','  ✓ ')} ${c('lgreen', msg)}`); },

  /**
   * 打印警告消息
   * @param {string} msg - 警告文本
   */
  warn(msg)    { console.log(`${c('lyellow','  ⚠ ')} ${c('lyellow', msg)}`); },

  /**
   * 打印错误消息
   * @param {string} msg - 错误文本
   */
  error(msg)   { console.log(`${c('lred','  ✗ ')} ${c('lred', msg)}`); },

  /**
   * 打印暗淡文本（次要信息）
   * @param {string} msg - 暗淡文本
   */
  dim(msg)     { console.log(`${A.dim}    ${msg}${A.reset}`); },

  /**
   * 旋转动画（覆盖同一行）
   * @param {string} msg - 显示的文本
   */
  thinking(msg) {
    process.stdout.write(`  ${c('cyan','⟳')} ${c('gray', msg)}\r`);
  },

  /**
   * 清除当前行
   */
  clearLine() {
    process.stdout.write(`\r${' '.repeat(80)}\r`);
  },

  // ── 工具调用显示 ───────────────────────────────────────────────────────────

  /**
   * 打印工具调用信息
   * @param {string} name - 工具名称
   * @param {object} args - 工具参数
   */
  toolCall(name, args) {
    console.log(`\n  ${cb('magenta','⚡ 工具调用')} ${c('cyan', `→ ${name}`)}`);
    const preview = jsonPreview(args);
    if (preview.trim()) {
      preview.split('\n').forEach(l => console.log(`  ${c('gray', l)}`));
    }
  },

  /**
   * 打印工具执行结果
   * @param {*} result - 执行结果
   * @param {boolean} isError - 是否为错误
   */
  toolResult(result, isError = false) {
    const icon   = isError ? c('lred','  ✗ 结果:') : c('lgreen','  ✓ 结果:');
    const text   = truncDisplay(String(result), 300);
    const color  = isError ? 'lred' : 'gray';
    console.log(`${icon}`);
    text.split('\n').slice(0, 12).forEach(l => console.log(`  ${c(color, l)}`));
    if (String(result).split('\n').length > 12) {
      console.log(`  ${c('gray','  … (已截断)')}`);
    }
    console.log('');
  },

  // ── 最终输出 ────────────────────────────────────────────────────────────────

  /**
   * 打印任务完成信息
   * @param {string} msg - 任务结果文本
   */
  finalOutput(msg) {
    const line = '━'.repeat(50);
    console.log(`\n${c('lgreen', line)}`);
    console.log(`${cb('lgreen','✅  任务完成')}`);
    console.log(`${c('lgreen', line)}\n`);
    console.log(msg);
    console.log('');
  },

  // ── 分隔符 ────────────────────────────────────────────────────────────────

  /**
   * 打印分隔标签
   * @param {string} label - 标签文本
   */
  separator(label = '') {
    const pad = label ? ` ${label} ` : '';
    console.log(`\n${c('gray', '·'.repeat(20) + pad + '·'.repeat(20))}\n`);
  },

  // ── 迭代标记 ────────────────────────────────────────────────────────────────

  /**
   * 打印迭代步骤标记
   * @param {number} n - 当前步骤
   * @param {number} max - 最大步骤数
   */
  iteration(n, max) {
    console.log(`\n${c('gray','  ┄')} ${c('dim',`步骤 ${n}/${max}`)} ${c('gray','┄')}`);
  },
};

module.exports = logger;
