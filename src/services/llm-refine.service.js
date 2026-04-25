/**
 * @file src/services/llm-refine.service.js
 * @description OCR 文字段落整理服务
 *
 * 调用 llm-refine 云函数，将 OCR 断行碎片整理为自然段落。
 * 任何错误（网络、超时、云函数报错）均静默降级，返回原始文字，
 * 确保主流程不被 LLM 步骤阻断。
 *
 * 使用：
 *   const { refine } = require('./llm-refine.service');
 *   const refined = await refine(rawOcrText);  // 始终返回字符串
 */

'use strict';

const { LLM_REFINE_URL, LLM_REFINE_TIMEOUT_MS } = require('../config');

/**
 * 整理 OCR 文字段落。
 *
 * @param {string} text  OCR 原始文字
 * @returns {Promise<string>}  整理后文字；失败时原样返回 text
 */
async function refine(text) {
  if (!text || !text.trim()) return text;

  // 未配置 URL 时跳过（开发环境 / 未部署）
  if (!LLM_REFINE_URL) {
    console.info('[LLMRefine] LLM_REFINE_URL 未配置，跳过整理');
    return text;
  }

  try {
    const refined = await _callWithTimeout(text, LLM_REFINE_TIMEOUT_MS);
    console.info('[LLMRefine] 整理完成，原长:', text.length, '→ 新长:', refined.length);
    return refined;
  } catch (err) {
    // 任何错误静默降级，主流程不受影响
    console.warn('[LLMRefine] 整理失败，使用原始文字。原因:', err.message);
    return text;
  }
}

// ─────────────────────────────────────────────────────────────────
//  内部方法
// ─────────────────────────────────────────────────────────────────

function _callWithTimeout(text, timeoutMs) {
  return new Promise((resolve, reject) => {
    let settled = false;

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      reject(new Error(`LLM 整理超时（>${timeoutMs}ms）`));
    }, timeoutMs);

    wx.request({
      url: LLM_REFINE_URL,
      method: 'POST',
      data: { text },
      timeout: timeoutMs,
      success: (res) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);

        if (res.statusCode === 200 && res.data && res.data.code === 0) {
          resolve(res.data.data.refinedText || text);
        } else {
          const msg = (res.data && res.data.message) || `HTTP ${res.statusCode}`;
          reject(new Error(msg));
        }
      },
      fail: (err) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(new Error(err.errMsg || '请求失败'));
      },
    });
  });
}

module.exports = { refine };
