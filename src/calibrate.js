// src/calibrate.js — 选择器校准工具（中文版）
'use strict';

const { chromium } = require('playwright');
const path         = require('path');
const config       = require('./config');

// 简单的控制台日志（不使用 logger 以避免循环依赖）
const log = {
  info : msg => console.log(`  ℹ  ${msg}`),
  warn : msg => console.log(`  ⚠  ${msg}`),
  error: msg => console.log(`  ✗  ${msg}`),
};

async function main() {
  console.log('\n🔬  DeepSeek Agent 中文版 — 选择器校准工具\n');
  console.log('此工具会打开 DeepSeek、检查 DOM 并打印出浏览器.js 应该使用的选择器。\n');

  console.log(`→ 正在导航到 ${config.DEEPSEEK_URL}...`);

  const browser = await chromium.launch({ headless: false });

  try {
    const context = await browser.newContext();
    const page   = await context.newPage();
    await page.setViewportSize({ width: 1280, height: 900 });

    await page.goto(config.DEEPSEEK_URL, { waitUntil: 'domcontentloaded', timeout: 30_000 });
    await page.waitForTimeout(3_000);

    console.log('→ 正在检查 DOM...\n');

    // 执行 DOM 分析
    const report = await page.evaluate(() => {
      const inputs = Array.from(document.querySelectorAll('input, textarea, [contenteditable]'))
        .map((el, i) => {
          const rect = el.getBoundingClientRect();
          return {
            index     : i,
            tag       : el.tagName,
            type      : el.type,
            id        : el.id || '(无)',
            class     : el.className?.slice(0, 60) || '(无)',
            name      : el.name || '(无)',
            placeholder: el.placeholder || '(无)',
            visible   : rect.width > 0 && rect.height > 0,
          };
        })
        .filter(el => el.visible)
        .slice(0, 15);

      const buttons = Array.from(document.querySelectorAll('button'))
        .map((el, i) => {
          const rect = el.getBoundingClientRect();
          return {
            index   : i,
            text    : el.innerText?.trim().slice(0, 40) || '(无文本)',
            id      : el.id || '(无)',
            class   : el.className?.slice(0, 60) || '(无)',
            visible : rect.width > 0 && rect.height > 0,
          };
        })
        .filter(el => el.visible)
        .slice(0, 30);

      // 按频率统计 CSS 类
      const classCounts = {};
      document.querySelectorAll('*').forEach(el => {
        el.classList?.forEach(cls => {
          classCounts[cls] = (classCounts[cls] || 0) + 1;
        });
      });
      const topClasses = Object.entries(classCounts)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 40)
        .map(([cls, n]) => ({ cls, n }));

      return {
        url       : location.href,
        title     : document.title,
        inputs,
        buttons,
        topClasses,
      };
    });

    const sep = '─'.repeat(40);

    console.log(sep);
    console.log('URL   :', report.url);
    console.log('标题 :', report.title);

    console.log('\n📥  输入元素（可见）:');
    if (report.inputs.length === 0) {
      console.log('  （未找到 — 你是否已登录？）');
    }
    report.inputs.forEach((el, i) => {
      console.log(`  [${i}] ${JSON.stringify({
        tag        : el.tag,
        type       : el.type,
        id         : el.id,
        placeholder: el.placeholder,
      })}`);
    });

    console.log('\n🔘  按钮（可见，前30个）:');
    if (report.buttons.length === 0) {
      console.log('  （未找到）');
    }
    report.buttons.forEach((el, i) => {
      console.log(`  [${i}] ${JSON.stringify({
        text: el.text,
        id  : el.id,
      })}`);
    });

    console.log('\n🏷️  高频 CSS 类:');
    report.topClasses.slice(0, 40).forEach(({ cls, n }) => {
      console.log(`  ${String(n).padStart(4)}x  .${cls}`);
    });

    // ── 建议选择器 ───────────────────────────────────────────────────────
    console.log('\n🎯  建议选择器（更新 src/browser.js 的 SEL 对象）:');

    // 找出最可能是聊天输入框的元素
    const chatInputCandidates = report.inputs.filter(el =>
      el.tag === 'TEXTAREA' ||
      el.tag === 'INPUT' && (el.type === 'text' || !el.type) ||
      el.placeholder?.toLowerCase().includes('message') ||
      el.placeholder?.toLowerCase().includes('输入')
    );

    if (chatInputCandidates.length > 0) {
      const best = chatInputCandidates[0];
      if (best.id && best.id !== '(无)') {
        console.log(`  chatInput  : '#${best.id}'  (或使用上述 id)`);
      } else {
        console.log(`  chatInput  : '${best.tag.toLowerCase()}[placeholder*="message"]'`);
      }
    } else {
      console.log('  chatInput  : (无法自动确定 — 请手动检查上面的输入元素)');
    }

    // 找出发送按钮
    const sendBtnCandidates = report.buttons.filter(el =>
      el.text.toLowerCase().includes('send') ||
      el.text.toLowerCase().includes('发送') ||
      el.text.includes('►') ||
      el.text === ''
    );

    if (sendBtnCandidates.length > 0) {
      const best = sendBtnCandidates[0];
      const sel = best.id ? `#${best.id}` : `button:has-text("${best.text}")`;
      console.log(`  sendButton : '${sel}'`);
    } else {
      console.log('  sendButton : (无法自动确定 — 请手动检查上面的按钮)');
    }

    // 找出停止按钮
    const stopBtnCandidates = report.buttons.filter(el =>
      el.text.toLowerCase().includes('stop') ||
      el.text.toLowerCase().includes('停止') ||
      el.text.toLowerCase().includes('interrupt')
    );

    if (stopBtnCandidates.length > 0) {
      const best = stopBtnCandidates[0];
      const sel = best.id ? `#${best.id}` : `button:has-text("${best.text}")`;
      console.log(`  stopButton : '${sel}'`);
    } else {
      console.log('  stopButton : ' + '\'button:has-text("Stop")\'');
    }

    // 找出新建聊天按钮
    const newChatCandidates = report.buttons.filter(el =>
      el.text.toLowerCase().includes('new chat') ||
      el.text.toLowerCase().includes('新对话') ||
      el.text.toLowerCase().includes('new conversation')
    );

    if (newChatCandidates.length > 0) {
      const best = newChatCandidates[0];
      const sel = best.id ? `#${best.id}` : `button:has-text("${best.text}")`;
      console.log(`  newChat    : '${sel}'`);
    } else {
      console.log('  newChat    : ' + '\'button:has-text("New Chat")\'');
    }

    // ── 截图 ──────────────────────────────────────────────────────────────
    console.log('\n📸  正在截图 → /tmp/deepseek-calibrate.png');
    await page.screenshot({ path: '/tmp/deepseek-calibrate.png', fullPage: true });

    console.log('\n✅  校准完成！请使用上面的建议更新 src/browser.js 中的 SEL 对象。');
    console.log('    按 Ctrl+C 退出。\n');

    // 保持浏览器打开以供手动检查
    await new Promise(() => {});
  } catch (err) {
    console.error('\n校准错误:', err.message);
    process.exit(1);
  } finally {
    await browser.close();
  }
}

main();
