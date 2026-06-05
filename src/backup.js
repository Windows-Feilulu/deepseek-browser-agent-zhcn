// src/backup.js — 文件备份工具（中文版）
'use strict';

const fs   = require('fs');
const path = require('path');
const os   = require('os');

let currentSessionId = null;
let currentSessionDir = null;

// 缓存已经备份过的文件，键为绝对路径，值为备份文件路径
const backedUpFiles = new Map();

/**
 * 设置当前会话 ID
 * @param {string} sessionId - 会话 ID
 */
function setSessionId(sessionId) {
  currentSessionId = sessionId;
  // 备份目录改为当前命令执行目录下的 deepseek-agent-zhcn-backups 子目录
  const baseDir = path.join(process.cwd(), '.deepseek-agent-zhcn-backups');
  currentSessionDir = path.join(baseDir, sessionId);
  fs.mkdirSync(currentSessionDir, { recursive: true });
  // 新会话时清空备份缓存
  backedUpFiles.clear();
}

/**
 * 获取当前备份目录
 * @returns {string} 备份目录路径
 */
function getBackupDir() {
  return currentSessionDir;
}

/**
 * 创建文件的备份（每个文件只备份一次原始版本）
 * @param {string} filePath - 要备份的文件路径
 * @returns {string|null} 备份文件路径，如果文件不存在或已是新文件则返回 null
 */
function createBackup(filePath) {
  if (!fs.existsSync(filePath)) {
    return null; // 新文件，无需备份
  }

  const absPath = path.resolve(filePath);

  // 如果已经备份过该文件，直接返回之前的备份路径
  if (backedUpFiles.has(absPath)) {
    return backedUpFiles.get(absPath);
  }

  const basename = path.basename(filePath);
  // 使用固定后缀 .original.backup 确保每个文件只有一个原始备份
  const backupFileName = `${basename}.original.backup`;
  const backupPath = path.join(currentSessionDir, backupFileName);

  // 避免文件名冲突：如果备份文件已存在（例如来自之前的会话），则添加时间戳
  // 但正常情况下会话目录是唯一的，所以直接使用固定名称也可行。
  // 为了更加健壮，如果已存在则添加时间戳后缀，但这样会导致多个备份，违背初衷。
  // 由于会话 ID 不同，目录不同，所以不会冲突。
  fs.copyFileSync(filePath, backupPath);
  backedUpFiles.set(absPath, backupPath);
  return backupPath;
}

/**
 * 创建带元数据的备份（只记录操作，不重复复制文件）
 * @param {string} filePath - 要备份的文件路径
 * @param {string} operation - 操作类型
 * @returns {string|null} 备份文件路径
 */
function createBackupWithMetadata(filePath, operation) {
  const backupPath = createBackup(filePath);
  
  // 只要有备份文件（无论是新创建还是已存在），都记录操作元数据
  if (backupPath) {
    const metadataPath = path.join(currentSessionDir, 'backup_manifest.json');
    let manifest = [];
    
    if (fs.existsSync(metadataPath)) {
      try {
        manifest = JSON.parse(fs.readFileSync(metadataPath, 'utf8'));
      } catch {
        manifest = [];
      }
    }
    
    manifest.push({
      timestamp: new Date().toISOString(),
      originalPath: filePath,
      backupPath: backupPath,
      operation: operation,
    });
    
    fs.writeFileSync(metadataPath, JSON.stringify(manifest, null, 2), 'utf8');
  }
  
  return backupPath;
}

/**
 * 备份用户提示词
 * @param {string} prompt - 用户提示词
 * @returns {string} 备份文件路径
 */
function backupUserPrompt(prompt) {
  if (!currentSessionDir) {
    throw new Error('必须先设置会话 ID');
  }
  
  if (typeof prompt !== 'string' || prompt.trim().length === 0) {
    throw new Error('任务内容必须是非空字符串');
  }
  
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const promptFile = path.join(currentSessionDir, `user_prompt_${timestamp}.txt`);
  
  fs.writeFileSync(promptFile, prompt, 'utf8');
  return promptFile;
}

/**
 * 列出当前会话的所有备份操作记录
 * @returns {Array} 备份操作列表
 */
function listBackups() {
  if (!currentSessionDir || !fs.existsSync(currentSessionDir)) {
    return [];
  }
  
  const manifestPath = path.join(currentSessionDir, 'backup_manifest.json');
  if (!fs.existsSync(manifestPath)) {
    return [];
  }
  
  try {
    return JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  } catch {
    return [];
  }
}

/**
 * 恢复文件到最后一个备份（即原始版本，因为只备份一次）
 * @param {string} filePath - 要恢复的文件路径
 * @returns {boolean} 是否成功恢复
 */
function restoreLastBackup(filePath) {
  const absPath = path.resolve(filePath);
  // 直接检查缓存中是否有该文件的备份
  if (backedUpFiles.has(absPath)) {
    const backupPath = backedUpFiles.get(absPath);
    if (fs.existsSync(backupPath)) {
      fs.copyFileSync(backupPath, filePath);
      return true;
    }
  }
  
  // 后备：从 manifest 中查找该文件的第一次备份（按时间最早的）
  const backups = listBackups()
    .filter(b => b.originalPath === filePath)
    .sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));
  
  if (backups.length === 0) {
    return false;
  }
  
  const firstBackup = backups[0];
  if (!fs.existsSync(firstBackup.backupPath)) {
    return false;
  }
  
  fs.copyFileSync(firstBackup.backupPath, filePath);
  return true;
}

module.exports = {
  setSessionId,
  getBackupDir,
  createBackup,
  createBackupWithMetadata,
  backupUserPrompt,
  listBackups,
  restoreLastBackup,
};
