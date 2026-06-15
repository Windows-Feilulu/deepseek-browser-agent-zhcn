// src/gitignore.js — .gitignore 规则解析与匹配（优化版）
'use strict';

const fs = require('fs');
const path = require('path');

/**
 * 将 .gitignore 模式转换为正则表达式
 * 遵循 Git 官方规范: https://git-scm.com/docs/gitignore
 *
 * @param {string} pattern - .gitignore 中的规则模式
 * @returns {Object|null} { regex, negated, dirOnly, anchored } 或 null（无效规则）
 */
function gitignorePatternToRegex(pattern) {
  if (!pattern || pattern.startsWith('#')) return null;

  let negated = false;
  let p = pattern;

  // 处理否定规则 !
  if (p.startsWith('!')) {
    negated = true;
    p = p.slice(1);
  }

  // 处理目录锚定 / 前缀（仅匹配根目录）
  const anchored = p.startsWith('/');
  if (anchored) p = p.slice(1);

  // 处理目录锚定 / 后缀（仅匹配目录）
  const dirOnly = p.endsWith('/');
  if (dirOnly) p = p.slice(0, -1);

  // 如果模式为空（例如 "!" 或 "/"），跳过
  if (!p) return null;

  // 转义正则特殊字符，同时处理 glob 通配符
  let regexStr = '';
  const chars = p.split('');
  for (let i = 0; i < chars.length; i++) {
    const c = chars[i];
    const next = chars[i + 1];

    if (c === '*' && next === '*') {
      // ** 匹配零个或多个路径段
      // 如果后面跟着 /，则匹配任意层级的目录
      if (chars[i + 2] === '/') {
        regexStr += '(?:[^/]*(?:\\/|$))*';
        i += 2; // 跳过 **/
      } else {
        // ** 在末尾，匹配所有
        regexStr += '.*';
        i++; // 跳过第二个 *
      }
    } else if (c === '*') {
      // * 匹配零个或多个非路径分隔符字符
      regexStr += '[^/]*';
    } else if (c === '?') {
      // ? 匹配单个非路径分隔符字符
      regexStr += '[^/]';
    } else if (c === '[') {
      // 字符类 [...] — 直接传递到正则
      // 找到匹配的 ]
      let j = i + 1;
      if (j < chars.length && (chars[j] === '!' || chars[j] === '^')) j++;
      if (j < chars.length && chars[j] === ']') j++;
      while (j < chars.length && chars[j] !== ']') j++;
      if (j < chars.length) {
        // 找到匹配的 ]，提取整个字符类
        let bracketContent = p.slice(i + 1, j);
        // 将 ! 转换为 ^（gitignore 用 ! 取反，正则用 ^）
        if (bracketContent.startsWith('!')) {
          bracketContent = '^' + bracketContent.slice(1);
        }
        regexStr += '[' + bracketContent + ']';
        i = j;
      } else {
        // 没有匹配的 ]，转义 [
        regexStr += '\\[';
      }
    } else if ('.+^${}()|'.includes(c)) {
      regexStr += '\\' + c;
    } else if (c === '\\') {
      // 转义下一个字符
      if (next) {
        regexStr += '\\' + (next === '/' ? '/' : next);
        i++;
      }
    } else {
      regexStr += c;
    }
  }

  // 构建最终正则
  let finalRegex;
  if (anchored) {
    // 锚定模式：从根目录开始匹配
    finalRegex = '^/' + regexStr;
    if (!dirOnly) {
      // 非目录锚定模式：匹配到路径末尾或 /
      finalRegex += '(/|$)';
    } else {
      // 目录锚定模式：必须以 / 结尾（在字符串末尾）
      finalRegex += '(/|$)';
    }
  } else {
    // 非锚定模式：可以匹配路径中的任意位置
    if (p.includes('/')) {
      // 包含 / 的模式：从任意位置匹配
      finalRegex = '(^|/)' + regexStr + '(/|$)';
    } else {
      // 简单名称模式：匹配路径中任意段
      finalRegex = '(^|/)' + regexStr + '(/|$)';
    }
  }

  try {
    return { regex: new RegExp(finalRegex), negated, dirOnly, anchored };
  } catch {
    return null;
  }
}

/**
 * 解析 .gitignore 文件内容
 * @param {string} content - .gitignore 文件内容
 * @returns {Array} 规则列表
 */
function parseGitignore(content) {
  const rules = [];
  const lines = content.split(/\r?\n/);

  for (const line of lines) {
    // 去除行尾空白
    const trimmed = line.trimEnd();
    // 跳过空行和注释
    if (!trimmed || trimmed.startsWith('#')) continue;

    const parsed = gitignorePatternToRegex(trimmed);
    if (parsed) {
      rules.push(parsed);
    }
  }

  return rules;
}

/**
 * 加载指定目录下的 .gitignore 规则
 * 会向上查找所有父目录中的 .gitignore 文件（直到 rootDir）
 * @param {string} searchDir - 起始搜索目录
 * @param {string} rootDir - 根目录（停止向上查找）
 * @returns {Array<{regex: RegExp, negated: boolean, dirOnly: boolean, anchored: boolean, baseDir: string}>} 合并后的规则列表
 */
