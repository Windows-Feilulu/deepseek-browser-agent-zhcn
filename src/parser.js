// src/parser.js — 解析 DeepSeek 的文本回复以提取工具调用（中文版）
'use strict';

/**
 * 解析原始 DeepSeek 回复字符串，提取**所有**工具调用。
 *
 * 一次回复中可能包含多个工具调用（多个 ```tool_call 代码块、
 * 一个包含数组的代码块、多个 XML <tool_call> 等）。
 *
 * 返回以下之一:
 *   { type: 'tool_calls', calls: Array<{name,args,raw}>, raw: string }
 *   { type: 'final',      content: string,                raw: string }
 *   { type: 'error',      message: string,                raw: string }
 */
function parseToolCalls(rawText) {
  const text = stripThinkingBlocks(rawText).trim();
  const calls = [];
  let fenceError = null;

  // ── 策略 1: 围栏代码块 ```tool_call / ```json / ```（支持一个回复中包含多个）──
  //  当浏览器 Markdown 渲染器把围栏转成 <pre><code> 时，getFullText() 会将其重建。
  const fenceRe = /```([a-zA-Z0-9_-]*)[ \t]*\r?\n?([\s\S]*?)```/g;
  let fm;
  while ((fm = fenceRe.exec(text)) !== null) {
    const lang = (fm[1] || '').toLowerCase();
    if (lang && lang !== 'tool_call' && lang !== 'json') continue;
    const body = fm[2];
    const r = parsePayloadToCalls(body, rawText);
    if (r.calls.length) {
      calls.push(...r.calls);
    } else if (lang === 'tool_call' && r.error && !fenceError) {
      fenceError = { body: body.trim(), error: r.error };
    }
  }
  if (calls.length) return { type: 'tool_calls', calls, raw: rawText };
  if (fenceError) {
    return {
      type    : 'error',
      message : 'tool_call 代码块包含无效的 JSON: ' + fenceError.error + '\n内容: ' + fenceError.body.slice(0, 300),
      raw     : rawText,
    };
  }

  // ── 策略 2: XML <tool_call>（支持多个） ───────────────────────────────
  const xmlRe = /<tool_call[^>]*>\s*(?:<name>([\s\S]*?)<\/name>\s*)?(?:<input>([\s\S]*?)<\/input>|<args>([\s\S]*?)<\/args>)\s*<\/tool_call>/gi;
  let xm;
  while ((xm = xmlRe.exec(text)) !== null) {
    const name     = (xm[1] || '').trim();
    const inputRaw = stripCodeFences((xm[2] || xm[3] || '').trim());
    if (!name) continue;
    const r = tryParseToolCall(name, inputRaw, rawText);
    if (r.type === 'tool_call') calls.push(r);
  }
  if (calls.length) return { type: 'tool_calls', calls, raw: rawText };

  // ── 策略 3 (DOM 回退): 裸 "tool_call\n{ ... }"（支持多个） ──────────────
  //  当浏览器渲染器把围栏转成 <pre><code> 且重建失败时，DOM 文本可能形如:
  //    tool_call
  //    {
  //      "name": "write_file",
  //      "args": { ... }
  //    }
  const bareParts = text.split(/(?:^|\n)[ \t]*tool_call[ \t]*\r?\n/i);
  if (bareParts.length > 1) {
    for (let i = 1; i < bareParts.length; i++) {
      const value = extractLargestJsonValue(bareParts[i]);
      if (value) calls.push(...jsonValueToCalls(value, rawText));
    }
    if (calls.length) return { type: 'tool_calls', calls, raw: rawText };
  }

  // ── 策略 4: 文本中任意位置包含 "name" 键的 JSON（对象或数组） ──────────
  if (/["']?(?:name|tool|function)["']?\s*:\s*["'][\w_]+["']/.test(text)) {
    const value = extractLargestJsonValue(text);
    if (value) {
      const cs = jsonValueToCalls(value, rawText);
      if (cs.length) return { type: 'tool_calls', calls: cs, raw: rawText };
    }
  }

  // ── 策略 5: 代码块中的 Python 风格函数调用 ──────────────────
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
      return { type: 'tool_calls', calls: [{ name, args, raw: rawText }], raw: rawText };
    }
  }

  // ── 未检测到工具调用 — 最终文本回复 ───────────────────────────
  return { type: 'final', content: text, raw: rawText };
}

/**
 * 兼容旧接口: 只返回第一个工具调用。
 * 新的 Agent 循环请使用 parseToolCalls 以支持一次回复中的多个调用。
 */
function parseResponse(rawText) {
  const parsed = parseToolCalls(rawText);
  if (parsed.type === 'tool_calls') {
    const first = parsed.calls[0];
    return { type: 'tool_call', name: first.name, args: first.args, calls: parsed.calls, raw: parsed.raw };
  }
  return parsed;
}

// ─────────────────────────────────────────────
//  辅助函数
// ─────────────────────────────────────────────

/** 解析单个 XML/文本工具调用（名称 + JSON 参数） */
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

/**
 * 将一个代码块内容解析为工具调用列表。
 * 支持单个 JSON 对象、JSON 数组（多个调用）以及常见 JSON 修复。
 * @returns {{calls: Array, error: string|null}}
 */
