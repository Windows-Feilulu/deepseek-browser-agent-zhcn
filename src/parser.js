// src/parser.js — 解析 DeepSeek 的文本回复以提取工具调用（中文版）
'use strict';

/**
 * 解析原始 DeepSeek 回复字符串。
 *
 * 返回以下之一:
 *   { type: 'tool_call', name: string, args: object, raw: string }
 *   { type: 'final',     content: string,            raw: string }
 *   { type: 'error',     message: string,            raw: string }
 */
function parseResponse(rawText) {
  const text = stripThinkingBlocks(rawText).trim();

  // ── 策略 0 (DOM 回退): 裸 "tool_call\n{ ... }" ─────────────────
  //
  //  当浏览器 Markdown 渲染器将:
  //    ```tool_call
  //    { "name": "write_file", "args": {...} }
  //    ```
  //  …转换为 <pre><code class="language-tool_call"> 元素时，我们的 getFullText()
  //  现在会重建围栏。但如果由于任何原因仍然失败，此策略会捕获原始 DOM 文本，
  //  其形式如下:
  //
  //    tool_call
  //    {
  //      "name": "write_file",
  //      "args": { ... }
  //    }
  //
  const bareMatch = text.match(/^tool_call\s*\n([\s\S]+)$/i);
  if (bareMatch) {
    const jsonRaw = bareMatch[1].trim();
    try {
      const parsed = JSON.parse(jsonRaw);
      const name   = parsed.name || parsed.tool || parsed.function;
      const args   = parsed.args || parsed.arguments || parsed.parameters || parsed.input || {};
      if (name && typeof name === 'string') {
        return { type: 'tool_call', name, args, raw: rawText };
      }
    } catch {
      const fixed = attemptJsonFix(jsonRaw);
      if (fixed) {
        const name = fixed.name || fixed.tool || fixed.function;
        const args = fixed.args || fixed.arguments || fixed.parameters || fixed.input || {};
        if (name) return { type: 'tool_call', name, args, raw: rawText };
      }
    }
  }

  // ── 策略 1 (主要): ```tool_call 围栏代码块 ─────────────────
  //  我们的主要格式 — 由 getFullText() 从 <pre><code> 重建。
  const fencedMatch = text.match(/```tool_call\s*([\s\S]*?)```/i);
  if (fencedMatch) {
    const raw = fencedMatch[1].trim();
    try {
      const parsed = JSON.parse(raw);
      const name   = parsed.name || parsed.tool || parsed.function;
      const args   = parsed.args || parsed.arguments || parsed.parameters || parsed.input || {};
      if (name && typeof name === 'string') {
        return { type: 'tool_call', name, args, raw: rawText };
      }
    } catch (e) {
      const fixed = attemptJsonFix(raw);
      if (fixed) {
        const name = fixed.name || fixed.tool || fixed.function;
        const args = fixed.args || fixed.arguments || fixed.parameters || fixed.input || {};
        if (name) return { type: 'tool_call', name, args, raw: rawText };
      }
      return {
        type    : 'error',
        message : 'tool_call 代码块包含无效的 JSON: ' + e.message + '\n内容: ' + raw.slice(0, 300),
        raw     : rawText,
      };
    }
  }

  // ── 策略 2: 包含 "name"/"tool" 键的 ```json 代码块 ──────────────────────
  const jsonFenceMatch = text.match(/```(?:json)?\s*(\{[\s\S]*?\})\s*```/);
  if (jsonFenceMatch) {
    try {
      const parsed = JSON.parse(jsonFenceMatch[1]);
      const name   = parsed.name || parsed.tool || parsed.function;
      const args   = parsed.args || parsed.arguments || parsed.parameters || parsed.input || {};
      if (name && typeof name === 'string') {
        return { type: 'tool_call', name, args, raw: rawText };
      }
    } catch {}
  }

  // ── 策略 3: XML <tool_call> ───────────────────────────────────────────
  const xmlMatch = text.match(
    /<tool_call[^>]*>\s*(?:<name>([\s\S]*?)<\/name>\s*)?(?:<input>([\s\S]*?)<\/input>|<args>([\s\S]*?)<\/args>)\s*<\/tool_call>/i
  );
  if (xmlMatch) {
    const name     = (xmlMatch[1] || '').trim();
    const inputRaw = stripCodeFences((xmlMatch[2] || xmlMatch[3] || '').trim());
    if (name) return tryParseToolCall(name, inputRaw, rawText);
  }

  // ── 策略 4: DOM 剥离了尖括号的 XML ───────────────────
  const domStrippedMatch = text.match(
    /tool_call\s+name\s+([\w_]+)\s*\/name\s+input\s*([\s\S]*?)\s*\/input\s*\/tool_call/i
  );
  if (domStrippedMatch) {
    const name     = domStrippedMatch[1].trim();
    const inputRaw = stripCodeFences(domStrippedMatch[2].trim());
    return tryParseToolCall(name, inputRaw, rawText);
  }

  // ── 策略 5: 文本中任何位置包含 "name" 键的 JSON 对象 ──────────
  //  使用贪婪匹配来找到最外层的 JSON 对象（而非片段）。
  if (/["'](?:name|tool|function)["']\s*:\s*["'][\w_]+["']/.test(text)) {
    const jsonObj = extractLargestJsonObject(text);
    if (jsonObj) {
      const name = jsonObj.name || jsonObj.tool || jsonObj.function;
      const args = jsonObj.args || jsonObj.arguments || jsonObj.parameters || jsonObj.input || {};
      if (name && typeof name === 'string') {
        return { type: 'tool_call', name, args, raw: rawText };
      }
    }
  }

  // ── 策略 6: 代码块中的 Python 风格函数调用 ──────────────────
  const funcMatch = text.match(/```\w*\s*([\w_]+)\(([^)]*)\)\s*```/);
  if (funcMatch) {
    const name    = funcMatch[1];
    const argsRaw = funcMatch[2];
    const args    = {};
    const argRe   = /(\w+)\s*=\s*(?:"([^"]*?)"|'([^']*?)'|(\d+(?:\.\d+)?)|(\btrue\b|\bfalse\b))/g;
    let   m;
    while ((m = argRe.exec(argsRaw)) !== null) {
      const key = m[1];
      if      (m[2] !== undefined) args[key] = m[2];
      else if (m[3] !== undefined) args[key] = m[3];
      else if (m[4] !== undefined) args[key] = parseFloat(m[4]);
      else if (m[5] !== undefined) args[key] = m[5] === 'true';
    }
    if (Object.keys(args).length > 0) {
      return { type: 'tool_call', name, args, raw: rawText };
    }
  }

  // ── 未检测到工具调用 — 最终文本回复 ───────────────────────────
  return { type: 'final', content: text, raw: rawText };
}

