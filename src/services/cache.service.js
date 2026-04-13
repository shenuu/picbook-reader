/**
 * @file services/cache.service.js
 * @description 绘本朗读助手 - 缓存服务（核心服务）
 *
 * 职责：
 *  1. 基于 LRU Cache（utils/lru-cache.js）管理页面缓存
 *  2. 以图片 XOR Hash 为键，存储 { text, imagePath, audioPath, createdAt }
 *  3. 最大缓存 20 页，超出时淘汰最久未访问的条目（含其音频文件）
 *  4. 持久化：LRU 内存结构 + wx.setStorageSync 双层存储
 *     - 启动时从 Storage 恢复 LRU 顺序
 *     - 每次写入/淘汰后同步持久化元数据
 *  5. 音频文件路径管理：淘汰时调用 wx.getFileSystemManager 删除本地文件
 *  6. 提供缓存统计信息
 *
 * 缓存 Key：  图片 XOR Hash（16进制字符串）
 * 缓存 Value：PageCacheEntry（见下方 typedef）
 *
 * 存储分层：
 *  内存  → LRUCache 实例（O(1) 读写）
 *  磁盘  → wx.Storage（key: '__picbook_cache_meta'）存 JSON 序列化的 entries 列表
 *  文件系统 → TTS 生成的 .mp3 文件
 *
 * @typedef {object} PageCacheEntry
 * @property {string} hash        - 图片指纹
 * @property {string} text        - OCR 识别文字
 * @property {string} imagePath   - 压缩后图片本地路径
 * @property {string} [audioPath] - TTS 生成的 MP3 本地路径（可能为空）
 * @property {number} createdAt   - Unix 时间戳（ms）
 * @property {number} [sizeKB]    - 条目估算大小（可选，用于统计）
 *
 * @author Jamie Park
 * @version 0.1.0
 */

const LRUCache = require('../utils/lru-cache');

/** Storage Key，用于持久化 LRU 元数据 */
const STORAGE_KEY = '__picbook_cache_meta';

/** 最大缓存页数 */
const MAX_CACHE_SIZE = 20;

// ─────────────────────────────────────────────────────────────────
//  单例初始化
// ─────────────────────────────────────────────────────────────────

/**
 * LRU Cache 实例（模块级单例）
 * capacity = MAX_CACHE_SIZE，淘汰回调中删除本地音频文件
 * @type {LRUCache}
 */
const lruCache = new LRUCache(MAX_CACHE_SIZE, _onEvict);

/** 模块是否已从 Storage 恢复 */
let _initialized = false;

/**
 * 初始化：从 wx.Storage 恢复 LRU 数据（按 lastAccess 升序还原访问顺序）
 * 第一次调用任意公开方法时自动触发
 * @private
 */
function _ensureInitialized() {
  if (_initialized) return;
  _initialized = true;

  try {
    const raw = wx.getStorageSync(STORAGE_KEY);
    if (!raw) return;

    /** @type {PageCacheEntry[]} */
    const entries = JSON.parse(raw);
    // 按 createdAt 升序恢复（最旧的最先插入，使 LRU 顺序正确）
    entries
      .sort((a, b) => a.createdAt - b.createdAt)
      .forEach((entry) => lruCache.put(entry.hash, entry));

    console.info(`[Cache] 已从 Storage 恢复 ${entries.length} 条缓存`);
  } catch (err) {
    console.error('[Cache] 恢复缓存失败，将以空缓存启动', err);
    // 恢复失败不影响正常使用，清空 Storage 防止下次再失败
    wx.removeStorageSync(STORAGE_KEY);
  }
}

// ─────────────────────────────────────────────────────────────────
//  公开接口 — 读写
// ─────────────────────────────────────────────────────────────────

/**
 * 读取缓存页（同时更新 LRU 访问顺序）
 *
 * @param {string} hash - 图片指纹
 * @returns {Promise<PageCacheEntry|null>} 缓存条目，未命中返回 null
 */
async function getPage(hash) {
  _ensureInitialized();

  const entry = lruCache.get(hash);
  if (!entry) {
    console.info('[Cache] 未命中，hash =', hash);
    return null;
  }

  // TODO: 验证 imagePath / audioPath 文件是否仍存在（文件可能被系统清理）
  // if (entry.audioPath && !_fileExists(entry.audioPath)) {
  //   entry.audioPath = '';
  //   lruCache.put(hash, entry);
  //   _persist();
  // }

  console.info('[Cache] 命中，hash =', hash);
  return entry;
}

