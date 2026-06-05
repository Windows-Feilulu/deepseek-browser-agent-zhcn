#!/usr/bin/env node
// src/index.js — DeepSeek Agent 中文版 CLI 入口
'use strict';

const path         = require('path');
const fs           = require('fs');
const config       = require('./config');
const logger       = require('./logger');
const DeepSeekAgent = require('./agent');

// ─────────────────────────────────────────────
//  解析 CLI 参数
// ─────────────────────────────────────────────

function parseArgs(argv) {
  const args = argv.slice(2);
  const opts = {
    task        : null,
    interactive : false,
    debug       : false,
    headless    : false,
    saveLog     : false,
    workingDir  : null,
    calibrate   : false,
    help        : false,
  };

  let i = 0;
  while (i < args.length) {
    const a = args[i];
    switch (a) {
      case '-i':
      case '--interactive': opts.interactive = true;    break;
      case '--debug':       opts.debug       = true;    break;
      case '--headless':    opts.headless    = true;    break;
      case '--save-log':    opts.saveLog     = true;    break;
      case '--calibrate':   opts.calibrate   = true;    break;
      case '-h':
      case '--help':        opts.help        = true;    break;
      case '-f':
      case '--task-file':
        opts.taskFile = args[++i];
        break;
      case '-d':
      case '--dir':
        opts.workingDir = args[++i];
        break;

      case '-t':
      case '--task':
        opts.task = args[++i];
        break;

      default:
        // 如果不以 '-' 开头，视为内联任务
        if (!a.startsWith('-')) {
          opts.task = args.slice(i).join(' ');
          i = args.length; // 消耗剩余所有参数
        }
    }
    i++;
  }

  return opts;
}

// ─────────────────────────────────────────────
//  帮助文本
// ─────────────────────────────────────────────

function printHelp() {
  console.log(`
\x1b[1mDEEPSEEK AGENT 中文版\x1b[0m — 基于浏览器自动化的AI编程助手

\x1b[33m用法\x1b[0m
  node src/index.js [选项] [任务]

\x1b[33m选项\x1b[0m
  -t, --task <任务>    要运行的任务（也可以是不带标志的最后一个参数）
  -f, --task-file <文件>   从文件读取任务（覆盖 -t）。将 \\r\\n 替换为 \\n。
  -i, --interactive    交互式 REPL 模式 — 保持浏览器打开，运行多个任务
  -d, --dir <路径>     设置工作目录（默认: 当前目录）
  --debug              详细调试输出
  --headless           以无头模式运行浏览器（必须已登录）
  --save-log           保存对话日志到 ~/.deepseek-agent-zhcn/logs/
  --calibrate          打开浏览器并打印 DOM 信息以帮助修复选择器
  -h, --help           显示此帮助

\x1b[33m示例\x1b[0m
  # 运行单个任务
  node src/index.js "创建一个 Express REST API，包含用户的 CRUD"

  # 从文件读取任务
  node src/index.js -f my_task.txt

  # 结合工作目录
  node src/index.js -d ~/projects/myapp -f task.md

  # 交互模式（推荐）
  node src/index.js --interactive

  # 在特定项目目录上运行
  node src/index.js --dir ~/projects/myapp "为此项目添加 TypeScript"

  # 调试模式（显示原始回复）
  node src/index.js --debug "用 Python 写一个二分查找"

  # 无头模式（更快，需要预先登录）
  node src/index.js --headless "将 index.js 重构为使用 async/await"

\x1b[33m首次设置\x1b[0m
  1. npm run setup         （安装依赖 + Playwright 浏览器）
  2. node src/index.js -i  （打开浏览器，登录 DeepSeek，然后正常使用）
     会话已保存 — 你只需登录一次。

\x1b[33m配置文件\x1b[0m
  在工作目录中创建 \x1b[36mdeepseek-agent-zhcn.config.json\x1b[0m 以覆盖设置:
  {
    "HEADLESS": true,
    "MAX_ITERATIONS": 50,
    "STABLE_DELAY": 3000
  }
`);
}

function readTaskFromFile(filePath) {
  const resolved = path.resolve(filePath);
  if (!fs.existsSync(resolved)) {
    throw new Error(`任务文件未找到: ${resolved}`);
  }
  let content = fs.readFileSync(resolved, 'utf8');
  // 将 \r\n 和 \n\r 统一替换为 \n
  content = content.replace(/\r\n|\n\r/g, '\n');
  if (!content.trim()) {
    throw new Error(`任务文件为空: ${resolved}`);
  }
  return content;
}

