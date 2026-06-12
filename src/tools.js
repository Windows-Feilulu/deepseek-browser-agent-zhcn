// src/tools.js — AI Agent 可用的所有工具（中文版）
'use strict';

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const http = require('http');
const https = require('https');
const config = require('./config');
const backup = require('./backup');

// ─────────────────────────────────────────────
//  辅助函数
// ─────────────────────────────────────────────

/** 将任意换行符转换为 LF (\n) */
function toLF(str) {
  if (!str) return '';
  return String(str).replace(/\r\n|\r/g, '\n');
}

/** 将任意换行符转换为 CRLF (\r\n) */
function toCRLF(str) {
  if (!str) return '';
  // 先归一化为 LF，再替换为 CRLF
  return toLF(str).replace(/\n/g, '\r\n');
}

/** 读取文件并以 LF 换行符返回内容 */
function readFileNormalized(filePath) {
  return toLF(fs.readFileSync(filePath, 'utf8'));
}

/** 以 CRLF 换行符写入内容到文件 */
function writeFileNormalized(filePath, content) {
  fs.writeFileSync(filePath, toCRLF(content), 'utf8');
}

/** 截断过长的字符串，防止超出上下文窗口 */
function truncate(str, max = config.MAX_OUTPUT_LENGTH) {
  if (!str) return '';
  const s = String(str);
  if (s.length <= max) return s;
  const half = Math.floor(max / 2);
  return (
    s.slice(0, half) +
    `\n\n⚠ [输出已截断 — 共 ${s.length.toLocaleString()} 字符，显示前 ${half} 和后 ${half} 字符]\n\n` +
    s.slice(-half)
  );
}

/** 解析相对于工作目录的路径 */
function resolve(filePath) {
  if (path.isAbsolute(filePath)) return filePath;
  return path.resolve(config.WORKING_DIR, filePath);
}

/**
 * 格式化字节大小
 * @param {number} bytes - 字节数
 * @returns {string} 格式化后的大小
 */
function formatBytes(bytes) {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return `${(bytes / Math.pow(k, i)).toFixed(1)} ${sizes[i]}`;
}

