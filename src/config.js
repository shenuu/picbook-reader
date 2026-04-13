/**
 * @file src/config.js
 * @description 绘本朗读助手 - 全局配置常量
 *
 * 在此统一管理 BFF 地址、超时时间、缓存容量等参数。
 * 修改时只需改动本文件，无需在各 service 中查找分散的魔术数字。
 *
 * @author Jamie Park
 * @version 0.1.0
 */

// ─────────────────────────────────────────────────────────────────
//  环境切换
//  生产环境部署后将 BFF_BASE_URL 改为实际域名即可；
//  开发时指向本地 BFF 服务。
// ─────────────────────────────────────────────────────────────────

/** BFF（Backend For Frontend）服务基础地址，不含末尾斜杠 */
const BFF_BASE_URL = 'https://api.picbook-reader.example.com';

// ─────────────────────────────────────────────────────────────────
//  OCR 配置
// ─────────────────────────────────────────────────────────────────

/** OCR 请求超时（毫秒） */
const OCR_TIMEOUT_MS = 5000;

/** OCR 最大重试次数（不含第一次正常尝试） */
const OCR_MAX_RETRY = 2;

/** OCR 重试基础延迟（毫秒），指数退避：500ms → 1000ms */
const OCR_RETRY_BASE_DELAY_MS = 500;

// ─────────────────────────────────────────────────────────────────
//  TTS 配置
// ─────────────────────────────────────────────────────────────────

/** TTS WebSocket 连接超时（毫秒） */
const TTS_WS_CONNECT_TIMEOUT_MS = 8000;

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
//  TTS 发音人配置
// ─────────────────────────────────────────────────────────────────

/**
 * 默认发音人标识，对应 VOICE_CONFIG 中的 key
 * 可选值：'childFemale' | 'childMale' | 'adultFemale' | 'adultMale'
 */
const DEFAULT_VOICE_TYPE = 'childFemale';

/**
 * 发音人配置映射
 * vcn:   讯飞发音人代码
 * speed: 语速（0-100，50 为标准速度）
 * label: 前端展示名称
 */
const VOICE_CONFIG = {
  childFemale: { vcn: 'x_xiaoman', speed: 45, label: '甜甜女声' },
  childMale:   { vcn: 'x_xiaoyu',  speed: 45, label: '活泼男声' },
  adultFemale: { vcn: 'x_xiaoyan', speed: 50, label: '温柔女声' },
  adultMale:   { vcn: 'x_xiaofeng', speed: 50, label: '磁性男声' },
};

// ─────────────────────────────────────────────────────────────────
//  模块导出
// ─────────────────────────────────────────────────────────────────

module.exports = {
  BFF_BASE_URL,
  OCR_TIMEOUT_MS,
  OCR_MAX_RETRY,
  OCR_RETRY_BASE_DELAY_MS,
  TTS_WS_CONNECT_TIMEOUT_MS,
  TTS_MAX_RETRY,
  TTS_RETRY_BASE_DELAY_MS,
  CACHE_MAX_SIZE,
  CACHE_STORAGE_KEY,
  AUDIO_STORAGE_DIR,
  IMAGE_TARGET_SIZE_BYTES,
  DEFAULT_VOICE_TYPE,
  VOICE_CONFIG,
};