// ─────────────────────────────────────────────
//  主函数
// ─────────────────────────────────────────────

async function main() {
  const opts = parseArgs(process.argv);

  // ── 帮助 ───────────────────────────────────────────────────────────────────
  if (opts.help) {
    printHelp();
    process.exit(0);
  }

  // ── 将选项应用到配置 ────────────────────────────────────────────────
  if (opts.debug)      config.DEBUG    = true;
  if (opts.headless)   config.HEADLESS = true;
  if (opts.workingDir) {
    const resolved = path.resolve(opts.workingDir);
    if (!fs.existsSync(resolved)) {
      logger.error(`工作目录未找到: ${resolved}`);
      process.exit(1);
    }
    config.WORKING_DIR = resolved;
  }

  // ── 横幅 ─────────────────────────────────────────────────────────────────
  logger.banner();
  logger.info(`工作目录 : \x1b[36m${config.WORKING_DIR}\x1b[0m`);
  logger.info(`会话目录 : \x1b[36m${config.SESSION_DIR}\x1b[0m`);
  logger.info(`无头模式 : \x1b[36m${config.HEADLESS}\x1b[0m`);
  logger.info(`调试模式 : \x1b[36m${config.DEBUG}\x1b[0m`);
  console.log('');

  // ── 创建 agent ───────────────────────────────────────────────────────────
  const agent = new DeepSeekAgent({ saveLog: opts.saveLog });

  // ── 优雅关闭处理器 ──────────────────────────────────────────────
  const shutdown = async (code = 0) => {
    try { await agent.shutdown(); } catch {}
    process.exit(code);
  };

  process.on('SIGINT',  () => shutdown(0));
  process.on('SIGTERM', () => shutdown(0));
  process.on('uncaughtException', async err => {
    logger.error(`未捕获的错误: ${err.message}`);
    if (config.DEBUG) console.error(err.stack);
    await shutdown(1);
  });
  process.on('unhandledRejection', async reason => {
    logger.error(`未处理的拒绝: ${reason}`);
    if (config.DEBUG) console.error(reason);
    await shutdown(1);
  });

  // ── 校准模式 ─────────────────────────────────────────────────────────
  if (opts.calibrate) {
    logger.header('校准模式 — 读取 DOM 选择器');
    await agent.init();
    await agent.browser.dumpDebugInfo();
    await agent.browser.screenshot();
    logger.info('完成。检查上面的输出以更新 src/browser.js 中的选择器。');
    await shutdown(0);
  }
  // ── 处理任务文件（优先级高于普通任务）────────────────────────
  let finalTask = opts.task;
  if (opts.taskFile) {
    if (opts.interactive) {
      logger.warn('--task-file 在交互模式下被忽略。\n');
    } else {
      try {
        finalTask = readTaskFromFile(opts.taskFile);
        logger.info(`已从文件加载任务: ${opts.taskFile}`);
        if (config.DEBUG) {
          logger.debug(`任务内容（前200字符）: ${finalTask.slice(0, 200)}...`);
        }
      } catch (err) {
        logger.error(err.message);
        process.exit(1);
      }
    }
  } else if (opts.task && opts.taskFile) {
    logger.warn('同时提供了 --task 和 --task-file；--task-file 优先。');
  }
  
  // ── 备份用户提示词（如果提供了任务）──────────────────────────────
  if (finalTask && !opts.interactive) {
    const backup = require('./backup');
    try {
      await backup.backupUserPrompt(finalTask);
      logger.dim(`用户提示已备份到会话: ${backup.getBackupDir()}`);
    } catch (err) {
      logger.warn(`备份用户提示失败: ${err.message}`);
    }
  }

  // ── 最终验证任务或交互模式 ────────────────────────────────────
  if (!opts.interactive && !finalTask) {
    logger.warn('未提供任务。切换到交互模式...\n');
    opts.interactive = true;
  }

  // ── 启动浏览器 ─────────────────────────────────────────────────────────
  try {
    await agent.init();
  } catch (err) {
    logger.error(`启动浏览器失败: ${err.message}`);
    if (config.DEBUG) console.error(err.stack);
    process.exit(1);
  }

  // ── 运行 ────────────────────────────────────────────────────────────────────
  try {
    if (opts.interactive) {
      await agent.runInteractive();
    } else {
      await agent.run(finalTask);
    }
  } catch (err) {
    logger.error(`Agent 错误: ${err.message}`);
    if (config.DEBUG) console.error(err.stack);
    await shutdown(1);
  }

  await shutdown(0);
}

main();
