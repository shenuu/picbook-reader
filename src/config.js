/**
 * @file src/config.js
 * @description 绘本朗读助手 - 全局配置常量
 *
 * 在此统一管理 BFF 地址、超时时间、缓存容量等参数。
 * 修改时只需改动本文件，无需在各 service 中查找分散的魔术数字。
 *
 * 安全说明：
 *  - TTS_CONFIG 中不再存放 API_KEY / API_SECRET，密钥由云函数通过环境变量管理
 *  - 小程序端只保留 APP_ID（非敏感信息），签名流程完全在 BFF/云函数侧完成
 *  - BFF_BASE_URL 和 TTS_APP_ID 从 env.js 读取，该文件已加入 .gitignore
 *  - 初始化：cp src/env.example.js src/env.js 并填写真实值
 *
 * @author Jamie Park
 * @version 0.3.0
 */

// ─────────────────────────────────────────────────────────────────
//  环境配置注入
//  BFF_BASE_URL / TTS_APP_ID 从 env.js 读取，env.js 已加入 .gitignore
//  新成员初始化：cp src/env.example.js src/env.js
// ─────────────────────────────────────────────────────────────────

const ENV = require('./env');

// ─────────────────────────────────────────────────────────────────
//  环境端点配置
//  根据编译环境自动切换；修改端点只需编辑 src/env.js，无需改动本文件。
// ─────────────────────────────────────────────────────────────────

/** OCR 云函数直接 URL（腾讯云函数 URL） */
const OCR_BASE_URL = ENV.OCR_URL;

/** TTS 签名云函数直接 URL（腾讯云函数 URL） */
const TTS_SIGN_BASE_URL = ENV.TTS_SIGN_URL;

/** 腾讯云 TTS 云函数直接 URL（英文/混合专用） */
const TTS_TENCENT_BASE_URL = ENV.TTS_TENCENT_URL;

/** Azure Neural TTS 云函数直接 URL（英文专用） */
const TTS_AZURE_BASE_URL = ENV.TTS_AZURE_URL || '';

/** LLM 段落整理云函数 URL */
const LLM_REFINE_BASE_URL = ENV.LLM_REFINE_URL || '';

// ─────────────────────────────────────────────────────────────────
//  TTS 配置（P0-1 安全修复：移除硬编码密钥）
// ─────────────────────────────────────────────────────────────────

/**
 * 讯飞 TTS 应用 ID（非敏感，仅用于标识应用，可放前端）
 * 从 env.js 读取，统一由环境配置文件管理
 * API_KEY / API_SECRET 已迁移至 BFF 云函数环境变量，不在此文件
 */
const TTS_APP_ID = ENV.TTS_APP_ID;

/**
 * BFF 签名端点：小程序调用此接口获取带 HMAC-SHA256 签名的 wss URL
 * 云函数 tts-sign 负责生成签名，密钥通过 process.env 注入
 */
const TTS_WS_SIGN_URL = TTS_SIGN_BASE_URL;

/** 腾讯云 TTS 云函数 URL（英文/混合文本专用） */
const TTS_TENCENT_URL = TTS_TENCENT_BASE_URL;

/** Azure Neural TTS 云函数 URL（英文专用） */
const TTS_AZURE_URL = TTS_AZURE_BASE_URL;

/** LLM 段落整理云函数 URL */
const LLM_REFINE_URL = LLM_REFINE_BASE_URL;

// ─────────────────────────────────────────────────────────────────
//  LLM 段落整理配置
// ─────────────────────────────────────────────────────────────────

/** LLM 整理请求超时（毫秒）。超时后静默降级，使用原始 OCR 文字 */
const LLM_REFINE_TIMEOUT_MS = 8000;

/** OCR 请求完整 URL */
const OCR_URL = OCR_BASE_URL;

// ─────────────────────────────────────────────────────────────────
//  OCR 配置
// ─────────────────────────────────────────────────────────────────

/** OCR 请求超时（毫秒） */
const OCR_TIMEOUT_MS = 10000;

/** OCR 最大重试次数（不含第一次正常尝试） */
const OCR_MAX_RETRY = 2;

/** OCR 重试基础延迟（毫秒），指数退避：500ms → 1000ms */
const OCR_RETRY_BASE_DELAY_MS = 500;

/**
 * OCR 上传图片文件大小上限（字节）
 * 与云函数端 4MB base64 上限对齐（base64 膨胀约 33%，原始文件 ≤ 3MB 即可）
 */
const OCR_MAX_FILE_BYTES = 3 * 1024 * 1024;

/**
 * OCR 上传图片文件大小下限（字节）
 * 小于此值视为无效图片（空文件 / 截断），直接拒绝
 */
const OCR_MIN_FILE_BYTES = 100;

// ─────────────────────────────────────────────────────────────────
//  TTS 运行时配置
// ─────────────────────────────────────────────────────────────────

