/**
 * 本地测试脚本 - 验证 OCR 云函数可以正常调用腾讯云 GeneralBasicOCR
 * 用法：
 *   TENCENT_SECRET_ID=xxx TENCENT_SECRET_KEY=xxx node test-local.js
 *   或：node test-local.js（从 .env.test 读取）
 */

'use strict';

const path = require('path');
const fs   = require('fs');

// 尝试从同目录 .env.test 加载凭证
const envFile = path.join(__dirname, '.env.test');
if (fs.existsSync(envFile)) {
  fs.readFileSync(envFile, 'utf8')
    .split('\n')
    .forEach(line => {
      const [k, ...v] = line.trim().split('=');
      if (k && v.length) process.env[k] = v.join('=');
    });
}

const { main } = require('./index.js');

// 用一张极小的测试图（1x1 白色 PNG 的 base64，仅测试网络联通性）
// 如需真实识字，换成真实绘本图片的 base64
const TINY_PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';

async function run() {
  console.log('=== OCR 云函数本地测试 ===');
  console.log('SecretId:', process.env.TENCENT_SECRET_ID ? '✓ 已配置' : '✗ 未配置');
  console.log('SecretKey:', process.env.TENCENT_SECRET_KEY ? '✓ 已配置' : '✗ 未配置');
  console.log('Region:', process.env.TENCENT_OCR_REGION || 'ap-guangzhou (默认)');
  console.log('');

  // 模拟 API 网关 event
  const event = {
    body: JSON.stringify({ imageBase64: TINY_PNG_BASE64 }),
  };

  console.log('调用中...');
  const start = Date.now();

  try {
    const result = await main(event);
    const elapsed = Date.now() - start;

    console.log(`耗时: ${elapsed}ms`);
    console.log('HTTP 状态码:', result.statusCode);

    const body = JSON.parse(result.body);
    console.log('响应 body:', JSON.stringify(body, null, 2));

    if (result.statusCode === 200 && body.code === 0) {
      console.log('\n✅ OCR 调用成功！');
      console.log('识别文字数:', body.data.words.length);
      console.log('fullText:', body.data.fullText || '(空白图片，无文字)');
    } else if (result.statusCode === 200 && body.code !== 0) {
      console.log('\n⚠️  API 连通，但 OCR 返回业务错误（可能是空白图片）');
      console.log('错误信息:', body.message);
    } else {
      console.log('\n❌ 调用失败，请检查凭证和网络');
    }
  } catch (e) {
    console.error('\n❌ 异常:', e.message);
  }
}

run();
