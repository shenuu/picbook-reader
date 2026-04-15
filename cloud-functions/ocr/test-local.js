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

// ─────────────────────────────────────────────────────────────────
//  输入校验单元测试（离线，不需要真实凭证）
// ─────────────────────────────────────────────────────────────────

async function runValidationTests() {
  console.log('\n=== 输入校验单元测试（离线）===');
  let passed = 0;
  let failed = 0;

  async function assert(desc, event, expectCode, expectStatus) {
    const result = await main(event);
    const body = JSON.parse(result.body);
    if (result.statusCode === expectStatus && body.code === expectCode) {
      console.log(`  ✅ ${desc}`);
      passed++;
    } else {
      console.log(`  ❌ ${desc}`);
      console.log(`     期望 HTTP ${expectStatus} code=${expectCode}`);
      console.log(`     实际 HTTP ${result.statusCode} code=${body.code}: ${body.message}`);
      failed++;
    }
  }

  // 缺少 imageBase64
  await assert(
    '缺少 imageBase64 → 400 code=40201',
    { body: JSON.stringify({}) },
    40201, 400,
  );

  // 空文件（< 100B）
  await assert(
    '图片过小（< 100B）→ 400 code=40203',
    { body: JSON.stringify({ imageBase64: 'aGVsbG8=' }) }, // "hello"
    40203, 400,
  );

  // 超大文件（模拟 > 4MB base64）
  const bigBase64 = 'A'.repeat(Math.ceil(4 * 1024 * 1024 / 0.75) + 10);
  await assert(
    '图片过大（> 4MB）→ 400 code=40202',
    { body: JSON.stringify({ imageBase64: bigBase64 }) },
    40202, 400,
  );

  // 非图片（纯文本内容）
  const textBase64 = Buffer.from('这不是图片，只是文字内容'.repeat(20)).toString('base64');
  await assert(
    '非图片格式（文本 base64）→ 400 code=40204',
    { body: JSON.stringify({ imageBase64: textBase64 }) },
    40204, 400,
  );

  // 合法 PNG（magic bytes 正确）
  await assert(
    '合法 PNG → 跳过格式校验（进入签名流程）',
    { body: JSON.stringify({ imageBase64: TINY_PNG_BASE64 }) },
    // 无凭证时返回 500，说明格式校验通过，进入了业务逻辑
    -1, 500,
  );

  console.log(`\n校验测试结果：${passed} 通过 / ${failed} 失败`);
}

run().then(() => runValidationTests());
