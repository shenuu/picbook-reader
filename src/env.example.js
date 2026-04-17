/**
 * @file src/env.example.js
 * @description 环境配置模板 — 复制为 src/env.js 并填入真实值
 *
 * 使用说明：
 *   cp src/env.example.js src/env.js
 *   编辑 src/env.js，将占位符替换为真实值
 *
 * 安全说明：
 *   - src/env.js 已加入 .gitignore，不会提交到代码仓库
 *   - 本文件（env.example.js）仅包含占位符，可以安全提交
 *   - 真实密钥（API_KEY / API_SECRET）只存储在云函数环境变量中，不在此文件
 *
 * @author Jamie Park
 * @version 1.1.0
 */

module.exports = {
  /**
   * OCR 云函数 URL（腾讯云函数 URL）
   * 在腾讯云函数控制台 → 函数管理 → 函数 URL 中查看
   * 示例：'https://1234567890-xxxxxxxxxx.ap-guangzhou.tencentscf.com'
   */
  OCR_URL: 'https://REPLACE_ME.ap-guangzhou.tencentscf.com',

  /**
   * TTS 签名云函数 URL（腾讯云函数 URL）
   * 示例：'https://1234567890-xxxxxxxxxx.ap-guangzhou.tencentscf.com'
   */
  TTS_SIGN_URL: 'https://REPLACE_ME.ap-guangzhou.tencentscf.com',

  /**
   * 讯飞 TTS 应用 ID（AppID，非密钥）
   * 在讯飞开放平台控制台 → 我的应用 → AppID 中查看
   * 示例：'a1b2c3d4'
   *
   * 注：API_KEY / API_SECRET 是敏感密钥，只配置在云函数环境变量中，此处不存放
   */
  TTS_APP_ID: 'REPLACE_ME',

  /**
   * 腾讯云 TTS 云函数 URL（英文/混合文本专用）
   * 在腾讯云函数控制台 → 函数管理 → 函数 URL 中查看
   * 示例：'https://1234567890-xxxxxxxxxx.ap-guangzhou.tencentscf.com'
   */
  TTS_TENCENT_URL: 'https://REPLACE_ME.ap-guangzhou.tencentscf.com',
};
