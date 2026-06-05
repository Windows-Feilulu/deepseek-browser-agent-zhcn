// src/browser.js — Playwright 浏览器控制器（中文版）
'use strict';

const { chromium } = require('playwright');
const config       = require('./config');
const logger       = require('./logger');

// ─────────────────────────────────────────────
//  CSS 选择器（根据 DeepSeek UI 更新）
// ─────────────────────────────────────────────

const SEL = {
  // 聊天输入框 — 使用多个候选选择器
  chatInput  : 'textarea, [contenteditable="true"], .chat-input, .input-box',
  // 发送按钮
  sendButton : 'button[type="submit"], .send-btn, [aria-label="Send"], button:has-text("Send")',
  // 停止按钮（生成时显示）
  stopButton : 'button:has-text("Stop"), .stop-btn, [aria-label="Stop"]',
  // 新建聊天按钮
  newChat    : 'button:has-text("New Chat"), .new-chat-btn, [aria-label="New Chat"]',
};

// ─────────────────────────────────────────────
//  浏览器控制器
// ─────────────────────────────────────────────

class DeepSeekBrowser {
  constructor() {
    this.browser   = null;
    this.page      = null;
    this._lastText = '';
    this._stableTimer = null;
  }

  // ── 启动 ──────────────────────────────────────────────────────────────────

  async launch() {
    logger.info('正在使用持久化会话启动浏览器...');
    this.browser = await chromium.launchPersistentContext(config.SESSION_DIR, {
      headless : config.HEADLESS,
      args     : [
        '--disable-blink-features=AutomationControlled',
        '--no-sandbox',
        '--disable-setuid-sandbox',
      ],
    });

    // 如果上下文已有页面则复用，否则新建
    const pages = this.browser.pages();
    this.page = pages.length > 0 ? pages[0] : await this.browser.newPage();

    // 设置视口
    await this.page.setViewportSize({ width: 1280, height: 900 });

    // 拦截图片/字体以加快速度
    await this.page.route('**/*', route => {
      const type = route.request().resourceType();
      if (['image', 'font', 'media'].includes(type)) {
        route.abort();
      } else {
        route.continue();
      }
    });

    // 导航到 DeepSeek
    try {
      await this.page.goto(config.DEEPSEEK_URL, { waitUntil: 'domcontentloaded', timeout: 30_000 });
    } catch (err) {
      logger.warn(`导航警告: ${err.message}`);
    }

    // 等待页面稳定
    await this.page.waitForTimeout(3_000);

    // 检查是否需要登录
    const needsLogin = await this._needsLogin();
    if (needsLogin && !config.HEADLESS) {
      await this._promptLogin();
    }

    logger.success('浏览器准备就绪！');
    return this.page;
  }

  // ── 关闭 ──────────────────────────────────────────────────────────────────

  async close() {
    if (this._stableTimer) clearTimeout(this._stableTimer);
    if (this.browser) {
      await this.browser.close();
      this.browser = null;
      this.page    = null;
    }
  }

  // ── 新建聊天 ──────────────────────────────────────────────────────────

  async newChat() {
    // 点击新建聊天按钮（如果存在）
    try {
      const btn = await this.page.$(SEL.newChat);
      if (btn) {
        await btn.click();
        await this.page.waitForTimeout(1_500);
        return;
      }
    } catch {
      // 回退：直接导航
    }

    // 回退：直接导航到 DeepSeek 首页
    try {
      await this.page.goto(config.DEEPSEEK_URL, { waitUntil: 'domcontentloaded', timeout: 20_000 });
      await this.page.waitForTimeout(2_000);
    } catch (err) {
      logger.warn(`导航警告: ${err.message}`);
    }

    logger.dim('已启动新聊天会话');
  }

  // ── 发送消息 ──────────────────────────────────────────────────────────

  async sendMessage(text) {
    const input = await this._findInputBox();

    // 聚焦并输入
    await input.focus();
    await input.fill('');
    await input.fill(text);

    // 短暂延迟让 UI 稳定
    await this.page.waitForTimeout(config.SEND_DELAY);

    // 按 Enter 发送
    await input.press('Enter');

    // 等待发送动画完成
    await this.page.waitForTimeout(800);
  }

  // ── 等待回复 ──────────────────────────────────────────────────────────

  async waitForResponse() {
    const start = Date.now();
    const maxWait = config.RESPONSE_TIMEOUT;
    const stableDelay = config.STABLE_DELAY;

    this._lastText = '';
    let stableStart = null;

    while (Date.now() - start < maxWait) {
      // 获取当前回复文本
      const currentText = await this._getLatestResponseText();

      // 检查文本是否稳定
      if (currentText !== this._lastText) {
        this._lastText = currentText;
        stableStart = Date.now();
        this._showProgress(currentText);
      } else if (stableStart && (Date.now() - stableStart >= stableDelay)) {
        // 文本已稳定 — 返回
        logger.clearLine();
        return currentText;
      }

      // 检查是否仍在生成
      const isGenerating = await this._isGenerating();
      if (!isGenerating && currentText.length > 0) {
        // 生成已停止且我们有文本 — 再等待稳定延迟
        if (!stableStart) stableStart = Date.now();
        if (Date.now() - stableStart >= stableDelay) {
          logger.clearLine();
          return currentText;
        }
      }

      await this.page.waitForTimeout(500);
    }

    // 超时 — 返回我们已有的内容
    logger.warn('回复可能延迟 — 继续等待...');
    return this._lastText || '';
  }

  // ── 内部辅助函数 ──────────────────────────────────────────────────────────

