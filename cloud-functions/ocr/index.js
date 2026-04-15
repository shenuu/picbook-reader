/**
 * @file cloud-functions/ocr/index.js
 * @description 腾讯云函数 - OCR 识字 BFF
 *
 * 功能：
 *  1. 接收小程序上传的图片 base64
 *  2. 调用腾讯云 GeneralBasicOCR（通用印刷体识别）
 *  3. 返回统一格式的识别结果
 *
 * 环境变量（在腾讯云函数控制台配置）：
 *  - TENCENT_SECRET_ID   腾讯云 SecretId
 *  - TENCENT_SECRET_KEY  腾讯云 SecretKey
 *  - TENCENT_OCR_REGION  OCR 服务地域，默认 ap-guangzhou
 *
 * 请求格式（POST body JSON）：
 *  { "imageBase64": "<纯 base64，不含 data:image 前缀>" }
 *
 * 响应格式：
 *  成功: { code: 0, data: { words: [...], fullText: "...", confidence: 98 } }
 *  失败: { code: <errCode>, message: "..." }
 *
 * @author Jamie Park
 * @version 1.0.0
 */

'use strict';

const https = require('https');
const crypto = require('crypto');

// ─────────────────────────────────────────────────────────────────
//  腾讯云 API 签名 v3（TC3-HMAC-SHA256）
// ─────────────────────────────────────────────────────────────────

const SERVICE   = 'ocr';
const HOST      = 'ocr.tencentcloudapi.com';
const REGION    = process.env.TENCENT_OCR_REGION || 'ap-guangzhou';
const ACTION    = 'GeneralBasicOCR';
const VERSION   = '2018-11-19';
const ALGORITHM = 'TC3-HMAC-SHA256';

/**
 * 生成腾讯云 API v3 签名
 * @see https://cloud.tencent.com/document/api/866/33518
 */
function _sign(secretId, secretKey, payload) {
  const timestamp   = Math.floor(Date.now() / 1000);
  const date        = new Date(timestamp * 1000).toISOString().slice(0, 10); // YYYY-MM-DD

  // Step 1: 构造规范请求
  const httpMethod        = 'POST';
  const canonicalUri      = '/';
  const canonicalQuery    = '';
  const canonicalHeaders  =
    `content-type:application/json; charset=utf-8\nhost:${HOST}\nx-tc-action:${ACTION.toLowerCase()}\n`;
  const signedHeaders     = 'content-type;host;x-tc-action';
  const hashedPayload     = crypto.createHash('sha256').update(payload).digest('hex');
  const canonicalRequest  = [
    httpMethod, canonicalUri, canonicalQuery,
    canonicalHeaders, signedHeaders, hashedPayload,
  ].join('\n');

  // Step 2: 构造待签字符串
  const credentialScope = `${date}/${SERVICE}/tc3_request`;
  const hashedCanonical = crypto.createHash('sha256').update(canonicalRequest).digest('hex');
  const stringToSign    = [ALGORITHM, timestamp, credentialScope, hashedCanonical].join('\n');

  // Step 3: 计算签名
  const secretDate    = crypto.createHmac('sha256', `TC3${secretKey}`).update(date).digest();
  const secretService = crypto.createHmac('sha256', secretDate).update(SERVICE).digest();
  const secretSigning = crypto.createHmac('sha256', secretService).update('tc3_request').digest();
  const signature     = crypto.createHmac('sha256', secretSigning).update(stringToSign).digest('hex');

  // Step 4: 构造 Authorization
  const authorization =
    `${ALGORITHM} Credential=${secretId}/${credentialScope}, ` +
    `SignedHeaders=${signedHeaders}, Signature=${signature}`;

  return { authorization, timestamp };
}

/**
 * 调用腾讯云 GeneralBasicOCR
 */