// ─────────────────────────────────────────────
//  辅助函数
// ─────────────────────────────────────────────

function tryParseToolCall(name, inputRaw, rawText) {
  try {
    const args = JSON.parse(inputRaw);
    return { type: 'tool_call', name, args, raw: rawText };
  } catch (e) {
    // 尝试修复常见的 JSON 问题
    const fixed = attemptJsonFix(inputRaw);
    if (fixed !== null) {
      return { type: 'tool_call', name, args: fixed, raw: rawText };
    }
    return {
      type    : 'error',
      message : `工具 "${name}" 返回了无效的 JSON: ${e.message}\n原始输入: ${inputRaw.slice(0, 200)}`,
      raw     : rawText,
    };
  }
}

/** 去除 ```json ... ``` 或 ``` ... ``` 围栏 */
function stripCodeFences(str) {
  return str
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/, '')
    .trim();
}

/** 移除 DeepSeek R1 思考块 */
function stripThinkingBlocks(text) {
  return text
    .replace(/<think>[\s\S]*?<\/think>\n?/gi, '')
    .replace(/^Thinking\.{0,3}\n[\s\S]*?\n\n/m, '')
    .trim();
}

/** 尝试修复 LLM 常见的 JSON 错误 */
function attemptJsonFix(str) {
  try {
    const fixed = str
      .replace(/,\s*([}\]])/g, '$1')
      .replace(/([{,]\s*)(\w+)\s*:/g, '$1"$2":');
    return JSON.parse(fixed);
  } catch {
    return null;
  }
}

/**
 * 从字符串中提取最大的有效 JSON 对象。
 * 使用括号计数方法而非正则表达式，以处理嵌套对象。
 */
function extractLargestJsonObject(text) {
  let best = null;
  let bestLen = 0;

  for (let i = 0; i < text.length; i++) {
    if (text[i] !== '{') continue;
    let depth   = 0;
    let inStr   = false;
    let escape  = false;

    for (let j = i; j < text.length; j++) {
      const ch = text[j];
      if (escape)          { escape = false; continue; }
      if (ch === '\\' && inStr) { escape = true; continue; }
      if (ch === '"')      { inStr = !inStr; continue; }
      if (inStr)           { continue; }
      if (ch === '{')      { depth++; }
      else if (ch === '}') {
        depth--;
        if (depth === 0) {
          const candidate = text.slice(i, j + 1);
          if (candidate.length > bestLen) {
            try {
              const parsed = JSON.parse(candidate);
              best    = parsed;
              bestLen = candidate.length;
            } catch {
              const fixed = attemptJsonFix(candidate);
              if (fixed && candidate.length > bestLen) {
                best    = fixed;
                bestLen = candidate.length;
              }
            }
          }
          break;
        }
      }
    }
  }

  return best;
}

/** 格式化工具结果以便发送回 AI */
function formatToolResult(toolName, result, isError = false) {
  const status = isError ? '错误' : '成功';
  return [
    `[工具结果: ${toolName} | ${status}]`,
    String(result),
    `[工具结果结束]`,
  ].join('\n');
}

/** 检查回复是否看起来像是 Agent 在提出澄清问题 */
function isAskingQuestion(text) {
  const questionIndicators = [
    /\?(\s*$)/m,
    /能否(请您)?(进一步)?(说明|解释|澄清)/i,
    /能否提供更多/i,
    /您(想|希望|想要|喜欢|偏好)(什么|哪个)/i,
    /请(具体说明|澄清|告诉我)/i,
  ];
  return questionIndicators.some(re => re.test(text));
}

module.exports = {
  parseResponse,
  formatToolResult,
  stripThinkingBlocks,
  isAskingQuestion,
};