  async _findInputBox() {
    // 尝试多个选择器
    const selectors = SEL.chatInput.split(',').map(s => s.trim());
    for (const sel of selectors) {
      const el = await this.page.$(sel);
      if (el) return el;
    }

    // 回退：查找任何内容可编辑元素
    const fallback = await this.page.$('[contenteditable="true"]');
    if (fallback) return fallback;

    throw new Error(
      '无法找到 DeepSeek 聊天输入框。\n' +
      '  → 确保页面已完全加载且你已登录。\n' +
      '  → 使用 --debug 运行以检查 DOM 选择器。\n' +
      '  → 运行: node src/calibrate.js 以自动检测选择器。'
    );
  }

  async _getLatestResponseText() {
    try {
      // 策略 1: 查找最新的助手消息
      const messages = await this.page.$$eval(
        '.message, .chat-message, [data-role="assistant"], .assistant-message, .bubble',
        els => els.map(el => el.innerText || el.textContent)
      );
      if (messages.length > 0) {
        return messages[messages.length - 1].trim();
      }

      // 策略 2: 从整个页面提取（回退）
      const bodyText = await this.page.$eval('body', el => el.innerText);
      const lines = bodyText.split('\n').filter(l => l.trim());
      // 返回最后几行（可能包含回复）
      return lines.slice(-20).join('\n');
    } catch {
      return '';
    }
  }

  async _isGenerating() {
    try {
      // 检查停止按钮（生成时可见）
      const stopBtn = await this.page.$(SEL.stopButton);
      if (stopBtn) {
        const visible = await stopBtn.isVisible();
        if (visible) return true;
      }

      // 检查加载/生成指示器
      const indicators = await this.page.$$eval(
        '.loading, .generating, .typing, .spinner, [data-loading="true"]',
        els => els.length
      );
      return indicators > 0;
    } catch {
      return false;
    }
  }

  async _needsLogin() {
    try {
      const url = this.page.url();
      if (url.includes('/login') || url.includes('/auth')) return true;

      // 检查登录表单
      const loginForm = await this.page.$('input[type="password"], .login-form, [data-testid="login"]');
      if (loginForm) return true;

      // 检查聊天输入框是否存在（已登录用户的标志）
      const input = await this._findInputBox().catch(() => null);
      return !input;
    } catch {
      return true;
    }
  }

  async _promptLogin() {
    logger.warn('╔══════════════════════════════════════════════╗');
    logger.warn('║  🔐  需要登录                                ║');
    logger.warn('║                                              ║');
    logger.warn('║  1. 在浏览器窗口中登录 DeepSeek              ║');
    logger.warn('║  2. 返回此处并按  回车  继续                 ║');
    logger.warn('╚══════════════════════════════════════════════╝');

    console.log('');
    console.log('');

    // 等待用户按 Enter
    await new Promise(resolve => {
      process.stdin.once('data', resolve);
    });

    // 给页面时间加载
    await this.page.waitForTimeout(3_000);

    // 验证登录
    const stillNeedsLogin = await this._needsLogin();
    if (stillNeedsLogin) {
      logger.warn('仍然需要登录。请完成登录后再试。');
      throw new Error('登录失败');
    }

    logger.success('登录成功！');
  }

  _showProgress(text) {
    const dotCount = Math.floor((Date.now() / 500) % 4);
    logger.thinking(`正在接收回复${'.'.repeat(dotCount)}  (${text.length} 字符)`);
  }

  // ── 调试 ──────────────────────────────────────────────────────────────────

  async dumpDebugInfo() {
    const info = await this.page.evaluate(() => {
      const inputs = Array.from(document.querySelectorAll('input, textarea, [contenteditable]'))
        .map(el => ({
          tag     : el.tagName,
          type    : el.type,
          id      : el.id,
          class   : el.className,
          name    : el.name,
          placeholder: el.placeholder,
        }));

      const buttons = Array.from(document.querySelectorAll('button'))
        .map(el => ({
          text    : el.innerText?.slice(0, 40),
          id      : el.id,
          class   : el.className,
        }));

      // 统计 CSS 类频率
      const classCounts = {};
      document.querySelectorAll('*').forEach(el => {
        el.classList?.forEach(cls => {
          classCounts[cls] = (classCounts[cls] || 0) + 1;
        });
      });
      const sortedClasses = Object.entries(classCounts)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 30);

      return {
        url     : location.href,
        title   : document.title,
        inputs  : inputs.slice(0, 10),
        buttons : buttons.slice(0, 20),
        classes : sortedClasses,
      };
    });

    console.log('\n' + '═'.repeat(40));
    console.log('  DOM 调试信息');
    console.log('═'.repeat(40));
    console.log('URL   :', info.url);
    console.log('标题 :', info.title);
    console.log('\n输入元素:');
    info.inputs.forEach(i => console.log(' ', JSON.stringify(i)));
    console.log('\n按钮（可见，前30个）:');
    info.buttons.forEach((b, i) => console.log(`  [${i}] ${JSON.stringify(b)}`));
    console.log('\n匹配 CSS 类（按频率）:');
    info.classes.forEach(([cls, count]) => console.log(`  ${String(count).padStart(3)}x  .${cls}`));
    console.log('═'.repeat(40) + '\n');
  }

  async screenshot(filePath) {
    const fp = filePath || '/tmp/deepseek-debug.png';
    await this.page.screenshot({ path: fp, fullPage: true });
    logger.info(`截图已保存: ${filePath}`);
  }
}

module.exports = DeepSeekBrowser;
