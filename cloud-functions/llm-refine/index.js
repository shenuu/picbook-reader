/**
 * @file cloud-functions/llm-refine/index.js
 * @description 腾讯云函数 - OCR 文字段落整理（混元大模型）
 *
 * 职责：接收 OCR 原始文字，调用腾讯混元大模型将断行/碎片化段落
 * 整理为自然、连贯的句子，供 TTS 朗读时停顿更流畅。
 *
 * 接口：hunyuan.tencentcloudapi.com / ChatCompletions
 * 版本：2023-09-01
 * 签名：TC3-HMAC-SHA256
 *
 * 环境变量：
 *  - TENCENT_SECRET_ID
 *  - TENCENT_SECRET_KEY
 *
 * 请求体：{ text: string }
 * 响应体：{ code: 0, data: { refinedText: string } }
 *         { code: -1, message: string }
 */

'use strict';

const crypto = require('crypto');
const https  = require('https');

// ─────────────────────────────────────────────────────────────────
//  常量
// ─────────────────────────────────────────────────────────────────

const HOST    = 'hunyuan.tencentcloudapi.com';
const SERVICE = 'hunyuan';
const VERSION = '2023-09-01';
const ACTION  = 'ChatCompletions';
const REGION  = 'ap-guangzhou';

const MODEL   = 'hunyuan-lite';   // 免费额度大，延迟低，足够段落整理任务
const MAX_INPUT_CHARS = 2000;     // 绘本单页文字极少超过此值

const SYSTEM_PROMPT =
  '你是一个绘本文字整理助手。' +
  '我会给你 OCR 识别出的绘本页面文字，可能存在以下问题：' +
  '①因扫描断行导致句子碎片化；' +
  '②OCR 噪声字符，如乱码、孤立符号（| \\ / _ ~ ` # @ 等）、无意义字母或数字片段。' +
  '请完成以下两件事：' +
  '1. 去除噪声字符和无意义片段，保留真实的绘本文字内容；' +
  '2. 将断行的句子整理成自然流畅的段落，保留原有标点。' +
  '不要翻译，不要解释，不要添加任何原文没有的内容。' +
  '只输出整理后的文字，不要输出任何其他内容。';

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

  const { text } = body;
  if (!text || !text.trim()) {
    return _resp(400, { code: -1, message: '参数错误：text 不能为空' });
  }

  const input = text.slice(0, MAX_INPUT_CHARS);

  try {
    const refinedText = await _callHunyuan({ secretId, secretKey, input });
    return _resp(200, { code: 0, data: { refinedText } });
  } catch (err) {
    console.error('[llm-refine] 整理失败:', err.message);
    return _resp(500, { code: -1, message: '整理失败: ' + err.message });
  }
};

// ─────────────────────────────────────────────────────────────────
//  混元 ChatCompletions 调用
// ─────────────────────────────────────────────────────────────────

async function _callHunyuan({ secretId, secretKey, input }) {
  const payload = JSON.stringify({
    Model: MODEL,
    Messages: [
      { Role: 'system', Content: SYSTEM_PROMPT },
      { Role: 'user',   Content: input },
    ],
    Stream: false,
  });

  const headers = _buildHeaders({ secretId, secretKey, payload });
  const resBody = await _post(HOST, '/', headers, payload);

  let parsed;
  try { parsed = JSON.parse(resBody); } catch (e) {
    throw new Error('响应解析失败: ' + resBody.slice(0, 200));
  }

  if (parsed.Response && parsed.Response.Error) {
    throw new Error(parsed.Response.Error.Code + ': ' + parsed.Response.Error.Message);
  }

  const content =
    parsed.Response &&
    parsed.Response.Choices &&
    parsed.Response.Choices[0] &&
    parsed.Response.Choices[0].Message &&
    parsed.Response.Choices[0].Message.Content;

  if (!content) {
    throw new Error('响应中无 Content: ' + JSON.stringify(parsed.Response));
  }

  return content.trim();
}

// ─────────────────────────────────────────────────────────────────
//  TC3-HMAC-SHA256 签名（与 tts-tencent/ocr 云函数完全相同的实现）
// ─────────────────────────────────────────────────────────────────

function _buildHeaders({ secretId, secretKey, payload }) {
  const timestamp = Math.floor(Date.now() / 1000);
  const date      = new Date(timestamp * 1000).toISOString().slice(0, 10);

  const algorithm   = 'TC3-HMAC-SHA256';
  const contentType = 'application/json; charset=utf-8';

  const canonicalHeaders = `content-type:${contentType}\nhost:${HOST}\n`;
  const signedHeaders    = 'content-type;host';

  const canonicalRequest = [
    'POST', '/', '',
    canonicalHeaders,
    signedHeaders,
    _sha256hex(payload),
  ].join('\n');

  const credentialScope = `${date}/${SERVICE}/tc3_request`;
  const stringToSign = [
    algorithm,
    String(timestamp),
    credentialScope,
    _sha256hex(canonicalRequest),
  ].join('\n');

  const secretDate    = _hmac(Buffer.from('TC3' + secretKey, 'utf8'), date);
  const secretService = _hmac(secretDate, SERVICE);
  const secretSigning = _hmac(secretService, 'tc3_request');
  const signature     = crypto.createHmac('sha256', secretSigning)
                               .update(stringToSign, 'utf8').digest('hex');

  const authorization =
    `${algorithm} Credential=${secretId}/${credentialScope}, ` +
    `SignedHeaders=${signedHeaders}, Signature=${signature}`;

  return {
    'Authorization':  authorization,
    'Content-Type':   contentType,
    'Host':           HOST,
    'X-TC-Action':    ACTION,
    'X-TC-Version':   VERSION,
    'X-TC-Timestamp': String(timestamp),
    'X-TC-Region':    REGION,
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
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Access-Control-Allow-Origin': '*',
    },
    body: JSON.stringify(body),
    isBase64Encoded: false,
  };
}
