// src/agent.js — 核心Agent循环，整合所有组件（中文版）
'use strict';

const fs                           = require('fs');
const path                         = require('path');
const { execSync, spawnSync, spawn } = require('child_process');
const iconv                        = require('iconv-lite');
const config                       = require('./config');
const logger                       = require('./logger');
const DeepSeekBrowser              = require('./browser');
const { executeTool }              = require('./tools');
const { parseResponse,
        formatToolResult }         = require('./parser');
const { ConversationManager }      = require('./prompt');
const backup                       = require('./backup');
const { createGitignoreFilter }    = require('./gitignore');

// ─────────────────────────────────────────────
//  Agent 类
// ─────────────────────────────────────────────

class DeepSeekAgent {
  constructor(options = {}) {
    this.browser      = new DeepSeekBrowser();
    this.conversation = new ConversationManager();
    this.options      = options;
    this._running     = false;
    this._buildPending = false; // 标记是否有待执行的 ai_build.bat
    this._parseErrorCount = 0;  // 解析错误计数器
    // 为此次对话生成唯一会话 ID
    const sessionId = `session_${Date.now()}_${Math.random().toString(36).substring(2, 10)}`;
    backup.setSessionId(sessionId);
    logger.info(`备份会话 ID: ${sessionId}`);
  }

  // ── 公开 API ──────────────────────────────────────────────────────────────

  /** 启动浏览器并加载 DeepSeek */
  async init() {
    await this.browser.launch();
    await this.browser.newChat();
  }

  /** 清理关闭 */
  async shutdown() {
    await this.browser.close();
  }

