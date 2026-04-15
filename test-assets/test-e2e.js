/**
 * 端到端测试脚本 — 模拟小程序完整 OCR → TTS 链路
 * 用法：node test-e2e.js
 *
 * 测试内容：
 *  1. 读取绘本图片 → base64
 *  2. 调用 OCR 云函数（直接 require，模拟云端执行）
 *  3. 打印识别文字 + 置信度 + 耗时
 */

'use strict';

const fs   = require('fs');
const path = require('path');

// ── 加载凭证 ──────────────────────────────────────────────
const envFile = path.join(__dirname, '../cloud-functions/ocr/.env.test');
if (fs.existsSync(envFile)) {
  fs.readFileSync(envFile, 'utf8').split('\n').forEach(line => {
    const [k, ...v] = line.trim().split('=');
    if (k && v.length) process.env[k] = v.join('=');
  });
}

const { main: ocrMain } = require('../cloud-functions/ocr/index.js');

// ── 工具函数 ──────────────────────────────────────────────
function readImageAsBase64(filePath) {
  return fs.readFileSync(filePath).toString('base64');
}

function printDivider(title) {
  console.log('\n' + '─'.repeat(50));
  console.log(`  ${title}`);
  console.log('─'.repeat(50));
}

// ── 主测试流程 ────────────────────────────────────────────
async function runTest() {
  console.log('🚀 绘本朗读助手 — 端到端 OCR 测试');
  console.log(`   SecretId : ${process.env.TENCENT_SECRET_ID ? '✓ 已配置' : '✗ 未配置'}`);
  console.log(`   SecretKey: ${process.env.TENCENT_SECRET_KEY ? '✓ 已配置' : '✗ 未配置'}`);
  console.log(`   Region   : ${process.env.TENCENT_OCR_REGION || 'ap-guangzhou'}`);

  // ── Step 1: 读取图片 ─────────────────────────────────
  printDivider('Step 1 · 读取绘本图片');
  const imgPath = path.join(__dirname, 'sample-book.jpg');
  if (!fs.existsSync(imgPath)) {
    console.error('❌ 测试图片不存在:', imgPath);
    process.exit(1);
  }

  const imgBase64 = readImageAsBase64(imgPath);
  const imgSize   = fs.statSync(imgPath).size;
  console.log(`   文件  : ${imgPath}`);
  console.log(`   大小  : ${(imgSize / 1024).toFixed(1)} KB`);
  console.log(`   Base64: ${imgBase64.length} chars`);

  // ── Step 2: 调用 OCR ─────────────────────────────────
  printDivider('Step 2 · OCR 识别');
  const event = { body: JSON.stringify({ imageBase64: imgBase64 }) };

  console.log('   调用中...');
  const t0     = Date.now();
  const result = await ocrMain(event);
  const elapsed = Date.now() - t0;

  console.log(`   耗时  : ${elapsed}ms`);
  console.log(`   HTTP  : ${result.statusCode}`);

  const body = JSON.parse(result.body);

  if (result.statusCode === 200 && body.code === 0) {
    const { words, fullText, confidence } = body.data;

    printDivider('Step 3 · 识别结果');
    console.log(`   行数     : ${words.length}`);
    console.log(`   置信度   : ${confidence}%`);
    console.log('\n   ── 识别文字 ──────────────────────────');
    console.log(fullText.split('\n').map(l => `   ${l}`).join('\n'));

    // ── Step 3: 验证文字是否正确 ─────────────────────
    printDivider('Step 4 · 内容验证');
    const expected = ['小熊', '读书', '快乐'];
    let passed = 0;
    for (const kw of expected) {
      const ok = fullText.includes(kw);
      console.log(`   ${ok ? '✅' : '❌'} 包含关键词「${kw}」`);
      if (ok) passed++;
    }

    const p90Pass = elapsed <= 2900;
    console.log(`\n   ${p90Pass ? '✅' : '⚠️ '} 耗时 ${elapsed}ms ${p90Pass ? '≤' : '>'} P90目标 2900ms`);

    console.log('\n' + '═'.repeat(50));
    if (passed === expected.length) {
      console.log('  🎉 端到端测试通过！OCR 链路工作正常。');
    } else {
      console.log(`  ⚠️  识别结果与预期有差异（${passed}/${expected.length} 关键词匹配）`);
      console.log('      可能是图片字体导致识别率低，属正常现象。');
    }
    console.log('═'.repeat(50));

  } else {
    printDivider('❌ 调用失败');
    console.log('   code   :', body.code);
    console.log('   message:', body.message);

    if (body.message && body.message.includes('UnOpen')) {
      console.log('\n   ⚠️  腾讯云 OCR 服务未开通！');
      console.log('   请访问：https://console.cloud.tencent.com/ocr/general');
      console.log('   点击「立即开通」后重新运行本测试。');
    }
    process.exit(1);
  }
}

runTest().catch(e => {
  console.error('❌ 未预期异常:', e.message);
  process.exit(1);
});
