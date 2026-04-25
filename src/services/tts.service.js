/**
 * @file services/tts.service.js
 * @description 绘本朗读助手 - TTS（文字转语音）服务
 *
 * 所有语种（中文、英文、混合）统一走腾讯云大模型 TTS 云函数。
 * 本模块负责：
 *  1. OCR 文本预处理（噪声清洗、字节截断）
 *  2. 语种检测（透传给调用方，用于显示徽章等）
 *  3. 委托 tts-tencent.service 完成合成 + 本地写文件
 *
 * @author Jamie Park
 * @version 2.0.0
 */

const { processForTts } = require('./text-processor.service');
const ttsTencentService = require('./tts-tencent.service');

// ─────────────────────────────────────────────────────────────────
//  公开接口
// ─────────────────────────────────────────────────────────────────

/**
 * 合成文字到本地 MP3 文件
 *
 * @param {string} text                      - 待合成的文字（≤ 8000 字节）
 * @param {object} [options]
 * @param {Function} [options.onProgress]    - 进度回调 (percent: number) => void
 * @param {Function} [options.onPlayStart]   - 合成完毕开始播放时回调，上层切换到 PLAYING 状态
 * @param {Function} [options.onLanguageDetected] - 语种检测结果回调
 * @returns {Promise<string>}                - 本地 MP3 文件路径
 *
 * @example
 *   const path = await ttsService.synthesize('床前明月光', {
 *     onProgress: p => console.log(p),
 *     onPlayStart: () => page.setData({ playStatus: 'playing' }),
 *   });
 */
async function synthesize(text, options = {}) {
  const { onProgress, onPlayStart } = options;

  // ── 文本预处理：OCR 噪声清洗 + 字节截断 ──
  const { processedText, language, truncated } = processForTts(text);
  if (truncated) {
    console.warn('[TTS] 文本超长已截断');
  }
  console.info(`[TTS] 语种检测: ${language.type}，英文占比 ${(language.englishRatio * 100).toFixed(0)}%`);

  // 把语种信息透传给调用方
  if (typeof options.onLanguageDetected === 'function') {
    options.onLanguageDetected(language);
  }

  // 所有语种统一走腾讯云大模型 TTS
  console.info('[TTS] → 腾讯云大模型 TTS');
  return ttsTencentService.synthesize(processedText, {
    languageType: language.type,
    onProgress,
    onPlayStart,
  });
}

/**
 * 取消当前正在进行的 TTS 合成
 * 腾讯云 TTS 使用 HTTP 请求，无法中途取消；此函数保留接口兼容性。
 */
function cancel() {
  console.info('[TTS] cancel() called — HTTP 请求无法中途取消，忽略');
}

// ─────────────────────────────────────────────────────────────────
//  模块导出
// ─────────────────────────────────────────────────────────────────

module.exports = {
  synthesize,
  cancel,
};
