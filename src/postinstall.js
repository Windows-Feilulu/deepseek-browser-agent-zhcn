// src/postinstall.js — 安装后设置脚本（中文版）
const { execSync } = require('child_process');

// 在 CI 环境中跳过
if (process.env.CI) {
  console.log('[deepseek-agent-zhcn] 检测到 CI 环境，跳过 Playwright 浏览器安装。');
  process.exit(0);
}

console.log('╔══════════════════════════════════════════════════╗');
console.log('║   🤖  DeepSeek 浏览器助手中文版 — 设置           ║');
console.log('╚══════════════════════════════════════════════════╝');
console.log('  正在下载 Playwright Chromium 浏览器...');
console.log('  （仅执行一次 — 约 150 MB）\n');

try {
  execSync('npx playwright install chromium', {
    stdio: 'inherit',
    cwd  : process.cwd(),
  });

  console.log('\n  ✓ 浏览器安装成功！');
  console.log('  开始使用:');
  console.log('    deepseek-agent-zhcn --interactive');
  console.log('    deepseek-agent-zhcn "用 Express 构建一个 REST API"');
} catch {
  console.warn('\n  ⚠  无法自动安装 Chromium。');
  console.warn('  请手动运行以下命令完成设置:');
  console.warn('    npx playwright install chromium');
}