function parsePayloadToCalls(payload, rawText) {
  const trimmed = String(payload).trim();
  if (!trimmed) return { calls: [], error: null };

  // 直接解析
  try {
    const value = JSON.parse(trimmed);
    const calls = jsonValueToCalls(value, rawText);
    if (calls.length) return { calls, error: null };
    return { calls: [], error: null };
  } catch (e) {
    // 尝试修复常见 JSON 问题
    const fixed = attemptJsonFix(trimmed);
    if (fixed !== null) {
      const calls = jsonValueToCalls(fixed, rawText);
      if (calls.length) return { calls, error: null };
      return { calls: [], error: null };
    }
    // 回退: 在代码块内扫描多个独立 JSON 对象/数组
    const scanned = collectJsonValues(trimmed)
      .flatMap(v => jsonValueToCalls(v, rawText));
    if (scanned.length) return { calls: scanned, error: null };
    return { calls: [], error: e.message };
  }
}

/**
 * 将一个已解析的 JSON 值转换为工具调用数组。
 * 支持单个对象、对象数组，以及 OpenAI 风格的 {type:"function",function:{...}}。
 */
function jsonValueToCalls(value, rawText) {
  if (Array.isArray(value)) {
    const out = [];
    for (const item of value) {
      const call = coerceToolCall(item, rawText);
      if (call) out.push(call);
    }
    return out;
  }
  const call = coerceToolCall(value, rawText);
  return call ? [call] : [];
}

/**
 * 判断一个对象是否为工具调用并规范化。
 * 返回 { name, args, raw } 或 null。
 */
function coerceToolCall(obj, rawText) {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return null;

  // OpenAI 风格: { type: "function", function: { name, arguments } }
  const src = (obj.function && typeof obj.function === 'object' && !Array.isArray(obj.function))
    ? obj.function
    : obj;

  let name = null;
  for (const key of ['name', 'tool', 'function']) {
    if (typeof src[key] === 'string' && src[key].trim()) { name = src[key].trim(); break; }
  }
  if (!name) return null;

  let args = {};
  let hasArgs = false;
  for (const key of ['args', 'arguments', 'parameters', 'input']) {
    if (src[key] !== undefined) { args = src[key]; hasArgs = true; break; }
  }

  // 防止误判: 若对象包含大量非工具字段且没有参数键，则不视为工具调用
  const toolKeys = new Set(['name', 'tool', 'function', 'args', 'arguments', 'parameters', 'input', 'id', 'type']);
  const onlyToolKeys = Object.keys(obj).every(k => toolKeys.has(k));
  if (!hasArgs && !onlyToolKeys) return null;

  // 参数为 JSON 字符串时尝试解析
  if (typeof args === 'string') {
    try { args = JSON.parse(args); } catch { /* 保留原始字符串 */ }
  }

  return { name, args: (args === undefined || args === null) ? {} : args, raw: rawText };
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
 * 从字符串中提取最大的有效 JSON 值（对象或数组）。
 * 使用括号计数方法而非正则表达式，以处理嵌套结构。
 */
function extractLargestJson(text, openChar, closeChar) {
  let best    = null;
  let bestLen = 0;

  for (let i = 0; i < text.length; i++) {
    if (text[i] !== openChar) continue;

    let depth  = 0;
    let inStr  = false;
    let escape = false;
    let end    = -1;

    for (let j = i; j < text.length; j++) {
      const ch = text[j];
      if (escape)               { escape = false; continue; }
      if (ch === '\\' && inStr) { escape = true; continue; }
      if (ch === '"')           { inStr = !inStr; continue; }
      if (inStr)                { continue; }
      if (ch === openChar)      { depth++; }
      else if (ch === closeChar) {
        depth--;
        if (depth === 0) { end = j; break; }
      }
    }

    if (end === -1) continue;
    const candidate = text.slice(i, end + 1);
    if (candidate.length <= bestLen) continue;

    let parsed = null;
    try { parsed = JSON.parse(candidate); }
    catch { parsed = attemptJsonFix(candidate); }

    if (parsed !== null && typeof parsed === 'object') {
      best    = parsed;
      bestLen = candidate.length;
    }
  }

  return best;
}

/** 提取最大的有效 JSON 值（优先对象，其次数组）。 */
function extractLargestJsonValue(text) {
  return extractLargestJson(text, '{', '}') || extractLargestJson(text, '[', ']');
}

/** 兼容旧名: 提取最大的有效 JSON 对象。 */
function extractLargestJsonObject(text) {
  return extractLargestJson(text, '{', '}');
}

/**
 * 扫描文本，收集其中所有顶层 JSON 对象/数组。
 * 用于同一代码块内出现多个独立 JSON 对象的情形。
 */
function collectJsonValues(text) {
  const values = [];
  let i = 0;

  while (i < text.length) {
    const ch = text[i];
    if (ch !== '{' && ch !== '[') { i++; continue; }

    const openChar  = ch;
    const closeChar = ch === '{' ? '}' : ']';
    let depth  = 0;
    let inStr  = false;
    let escape = false;
    let end    = -1;

    for (let j = i; j < text.length; j++) {
      const c = text[j];
      if (escape)               { escape = false; continue; }
      if (c === '\\' && inStr)  { escape = true; continue; }
      if (c === '"')            { inStr = !inStr; continue; }
      if (inStr)                { continue; }
      if (c === openChar)       { depth++; }
      else if (c === closeChar) {
        depth--;
        if (depth === 0) { end = j; break; }
      }
    }

    if (end === -1) { i++; continue; }

    const candidate = text.slice(i, end + 1);
    let parsed = null;
    try { parsed = JSON.parse(candidate); }
    catch { parsed = attemptJsonFix(candidate); }

    if (parsed !== null && typeof parsed === 'object') {
      values.push(parsed);
      i = end + 1;
    } else {
      i++;
    }
  }

  return values;
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
  parseToolCalls,
  parseResponse,
  formatToolResult,
  stripThinkingBlocks,
  isAskingQuestion,
};
