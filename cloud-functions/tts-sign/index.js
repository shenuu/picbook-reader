/**
 * @file cloud-functions/tts-sign/index.js
 * @description 腾讯云函数 - 讯飞 TTS WebSocket 签名生成服务
 *
 * 功能：
 *  1. 从环境变量读取 TTS_API_KEY / TTS_API_SECRET（密钥不硬编码，P0-1/P0-2 修复）
 *  2. 按讯飞 WebSocket 鉴权规范生成 HMAC-SHA256 签名
 *  3. 拼装完整的 wss:// URL 返回给小程序端
 *
 * 环境变量（在腾讯云函数控制台配置）：
 *  - TTS_API_KEY    讯飞开放平台 API Key
 *  - TTS_API_SECRET 讯飞开放平台 API Secret
 *  - TTS_APP_ID     讯飞应用 ID（可选，也可从前端传入）
 *
 * 讯飞 WebSocket 鉴权规范：
 *  - 参考: https://www.xfyun.cn/doc/tts/online_tts/API.html
 *  - date: RFC1123 格式 UTC 时间，如 "Mon, 14 Apr 2026 08:00:00 GMT"
 *  - signature_origin: "host: tts-api.xfyun.cn\ndate: {date}\nGET /v2/tts HTTP/1.1"
 *  - signature: base64(HMAC-SHA256(signature_origin, api_secret))
 *  - authorization_origin: 'api_key="{api_key}", algorithm="hmac-sha256", headers="host date request-line", signature="{signature}"'
 *  - authorization: base64(authorization_origin)
 *  - 最终 URL: wss://tts-api.xfyun.cn/v2/tts?authorization={authorization}&date={date}&host=tts-api.xfyun.cn
 *
 * 部署说明：
 *  1. 在腾讯云函数控制台创建云函数，选择 Node.js 16 运行时
 *  2. 上传本目录代码
 *  3. 在"环境变量"中配置 TTS_API_KEY、TTS_API_SECRET
 *  4. 绑定 API 网关触发器，路径配置为 GET /tts-sign
 *  5. 小程序合法域名白名单中添加网关域名
 *
 * 响应格式：
 *  成功: { code: 0, data: { wsUrl: "wss://tts-api.xfyun.cn/v2/tts?..." } }
 *  失败: { code: -1, message: "错误描述" }
 *
 * @author Jamie Park
 * @version 1.0.0
 */

'use strict';

const crypto = require('crypto');

// ─────────────────────────────────────────────────────────────────
//  常量
// ─────────────────────────────────────────────────────────────────

/** 讯飞 TTS WebSocket 主机名 */
const TTS_HOST = 'tts-api.xfyun.cn';

/** 讯飞 TTS WebSocket 路径 */
const TTS_PATH = '/v2/tts';

/** 签名算法名称（讯飞规范固定值） */
const ALGORITHM = 'hmac-sha256';

/** 鉴权头字段顺序（讯飞规范固定值） */
const HEADERS = 'host date request-line';

// ─────────────────────────────────────────────────────────────────
//  云函数入口
// ─────────────────────────────────────────────────────────────────

/**
 * 腾讯云函数主入口
 * 通过 API 网关触发，返回带签名的 wss URL
 *
 * @param {object} event   - 云函数事件（API 网关触发时包含 HTTP 请求信息）
 * @param {object} context - 云函数上下文（包含运行时信息）
 * @returns {Promise<object>} API 网关标准响应格式
 */
exports.main = async (event, context) => {
  // 从环境变量读取密钥（不能硬编码！密钥仅存在于云函数运行时环境中）
  const apiKey    = process.env.TTS_API_KEY;
  const apiSecret = process.env.TTS_API_SECRET;

  // 严格校验：密钥缺失时返回 500，避免生成无效签名
  if (!apiKey || !apiSecret) {
    console.error('[tts-sign] 环境变量 TTS_API_KEY / TTS_API_SECRET 未配置');
    return _makeResponse(500, {
      code: -1,
      message: '服务配置错误，请联系管理员',
    });
  }

  try {
    const wsUrl = _buildSignedWsUrl(apiKey, apiSecret);
    console.info('[tts-sign] 签名 URL 生成成功');

    return _makeResponse(200, {
      code: 0,
      data: { wsUrl },
    });
  } catch (err) {
    console.error('[tts-sign] 签名生成失败:', err.message);
    return _makeResponse(500, {
      code: -1,
      message: '签名生成失败: ' + err.message,
    });
  }
};

// ─────────────────────────────────────────────────────────────────
//  签名生成核心逻辑
// ─────────────────────────────────────────────────────────────────

/**
 * 生成带 HMAC-SHA256 签名的讯飞 TTS WebSocket URL
 *
 * 签名算法（参考讯飞官方文档）：
 *  1. 生成 RFC1123 格式的 UTC 时间戳
 *  2. 构造 signature_origin（三行拼接）
 *  3. HMAC-SHA256(signature_origin, apiSecret) → Base64 = signature
 *  4. 构造 authorization_origin 字符串
 *  5. Base64(authorization_origin) = authorization
 *  6. 拼装最终 URL
 *
 * @param {string} apiKey    - 讯飞 API Key
 * @param {string} apiSecret - 讯飞 API Secret
 * @returns {string}         - 完整的 wss:// URL（含签名参数）
 * @private
 */
function _buildSignedWsUrl(apiKey, apiSecret) {
  // Step 1: RFC1123 格式 UTC 时间戳（讯飞要求此格式）
  const date = new Date().toUTCString();

  // Step 2: 构造待签名字符串
  // 格式固定为：三行，分别是 host、date、请求行
  const signatureOrigin = [
    `host: ${TTS_HOST}`,
    `date: ${date}`,
    `GET ${TTS_PATH} HTTP/1.1`,
  ].join('\n');

  // Step 3: HMAC-SHA256 签名 → Base64
  const signature = crypto
    .createHmac('sha256', apiSecret)
    .update(signatureOrigin)
    .digest('base64');

  // Step 4: 构造 authorization_origin
  const authorizationOrigin = [
    `api_key="${apiKey}"`,
    `algorithm="${ALGORITHM}"`,
    `headers="${HEADERS}"`,
    `signature="${signature}"`,
  ].join(', ');

  // Step 5: Base64 编码 authorization_origin
  const authorization = Buffer.from(authorizationOrigin).toString('base64');

  // Step 6: 拼装最终 URL（query 参数需要 URL encode）
  const params = new URLSearchParams({
    authorization,
    date,
    host: TTS_HOST,
  });

  return `wss://${TTS_HOST}${TTS_PATH}?${params.toString()}`;
}

// ─────────────────────────────────────────────────────────────────
//  API 网关响应格式
// ─────────────────────────────────────────────────────────────────

/**
 * 构造腾讯云 API 网关标准响应对象
 * 腾讯云 API 网关要求返回此固定格式，statusCode 会被映射为 HTTP 状态码
 *
 * @param {number} statusCode - HTTP 状态码
 * @param {object} body       - 响应体（将被序列化为 JSON）
 * @returns {object}
 * @private
 */
function _makeResponse(statusCode, body) {
  return {
    statusCode,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      // 按需开启 CORS（若小程序通过 wx.request 直接调用可无需 CORS）
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, OPTIONS',
    },
    body: JSON.stringify(body),
    // 腾讯云 API 网关 isBase64Encoded 固定为 false
    isBase64Encoded: false,
  };
}