  /**
   * 运行任务直到完成。
   * 返回最终回复字符串。
   */
  async run(task) {
    this._running   = true;
    const maxIter   = config.MAX_ITERATIONS;

    // ── 1. 快照工作目录 ──────────────────────────────────────
    const dirListing = this._getWorkingDirListing();

    // ── 2. 构建并发送首条消息 ───────────────────────────────────
    logger.header(`任务: ${task.slice(0, 80)}${task.length > 80 ? '…' : ''}`);

    const firstMsg = this.conversation.buildFirstMessage(task, dirListing);

    if (config.DEBUG) {
      logger.dim('--- 首条消息（截断）---');
      logger.dim(firstMsg.slice(0, 600) + '...');
    }

    logger.info('正在发送任务到 DeepSeek...');
    await this.browser.sendMessage(firstMsg);

    // ── 3. Agent 循环 ──────────────────────────────────────────────────────
    for (let iter = 1; iter <= maxIter; iter++) {
      logger.iteration(iter, maxIter);

      // 等待 DeepSeek 的回复
      const rawResponse = await this.browser.waitForResponse();

      if (!rawResponse || rawResponse.trim().length === 0) {
        logger.warn('收到空回复 — 正在重试...');
        await this.browser.sendMessage('请继续。如果你正在等待输入，请根据最佳判断继续。');
        continue;
      }

      if (config.DEBUG) {
        logger.dim(`--- 原始回复（${rawResponse.length} 字符）---`);
        logger.dim(rawResponse.slice(0, 400));
      }

      // 在对话历史中记录 AI 回复
      this.conversation.addAssistantMessage(rawResponse);

      // 解析回复
      const parsed = parseResponse(rawResponse);

      // ── 情况 1: 工具调用 ──────────────────────────────────────────────
      if (parsed.type === 'tool_call') {
        this._parseErrorCount = 0; // 重置解析错误计数
        this._buildPending = false; // 重置构建
        logger.toolCall(parsed.name, parsed.args);

        let result;
        let isError = false;

        try {
          result  = await executeTool(parsed.name, parsed.args);
          
          // 检查是否是 ask_user 请求（特殊标记）
          if (result && typeof result === 'object' && result.__ask_user === true) {
            // 这是用户交互请求
            logger.info(`\n🤖 AI 提问: ${result.question}`);
            
            // 获取用户输入
            const userResponse = await this._promptUser(result.question, result.options);
            
            // 将用户回复作为工具结果发送回 AI
            const feedbackMsg = this.conversation.addToolResult(parsed.name, userResponse, false);
            await this.browser.sendMessage(feedbackMsg);
            continue;
          }
          
          logger.toolResult(result);
        } catch (err) {
          result  = `错误: ${err.message}`;
          isError = true;
          logger.toolResult(result, true);
        }

        // 反馈结果
        const feedbackMsg = this.conversation.addToolResult(parsed.name, result, isError);
        await this.browser.sendMessage(feedbackMsg);
        continue;
      }

      // ── 情况 2: 解析错误 ────────────────────────────────────────────
      if (parsed.type === 'error') {
        this._parseErrorCount++;
        logger.warn(`解析错误 (${this._parseErrorCount}/1): ${parsed.message}`);
        
        // 解析错误超过1次，视为任务完成
        if (this._parseErrorCount >= 1) {
          logger.warn('解析错误次数过多，视为任务完成');
          parsed.type = 'final';
          parsed.content = `任务完成（但解析遇到错误）。\n\n最后错误: ${parsed.message}`;
          // 继续执行到 final 分支
        } else {
          const recovery = this.conversation.addToolResult(
            '系统',
            `解析错误: ${parsed.message}\n\n请使用有效的 JSON 重试工具调用。`,
            true
          );
          await this.browser.sendMessage(recovery);
          continue;
        }
      }

      // ── 情况 3: 最终回复 ─────────────────────────────────────────
      if (parsed.type === 'final') {
        this._parseErrorCount = 0; // 重置解析错误计数
        
        // 安全网：如果"最终"回复文本包含我们的解析器遗漏的 tool_call 块
        // （例如被 DOM 搞乱），发送纠正提示。
        const looksLikeToolCall = (
          /tool_call/i.test(parsed.content) ||
          /"name"\s*:\s*"[\w_]+"/.test(parsed.content) ||
          /write_file|read_file|run_command|list_directory/i.test(parsed.content.slice(0, 200))
        );

        if (looksLikeToolCall && this.conversation.turnCount <= maxIter - 2) {
          logger.warn('回复看起来像工具调用但未被解析 — 请求 AI 重试格式...');
          const retry = this.conversation.addToolResult(
            '系统',
            '你的回复似乎包含工具调用但无法解析。' +
            '请仅使用 ```tool_call 代码块回复，前后不要有任何文字。',
            true
          );
          await this.browser.sendMessage(retry);
          continue;
        }

        // ── ai_build.bat 检查与执行 ─────────────────────────────────
        const buildBatPath = path.join(config.WORKING_DIR, 'ai_build.bat');
        if (fs.existsSync(buildBatPath)) {
          // 如果之前已经执行过 ai_build，且 agent 再次回复 final，
          // 说明 agent 已经处理完构建结果，真正完成了
          if (this._buildPending) {
            this._buildPending = false;
            logger.finalOutput(parsed.content);

            // 可选保存对话日志
            if (this.options.saveLog) {
              await this._saveConversationLog(task, parsed.content);
            }

            // 显示备份摘要
            const backups = backup.listBackups();
            if (backups.length > 0) {
              if (config.DEBUG) {
                console.log('备份清单:');
                backups.slice(-5).forEach(b => {
                  console.log(`  - ${b.operation}: ${b.filePath} → ${b.backupPath ? path.basename(b.backupPath) : '(新文件)'}`);
                });
                if (backups.length > 5) console.log(`  ... 还有 ${backups.length - 5} 个`);
              }
            }

            this._running = false;
            return parsed.content;
          }

          // 第一次进入 final，执行 ai_build.bat
          this._buildPending = true;
          logger.info('检测到 ai_build.bat，正在执行...');
          let buildOutput = '';
          let buildError = false;
          try {
            // 使用 spawn 流式输出，保证 stdout 和 stderr 按实际顺序显示
            const child = spawn('cmd.exe', ['/c', buildBatPath], {
              cwd: config.WORKING_DIR,
              windowsHide: true,
            });
            let timedOut = false;
            const timeoutMs = 1200000;
            const timeout = setTimeout(() => {
              timedOut = true;
              child.kill();
            }, timeoutMs);

            // 不设置 setEncoding，直接接收 Buffer，然后用 iconv-lite 按 GBK 解码
            // 以正确处理中文输出（兼容 GBK / GB2312 / GB18030）
            child.stdout.on('data', (data) => {
              const text = iconv.decode(data, 'gbk');
              buildOutput += text;
              process.stdout.write(text);
            });
            child.stderr.on('data', (data) => {
              const text = iconv.decode(data, 'gbk');
              buildOutput += text;
              process.stderr.write(text);
            });

            await new Promise((resolve) => {
              child.on('close', (code) => {
                clearTimeout(timeout);
                buildError = (code !== 0) || timedOut;
                if (timedOut) {
                  const timeoutMsg = `\n[超时] 执行时间超过 ${timeoutMs/1000} 秒`;
                  buildOutput += timeoutMsg;
                  if (config.DEBUG) process.stderr.write(timeoutMsg);
                }
                if (buildError) {
                  logger.warn(`ai_build.bat 执行失败（退出码 ${code}）`);
                } else {
                  logger.info('ai_build.bat 执行成功');
                }
                resolve();
              });
              child.on('error', (err) => {
                clearTimeout(timeout);
                buildError = true;
                buildOutput = err.message;
                logger.warn(`ai_build.bat 执行失败: ${err.message}`);
                resolve();
              });
            });
            buildOutput = buildOutput.trim();
          } catch (err) {
            buildError = true;
            buildOutput = err.message;
            logger.warn(`ai_build.bat 执行失败: ${err.message}`);
          }

          // 将构建结果汇报给 agent，让 agent 决定下一步
          const buildReport = this.conversation.addToolResult(
            '自动构建',
            `检测到任务完成，运行自动构建执行${buildError ? '失败' : '成功'}:\n${buildOutput}`,
            buildError
          );
          await this.browser.sendMessage(buildReport);
          continue; // 继续循环，等待 agent 的下一步回复
        }

        logger.finalOutput(parsed.content);

        // 可选保存对话日志
        if (this.options.saveLog) {
          await this._saveConversationLog(task, parsed.content);
        }

        // 显示备份摘要
        const backups = backup.listBackups();
        if (backups.length > 0) {
          if (config.DEBUG) {
            console.log('备份清单:');
            backups.slice(-5).forEach(b => {
              console.log(`  - ${b.operation}: ${b.filePath} → ${b.backupPath ? path.basename(b.backupPath) : '(新文件)'}`);
            });
            if (backups.length > 5) console.log(`  ... 还有 ${backups.length - 5} 个`);
          }
        }

        this._running = false;
        return parsed.content;
      }
    }

    // ── 达到最大迭代次数 ─────────────────────────────────────────────────
    this._running = false;
    const warn = `⚠ 已达到最大迭代次数（${maxIter}）。任务可能未完成。`;
    logger.warn(warn);
    return warn;
  }