function loadGitignoreRules(searchDir, rootDir) {
  const allRules = [];
  let currentDir = path.resolve(searchDir);
  const root = path.resolve(rootDir);

  // 收集从 searchDir 到 rootDir 路径上所有 .gitignore 文件
  const gitignoreFiles = [];
  while (true) {
    const gitignorePath = path.join(currentDir, '.gitignore');
    if (fs.existsSync(gitignorePath)) {
      gitignoreFiles.push({ dir: currentDir, path: gitignorePath });
    }
    if (currentDir === root) break;
    const parentDir = path.dirname(currentDir);
    if (parentDir === currentDir) break; // 到达文件系统根目录
    currentDir = parentDir;
  }

  // 按从根到子目录的顺序解析规则（根目录规则先应用）
  gitignoreFiles.reverse();

  for (const { dir, path: gitignorePath } of gitignoreFiles) {
    try {
      const content = fs.readFileSync(gitignorePath, 'utf8');
      const rules = parseGitignore(content);
      // 记录规则来源目录，用于后续相对路径计算
      for (const rule of rules) {
        allRules.push({ ...rule, baseDir: dir });
      }
    } catch {
      // 忽略读取错误
    }
  }

  return allRules;
}

/**
 * 检查路径是否被 .gitignore 规则忽略
 *
 * @param {string} filePath - 要检查的文件/目录路径（绝对路径）
 * @param {string} rootDir - 项目根目录（用于计算相对路径）
 * @param {Array} rules - .gitignore 规则列表
 * @param {boolean} isDirectory - 是否为目录
 * @returns {boolean} true 表示被忽略
 */
function isIgnored(filePath, rootDir, rules, isDirectory = false) {
  const absPath = path.resolve(filePath);
  const root = path.resolve(rootDir);

  // 计算相对于根目录的路径（统一使用 /）
  let relativePath = path.relative(root, absPath).replace(/\\/g, '/');

  let ignored = false;

  for (const rule of rules) {
    const baseDir = rule.baseDir || root;

    // 计算相对于规则来源目录的路径
    let relToBase = path.relative(baseDir, absPath).replace(/\\/g, '/');

    // 对于锚定规则，使用相对于规则所在目录的路径
    let testPath = rule.anchored ? ('/' + relToBase) : ('/' + relativePath);

    // dirOnly 规则只匹配目录
    if (rule.dirOnly && !isDirectory) {
      // 对于 dirOnly 规则和非目录文件，检查路径的每个父目录是否匹配
      // 例如 node_modules/ 规则应该忽略 node_modules/foo/bar.txt
      const segments = relativePath.split('/');
      let parentIgnored = false;
      for (let i = 1; i < segments.length; i++) {
        const parentPath = '/' + segments.slice(0, i).join('/') + '/';
        if (rule.regex.test(parentPath)) {
          parentIgnored = true;
          break;
        }
      }
      if (!parentIgnored) continue;
    } else {
      // 目录路径需要添加尾部 / 以匹配 dirOnly 规则
      if (isDirectory && !testPath.endsWith('/')) {
        testPath += '/';
      }
    }

    const matched = rule.regex.test(testPath);

    if (matched) {
      if (rule.negated) {
        // 否定规则：取消忽略
        ignored = false;
      } else {
        ignored = true;
      }
    }
  }

  return ignored;
}

/**
 * 默认忽略目录集合（当工作目录不存在 .gitignore 时使用）
 */
const DEFAULT_IGNORE_DIRS = new Set([
  'node_modules', '.git', 'dist', '.next', 'build',
  '.deepseek-agent-zhcn-backups', '.vs', '.vscode', 'backups',
  'depend', 'lib', '.qm', '.qtcreator', '.uploads', 'debug',
  'release', 'obj',
]);

/**
 * 创建工作目录的 .gitignore 过滤函数
 *
 * 语义：
 *   - 返回 true  表示"保留"（不被忽略）
 *   - 返回 false 表示"忽略"（被过滤掉）
 *
 * 当工作目录存在 .gitignore 时，以 .gitignore 规则为主。
 * 不存在 .gitignore 时，使用内置的默认忽略目录集合进行过滤。
 *
 * @param {string} workingDir - 工作目录
 * @returns {Function} 过滤函数 (filePath, isDirectory) => boolean
 */
function createGitignoreFilter(workingDir) {
  const rules = loadGitignoreRules(workingDir, workingDir);
  const hasGitignore = rules.length > 0;

  return (filePath, isDirectory) => {
    const name = path.basename(filePath);

    // 如果存在 .gitignore 规则，使用 .gitignore 进行过滤
    if (hasGitignore) {
      // 始终忽略 .git 目录（Git 内部目录）
      if (name === '.git') return false;
      return !isIgnored(filePath, workingDir, rules, isDirectory);
    }

    // 没有 .gitignore 时，使用默认忽略目录集合
    if (isDirectory && DEFAULT_IGNORE_DIRS.has(name)) return false;

    return true;
  };
}

module.exports = {
  parseGitignore,
  loadGitignoreRules,
  isIgnored,
  createGitignoreFilter,
};
