/**
 * @file services/ocr.service.js
 * @description 绘本朗读助手 - OCR 识别服务
 *
 * 职责：
 *  1. 将压缩后的图片上传到 BFF /api/ocr 接口，获取识别文字
 *  2. 请求超时控制（默认 5 秒）
 *  3. 失败自动重试（最多 2 次，指数退避：1s / 2s）
 *  4. 支持外部传入进度回调（上传进度百分比）
 *  5. 支持手动取消请求（abort）
 *
 * 接口约定（BFF /api/ocr）：
 *  - Method: POST multipart/form-data
 *  - Field:  image (binary)
 *  - 响应:   { code: 0, data: { text: string }, msg: string }
 *
 * @author Jamie Park
 * @version 0.1.0
 */

/** BFF 接口基础路径，从小程序全局配置中读取 */
const BASE_URL = getApp().globalData?.bffBaseUrl || 'https://api.example.com';

/** OCR 接口超时时间（毫秒） */
const OCR_TIMEOUT_MS = 5000;

/** 最大重试次数 */
const MAX_RETRY = 2;

/** 指数退避基础时间（毫秒） */
const RETRY_BASE_DELAY_MS = 1000;

// ─────────────────────────────────────────────────────────────────
//  公开接口
// ─────────────────────────────────────────────────────────────────

/**
 * 识别图片中的文字
 *
 * @param {string} imagePath          - 本地图片路径（压缩后）
 * @param {object} [options]
 * @param {Function} [options.onProgress] - 上传进度回调 (percent: number) => void
 * @returns {Promise<{ text: string }>}   - OCR 结果
 *
 * @example
 *   const { text } = await ocrService.recognize('/tmp/img.jpg');
 */
async function recognize(imagePath, options = {}) {
  const { onProgress } = options;

  let lastError;
  for (let attempt = 0; attempt <= MAX_RETRY; attempt++) {
    if (attempt > 0) {
      // 指数退避等待
      await _delay(RETRY_BASE_DELAY_MS * Math.pow(2, attempt - 1));
      console.info(`[OCR] 第 ${attempt} 次重试...`);
    }
    try {
      const result = await _uploadWithTimeout(imagePath, onProgress);
      return result;
    } catch (err) {
      lastError = err;
      console.warn(`[OCR] 第 ${attempt + 1} 次请求失败:`, err.message);
    }
  }

  // 所有重试用尽
  throw new Error(`OCR 识别失败（已重试 ${MAX_RETRY} 次）: ${lastError?.message}`);
}

// ─────────────────────────────────────────────────────────────────
//  内部实现
// ─────────────────────────────────────────────────────────────────

/**
 * 带超时控制的图片上传请求
 * 使用 wx.uploadFile + Promise.race 实现超时竞争
 *
 * @param {string} imagePath
 * @param {Function|undefined} onProgress
 * @returns {Promise<{ text: string }>}
 * @private
 */
function _uploadWithTimeout(imagePath, onProgress) {
  return Promise.race([
    _doUpload(imagePath, onProgress),
    _timeoutPromise(OCR_TIMEOUT_MS),
  ]);
}

/**
 * 执行实际的 wx.uploadFile 上传
 *
 * @param {string} imagePath
 * @param {Function|undefined} onProgress
 * @returns {Promise<{ text: string }>}
 * @private
 */
function _doUpload(imagePath, onProgress) {
  return new Promise((resolve, reject) => {
    // TODO: 从 getApp().globalData 或 storage 读取 authToken 并附加到 header
    const uploadTask = wx.uploadFile({
      url: `${BASE_URL}/api/ocr`,
      filePath: imagePath,
      name: 'image',
      header: {
        // 'Authorization': `Bearer ${token}`,
        // 'X-App-Version': '1.0.0',
      },
      formData: {
        // TODO: 可附加额外参数，如 lang: 'zh-CN'
      },
      success: (res) => {
        try {
          // wx.uploadFile 的 data 是字符串，需手动 parse
          const body = JSON.parse(res.data);
          if (body.code !== 0) {
            reject(new Error(body.msg || 'OCR 服务错误'));
            return;
          }
          resolve({ text: body.data.text });
        } catch (parseErr) {
          reject(new Error('OCR 响应解析失败: ' + parseErr.message));
        }
      },
      fail: (err) => {
        reject(new Error('上传失败: ' + err.errMsg));
      },
    });

    // 监听上传进度
    if (typeof onProgress === 'function') {
      uploadTask.onProgressUpdate((progressEvent) => {
        // progressEvent.progress: 0-100
        // 上传阶段占整体进度的 10-80%，留头尾给压缩和解析
        const mapped = 10 + Math.floor(progressEvent.progress * 0.7);
        onProgress(mapped);
      });
    }
  });
}

/**
 * 生成一个在指定毫秒后 reject 的 Promise（用于超时竞争）
 * @param {number} ms
 * @returns {Promise<never>}
 * @private
 */
function _timeoutPromise(ms) {
  return new Promise((_, reject) =>
    setTimeout(() => reject(new Error(`OCR 请求超时（${ms}ms）`)), ms)
  );
}

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
