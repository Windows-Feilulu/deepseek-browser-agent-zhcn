// src/browser.js — Playwright 控制器 for chat.deepseek.com（修复版）
'use strict';

const { chromium } = require('playwright');
const path         = require('path');
const config       = require('./config');
const logger       = require('./logger');

// ─────────────────────────────────────────────────────────────────────────────
//  选择器库 — 按可能性排序，提供回退方案
//  绝不依赖单一选择器，因为 DeepSeek 的 UI 可能会变
// ─────────────────────────────────────────────────────────────────────────────

const SEL = {
  // 用户输入消息的文本框
  chatInput: [
    '#chat-input',
    'textarea[placeholder]',
    'textarea',
    '[contenteditable="true"][role="textbox"]',
    '[contenteditable="true"]',
  ],

  // 提交消息的按钮
  sendButton: [
    'button[aria-label*="Send" i]',
    'button[aria-label*="send" i]',
    '[data-testid="send-button"]',
    'button[type="submit"]',
    '[class*="send-btn"]',
    '[class*="sendBtn"]',
    '[class*="send-button"]',
  ],

  // “停止生成”按钮 — 在流式响应时可见
  stopButton: [
    'button[aria-label*="Stop" i]',
    '[aria-label*="stop generating" i]',
    '[data-testid="stop-button"]',
    '[class*="stop-btn"]',
    '[class*="stopBtn"]',
  ],

  // 侧边栏中的“新建聊天”按钮
  newChat: [
    'button[aria-label*="New chat" i]',
    'button[aria-label*="New conversation" i]',
    'a[href="/"][aria-label]',
    '[data-testid="new-chat"]',
    '[class*="new-chat"]',
    '[class*="newChat"]',
  ],

  // 主要聊天消息容器
  messageContainer: [
    '[class*="chat-content"]',
    '[class*="message-list"]',
    '[class*="conversation"]',
    'main',
  ],
};

// ─────────────────────────────────────────────────────────────────────────────
//  DeepSeekBrowser 类
// ─────────────────────────────────────────────────────────────────────────────

class DeepSeekBrowser {
  constructor() {
    this.context  = null;
    this.page     = null;
    this._closed  = false;
  }

  // ── 生命周期 ──────────────────────────────────────────────────────────────

  async launch() {
    logger.info('正在使用持久化会话启动浏览器...');

    const sessionDir = path.resolve(config.SESSION_DIR);

    this.context = await chromium.launchPersistentContext(sessionDir, {
      headless      : config.HEADLESS,
      viewport      : { width: 1280, height: 900 },
      userAgent     : [
        'Mozilla/5.0 (X11; Linux x86_64)',
        'AppleWebKit/537.36 (KHTML, like Gecko)',
        'Chrome/124.0.0.0 Safari/537.36',
      ].join(' '),
      args: [
        '--disable-blink-features=AutomationControlled',
        '--no-first-run',
        '--disable-default-apps',
        '--no-sandbox',
        '--disable-setuid-sandbox',
      ],
      ignoreDefaultArgs: ['--enable-automation'],
    });

    // 复用已有页面或创建新页面
    const pages   = this.context.pages();
    this.page     = pages.length > 0 ? pages[0] : await this.context.newPage();

    // 屏蔽自动化特征
    await this.page.addInitScript(() => {
      Object.defineProperty(navigator, 'webdriver', { get: () => false });
    });

    await this._navigate(config.DEEPSEEK_URL);
    await this._ensureLoggedIn();

    logger.success('浏览器准备就绪！');
  }

  async close() {
    if (this._closed) return;
    this._closed = true;
    try { await this.context?.close(); } catch {}
  }

  // ── 导航 ─────────────────────────────────────────────────────────────────

