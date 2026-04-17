/**
 * @file services/tts-tencent.service.js
 * @description 绘本朗读助手 - 腾讯云 TTS 服务（英文/混合文本专用）
 *
 * 职责：
 *  1. 将文本 POST 到腾讯云 TTS 云函数（tts-tencent）
 *  2. 接收 Base64 MP3，写入本地文件系统
 *  3. 返回本地文件路径，供播放器使用
 *
 * 语种路由策略：
 *  - english → voiceType=101051（英文女声）
 *  - mixed   → voiceType=101010（中英双语女声）
 *
 * 腾讯云 TTS 单次上限：150 字符（标准音质）
 * 若文本超长，云函数侧已截断处理。
 *
 * @author Jamie Park
 * @version 1.0.0
 */

const {
  TTS_TENCENT_URL,
  AUDIO_STORAGE_DIR,
} = require('../config');

/** 本地音频文件存储目录 */
const AUDIO_DIR = `${wx.env.USER_DATA_PATH}/${AUDIO_STORAGE_DIR}`;

/** 请求超时（毫秒） */
const REQUEST_TIMEOUT_MS = 15000;

/** 最大重试次数 */
const MAX_RETRY = 2;

/** 重试基础延迟（毫秒） */
const RETRY_BASE_DELAY_MS = 500;

// ─────────────────────────────────────────────────────────────────
//  公开接口
// ─────────────────────────────────────────────────────────────────

/**
 * 用腾讯云 TTS 合成文本（英文/混合专用）
 *
 * @param {string} text                     - 待合成文字
 * @param {object} [options]
 * @param {string} [options.languageType]   - 'english' | 'mixed'（默认 'english'）
 * @param {Function} [options.onProgress]   - 进度回调 (percent) => void
 * @param {Function} [options.onPlayStart]  - 合成完毕即将播放时回调
 * @returns {Promise<string>}               - 本地 MP3 文件路径
 */
async function synthesize(text, options = {}) {
  const { languageType = 'english', onProgress, onPlayStart } = options;

  let lastError;
  for (let attempt = 0; attempt <= MAX_RETRY; attempt++) {
    if (attempt > 0) {
      await _delay(RETRY_BASE_DELAY_MS * Math.pow(2, attempt - 1));
      console.info(`[TTS-Tencent] 第 ${attempt} 次重试…`);
    }

    try {
      if (typeof onProgress === 'function') onProgress(10);

      const audioBase64 = await _callCloud(text, languageType);

      if (typeof onProgress === 'function') onProgress(90);

      const localPath = await _writeAudioFile(audioBase64);

      if (typeof onProgress === 'function') onProgress(100);
      if (typeof onPlayStart === 'function') onPlayStart();

      return localPath;
    } catch (err) {
      lastError = err;
      console.warn(`[TTS-Tencent] 第 ${attempt + 1} 次合成失败:`, err.message);
    }
  }

  throw new Error(`腾讯云 TTS 合成失败（已重试 ${MAX_RETRY} 次）: ${lastError?.message}`);
}

// ─────────────────────────────────────────────────────────────────
//  内部实现
// ─────────────────────────────────────────────────────────────────

/**
 * 调用腾讯云 TTS 云函数
 *
 * @param {string} text
 * @param {string} languageType
 * @returns {Promise<string>} Base64 MP3
 */
function _callCloud(text, languageType) {
  return new Promise((resolve, reject) => {
    wx.request({
      url: TTS_TENCENT_URL,
      method: 'POST',
      timeout: REQUEST_TIMEOUT_MS,
      header: { 'Content-Type': 'application/json' },
      data: { text, languageType },
      success: (res) => {
        if (res.statusCode !== 200) {
          reject(new Error(`腾讯 TTS 云函数 HTTP ${res.statusCode}`));
          return;
        }
        if (res.data?.code === 0 && res.data?.data?.audioBase64) {
          resolve(res.data.data.audioBase64);
        } else {
          reject(new Error('腾讯 TTS 云函数响应异常: ' + JSON.stringify(res.data)));
        }
      },
      fail: (err) => reject(new Error('腾讯 TTS 请求失败: ' + err.errMsg)),
    });
  });
}

/**
 * 将 Base64 MP3 写入本地文件
 *
 * @param {string} base64
 * @returns {Promise<string>} 本地文件路径
 */
function _writeAudioFile(base64) {
  return new Promise((resolve, reject) => {
    const fs       = wx.getFileSystemManager();
    const fileName = `tts_tc_${Date.now()}.mp3`;
    const filePath = `${AUDIO_DIR}/${fileName}`;

    // 确保目录存在
    try {
      fs.mkdirSync(AUDIO_DIR, true);
    } catch (_) { /* 目录已存在，忽略 */ }

    fs.writeFile({
      filePath,
      data: base64,
      encoding: 'base64',
      success: () => resolve(filePath),
      fail: (err) => reject(new Error('写入音频文件失败: ' + JSON.stringify(err))),
    });
  });
}

function _delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// ─────────────────────────────────────────────────────────────────
//  模块导出
// ─────────────────────────────────────────────────────────────────

module.exports = { synthesize };