/** 转义字符串以用于 PowerShell 单引号参数 */
function escapePS(str) {
  if (typeof str !== 'string') return String(str);
  // 将单引号替换为两个单引号（PowerShell 转义规则）
  return str.replace(/'/g, "''");
}

/** 转义正则表达式中的特殊字符 */
function escapeRegExp(string) {
  return string.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// ─────────────────────────────────────────────
//  工具定义
// ─────────────────────────────────────────────

const TOOLS = {

  // ── 文件读取 ────────────────────────────────────────────────────────────
  read_file: {
    description: '读取文件的完整内容。可选读取指定行范围。',
    parameters: {
      path: { type: 'string', required: true, description: '文件路径' },
      start_line: { type: 'number', required: false, description: '起始行号（从1开始）' },
      end_line: { type: 'number', required: false, description: '结束行号（包含）' },
    },
    async execute({ path: filePath, start_line, end_line }) {
      const abs = resolve(filePath);
      if (!fs.existsSync(abs)) throw new Error(`文件未找到: ${filePath}`);
      if (fs.statSync(abs).isDirectory()) throw new Error(`${filePath} 是目录`);

      // 以 LF 换行符读取
      let content = readFileNormalized(abs);
      const lines = content.split('\n');
      const totalLines = lines.length;

      if (start_line != null || end_line != null) {
        const s = Math.max(0, (start_line || 1) - 1);
        const e = end_line != null ? end_line : totalLines;
        const sliced = lines.slice(s, e);
        const numbered = sliced.map((l, i) => `${s + i + 1}:${l}`).join('\n');
        return `[${filePath} | 第 ${s + 1}–${e} 行]\n${truncate(numbered)}`;
      }

      // 始终为完整文件输出行号
      const numbered = lines.map((l, i) => `${i + 1}:${l}`).join('\n');
      return `[${filePath} | 共 ${totalLines} 行]\n${truncate(numbered)}`;
    },
  },

  // ── 文件写入 ────────────────────────────────────────────────────────────
  write_file: {
    description: '写入（创建或覆盖）文件。自动创建父目录。',
    parameters: {
      path: { type: 'string', required: true, description: '目标文件路径' },
      content: { type: 'string', required: true, description: '要写入的完整文件内容' },
    },
    async execute({ path: filePath, content }) {
      const abs = resolve(filePath);
      // 修改前创建备份
      try {
        await backup.createBackupWithMetadata(abs, 'write_file');
      } catch (err) {
        // 备份失败仅记录日志，不中断操作
        console.error(`${filePath} 备份失败:`, err);
      }
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      writeFileNormalized(abs, content);
      const lineCount = toLF(content).split('\n').length;
      return `✓ 已写入 ${formatBytes(Buffer.byteLength(toCRLF(content), 'utf8'))}（${lineCount} 行）→ ${filePath}`;
    },
  },

  // ── 文本替换（区分大小写，全部替换）────────────────────────────────────
  edit_file: {
    description: '在文件中查找文本并全部替换。默认区分大小写。',
    parameters: {
      path: { type: 'string', required: true, description: '文件路径' },
      old_string: { type: 'string', required: true, description: '被替换文本' },
      new_string: { type: 'string', required: true, description: '替换文本' },
      case_sensitive: { type: 'boolean', required: false, description: '区分大小写（默认: true）' },
    },
    async execute({ path: filePath, old_string, new_string, case_sensitive = true }) {
      const abs = resolve(filePath);
      // 修改前创建备份
      try {
        await backup.createBackupWithMetadata(abs, 'replace_text');
      } catch (err) {
        console.error(`${filePath} 备份失败:`, err);
      }

      // 以 LF 读取
      let content = readFileNormalized(abs);
      const original = content;
      const normalizedText = toLF(old_string);
      const normalizedReplace = toLF(new_string);

      // 转义搜索文本，构造正则
      const escaped = escapeRegExp(normalizedText);
      const flags = case_sensitive ? 'g' : 'gi';
      const regex = new RegExp(escaped, flags);

      // 统计匹配次数
      const matches = original.match(regex);
      const count = matches ? matches.length : 0;

      if (count === 0) {
        return `⚠ 在 ${filePath} 中未找到 "${old_string}" 的匹配项`;
      }

      // 全部替换，避免 $ 特殊符号干扰
      content = original.replace(regex, () => normalizedReplace);

      writeFileNormalized(abs, content);
      return `✓ 在 ${filePath} 中替换了 ${count} 处 "${old_string}"`;
    },
  },

  // ── 正则替换（区分大小写，全部替换）────────────────────────────────────
  replace_regex: {
    description: '使用正则表达式在文件中查找并全部替换。默认区分大小写。正则不应包含标志（由工具自动添加 g 与 i）。',
    parameters: {
      path: { type: 'string', required: true, description: '文件路径' },
      regex: { type: 'string', required: true, description: '正则表达式（不含标志）' },
      replace: { type: 'string', required: true, description: '替换文本，支持 $1, $2' },
      case_sensitive: { type: 'boolean', required: false, description: '区分大小写（默认: true）' },
    },
    async execute({ path: filePath, regex: pattern, replace, case_sensitive = true }) {
      const abs = resolve(filePath);
      try {
        await backup.createBackupWithMetadata(abs, 'replace_regex');
      } catch (err) {
        console.error(`${filePath} 备份失败:`, err);
      }

      let content = readFileNormalized(abs);
      const original = content;
      const normalizedReplace = toLF(replace);

      // 构造全局正则，根据 case_sensitive 决定是否添加 i 标志
      const flags = case_sensitive ? 'g' : 'gi';
      const regex = new RegExp(pattern, flags);

      // 统计匹配次数
      const matches = original.match(regex);
      const count = matches ? matches.length : 0;

      if (count === 0) {
        return `⚠ 在 ${filePath} 中未找到正则 "${pattern}" 的匹配项`;
      }

      content = original.replace(regex, normalizedReplace);

      writeFileNormalized(abs, content);
      return `✓ 在 ${filePath} 中替换了 ${count} 处匹配 "${pattern}"`;
    },
  },

  // ── 删除文件 ─────────────────────────────────────────────────────────────
  delete_file: {
    description: '永久删除文件。',
    parameters: {
      path: { type: 'string', required: true, description: '要删除的文件' },
    },
    async execute({ path: filePath }) {
      const abs = resolve(filePath);
      if (!fs.existsSync(abs)) throw new Error(`文件未找到: ${filePath}`);
      // 删除前创建备份
      try {
        await backup.createBackupWithMetadata(abs, 'delete_file');
      } catch (err) {
        // 备份失败仅记录日志，不中断操作
        console.error(`${filePath} 备份失败:`, err);
      }
      fs.unlinkSync(abs);
      return `✓ 已删除 ${filePath}`;
    },
  },

  // ── 列出目录 ──────────────────────────────────────────────────────────
  list_directory: {
    description: '列出目录中的文件和文件夹，可选递归。',
    parameters: {
      path: { type: 'string', required: false, description: '要列出的目录（默认: 工作目录）' },
      recursive: { type: 'boolean', required: false, description: '递归到子目录（默认: false）' },
      show_hidden: { type: 'boolean', required: false, description: '包含以 . 开头的隐藏文件（默认: false）' },
    },
    async execute({ path: dirPath = '.', recursive = false, show_hidden = false }) {
      const abs = resolve(dirPath);
      if (!fs.existsSync(abs)) throw new Error(`目录未找到: ${dirPath}`);
      if (!fs.statSync(abs).isDirectory()) throw new Error(`${dirPath} 不是目录`);

      if (recursive) {
        // 使用 PowerShell Get-ChildItem 递归，过滤掉常见噪声文件夹
        const hiddenFilter = show_hidden ? '' : '-Force'; // -Force 包含隐藏文件；如果不显示隐藏文件则后续过滤
        // 构建排除目录的正则
        const excludePattern = 'node_modules|\\.git|dist|build|x64|x86|depend|Debug|Release|Obj|bin|.qtcreator|.vscode';
        // PowerShell 命令：递归获取所有文件/目录，排除不需要的文件夹，按全名排序，取前300个
        let psCmd = `Get-ChildItem -Path '${escapePS(abs)}' -Recurse`;
        if (!show_hidden) {
          psCmd += ` | Where-Object { $_.Name -notlike '.*' }`;
        }
        psCmd += ` | Where-Object { $_.FullName -notmatch '${excludePattern}' }`;
        psCmd += ` | Sort-Object FullName | Select-Object -First 300 | ForEach-Object { $_.FullName }`;
        const out = execSync(`powershell.exe -NoProfile -Command "${psCmd}"`, { encoding: 'utf8' }).trim();
        return out || '(空)';
      }

      const entries = fs.readdirSync(abs, { withFileTypes: true });
      const visible = show_hidden ? entries : entries.filter(e => !e.name.startsWith('.'));
      visible.sort((a, b) => {
        if (a.isDirectory() && !b.isDirectory()) return -1;
        if (!a.isDirectory() && b.isDirectory()) return 1;
        return a.name.localeCompare(b.name);
      });

      if (visible.length === 0) return `(空目录: ${dirPath})`;

      const lines = visible.map(e => {
        if (e.isDirectory()) {
          return `📁  ${e.name}/`;
        }
        try {
          const size = fs.statSync(path.join(abs, e.name)).size;
          return `📄  ${e.name}  ${formatBytes(size)}`;
        } catch {
          return `📄  ${e.name}`;
        }
      });

      return `[${dirPath}] — ${visible.length} 项\n${lines.join('\n')}`;
    },
  },

  // ── 创建目录 ────────────────────────────────────────────────────────────
  create_directory: {
    description: '创建目录（自动创建所有必要的父目录）。',
    parameters: {
      path: { type: 'string', required: true, description: '要创建的目录路径' },
    },
    async execute({ path: dirPath }) {
      const abs = resolve(dirPath);
      fs.mkdirSync(abs, { recursive: true });
      return `✓ 已创建目录: ${dirPath}`;
    },
  },

  // ── 移动 / 重命名 ─────────────────────────────────────────────────────────
  move_file: {
    description: '移动或重命名文件或目录。',
    parameters: {
      source: { type: 'string', required: true, description: '源路径' },
      destination: { type: 'string', required: true, description: '目标路径' },
    },
    async execute({ source, destination }) {
      const src = resolve(source);
      const dest = resolve(destination);
      if (!fs.existsSync(src)) throw new Error(`源文件未找到: ${source}`);
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.renameSync(src, dest);
      return `✓ 已移动: ${source} → ${destination}`;
    },
  },

  // ── 复制文件 ──────────────────────────────────────────────────────────────
  copy_file: {
    description: '复制文件到新位置。',
    parameters: {
      source: { type: 'string', required: true, description: '源文件路径' },
      destination: { type: 'string', required: true, description: '目标文件路径' },
    },
    async execute({ source, destination }) {
      const src = resolve(source);
      const dest = resolve(destination);
      if (!fs.existsSync(src)) throw new Error(`源文件未找到: ${source}`);
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.copyFileSync(src, dest);
      return `✓ 已复制: ${source} → ${destination}`;
    },
  },

  // ── 文件信息 ──────────────────────────────────────────────────────────────
  get_file_info: {
    description: '获取文件或目录的元数据（大小、修改日期、行数等）。',
    parameters: {
      path: { type: 'string', required: true, description: '文件或目录路径' },
    },
    async execute({ path: filePath }) {
      const abs = resolve(filePath);
      if (!fs.existsSync(abs)) throw new Error(`未找到: ${filePath}`);
      const stat = fs.statSync(abs);
      const info = {
        path: abs,
        type: stat.isDirectory() ? '目录' : '文件',
        size: stat.size,
        size_human: formatBytes(stat.size),
        modified: stat.mtime.toISOString(),
        created: stat.birthtime.toISOString(),
        permissions: `0${(stat.mode & 0o777).toString(8)}`,
      };
      if (stat.isFile()) {
        const content = readFileNormalized(abs);
        info.lines = content.split('\n').length;
        info.encoding = 'utf-8';
      }
      return JSON.stringify(info, null, 2);
    },
  },

  // run_command 工具修改部分：添加文件读取检测
  run_command: {
    description: '执行 shell 命令并返回输出。默认在工作目录中运行。',
    parameters: {
      command: { type: 'string', required: true, description: '要运行的 shell 命令' },
      cwd: { type: 'string', required: false, description: '命令的工作目录' },
      timeout: { type: 'number', required: false, description: '超时时间（毫秒，默认: 60000）' },
      env: { type: 'object', required: false, description: '额外的环境变量（键值对）' },
    },
    async execute({ command, cwd, timeout = 60_000, env = {} }) {
      // ========== 新增：检测是否试图读取文件内容 ==========
      const fileReadPatterns = [
        /Get-Content/i,
        /\bcat\s+/i,
        /\btype\s+/i,
        /\bmore\s+/i,
        /\btail\s+/i,
        /\bgc\s+/i,
        /<\s*["']?\w+["']?/,
      ];
      for (const pattern of fileReadPatterns) {
        if (pattern.test(command)) {
          throw new Error('禁止通过命令行读取文件内容。请使用 read_file 工具代替。');
        }
      }
      // ========== 检测结束 ==========

      const workDir = cwd ? resolve(cwd) : config.WORKING_DIR;
      try {
        const output = execSync(command, {
          cwd: workDir,
          encoding: 'utf8',
          timeout,
          maxBuffer: 20 * 1024 * 1024,
          env: { ...process.env, ...env },
          stdio: ['pipe', 'pipe', 'pipe'],
        });
        const result = (output || '').trim();
        return truncate(result || '(命令执行完成，无输出)');
      } catch (err) {
        const stdout = (err.stdout || '').trim();
        const stderr = (err.stderr || '').trim();
        const combined = [
          stdout && `标准输出:\n${stdout}`,
          stderr && `标准错误:\n${stderr}`,
        ].filter(Boolean).join('\n\n');
        throw new Error(`命令失败（退出码 ${err.status}）:\n${truncate(combined || err.message)}`);
      }
    },
  },

  // ── 查找文件 ──────────────────────────────────────────────────────────────
  find_files: {
    description: '按名称模式搜索文件（glob风格，例如 "*.js"、"test_*"）。',
    parameters: {
      pattern: { type: 'string', required: true, description: '文件名模式（例如 "*.ts"）' },
      directory: { type: 'string', required: false, description: '搜索目录（默认: 工作目录）' },
      exclude: { type: 'string', required: false, description: '要从结果中排除的模式' },
    },
    async execute({ pattern, directory = '.', exclude }) {
      const dir = resolve(directory);
      let excludePattern = 'node_modules|build|debug|release|backups|\\.git|dist';
      if (exclude) {
        excludePattern += `|${escapePS(exclude)}`;
      }
      // 使用 PowerShell: Get-ChildItem -Recurse -Filter，然后过滤排除的文件夹
      const psCmd = `Get-ChildItem -Path '${escapePS(dir)}' -Recurse -Filter '${escapePS(pattern)}' -File | Where-Object { $_.FullName -notmatch '${excludePattern}' } | Sort-Object FullName | Select-Object -First 100 | ForEach-Object { $_.FullName }`;
      let result;
      try {
        result = execSync(`powershell.exe -NoProfile -Command "${psCmd}"`, { encoding: 'utf8' }).trim();
      } catch (err) {
        if (err.status === 1) return `在 ${directory} 中未找到匹配 "${pattern}" 的文件`;
        throw err;
      }
      return result || `在 ${directory} 中未找到匹配 "${pattern}" 的文件`;
    },
  },

  // ── 文件内搜索（grep）───────────────────────────────────────────────────
  search_in_files: {
    description: '在文件内搜索文本模式（类似 grep -r）。返回匹配行及文件名。',
    parameters: {
      pattern: { type: 'string', required: true, description: '要搜索的文本或正则表达式' },
      directory: { type: 'string', required: false, description: '搜索目录（默认: 工作目录）' },
      file_pattern: { type: 'string', required: false, description: '仅搜索匹配此模式的文件（例如 "*.js"）' },
      case_sensitive: { type: 'boolean', required: false, description: '区分大小写（默认: false）' },
      context_lines: { type: 'number', required: false, description: '每处匹配周围的上下文行数（默认: 2）' },
    },
    async execute({ pattern, directory = '.', file_pattern, case_sensitive = false, context_lines = 2 }) {
      const dir = resolve(directory);
      if (!fs.existsSync(dir)) throw new Error(`目录未找到: ${directory}`);

      // 构建正则表达式
      let regex;
      const flags = case_sensitive ? '' : 'i';
      try {
        // 尝试作为正则表达式解析
        regex = new RegExp(pattern, flags);
      } catch {
        // 如果不是有效正则，转义特殊字符后作为普通字符串匹配
        const escaped = pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        regex = new RegExp(escaped, flags);
      }

      // 文件模式匹配（glob 转正则）
      let fileMatcher = null;
      if (file_pattern) {
        const globToRegex = (glob) => {
          const escaped = glob.replace(/[.+^${}()|[\]\\]/g, '\\$&')
            .replace(/\*/g, '.*')
            .replace(/\?/g, '.');
          return new RegExp(`^${escaped}$`, 'i');
        };
        fileMatcher = globToRegex(file_pattern);
      }

      // 排除目录（正则匹配目录名或路径片段）
      const excludeDirs = /node_modules|build|debug|release|\.git|dist|__pycache__|backups|venv|\.idea|\.vscode/;

      const results = [];
      const MAX_RESULTS = 150;
      const MAX_FILE_SIZE = 5 * 1024 * 1024; // 跳过超过 5MB 的文件

      // 递归遍历目录
      function walk(currentDir) {
        if (results.length >= MAX_RESULTS) return;
        let entries;
        try {
          entries = fs.readdirSync(currentDir, { withFileTypes: true });
        } catch {
          return; // 忽略权限错误
        }

        for (const entry of entries) {
          if (results.length >= MAX_RESULTS) break;
          const fullPath = path.join(currentDir, entry.name);

          if (entry.isDirectory()) {
            // 跳过排除的目录
            if (excludeDirs.test(entry.name) || excludeDirs.test(fullPath)) continue;
            walk(fullPath);
          } else if (entry.isFile()) {
            // 文件模式过滤
            if (fileMatcher && !fileMatcher.test(entry.name)) continue;

            // 跳过超大文件
            let stats;
            try {
              stats = fs.statSync(fullPath);
              if (stats.size > MAX_FILE_SIZE) continue;
            } catch { continue; }

            // 检测二进制文件（读取前 1KB，若含 null 字节则跳过）
            let isBinary = false;
            try {
              const fd = fs.openSync(fullPath, 'r');
              const buffer = Buffer.alloc(1024);
              const bytesRead = fs.readSync(fd, buffer, 0, 1024, 0);
              fs.closeSync(fd);
              if (buffer.slice(0, bytesRead).includes(0)) isBinary = true;
            } catch { continue; }
            if (isBinary) continue;

            // 读取文件内容（UTF-8）
            let content;
            try {
              content = fs.readFileSync(fullPath, 'utf8');
            } catch {
              continue; // 编码问题跳过
            }

            const lines = content.split(/\r?\n/);

            // 收集本文件中所有匹配行号
            const matchLineIndices = [];
            for (let i = 0; i < lines.length; i++) {
              if (regex.test(lines[i])) {
                matchLineIndices.push(i);
              }
            }

            if (matchLineIndices.length === 0) continue;

            // 合并重叠或相邻的上下文范围
            // 每个范围: [startLine, endLine]（0-based，含首尾）
            const mergedRanges = [];
            for (const lineIdx of matchLineIndices) {
              const rangeStart = Math.max(0, lineIdx - context_lines);
              const rangeEnd = Math.min(lines.length - 1, lineIdx + context_lines);

              if (mergedRanges.length > 0) {
                const last = mergedRanges[mergedRanges.length - 1];
                // 如果当前范围与上一个范围重叠或紧邻（相差 <= 1 行），则合并
                if (rangeStart <= last[1] + 1) {
                  last[1] = Math.max(last[1], rangeEnd);
                  continue;
                }
              }
              mergedRanges.push([rangeStart, rangeEnd]);
            }

            const relativePath = path.relative(dir, fullPath);
            for (const [start, end] of mergedRanges) {
              if (results.length >= MAX_RESULTS) break;
              const contextParts = [];
              for (let j = start; j <= end; j++) {
                const isMatch = matchLineIndices.includes(j);
                const prefix = isMatch ? '>>>' : '   ';
                contextParts.push(`${prefix} ${j + 1}: ${lines[j]}`);
              }
              results.push(`[${relativePath}:${start + 1}–${end + 1}]\n${contextParts.join('\n')}\n`);
            }
          }
        }
      }

      walk(dir);

      if (results.length === 0) {
        return `未找到匹配: ${pattern}`;
      }
      return truncate(results.join('\n').trim());
    },
  },

  // ── 询问用户 ──────────────────────────────────────────────────────────
  ask_user: {
    description: '向用户提问并等待回复。当你需要澄清、确认或建议时很有用。',
    parameters: {
      question: { type: 'string', required: true, description: '要问用户的问题' },
      options: { type: 'array', required: false, description: '可选的选项列表供用户选择（例如 ["是", "否", "取消"]）' },
    },
    async execute({ question, options }) {
      // 返回一个特殊标记，Agent 循环会识别它
      // Agent 将向用户显示此问题并等待输入
      return {
        __ask_user: true,
        question: question,
        options: options || []
      };
    },
  },

  // ── 获取 URL ────────────────────────────────────────────────────────────
  read_url: {
    description: '获取 URL 的文本内容（用于阅读文档、API等）。',
    parameters: {
      url: { type: 'string', required: true, description: '要获取的完整 URL（http 或 https）' },
    },
    async execute({ url }) {
      return new Promise((resolve_p, reject) => {
        const client = url.startsWith('https') ? https : http;
        const options = {
          headers: {
            'User-Agent': 'Mozilla/5.0 (compatible; DeepSeekAgent/1.0)',
            'Accept': 'text/html,text/plain,application/json',
          },
        };

        const req = client.get(url, options, (res) => {
          if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
            return TOOLS.read_url.execute({ url: res.headers.location }).then(resolve_p).catch(reject);
          }

          let data = '';
          res.on('data', chunk => { data += chunk; });
          res.on('end', () => {
            const text = data
              .replace(/<script[\s\S]*?<\/script>/gi, '')
              .replace(/<style[\s\S]*?<\/style>/gi, '')
              .replace(/<[^>]+>/g, ' ')
              .replace(/\s{3,}/g, '\n\n')
              .trim();
            resolve_p(truncate(text));
          });
        });

        req.on('error', reject);
        req.setTimeout(15_000, () => { req.destroy(); reject(new Error('URL 获取超时')); });
      });
    },
  },

  // ── 批量写入文件 ───────────────────────────────────────────────────────────
  write_files: {
    description: '同时写入多个文件 — 适用于项目脚手架。',
    parameters: {
      files: {
        type: 'array',
        required: true,
        description: '{path, content} 对象数组',
      },
    },
    async execute({ files }) {
      if (!Array.isArray(files)) throw new Error('"files" 必须是 {path, content} 对象数组');
      const results = [];
      for (const { path: filePath, content } of files) {
        const abs = resolve(filePath);
        // 写入前创建备份
        try {
          await backup.createBackupWithMetadata(abs, 'write_files');
        } catch (err) {
          // 备份失败仅记录日志，不中断操作
          console.error(`${filePath} 备份失败:`, err);
        }
        fs.mkdirSync(path.dirname(abs), { recursive: true });
        writeFileNormalized(abs, content);
        results.push(`✓ ${filePath}`);
      }
      return `已写入 ${results.length} 个文件:\n${results.join('\n')}`;
    },
  },

};

// ─────────────────────────────────────────────
//  生成系统提示词的工具文档
// ─────────────────────────────────────────────
function getToolDescriptions() {
  return Object.entries(TOOLS).map(([name, tool]) => {
    const paramLines = Object.entries(tool.parameters || {}).map(([pName, p]) =>
      `    - ${pName} (${p.type}${p.required ? ', 必填' : ''}): ${p.description || ''}`
    ).join('\n');

    return `### ${name}\n  ${tool.description}\n  参数:\n${paramLines}`;
  }).join('\n\n');
}

// ─────────────────────────────────────────────
//  按名称执行工具
// ─────────────────────────────────────────────
async function executeTool(name, args) {
  const tool = TOOLS[name];
  if (!tool) {
    const available = Object.keys(TOOLS).join(', ');
    throw new Error(`未知工具: "${name}"。可用工具: ${available}`);
  }
  return await tool.execute(args);
}

module.exports = { TOOLS, executeTool, getToolDescriptions };