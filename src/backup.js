// src/backup.js — 文件备份工具（中文版）
'use strict';

const fs   = require('fs');
const path = require('path');
const os   = require('os');

let currentSessionId = null;
let currentSessionDir = null;

/**
 * 设置当前会话 ID
 * @param {string} sessionId - 会话 ID
 */
function setSessionId(sessionId) {
  currentSessionId = sessionId;
  // 备份目录改为当前命令执行目录下的 deepseek-agent-backups 子目录
  const baseDir = path.join(process.cwd(), '.deepseek-agent-backups');
  currentSessionDir = path.join(baseDir, sessionId);
  fs.mkdirSync(currentSessionDir, { recursive: true });
}

/**
 * 获取当前备份目录
 * @returns {string} 备份目录路径
 */
function getBackupDir() {
  return currentSessionDir;
}

/**
 * 创建文件的备份
 * @param {string} filePath - 要备份的文件路径
 * @returns {string|null} 备份文件路径，如果文件不存在则返回 null
 */
function createBackup(filePath) {
  if (!fs.existsSync(filePath)) {
    return null; // 新文件，无需备份
  }

  const timestamp = Date.now();
  const basename = path.basename(filePath);
  const backupFileName = `${basename}.${timestamp}.backup`;
  const backupPath = path.join(currentSessionDir, backupFileName);

  fs.copyFileSync(filePath, backupPath);
  return backupPath;
}

/**
 * 创建带元数据的备份
 * @param {string} filePath - 要备份的文件路径
 * @param {string} operation - 操作类型
 * @returns {string|null} 备份文件路径
 */
function createBackupWithMetadata(filePath, operation) {
  const backupPath = createBackup(filePath);
  
  if (backupPath) {
    // 记录备份元数据
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
 * 列出当前会话的所有备份
 * @returns {Array} 备份列表
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
 * 恢复文件到最后一个备份
 * @param {string} filePath - 要恢复的文件路径
 * @returns {boolean} 是否成功恢复
 */
function restoreLastBackup(filePath) {
  const backups = listBackups()
    .filter(b => b.originalPath === filePath)
    .sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));
  
  if (backups.length === 0) {
    return false;
  }
  
  const lastBackup = backups[0];
  if (!fs.existsSync(lastBackup.backupPath)) {
    return false;
  }
  
  fs.copyFileSync(lastBackup.backupPath, filePath);
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