/**
 * 写入缓存页
 * 若 hash 已存在则更新；若超过容量则 LRU 自动淘汰最旧条目（触发 _onEvict）
 *
 * @param {string} hash                    - 图片指纹
 * @param {{ text: string, imagePath: string, audioPath?: string }} data
 * @returns {Promise<void>}
 */
async function setPage(hash, data) {
  _ensureInitialized();

  /** @type {PageCacheEntry} */
  const entry = {
    hash,
    text: data.text || '',
    imagePath: data.imagePath || '',
    audioPath: data.audioPath || '',
    createdAt: Date.now(),
  };

  lruCache.put(hash, entry);
  _persist();

  console.info('[Cache] 已写入，hash =', hash, '| 当前缓存数:', lruCache.size());
}

/**
 * 更新已存在条目的音频路径（TTS 合成完成后回写）
 *
 * @param {string} hash
 * @param {string} audioPath - 本地 MP3 路径
 * @returns {Promise<void>}
 */
async function updateAudioPath(hash, audioPath) {
  _ensureInitialized();

  const entry = lruCache.get(hash);
  if (!entry) {
    console.warn('[Cache] updateAudioPath: 未找到 hash =', hash);
    return;
  }

  entry.audioPath = audioPath;
  lruCache.put(hash, entry); // 重新 put 以更新 LRU 顺序
  _persist();
}

/**
 * 清除全部缓存（内存 + Storage + 本地音频文件）
 * @returns {Promise<void>}
 */
async function clearAll() {
  _ensureInitialized();

  // 遍历所有条目，删除音频文件
  const allEntries = lruCache.values();
  allEntries.forEach((entry) => _deleteAudioFile(entry.audioPath));

  lruCache.clear();
  wx.removeStorageSync(STORAGE_KEY);

  console.info('[Cache] 已清除全部缓存');
}

// ─────────────────────────────────────────────────────────────────
//  公开接口 — 统计
// ─────────────────────────────────────────────────────────────────

/**
 * 获取缓存统计信息
 *
 * @returns {Promise<{ count: number, maxCount: number, totalSizeKB: number }>}
 */
async function getStats() {
  _ensureInitialized();

  const count = lruCache.size();
  const entries = lruCache.values();

  // 估算总大小：文字长度 * 2 字节 + 音频文件大小（TODO：实际读取文件大小）
  let totalSizeKB = 0;
  entries.forEach((entry) => {
    const textBytes = (entry.text || '').length * 2;
    // TODO: 读取 entry.audioPath 文件大小
    totalSizeKB += Math.ceil(textBytes / 1024);
  });

  return { count, maxCount: MAX_CACHE_SIZE, totalSizeKB };
}

// ─────────────────────────────────────────────────────────────────
//  内部工具
// ─────────────────────────────────────────────────────────────────

/**
 * LRU 淘汰回调：删除被淘汰条目的本地音频文件
 * @param {string} hash
 * @param {PageCacheEntry} entry
 * @private
 */
function _onEvict(hash, entry) {
  console.info('[Cache] 淘汰条目，hash =', hash);
  _deleteAudioFile(entry.audioPath);
  // 持久化在外部 setPage 调用中处理，此处无需再调用 _persist
}

/**
 * 删除本地音频文件（静默失败）
 * @param {string} [audioPath]
 * @private
 */
function _deleteAudioFile(audioPath) {
  if (!audioPath) return;
  try {
    wx.getFileSystemManager().unlinkSync(audioPath);
    console.info('[Cache] 已删除音频文件:', audioPath);
  } catch (err) {
    // 文件不存在或已被系统清理，忽略
    console.warn('[Cache] 删除音频文件失败（可忽略）:', audioPath, err.message);
  }
}

/**
 * 将 LRU 数据序列化后持久化到 wx.Storage
 * 注意：同步写入，调用方频繁写入时可考虑加 debounce
 * @private
 */
function _persist() {
  try {
    const entries = lruCache.values(); // 按 LRU 顺序（最旧 → 最新）
    wx.setStorageSync(STORAGE_KEY, JSON.stringify(entries));
  } catch (err) {
    console.error('[Cache] 持久化失败', err);
  }
}

/**
 * 检查本地文件是否存在
 * @param {string} filePath
 * @returns {boolean}
 * @private
 */
function _fileExists(filePath) {
  try {
    wx.getFileSystemManager().accessSync(filePath);
    return true;
  } catch (_) {
    return false;
  }
}

// ─────────────────────────────────────────────────────────────────
//  模块导出
// ─────────────────────────────────────────────────────────────────

module.exports = {
  getPage,
  setPage,
  updateAudioPath,
  clearAll,
  getStats,
};
