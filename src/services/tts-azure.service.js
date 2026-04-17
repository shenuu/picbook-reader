/**
 * @file services/tts-azure.service.js
 * @description 绘本朗读助手 - Azure Neural TTS 服务（英文专用）
 *
 * 职责：
 *  1. 将文本 POST 到 Azure TTS 云函数（tts-azure）
 *  2. 接收 Base64 MP3，写入本地文件系统
 *  3. 返回本地文件路径，供播放器使用
 *
 * 声音选择：
 *  - en-US-AnaNeural     儿童女声（绘本默认）
 *  - en-US-AvaMultilingualNeural  成人自然女声
 *  - en-US-GuyNeural     成人男声
 *
 * Azure Neural TTS 每月免费额度：50 万字符
 *
 * @author Jamie Park
 * @version 1.0.0
 */

const {
  TTS_AZURE_URL,
  AUDIO_STORAGE_DIR,
} = require('../config');

/** 本地音频文件存储目录 */
const AUDIO_DIR = `${wx.env.USER_DATA_PATH}/${AUDIO_STORAGE_DIR}`;

/** 请求超时（毫秒）— Azure Neural TTS 通常 1~3s，给足余量 */
const REQUEST_TIMEOUT_MS = 20000;

/** 最大重试次数 */
const MAX_RETRY = 2;

/** 重试基础延迟（毫秒） */
const RETRY_BASE_DELAY_MS = 500;

// ─────────────────────────────────────────────────────────────────
//  公开接口
// ─────────────────────────────────────────────────────────────────

/**
 * 用 Azure Neural TTS 合成英文文本
 *
 * @param {string} text                     - 待合成文字（英文）
 * @param {object} [options]
 * @param {string} [options.voiceName]      - Azure 声音名称（默认 en-US-AnaNeural）
 * @param {Function} [options.onProgress]   - 进度回调 (percent) => void
 * @param {Function} [options.onPlayStart]  - 合成完毕即将播放时回调
 * @returns {Promise<string>}               - 本地 MP3 文件路径
 */
async function synthesize(text, options = {}) {
  const { voiceName = 'en-US-AnaNeural', onProgress, onPlayStart } = options;

  let lastError;
  for (let attempt = 0; attempt <= MAX_RETRY; attempt++) {
    if (attempt > 0) {
      await _delay(RETRY_BASE_DELAY_MS * Math.pow(2, attempt - 1));
      console.info(`[TTS-Azure] 第 ${attempt} 次重试…`);
    }

    try {
      if (typeof onProgress === 'function') onProgress(10);

      const audioBase64 = await _callCloud(text, voiceName);

      if (typeof onProgress === 'function') onProgress(90);

      const localPath = await _writeAudioFile(audioBase64);

      if (typeof onProgress === 'function') onProgress(100);
      if (typeof onPlayStart === 'function') onPlayStart();

      return localPath;
    } catch (err) {
      lastError = err;
      console.warn(`[TTS-Azure] 第 ${attempt + 1} 次合成失败:`, err.message);
    }
  }

  throw new Error(`Azure TTS 合成失败（已重试 ${MAX_RETRY} 次）: ${lastError?.message}`);
}

// ─────────────────────────────────────────────────────────────────
//  内部实现
// ─────────────────────────────────────────────────────────────────

/**
 * 调用 Azure TTS 云函数
 *
 * @param {string} text
 * @param {string} voiceName
 * @returns {Promise<string>} Base64 MP3
 */
function _callCloud(text, voiceName) {
  return new Promise((resolve, reject) => {
    wx.request({
      url:     TTS_AZURE_URL,
      method:  'POST',
      timeout: REQUEST_TIMEOUT_MS,
      header:  { 'Content-Type': 'application/json' },
      data:    { text, voiceName },
      success: (res) => {
        if (res.statusCode !== 200) {
          reject(new Error(`Azure TTS 云函数 HTTP ${res.statusCode}`));
          return;
        }
        if (res.data?.code === 0 && res.data?.data?.audioBase64) {
          resolve(res.data.data.audioBase64);
        } else {
          reject(new Error('Azure TTS 云函数响应异常: ' + JSON.stringify(res.data)));
        }
      },
      fail: (err) => reject(new Error('Azure TTS 请求失败: ' + err.errMsg)),
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
    const fileName = `tts_az_${Date.now()}.mp3`;
    const filePath = `${AUDIO_DIR}/${fileName}`;

    try { fs.mkdirSync(AUDIO_DIR, true); } catch (_) { /* 目录已存在 */ }

    fs.writeFile({
      filePath,
      data:     base64,
      encoding: 'base64',
      success: () => {
        try {
          const stat = fs.statSync(filePath);
          console.info('[TTS-Azure] 音频文件写入成功:', filePath, '大小:', stat.size, 'bytes');
          if (stat.size < 100) {
            reject(new Error(`写入文件过小 (${stat.size}B)，可能不是有效 MP3`));
            return;
          }
        } catch (_) {}
        resolve(filePath);
      },
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
