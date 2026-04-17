/**
 * @file cloud-functions/tts-tencent/index.js
 * @description 腾讯云函数 - 大模型语音合成
 *
 * 接口：tts.tencentcloudapi.com / TextToVoice
 * 版本：2024-11-01（大模型版，需搭配 ModelType:1 + 大模型资源包）
 * 签名：TC3-HMAC-SHA256
 *
 * 环境变量：
 *  - TENCENT_SECRET_ID
 *  - TENCENT_SECRET_KEY
 */

'use strict';

const crypto = require('crypto');
const https  = require('https');

// ─────────────────────────────────────────────────────────────────
//  常量
// ─────────────────────────────────────────────────────────────────

const TTS_HOST    = 'tts.tencentcloudapi.com';
const TTS_SERVICE = 'tts';
const TTS_VERSION = '2019-08-23';   // TextToVoice 唯一有效版本
const TTS_ACTION  = 'TextToVoice';
const TTS_REGION  = 'ap-guangzhou';

// ─────────────────────────────────────────────────────────────────
//  云函数入口
// ─────────────────────────────────────────────────────────────────

exports.main = async (event, context) => {
  const secretId  = process.env.TENCENT_SECRET_ID;
  const secretKey = process.env.TENCENT_SECRET_KEY;

  if (!secretId || !secretKey) {
    return _resp(500, { code: -1, message: '服务配置错误：环境变量未配置' });
  }

  let body = event;
  if (typeof event.body === 'string') {
    try { body = JSON.parse(event.body); } catch (_) { body = {}; }
  }

  const { text, speed = 0, volume = 0 } = body;

  if (!text || !text.trim()) {
    return _resp(400, { code: -1, message: '参数错误：text 不能为空' });
  }

  try {
    const audioBase64 = await _callTTS({ secretId, secretKey, text: text.slice(0, 500), speed, volume });
    return _resp(200, { code: 0, data: { audioBase64, format: 'mp3' } });
  } catch (err) {
    console.error('[tts-tencent] 合成失败:', err.message);
    return _resp(500, { code: -1, message: '合成失败: ' + err.message });
  }
};

// ─────────────────────────────────────────────────────────────────
//  TTS 调用
// ─────────────────────────────────────────────────────────────────

async function _callTTS({ secretId, secretKey, text, speed, volume }) {
  const payload = JSON.stringify({
    Text:      text,
    SessionId: 'cf-' + Date.now(),
    // VoiceType 501004 = 月华（大模型音色女声），消耗"大模型音色免费资源包"
    // 大模型音色范围：501000-501009、601008-601014
    VoiceType: 501004,
    Codec:     'mp3',
    Speed:     speed,
    Volume:    volume,
    SampleRate: 16000,
  });

  const headers = _buildHeaders({ secretId, secretKey, payload });
  const resBody = await _post(TTS_HOST, '/', headers, payload);

  let parsed;
  try { parsed = JSON.parse(resBody); } catch (e) {
    throw new Error('响应解析失败: ' + resBody.slice(0, 200));
  }

  if (parsed.Response && parsed.Response.Error) {
    throw new Error(parsed.Response.Error.Code + ': ' + parsed.Response.Error.Message);
  }

  const audio = parsed.Response && parsed.Response.Audio;
  if (!audio) {
    throw new Error('响应中无 Audio 字段: ' + JSON.stringify(parsed.Response));
  }

  return audio;
}

// ─────────────────────────────────────────────────────────────────
//  TC3-HMAC-SHA256 签名
// ─────────────────────────────────────────────────────────────────

function _buildHeaders({ secretId, secretKey, payload }) {
  const timestamp = Math.floor(Date.now() / 1000);
  const date      = new Date(timestamp * 1000).toISOString().slice(0, 10); // YYYY-MM-DD UTC

  const algorithm  = 'TC3-HMAC-SHA256';
  const contentType = 'application/json; charset=utf-8';

  // CanonicalHeaders：key 小写，按 ASCII 升序，每行以 \n 结尾
  // content-type < host（升序），只签这两个
  const canonicalHeaders = `content-type:${contentType}\nhost:${TTS_HOST}\n`;
  const signedHeaders    = 'content-type;host';

  // 步骤 1：规范请求串
  const canonicalRequest = [
    'POST',
    '/',
    '',                           // CanonicalQueryString（POST 固定为空）
    canonicalHeaders,
    signedHeaders,
    _sha256hex(payload),
  ].join('\n');

  // 步骤 2：待签名字符串
  const credentialScope  = `${date}/${TTS_SERVICE}/tc3_request`;
  const stringToSign = [
    algorithm,
    String(timestamp),
    credentialScope,
    _sha256hex(canonicalRequest),
  ].join('\n');

  // 步骤 3：签名
  const secretDate    = _hmac(Buffer.from('TC3' + secretKey, 'utf8'), date);
  const secretService = _hmac(secretDate, TTS_SERVICE);
  const secretSigning = _hmac(secretService, 'tc3_request');
  const signature     = crypto.createHmac('sha256', secretSigning)
                               .update(stringToSign, 'utf8').digest('hex');

  // 步骤 4：Authorization
  const authorization =
    `${algorithm} Credential=${secretId}/${credentialScope}, ` +
    `SignedHeaders=${signedHeaders}, Signature=${signature}`;

  return {
    'Authorization':  authorization,
    'Content-Type':   contentType,
    'Host':           TTS_HOST,
    'X-TC-Action':    TTS_ACTION,
    'X-TC-Version':   TTS_VERSION,
    'X-TC-Timestamp': String(timestamp),
    'X-TC-Region':    TTS_REGION,
  };
}

function _sha256hex(str) {
  return crypto.createHash('sha256').update(str, 'utf8').digest('hex');
}

function _hmac(key, data) {
  return crypto.createHmac('sha256', key).update(data, 'utf8').digest();
}

// ─────────────────────────────────────────────────────────────────
//  HTTPS
// ─────────────────────────────────────────────────────────────────

function _post(host, path, headers, body) {
  return new Promise((resolve, reject) => {
    const req = https.request({ hostname: host, path, method: 'POST', headers }, (res) => {
      let data = '';
      res.on('data', c => { data += c; });
      res.on('end', () => resolve(data));
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

// ─────────────────────────────────────────────────────────────────
//  响应格式
// ─────────────────────────────────────────────────────────────────

function _resp(statusCode, body) {
  return {
    statusCode,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Access-Control-Allow-Origin': '*' },
    body: JSON.stringify(body),
    isBase64Encoded: false,
  };
}