  // ── 交互式（REPL）模式 ────────────────────────────────────────────────

  /**
   * 以交互模式运行 agent — 保持浏览器打开
   * 并一个接一个地接受任务。
   */
  async runInteractive() {
    const readline = require('readline');

    logger.header('交互模式 — 输入任务并按回车');
    logger.info('命令: 输入 "exit" 或 "quit" 退出，"new" 开始新对话\n');

    const rl = readline.createInterface({
      input    : process.stdin,
      output   : process.stdout,
      terminal : true,
    });

    const ask = () => new Promise(resolve => rl.question('\n\x1b[96m❯ 任务:\x1b[0m ', resolve));

    while (true) {
      let task;
      try {
        task = (await ask()).trim();
      } catch {
        break; // stdin 已关闭
      }

      if (!task) continue;

      if (['exit', 'quit', 'q'].includes(task.toLowerCase())) {
        logger.info('正在退出...');
        break;
      }

      if (task.toLowerCase() === 'new') {
        logger.info('正在开始新对话...');
        await this.browser.newChat();
        this.conversation = new ConversationManager();
        continue;
      }

      // 每个新任务都重置对话
      this.conversation = new ConversationManager();

      try {
        await this.browser.newChat();
        await this.run(task);
      } catch (err) {
        logger.error(`任务失败: ${err.message}`);
        if (config.DEBUG) console.error(err);
      }
    }

    rl.close();
  }