/** TTS WebSocket 连接超时（毫秒） */
const TTS_WS_CONNECT_TIMEOUT_MS = 8000;

/**
 * TTS 全局合成超时（毫秒）
 * onError 后 onClose 不保证触发，此兜底超时防止 Promise 永久 pending（P0-4）
 */
const TTS_GLOBAL_TIMEOUT_MS = 15000;

/** TTS 最大重试次数（不含第一次正常尝试） */
const TTS_MAX_RETRY = 2;

/** TTS 重试基础延迟（毫秒），指数退避：500ms → 1000ms */
const TTS_RETRY_BASE_DELAY_MS = 500;

// ─────────────────────────────────────────────────────────────────
//  缓存配置
// ─────────────────────────────────────────────────────────────────

/** LRU 缓存最大容量（页） */
const CACHE_MAX_SIZE = 20;

/**
 * 缓存元数据存储在 wx.storage 中使用的 key
 * 避免与小程序其他模块冲突
 */
const CACHE_STORAGE_KEY = '__picbook_cache_v1__';

// ─────────────────────────────────────────────────────────────────
//  音频存储目录
// ─────────────────────────────────────────────────────────────────

/**
 * TTS 音频文件存储子目录名（相对于 wx.env.USER_DATA_PATH）
 * 最终路径形如：{USER_DATA_PATH}/picbook_audio/tts_xxx.mp3
 */
const AUDIO_STORAGE_DIR = 'picbook_audio';

// ─────────────────────────────────────────────────────────────────
//  图片压缩
// ─────────────────────────────────────────────────────────────────

/** OCR 上传图片目标大小（字节），约 500 KB */
const IMAGE_TARGET_SIZE_BYTES = 500 * 1024;

// ─────────────────────────────────────────────────────────────────
//  TTS 发音人配置（Phase 2 声音切换面板）
// ─────────────────────────────────────────────────────────────────

/**
 * 默认发音人标识，对应 TTS_VOICES 中的 vcn 值
 */
const DEFAULT_VOICE_TYPE = 'childFemale';

/**
 * 发音人配置映射（旧版，保持向后兼容）
 * vcn:   讯飞发音人代码
 * speed: 语速（0-100，50 为标准速度）
 * label: 前端展示名称
 */
const VOICE_CONFIG = {
  childFemale: { vcn: 'xiaoyan',  speed: 45, label: '甜甜女声' },
  childMale:   { vcn: 'xiaoyu',   speed: 45, label: '活泼男声' },
  adultFemale: { vcn: 'xiaoyan',  speed: 50, label: '温柔女声' },
  adultMale:   { vcn: 'xiaofeng', speed: 50, label: '磁性男声' },
};

/**
 * Phase 2 声音切换面板 — 可选声音角色列表
 * id:     唯一标识，对应讯飞发音人代码（vcn 参数）
 * label:  用户界面展示名称
 * gender: 'female' | 'male' | 'child'
 * speed:  语速默认值（0-100）
 * emoji:  头像区域显示的表情符号
 */
const TTS_VOICES = [
  {
    id: 'xiaoyan',
    vcn: 'xiaoyan',
    label: '小燕',
    gender: 'female',
    speed: 50,
    emoji: '👩',
  },
  {
    id: 'aisjiuxu',
    vcn: 'aisjiuxu',
    label: '爱思',
    gender: 'male',
    speed: 50,
    emoji: '👨',
  },
  {
    id: 'aisjinger',
    vcn: 'aisjinger',
    label: '爱晶',
    gender: 'child',
    speed: 45,
    emoji: '👧',
  },
];

/** 默认选中的声音角色 ID */
const DEFAULT_TTS_VOICE_ID = 'xiaoyan';

// ─────────────────────────────────────────────────────────────────
//  模块导出
// ─────────────────────────────────────────────────────────────────

module.exports = {
  OCR_URL,
  TTS_APP_ID,
  TTS_WS_SIGN_URL,
  TTS_TENCENT_URL,
  TTS_AZURE_URL,
  LLM_REFINE_URL,
  LLM_REFINE_TIMEOUT_MS,
  OCR_TIMEOUT_MS,
  OCR_MAX_RETRY,
  OCR_RETRY_BASE_DELAY_MS,
  OCR_MAX_FILE_BYTES,
  OCR_MIN_FILE_BYTES,
  TTS_WS_CONNECT_TIMEOUT_MS,
  TTS_GLOBAL_TIMEOUT_MS,
  TTS_MAX_RETRY,
  TTS_RETRY_BASE_DELAY_MS,
  CACHE_MAX_SIZE,
  CACHE_STORAGE_KEY,
  AUDIO_STORAGE_DIR,
  IMAGE_TARGET_SIZE_BYTES,
  DEFAULT_VOICE_TYPE,
  VOICE_CONFIG,
  TTS_VOICES,
  DEFAULT_TTS_VOICE_ID,
};
