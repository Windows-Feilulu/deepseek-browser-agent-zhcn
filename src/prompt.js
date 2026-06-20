// src/prompt.js — 系统提示词和对话管理器（中文版）
'use strict';

const os   = require('os');
const path = require('path');
const { getToolDescriptions } = require('./tools');
const config = require('./config');

// ─────────────────────────────────────────────
//  系统提示词 — 作为首条消息发送
// ─────────────────────────────────────────────

/**
 * 构建系统提示词
 * @returns {string} 完整的系统提示词
 */
function buildSystemPrompt() {
  const toolDocs = getToolDescriptions();
  const cwd      = config.WORKING_DIR;
  const platform = os.platform() + ' ' + os.release();
  const nodeVer  = process.version;
  const now      = new Date().toISOString();

  const FENCE = '```';

  const lines = [
    '你是 DeepSeek Agent — 一位专业的AI软件工程师和编程助手，',
    '运行在基于终端的Agent框架中。你拥有对用户文件系统的直接访问权限，',
    '并且可以执行shell命令。',
    '──────运行环境──────',
    '操作系统 : ' + platform,
    'Node.js : ' + nodeVer,
    '日期/时间 : ' + now,
    '工作目录 : ' + cwd,
    '──────你的能力──────',
    '你可以读写文件、运行shell命令、搜索代码库、获取URL内容，',
    '以及搭建完整项目。你在自主循环中运行：调用工具、接收结果，',
    '直到任务完全完成。',
    '──────如何调用工具──────',
    '当你需要使用工具时，你的回复**必须**包含一个标记为"tool_call"的代码块。',
    FENCE + 'tool_call',
    '{',
    '  "name": "工具名称",',
    '  "args": {',
    '    "参数1": "值1",',
    '    "参数2": "值2"',
    '  }',
    '}',
    FENCE,
    '重要规则:',
    '- 每次回复**只能**调用一个工具，不要多个。',
    '- 内容必须是有效的JSON，且必须包含 "name" 和 "args" 键。',
    '- 收到工具结果后，要么调用另一个工具，要么给出最终回复。',
    '- 只有在任务**100%完成**时，才输出纯文本（不使用代码块）。',
    '──────文件操作（重要）──────',
    '- 创建文件用write_file，删除文件用delete_file，修改文件用edit_file，读取文件用read_file，移动或重命名文件用move_file',
    '- **不要**使用shell命令（echo、del、mkdir、rm、重定向等）来操作文件。',
    '- shell命令（通过 run_command）仅用于 git、npm、运行构建/测试，',
    '  或检查系统状态。文件操作必须使用上述工具。',
    '──────何时停止──────',
    '任务完全完成后，用清晰的自然语言总结回复。',
    '不要将其包裹在任何标签或代码块中。直接输出纯文本。',
    '──────编码规范──────',
    '- 修改前务必先读取现有文件。',
    '- 创建新文件前先检查目录结构。',
    '- 编写完整、生产级的代码 — 不要TODO、不要占位符。',
    '- 所有代码都要包含适当的错误处理。',
    '- 优先使用小而专注的文件，而非庞大的单体文件。',
    '- 安装包时，先检查 package.json。',
    '──────多步骤方法──────',
    '对于复杂任务，分解为以下步骤：',
    '1. 探索代码库 / 了解上下文',
    '2. 规划需要做的更改',
    '3. 系统地逐个文件进行修改',
    '4. 测试 / 验证结果',
    '──────任务工具──────',
    toolDocs,
    '记住：你是自主运行的。要使用任务工具来实际完成任务，而不是回答问题，除非任务要求仅回答。',
    '如果是询问用户，请使用ask_user。除非已完成任务，否则必须调用一次专用工具',
  ];

  return lines.join('\n');
}

// ─────────────────────────────────────────────
//  对话 / 消息历史管理器
// ─────────────────────────────────────────────

class ConversationManager {
  constructor() {
    this.messages      = [];
    this._systemPrompt = null;
  }

  /**
   * 构建包含系统提示词、工作目录上下文和用户任务的初始消息。
   * @param {string} task - 用户任务
   * @param {string} workingDirListing - 工作目录内容列表
   * @returns {string} 完整的初始消息
   */
  buildFirstMessage(task, workingDirListing) {
    this._systemPrompt = buildSystemPrompt();

    const dirContext = workingDirListing
      ? '\n当前工作目录内容（部分）:\n' + workingDirListing + '\n'
      : '';

    const firstMessage = [
      this._systemPrompt,
      '',
      // '═'.repeat(40),
      // '',
      // dirContext,
      '──────用户任务──────',
      task,
    ].join('\n');

    this.messages.push({ role: 'user', content: firstMessage });
    return firstMessage;
  }

  /**
   * 添加工具结果作为用户回合消息（将结果反馈给AI）。
   * @param {string} toolName - 工具名称
   * @param {*} result - 工具执行结果
   * @param {boolean} isError - 是否为错误
   * @returns {string} 格式化的工具结果消息
   */
  addToolResult(toolName, result, isError) {
    const status  = isError ? '错误' : '成功';
    const content = [
      '[工具结果: ' + toolName + ' | ' + status + ']',
      String(result),
      '[工具结果结束]',
      '',
      '必须用tool_call代码块调用工具实际完成任务，否则视为完成任务的最终回复。',
    ].join('\n');

    this.messages.push({ role: 'user', content: content });
    return content;
  }

  /**
   * 添加助手消息（AI的原始回复）。
   * @param {string} content - AI回复内容
   */
  addAssistantMessage(content) {
    this.messages.push({ role: 'assistant', content: content });
  }

  /**
   * 获取最近的用户消息内容。
   * @returns {string} 最近的用户消息
   */
  getLatestUserMessage() {
    const userMessages = this.messages.filter(function(m) { return m.role === 'user'; });
    return userMessages.length > 0 ? userMessages[userMessages.length - 1].content : '';
  }

  /**
   * 已发生的助手回合数。
   * @returns {number} 助手回合数
   */
  get turnCount() {
    return this.messages.filter(function(m) { return m.role === 'assistant'; }).length;
  }

  /**
   * 导出完整对话为可读文本日志。
   * @returns {string} 对话日志
   */
  exportLog() {
    return this.messages.map(function(m) {
      const header = m.role === 'user' ? '用户' : '助手';
      return '\n' + '─'.repeat(40) + '\n' + header + '\n' + '─'.repeat(40) + '\n' + m.content;
    }).join('\n');
  }
}

module.exports = { buildSystemPrompt, ConversationManager };
