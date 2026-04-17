/**
 * @file cloud-functions/tts-azure/index.js
 * @description 腾讯云函数 - Azure Neural TTS 合成服务（英文专用）
 *
 * 功能：
 *  1. 从环境变量读取 AZURE_SPEECH_KEY / AZURE_SPEECH_REGION（密钥不硬编码）
 *  2. 调用 Azure Cognitive Services TTS REST API
 *  3. 返回 Base64 编码的 MP3 音频给小程序端
 *
 * 环境变量（在腾讯云函数控制台配置）：
 *  - AZURE_SPEECH_KEY     Azure Speech 订阅密钥
 *  - AZURE_SPEECH_REGION  Azure 区域，例如 eastasia / eastus（默认 eastasia）
 *
 * Azure Neural TTS 免费额度：每月 50 万字符（Neural 声音）
 *
 * 推荐声音：
 *  - en-US-AnaNeural         儿童女声（绘本最佳）
 *  - en-US-AvaMultilingualNeural  自然成人女声
 *  - en-US-GuyNeural         成人男声
 *
 * 请求格式（POST body JSON）：
 *  { text: string, voiceName?: string }
 *
 * 响应格式：
 *  成功: { code: 0, data: { audioBase64: string, format: 'mp3' } }
 *  失败: { code: -1, message: string }
 *
 * @see https://learn.microsoft.com/azure/cognitive-services/speech-service/rest-text-to-speech
 * @author Jamie Park
 * @version 1.0.0
 */

'use strict';

const https = require('https');

// ─────────────────────────────────────────────────────────────────
//  常量
// ─────────────────────────────────────────────────────────────────

/** 默认声音：儿童女声，适合绘本 */
const DEFAULT_VOICE = 'en-US-AnaNeural';

/** 单次文本字符上限（Azure Neural TTS 每次请求建议 ≤ 1000 字符） */
const MAX_TEXT_LEN = 800;

// ─────────────────────────────────────────────────────────────────
//  云函数入口
// ─────────────────────────────────────────────────────────────────

exports.main = async (event, context) => {
  const speechKey    = process.env.AZURE_SPEECH_KEY;
  const speechRegion = process.env.AZURE_SPEECH_REGION || 'eastasia';

  if (!speechKey) {
    console.error('[tts-azure] 环境变量 AZURE_SPEECH_KEY 未配置');
    return _resp(500, { code: -1, message: '服务配置错误：缺少 AZURE_SPEECH_KEY' });
  }

  // 解析请求体：支持函数 URL 直接调用（event.body 是字符串）和直接事件对象
  let body = event;
  if (typeof event.body === 'string') {
    try { body = JSON.parse(event.body); } catch (_) { body = {}; }
  }

  const { text, voiceName = DEFAULT_VOICE } = body;

  if (!text || text.trim() === '') {
    return _resp(400, { code: -1, message: '参数错误：text 不能为空' });
  }

  // 截断超长文本
  const safeText = text.slice(0, MAX_TEXT_LEN);

  try {
    const audioBase64 = await _callAzureTts({ speechKey, speechRegion, text: safeText, voiceName });
    return _resp(200, { code: 0, data: { audioBase64, format: 'mp3' } });
  } catch (err) {
    console.error('[tts-azure] 合成失败:', err.message);
    return _resp(500, { code: -1, message: '合成失败: ' + err.message });
  }
};

// ─────────────────────────────────────────────────────────────────
//  Azure TTS 调用
// ─────────────────────────────────────────────────────────────────

/**
 * 调用 Azure Neural TTS REST API
 *
 * @param {object} params
 * @param {string} params.speechKey
 * @param {string} params.speechRegion
 * @param {string} params.text
 * @param {string} params.voiceName
 * @returns {Promise<string>} Base64 编码的 MP3 音频
 */
function _callAzureTts({ speechKey, speechRegion, text, voiceName }) {
  // SSML 请求体
  const ssml = `<speak version='1.0' xml:lang='en-US'>
  <voice name='${voiceName}'>
    <prosody rate='0%' pitch='0%'>${_escapeXml(text)}</prosody>
  </voice>
</speak>`;

  const ssmlBuf = Buffer.from(ssml, 'utf8');

  const options = {
    hostname: `${speechRegion}.tts.speech.microsoft.com`,
    path:     '/cognitiveservices/v1',
    method:   'POST',
    headers: {
      'Ocp-Apim-Subscription-Key': speechKey,
      'Content-Type':              'application/ssml+xml',
      'X-Microsoft-OutputFormat':  'audio-16khz-128kbitrate-mono-mp3',
      'User-Agent':                'picbook-reader',
      'Content-Length':            ssmlBuf.length,
    },
  };

  return new Promise((resolve, reject) => {
    const req = https.request(options, (res) => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => {
        if (res.statusCode === 200) {
          const audioBase64 = Buffer.concat(chunks).toString('base64');
          resolve(audioBase64);
        } else {
          const errBody = Buffer.concat(chunks).toString('utf8');
          reject(new Error(`Azure TTS HTTP ${res.statusCode}: ${errBody.slice(0, 200)}`));
        }
      });
    });
    req.on('error', reject);
    req.write(ssmlBuf);
    req.end();
  });
}

// ─────────────────────────────────────────────────────────────────
//  工具函数
// ─────────────────────────────────────────────────────────────────

/** XML 特殊字符转义（防止 SSML 注入） */
function _escapeXml(str) {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/** 统一响应格式（兼容腾讯云函数 URL 直接调用） */
function _resp(statusCode, body) {
  return {
    statusCode,
    headers: {
      'Content-Type':                'application/json; charset=utf-8',
      'Access-Control-Allow-Origin': '*',
    },
    body:            JSON.stringify(body),
    isBase64Encoded: false,
  };
}