  async _navigate(url) {
    try {
      await this.page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30_000 });
      await this.page.waitForTimeout(1_500);
    } catch (err) {
      logger.warn(`导航警告: ${err.message}`);
    }
  }

  async newChat() {
    try {
      // 尝试点击侧边栏的“新建聊天”按钮
      for (const sel of SEL.newChat) {
        try {
          const el = await this.page.$(sel);
          if (el && await el.isVisible()) {
            await el.click();
            await this.page.waitForTimeout(1_000);
            logger.dim('已启动新聊天会话');
            return;
          }
        } catch {}
      }
    } catch {}

    // 回退方案：导航到首页，通常会打开新聊天
    await this._navigate(config.DEEPSEEK_URL);
    logger.dim('已导航到 DeepSeek 首页（新聊天）');
  }

  // ── 登录处理 ─────────────────────────────────────────────────────────────

  async _ensureLoggedIn() {
    await this.page.waitForTimeout(2_000);

    const needsLogin = await this.page.evaluate(() => {
      const url = window.location.href;
      const bodyText = document.body?.innerText || '';
      return (
        url.includes('/auth') ||
        url.includes('/login') ||
        url.includes('/sign') ||
        bodyText.includes('Sign in') ||
        bodyText.includes('Log in') ||
        !!document.querySelector('input[type="password"]')
      );
    });

    if (needsLogin) {
      this._printLoginBanner();
      await this._waitForEnter();
      await this.page.waitForTimeout(2_000);
    }
  }

  _printLoginBanner() {
    console.log('');
    logger.warn('╔══════════════════════════════════════════════╗');
    logger.warn('║  🔐  需要登录                                ║');
    logger.warn('║                                              ║');
    logger.warn('║  1. 在浏览器窗口中登录 DeepSeek              ║');
    logger.warn('║  2. 返回此处并按  回车  继续                 ║');
    logger.warn('╚══════════════════════════════════════════════╝');
    console.log('');
  }

  async _waitForEnter() {
    return new Promise(resolve => {
      const stdin   = process.stdin;
      const wasRaw  = stdin.isRaw;
      const wasPaused = !stdin.readable;

      if (stdin.isTTY) stdin.setRawMode(false);
      stdin.resume();

      const handler = chunk => {
        const s = chunk.toString();
        if (s.includes('\n') || s.includes('\r')) {
          stdin.removeListener('data', handler);
          if (stdin.isTTY && wasRaw) stdin.setRawMode(true);
          if (wasPaused)            stdin.pause();
          resolve();
        }
      };

      stdin.on('data', handler);
    });
  }

  // ── 发送消息 ─────────────────────────────────────────────────────────────

  async sendMessage(text) {
    // 找到输入框
    const { el, isTextarea } = await this._findInput();

    // 点击聚焦
    await el.click({ force: true });
    await this.page.waitForTimeout(200);

    // 清空现有内容
    await this.page.keyboard.press('Control+a');
    await this.page.waitForTimeout(100);

    if (isTextarea) {
      // 标准 textarea — 使用 fill() 更可靠
      await el.fill(text);
    } else {
      // contenteditable div — 使用 execCommand
      await this.page.evaluate((element, content) => {
        element.focus();
        document.execCommand('selectAll', false, null);
        document.execCommand('delete',    false, null);
        document.execCommand('insertText', false, content);
        element.dispatchEvent(new InputEvent('input', { bubbles: true, data: content }));
      }, el, text);
    }

    await this.page.waitForTimeout(config.SEND_DELAY);

    // 优先点击发送按钮，否则按 Enter
    const clicked = await this._clickSendButton();
    if (!clicked) {
      // DeepSeek 默认 Enter 发送，Shift+Enter 换行
      await this.page.keyboard.press('Enter');
    }

    await this.page.waitForTimeout(500);
  }

  async _findInput() {
    for (const sel of SEL.chatInput) {
      try {
        const el = await this.page.waitForSelector(sel, { timeout: 4_000, state: 'visible' });
        if (!el) continue;
        const tagName          = await el.evaluate(e => e.tagName.toLowerCase());
        const isContentEditable = await el.evaluate(e => e.isContentEditable);
        return { el, isTextarea: tagName === 'textarea' && !isContentEditable };
      } catch {}
    }
    throw new Error(
      '无法找到 DeepSeek 聊天输入框。\n' +
      '  → 确保页面已完全加载且你已登录。\n' +
      '  → 使用 --debug 运行以检查 DOM 选择器。\n' +
      '  → 运行: node src/calibrate.js 以自动检测选择器。'
    );
  }

  async _clickSendButton() {
    for (const sel of SEL.sendButton) {
      try {
        const el = await this.page.$(sel);
        if (el && await el.isVisible() && await el.isEnabled()) {
          await el.click();
          return true;
        }
      } catch {}
    }
    return false;
  }

  // ── 等待响应 ─────────────────────────────────────────────────────────────

  /**
   * 等待 DeepSeek 完成生成并返回响应文本。
   *
   * 算法：
   *  1. 记录当前页面上的助手消息数量。
   *  2. 等待新消息出现（数量增加）。
   *  3. 每 500ms 轮询最后一条消息的文本。
   *  4. 当文本在 STABLE_DELAY 毫秒内未变化，且没有“停止/加载”指示器时 → 完成。
   */
  async waitForResponse() {
    const timeout     = config.RESPONSE_TIMEOUT;
    const stableDelay = config.STABLE_DELAY;
    const start       = Date.now();

    // ── 阶段1：等待新消息出现 ──────────────────────────────────────────
    const initialCount = await this._getMessageCount();
    let   appeared     = false;

    while (Date.now() - start < 12_000) {
      const count = await this._getMessageCount();
      if (count > initialCount) { appeared = true; break; }
      await this.page.waitForTimeout(400);
    }

    if (!appeared) logger.warn('响应可能延迟 — 继续等待...');

    // ── 阶段2：等待文本稳定 ────────────────────────────────────────────
    let lastText    = '';
    let stableStart = null;
    let dotCount    = 0;

    while (Date.now() - start < timeout) {
      const text = await this._extractLastMessage();

      if (text !== lastText) {
        lastText    = text;
        stableStart = null;
      } else if (text.length > 0) {
        if (!stableStart) stableStart = Date.now();
        else if (Date.now() - stableStart >= stableDelay) {
          if (!await this._isGenerating()) break;  // 确认已完成
          stableStart = null;                       // 仍在生成，重置
        }
      }

      // 进度指示
      dotCount = (dotCount + 1) % 4;
      logger.thinking(`正在接收回复${'.'.repeat(dotCount)}  (${text.length} 字符)`);

      await this.page.waitForTimeout(500);
    }

    logger.clearLine();

    const final = await this._extractLastMessage();
    return this._cleanText(final);
  }

  // ── DOM 提取 ───────────────────────────────────────────────────────────

  /** 统计可见的“响应”块数量 */
  async _getMessageCount() {
    return await this.page.evaluate(() => {
      const candidates = [
        '[class*="assistant"][class*="message"]',
        '[data-role="assistant"]',
        '[class*="markdown-content"]',
        '.ds-markdown',
        '[class*="chat-message"]',
        '[class*="message-bubble"]',
      ];
      for (const sel of candidates) {
        const els = document.querySelectorAll(sel);
        if (els.length > 0) return els.length;
      }
      // 广泛回退
      return document.querySelectorAll('[class*="message"]').length;
    });
  }

  /** 提取最后一条助手消息的文本（包含代码块） */
  async _extractLastMessage() {
    return await this.page.evaluate(() => {

      // ── 辅助函数：提取完整文本，保留代码块 fence ────────────────────
      function getFullText(el) {
        if (!el) return '';
        let result = '';

        function walk(node) {
          if (node.nodeType === Node.TEXT_NODE) {
            result += node.textContent;
            return;
          }
          if (node.nodeType !== Node.ELEMENT_NODE) return;
          const tag = node.tagName.toLowerCase();

          // <pre> 包裹了带 fence 的代码块 — 重建反引号 fence
          if (tag === 'pre') {
            const codeEl = node.querySelector('code');
            if (codeEl) {
              const cls  = codeEl.className || '';
              const lang = (cls.match(/language-(\S+)/) || [])[1] || '';
              const body = codeEl.textContent || '';
              result += '\n```' + lang + '\n' + body + '\n```\n';
            } else {
              result += '\n```\n' + node.textContent + '\n```\n';
            }
            return;
          }

          // 行内 <code> — 若不在 <pre> 内则包裹反引号
          if (tag === 'code') {
            const parentTag = node.parentElement && node.parentElement.tagName
              ? node.parentElement.tagName.toLowerCase() : '';
            if (parentTag !== 'pre') {
              result += '`' + node.textContent + '`';
            }
            return;
          }

          for (const child of node.childNodes) walk(child);

          if (['p','div','li','br','h1','h2','h3','h4','h5','h6'].includes(tag)) {
            result += '\n';
          }
        }

        walk(el);
        return result.trim();
      }

      // ── 尝试1：特定的助手消息选择器 ──────────────────────────────────
      const directSelectors = [
        '.ds-markdown',
        '[class*="assistant"] [class*="markdown"]',
        '[class*="assistant"] [class*="content"]',
        '[data-role="assistant"] [class*="content"]',
        '[class*="ai-message"] [class*="content"]',
        '[class*="bot-message"] [class*="content"]',
        '[class*="response-content"]',
        '[class*="message-content"]:last-child',
      ];

      for (const sel of directSelectors) {
        const els = document.querySelectorAll(sel);
        if (els.length > 0) {
          const t = getFullText(els[els.length - 1]);
          if (t.length > 10) return t;
        }
      }

      // ── 尝试2：任何 markdown / prose 容器 ──────────────────────────────
      const markdownEls = document.querySelectorAll(
        '[class*="markdown"], [class*="prose"], [class*="rendered"]'
      );
      if (markdownEls.length > 0) {
        const t = getFullText(markdownEls[markdownEls.length - 1]);
        if (t.length > 10) return t;
      }

      // ── 尝试3：启发式 — 大的非用户文本块 ──────────────────────────────
      const allBlocks = Array.from(
        document.querySelectorAll('[class*="message"], [class*="chat-item"], [class*="turn"]')
      );
      const candidates = allBlocks.filter(el => {
        const cls = el.className || '';
        return (
          !cls.toLowerCase().includes('input') &&
          !cls.toLowerCase().includes('user') &&
          !el.querySelector('textarea, input[type="text"]') &&
          (el.innerText || '').length > 20
        );
      });

      if (candidates.length > 0) {
        return getFullText(candidates[candidates.length - 1]);
      }

      return '';
    });
  }

  /** 如果 DeepSeek 仍在流式生成则返回 true */
  async _isGenerating() {
    return await this.page.evaluate(() => {
      // 检查停止按钮
      const stopSelectors = [
        'button[aria-label*="Stop" i]',
        '[class*="stop-gen"]',
        '[class*="stopGen"]',
        '[class*="generating"]',
      ];
      for (const sel of stopSelectors) {
        const el = document.querySelector(sel);
        if (el) {
          const s = window.getComputedStyle(el);
          if (s.display !== 'none' && s.visibility !== 'hidden' && s.opacity !== '0') return true;
        }
      }

      // 检查动画加载/打字指示器
      const loaderSelectors = [
        '[class*="typing"]',
        '[class*="loading"]',
        '[class*="spinner"]',
        '[class*="blink"]',
        '[class*="cursor"]',
        '[class*="pulsing"]',
        'svg[class*="loading"]',
        'svg[class*="spinner"]',
      ];
      for (const sel of loaderSelectors) {
        const el = document.querySelector(sel);
        if (el) {
          const s = window.getComputedStyle(el);
          if (s.display !== 'none' && s.visibility !== 'hidden') return true;
        }
      }

      return false;
    });
  }

  // ── 文本清理 ────────────────────────────────────────────────────────────

  _cleanText(text) {
    if (!text) return '';

    return text
      // 去除 DeepSeek R1 的思考块
      .replace(/<think>[\s\S]*?<\/think>\n?/gi, '')
      // 去除有时前缀的“Thinking...”头
      .replace(/^Thinking\.{0,3}\n[\s\S]*?\n\n/m, '')
      // 去除复制代码按钮的伪影如 “1CopyRunInsert”
      .replace(/^\d+(?:Copy|Run|Insert|Edit)\b.*$/gm, '')
      // 将 3 个以上空行压缩为 2 个
      .replace(/\n{3,}/g, '\n\n')
      .trim();
  }

  // ── 调试 / 校准工具 ────────────────────────────────────────────────────

  /**
   * 将有用的 DOM 信息打印到 stdout。
   * 通过 `node src/calibrate.js` 或 `--debug` 标志调用。
   */
  async dumpDebugInfo() {
    const info = await this.page.evaluate(() => {
      const classFreq = {};
      document.querySelectorAll('*').forEach(el => {
        el.classList.forEach(c => {
          if (c.match(/message|chat|input|send|stop|markdown|content|assistant|user|bot/i)) {
            classFreq[c] = (classFreq[c] || 0) + 1;
          }
        });
      });

      const inputs = Array.from(document.querySelectorAll('textarea, [contenteditable]')).map(e => ({
        tag         : e.tagName,
        id          : e.id || null,
        class       : e.className?.slice(0, 80) || null,
        placeholder : e.placeholder || null,
        editable    : e.isContentEditable,
        visible     : e.offsetParent !== null,
      }));

      return {
        url    : window.location.href,
        title  : document.title,
        classes: Object.entries(classFreq).sort((a, b) => b[1] - a[1]).slice(0, 40),
        inputs,
      };
    });

    console.log('\n' + '═'.repeat(40));
    console.log('  DOM 调试信息');
    console.log('═'.repeat(40));
    console.log('URL   :', info.url);
    console.log('标题 :', info.title);
    console.log('\n输入元素:');
    info.inputs.forEach(i => console.log(' ', JSON.stringify(i)));
    console.log('\n匹配 CSS 类（按频率）:');
    info.classes.forEach(([cls, count]) => console.log(`  ${String(count).padStart(3)}x  .${cls}`));
    console.log('═'.repeat(40) + '\n');
  }

  /** 截图（用于调试） */
  async screenshot(filePath = '/tmp/deepseek-agent-debug.png') {
    await this.page.screenshot({ path: filePath, fullPage: false });
    logger.info(`截图已保存: ${filePath}`);
  }
}

module.exports = DeepSeekBrowser;