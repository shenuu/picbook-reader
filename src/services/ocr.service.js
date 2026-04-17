/**
 * @file services/ocr.service.js
 * @description 绘本朗读助手 - OCR 识别服务
 *
 * 职责：
 *  1. 将本地图片文件读取并编码为 Base64
 *  2. 调用 BFF /api/ocr 接口（BFF 再中转到腾讯云 GeneralBasicOCR）
 *  3. 2 次指数退避重试（500ms → 1000ms），超时 5 秒
 *  4. 返回结构化识别结果 { text, words }
 *
 * BFF 接口契约：
 *   POST /api/ocr
 *   Body: { imageBase64: string }
 *   Response: {
 *     code: 0,
 *     data: {
 *       text: string,              // 全文（换行符分隔）
 *       words: [{
 *         text: string,
 *         confidence: number,      // 0-100
 *         boundingBox: { x, y, w, h }  // 归一化坐标 0-1
 *       }]
 *     }
 *   }
 *
 * @author Jamie Park
 * @version 0.1.0
 */

const {
  OCR_URL,
  OCR_TIMEOUT_MS,
  OCR_MAX_RETRY,
  OCR_RETRY_BASE_DELAY_MS,
  OCR_MAX_FILE_BYTES,
  OCR_MIN_FILE_BYTES,
} = require('../config');

/**
 * 对图片文件进行 OCR 识别
 * 内部自动重试（最多 OCR_MAX_RETRY 次，指数退避）
 *
 * @param {string} filePath                 - 本地或临时图片路径
 * @param {object} [options]
 * @param {Function} [options.onProgress]   - 进度回调 (percent: number) => void，
 *                                            供 guide 页更新进度条
 * @returns {Promise<{ text: string, words: Array }>}
 *
 * @example
 *   const result = await ocrService.recognize('/tmp/xxx.jpg');
 *   console.log(result.text); // "床前明月光\n疑是地上霜"
 */
async function recognize(filePath, options = {}) {
  const { onProgress } = options;
  if (typeof onProgress === 'function') onProgress(5);

  // Step 0: 文件大小前置校验（避免超限 / 空文件浪费网络）
  await _validateFileSize(filePath);

  // Step 1: Base64 编码
  let imageBase64;
  try {
    imageBase64 = await _readFileAsBase64(filePath);
  } catch (err) {
    throw new Error('图片读取失败: ' + err.message);
  }

  if (typeof onProgress === 'function') onProgress(20);

  // Step 2: 带重试的 OCR 请求
  let lastError;
  for (let attempt = 0; attempt <= OCR_MAX_RETRY; attempt++) {
    if (attempt > 0) {
      // 指数退避：500ms → 1000ms
      await _delay(OCR_RETRY_BASE_DELAY_MS * Math.pow(2, attempt - 1));
      console.info(`[OCR] 第 ${attempt} 次重试…`);
    }
    try {
      const data = await _callOcrBFF(imageBase64);
      if (typeof onProgress === 'function') onProgress(100);
      return data;
    } catch (err) {
      lastError = err;
      console.warn(`[OCR] 第 ${attempt + 1} 次识别失败:`, err.message);
      // P1-7: 4xx 客户端错误（noRetry 标志）直接抛出，不再重试
      if (err.noRetry) {
        console.warn('[OCR] 客户端错误，跳过后续重试:', err.message);
        throw err;
      }
    }
  }

  throw new Error(`OCR 识别失败（已重试 ${OCR_MAX_RETRY} 次）: ${lastError?.message}`);
}

// ─────────────────────────────────────────────────────────────────
//  内部：文件大小校验
// ─────────────────────────────────────────────────────────────────

/**
 * 校验文件大小是否在允许范围内
 * 在 Base64 编码前执行，拦截空文件和超大文件
 *
 * @param {string} filePath - 本地文件路径
 * @returns {Promise<void>} - 校验通过则 resolve，否则 reject（带 noRetry 标志）
 * @throws {Error} 文件过小（< OCR_MIN_FILE_BYTES）或过大（> OCR_MAX_FILE_BYTES）
 * @private
 */