  // ── 辅助函数 ────────────────────────────────────────────────────────────────

  async _promptUser(question, options = []) {
    const readline = require('readline');
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
    });

    // 显示问题
    console.log('\n' + '='.repeat(60));
    console.log(`📝 ${question}`);
    if (options && options.length > 0) {
      console.log('\n选项:');
      options.forEach((opt, i) => {
        console.log(`  ${i + 1}. ${opt}`);
      });
      console.log('\n(输入数字或直接回复)')
    }
    console.log('='.repeat(60));
    
    return new Promise((resolve) => {
      rl.question('\n你的回复: ', (answer) => {
        rl.close();
        
        // 检查回复是否是数字且有选项
        if (options && options.length > 0) {
          const num = parseInt(answer, 10);
          if (!isNaN(num) && num >= 1 && num <= options.length) {
            resolve(options[num - 1]);
            return;
          }
        }
        
        resolve(answer);
      });
    });
  }

  _getWorkingDirListing() {
    // 使用 .gitignore 规则进行过滤
    const gitignoreFilter = createGitignoreFilter(config.WORKING_DIR);
    const results = [];

    const walk = (dirRel, depth) => {
      if (depth > 3) return;
      let entries;
      try {
        entries = fs.readdirSync(path.join(config.WORKING_DIR, dirRel), { withFileTypes: true });
      } catch {
        return;
      }
      for (const entry of entries) {
        // 构建相对路径，统一使用 POSIX 分隔符并加上 ./ 前缀
        const entryRel = './' + path.join(dirRel, entry.name).split(path.sep).join('/');
        const fullPath = path.join(config.WORKING_DIR, dirRel, entry.name);

        if (entry.isDirectory()) {
          // 使用 .gitignore 规则过滤目录
          if (!gitignoreFilter(fullPath, true)) continue;
          walk(entryRel, depth + 1);
        } else if (entry.isFile()) {
          // 使用 .gitignore 规则过滤文件
          if (!gitignoreFilter(fullPath, false)) continue;
          results.push(entryRel);
        } else {
          // 符号链接等其他类型仍加入
          results.push(entryRel);
        }
      }
    };

    walk('.', 1);            // 从工作目录直接子项开始，深度 1
    results.sort();          // 等效于 sort
    return results.slice(0, 80).join('\n') || '(空目录)';
  }

  async _saveConversationLog(task, finalResponse) {
    try {
      const logsDir = path.join(os.homedir(), '.deepseek-agent-zhcn', 'logs');
      fs.mkdirSync(logsDir, { recursive: true });

      const ts       = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
      const logFile  = path.join(logsDir, `session-${ts}.txt`);
      const content  = [
        `DeepSeek Agent 中文版 — 会话日志`,
        `日期: ${new Date().toISOString()}`,
        `任务: ${task}`,
        `工作目录: ${config.WORKING_DIR}`,
        '═'.repeat(40),
        this.conversation.exportLog(),
        '',
        '═'.repeat(40),
        '最终回复:',
        finalResponse,
      ].join('\n');

      fs.writeFileSync(logFile, content, 'utf8');
      logger.dim(`对话已保存: ${logFile}`);
    } catch (err) {
      logger.warn(`无法保存日志: ${err.message}`);
    }
  }
}

// Pull os into scope for the log save helper
const os = require('os');

module.exports = DeepSeekAgent;