function _callTencentOCR(secretId, secretKey, imageBase64) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({ ImageBase64: imageBase64 });
    const { authorization, timestamp } = _sign(secretId, secretKey, body);

    const options = {
      hostname: HOST,
      path: '/',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json; charset=utf-8',
        'Host': HOST,
        'X-TC-Action': ACTION,
        'X-TC-Version': VERSION,
        'X-TC-Region': REGION,
        'X-TC-Timestamp': timestamp,
        'Authorization': authorization,
      },
    };

    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => {
        try {
          resolve({ statusCode: res.statusCode, data: JSON.parse(data) });
        } catch (e) {
          reject(new Error(`JSON parse failed: ${e.message}`));
        }
      });
    });

    req.on('error', (e) => reject(new Error(`Request failed: ${e.message}`)));
    req.setTimeout(8000, () => {
      req.destroy();
      reject(new Error('OCR request timeout'));
    });

    req.write(body);
    req.end();
  });
}

// ─────────────────────────────────────────────────────────────────
//  云函数入口
// ─────────────────────────────────────────────────────────────────

exports.main = async (event) => {
  const secretId  = process.env.TENCENT_SECRET_ID;
  const secretKey = process.env.TENCENT_SECRET_KEY;

  if (!secretId || !secretKey) {
    console.error('[ocr] 环境变量 TENCENT_SECRET_ID / TENCENT_SECRET_KEY 未配置');
    return _makeResponse(500, { code: -1, message: '服务配置错误，请联系管理员' });
  }

  // 解析请求体
  let body;
  try {
    body = typeof event.body === 'string' ? JSON.parse(event.body) : (event.body || event);
  } catch (e) {
    return _makeResponse(400, { code: 40001, message: '请求体 JSON 解析失败' });
  }

  const imageBase64 = body.imageBase64 || body.image;
  if (!imageBase64) {
    return _makeResponse(400, { code: 40201, message: '缺少 imageBase64 参数' });
  }

  // base64 大小校验（4MB 上限）
  const approxBytes = imageBase64.length * 0.75;
  if (approxBytes > 4 * 1024 * 1024) {
    return _makeResponse(400, { code: 40202, message: '图片超过 4MB 限制，请压缩后重试' });
  }

  try {
    const result = await _callTencentOCR(secretId, secretKey, imageBase64);

    if (result.statusCode !== 200) {
      console.error('[ocr] 腾讯云 API 返回非 200:', result.statusCode, result.data);
      return _makeResponse(502, { code: 50101, message: '腾讯云 OCR 接口调用失败' });
    }

    const resp = result.data.Response;

    // 腾讯云业务错误
    if (resp.Error) {
      console.error('[ocr] 腾讯云 OCR 业务错误:', resp.Error);
      return _makeResponse(200, {
        code: 50101,
        message: `OCR 错误: ${resp.Error.Message} (${resp.Error.Code})`,
      });
    }

    // 解析识别结果
    const detections = resp.TextDetections || [];
    const words = detections.map(item => ({
      text:       item.DetectedText,
      confidence: item.Confidence,
      polygon:    (item.Polygon || []).map(p => [p.X, p.Y]),
    }));

    const fullText = detections
      .map(item => item.DetectedText)
      .join('\n')
      .trim();

    const avgConfidence = words.length > 0
      ? Math.round(words.reduce((s, w) => s + w.confidence, 0) / words.length)
      : 0;

    console.info(`[ocr] 识别成功，共 ${words.length} 行，置信度 ${avgConfidence}`);

    return _makeResponse(200, {
      code: 0,
      data: { words, fullText, confidence: avgConfidence },
    });

  } catch (err) {
    console.error('[ocr] 内部错误:', err.message);
    const isTimeout = err.message.includes('timeout');
    return _makeResponse(502, {
      code: isTimeout ? 50102 : 50101,
      message: isTimeout ? 'OCR 请求超时，请重试' : `OCR 调用失败: ${err.message}`,
    });
  }
};

// ─────────────────────────────────────────────────────────────────
//  API 网关响应格式
// ─────────────────────────────────────────────────────────────────

function _makeResponse(statusCode, body) {
  return {
    statusCode,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Access-Control-Allow-Origin': 'https://servicewechat.com',
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
    },
    body: JSON.stringify(body),
    isBase64Encoded: false,
  };
}