function _validateFileSize(filePath) {
  return new Promise((resolve, reject) => {
    wx.getFileInfo({
      filePath,
      success: (info) => {
        const size = info.size;
        if (size < OCR_MIN_FILE_BYTES) {
          const err = new Error(`图片文件过小（${size} 字节），请重新选择`);
          err.noRetry = true;
          return reject(err);
        }
        if (size > OCR_MAX_FILE_BYTES) {
          const maxMB = (OCR_MAX_FILE_BYTES / 1024 / 1024).toFixed(0);
          const err = new Error(`图片文件超过 ${maxMB}MB 限制，请压缩后重试`);
          err.noRetry = true;
          return reject(err);
        }
        resolve();
      },
      fail: (e) => {
        // 无法获取文件信息时继续（不阻断流程，由后续 readFile 兜底报错）
        console.warn('[OCR] 无法获取文件大小，跳过前置校验:', e.errMsg);
        resolve();
      },
    });
  });
}

// ─────────────────────────────────────────────────────────────────
//  内部：Base64 编码
// ─────────────────────────────────────────────────────────────────

/**
 * 将本地文件读取为 Base64 字符串（不含 data:image/xxx;base64, 前缀）
 *
 * @param {string} filePath - 本地文件路径（wx.env.USER_DATA_PATH 下，或 tmpXXX）
 * @returns {Promise<string>} - Base64 字符串
 * @private
 */
function _readFileAsBase64(filePath) {
  return new Promise((resolve, reject) => {
    wx.getFileSystemManager().readFile({
      filePath,
      encoding: 'base64',
      success: (res) => resolve(res.data),
      fail: (err) => reject(new Error('文件读取错误: ' + err.errMsg)),
    });
  });
}

// ─────────────────────────────────────────────────────────────────
//  内部：调用 BFF
// ─────────────────────────────────────────────────────────────────

/**
 * 发起 OCR 请求到 BFF，超时 OCR_TIMEOUT_MS
 *
 * @param {string} imageBase64 - 图片 Base64（无前缀）
 * @returns {Promise<{ text: string, words: Array }>}
 * @private
 */
function _callOcrBFF(imageBase64) {
  return new Promise((resolve, reject) => {
    // wx.request 没有内置 abort，用 timer + done 标志模拟超时
    let settled = false;
    const done = (result) => { if (!settled) { settled = true; resolve(result); } };
    const fail = (err)   => { if (!settled) { settled = true; reject(err); } };

    const timeoutTimer = setTimeout(() => {
      fail(new Error(`OCR 请求超时（${OCR_TIMEOUT_MS}ms）`));
    }, OCR_TIMEOUT_MS);

    wx.request({
      url: OCR_URL,
      method: 'POST',
      header: {
        'Content-Type': 'application/json',
      },
      data: { imageBase64 },
      timeout: OCR_TIMEOUT_MS,
      success: (res) => {
        clearTimeout(timeoutTimer);
        if (settled) return;

        if (res.statusCode !== 200) {
          const err = new Error(`HTTP ${res.statusCode}: ${JSON.stringify(res.data)}`);
          /**
           * P1-7: 4xx 客户端错误（如 400 Bad Request、413 Request Entity Too Large）
           * 是请求本身的问题，重试也不会成功，直接标记 noRetry 跳过重试逻辑
           */
          if (res.statusCode >= 400 && res.statusCode < 500) {
            err.noRetry = true;
          }
          fail(err);
          return;
        }

        const body = res.data;
        if (body?.code !== 0) {
          fail(new Error(`BFF OCR 错误 code=${body?.code}: ${body?.message}`));
          return;
        }

        const { fullText: text, words = [] } = body.data;

        if (!text || !text.trim()) {
          // 识别内容为空通常代表图片中没有文字，不触发重试
          fail(Object.assign(new Error('OCR 返回内容为空，请确认图片中有文字'), { noRetry: true }));
          return;
        }

        done({ text, words });
      },
      fail: (err) => {
        clearTimeout(timeoutTimer);
        fail(new Error('网络请求失败: ' + err.errMsg));
      },
    });
  });
}

// ─────────────────────────────────────────────────────────────────
//  工具
// ─────────────────────────────────────────────────────────────────

/**
 * 延迟工具
 * @param {number} ms
 * @returns {Promise<void>}
 * @private
 */
function _delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ─────────────────────────────────────────────────────────────────
//  模块导出
// ─────────────────────────────────────────────────────────────────

module.exports = {
  recognize,
};
