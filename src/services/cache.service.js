/**
 * @file services/cache.service.js
 * @description 绘本朗读助手 - 页面缓存服务
 *
 * 职责：
 *  1. 基于 utils/lru-cache.js 管理最近 20 页的 OCR 文字 + 音频路径
 *  2. LRU 淘汰时自动删除对应的本地 MP3 文件（防止磁盘泄漏）
 *  3. 冷启动时从 wx.storage 恢复 LRU 元数据（持久化）
 *  4. 每次写操作后将元数据同步回 wx.storage
 *
 * 缓存节点结构（PageCacheEntry）：
 *  {
 *    pageHash: string,         // 图片 XOR 指纹
 *    text: string,             // OCR 识别全文
 *    audioPath: string,        // 本地 TTS MP3 路径（合成后写入，初始为 ''）
 *    timestamp: number,        // 首次写入时间
 *    lastAccessAt: number,     // 最后访问时间（LRU 使用）
 *  }
 *
 * @author Jamie Park
 * @version 0.1.0
 */

const LRUCache = require('../utils/lru-cache');
const {
  CACHE_MAX_SIZE,
  CACHE_STORAGE_KEY,
} = require('../config');

// ─────────────────────────────────────────────────────────────────
//  模块级单例
// ─────────────────────────────────────────────────────────────────

/**
 * LRU 缓存实例（懒初始化，首次操作时从 Storage 恢复）
 * @type {LRUCache|null}
 */
let _cache = null;

/** 是否已完成初始化（避免重复从 Storage 读取） */
let _initialized = false;

/** 当前正在进行的初始化 Promise，防止并发多次初始化 */
let _initPromise = null;

// ─────────────────────────────────────────────────────────────────
//  公开接口
// ─────────────────────────────────────────────────────────────────

/**
 * 读取页面缓存条目
 * 同时更新该条目的 lastAccessAt（触发 LRU 移动到最新位置）
 *
 * @param {string} pageHash - 图片指纹
 * @returns {Promise<PageCacheEntry|null>} 命中时返回条目，否则返回 null
 */
async function getPage(pageHash) {
  await _ensureInitialized();

  const entry = _cache.get(pageHash);
  if (!entry) return null;

  // 更新最后访问时间（LRU 已在 get() 内部将节点移至最新）
  entry.lastAccessAt = Date.now();

  // 异步持久化（不阻塞主流程）
  _persistAsync();

  return entry;
}

/**
 * 写入页面缓存条目
 * 若该 hash 已存在，则更新并移到 LRU 最新位置；
 * 若已满 20 条，自动淘汰最旧条目（连带删除其 MP3 文件）
 *
 * @param {string} pageHash   - 图片指纹
 * @param {{ text: string, imagePath?: string }} payload - OCR 结果（audioPath 默认为空）
 * @returns {Promise<void>}
 */
async function setPage(pageHash, payload) {
  await _ensureInitialized();

  const now = Date.now();

  /** @type {PageCacheEntry} */
  const entry = {
    pageHash,
    text: payload.text || '',
    audioPath: payload.audioPath || '',
    timestamp: now,
    lastAccessAt: now,
  };

  _cache.put(pageHash, entry);

  // 同步持久化
  await _persist();
}

/**
 * 将 TTS 生成的音频路径写回对应的缓存条目
 * 若 pageHash 不存在于缓存（例如已被淘汰），操作静默忽略
 *
 * @param {string} pageHash  - 图片指纹
 * @param {string} audioPath - 本地 MP3 路径
 * @returns {Promise<void>}
 */
async function updateAudioPath(pageHash, audioPath) {
  await _ensureInitialized();

  const entry = _cache.get(pageHash);
  if (!entry) {
    console.warn('[Cache] updateAudioPath: 未找到 pageHash =', pageHash);
    return;
  }

  entry.audioPath = audioPath;
  entry.lastAccessAt = Date.now();

  await _persist();
}

/**
 * 获取缓存统计信息
 * @returns {Promise<{ count: number, maxCount: number, totalSizeKB: number }>}
 */
async function getStats() {
  await _ensureInitialized();

  const entries = _cache.values();
  const count = _cache.size();

  // 粗略估算文本缓存占用（音频文件大小需从 FS 读取，这里仅统计文本）
  let totalSizeKB = 0;
  for (const entry of entries) {
    // 文本按 2 字节/字符估算（中文 UTF-8 占 3 字节，这里保守估算）
    totalSizeKB += Math.ceil((entry.text?.length || 0) * 2 / 1024);
  }

  return { count, maxCount: CACHE_MAX_SIZE, totalSizeKB };
}

/**
 * 删除指定页面的缓存及其 MP3 文件
 * @param {string} pageHash
 * @returns {Promise<boolean>} 是否成功删除
 */
async function removePage(pageHash) {
  await _ensureInitialized();

  const entry = _cache.get(pageHash);
  if (entry?.audioPath) {
    _deleteAudioFile(entry.audioPath);
  }

  const deleted = _cache.delete(pageHash);
  if (deleted) {
    await _persist();
  }
  return deleted;
}

/**
 * 清空全部缓存：删除所有 MP3 文件 + 清空 LRU + 清空 Storage
 * @returns {Promise<void>}
 */
async function clearAll() {
  await _ensureInitialized();

  // 删除所有已缓存的 MP3 文件
  const entries = _cache.values();
  for (const entry of entries) {
    if (entry.audioPath) {
      _deleteAudioFile(entry.audioPath);
    }
  }

  _cache.clear();

  try {
    wx.removeStorageSync(CACHE_STORAGE_KEY);
  } catch (err) {
    console.warn('[Cache] 清空 Storage 失败:', err.message);
  }

  console.info('[Cache] 缓存已全部清空');
}

// ─────────────────────────────────────────────────────────────────
//  初始化与持久化
// ─────────────────────────────────────────────────────────────────

/**
 * 确保缓存服务已初始化（懒加载，只执行一次）
 * 通过 _initPromise 防止并发初始化
 * @private
 */
function _ensureInitialized() {
  if (_initialized) return Promise.resolve();
  if (_initPromise) return _initPromise;

  _initPromise = _initialize().then(() => {
    _initialized = true;
    _initPromise = null;
  });

  return _initPromise;
}

/**
 * 从 wx.storage 读取 LRU 元数据并重建缓存实例
 * @private
 */
function _initialize() {
  return new Promise((resolve) => {
    // 创建 LRU 实例，附带淘汰回调（自动删除被淘汰条目的 MP3 文件）
    _cache = new LRUCache(CACHE_MAX_SIZE, _onEvict);

    let savedMeta = null;
    try {
      savedMeta = wx.getStorageSync(CACHE_STORAGE_KEY);
    } catch (err) {
      console.warn('[Cache] 读取持久化元数据失败:', err.message);
    }

    if (savedMeta && savedMeta.order && savedMeta.nodes) {
      _restoreFromMeta(savedMeta);
      console.info(`[Cache] 冷启动恢复完成，恢复 ${_cache.size()} 条缓存`);
    } else {
      console.info('[Cache] 无持久化数据，使用空缓存');
    }

    resolve();
  });
}

/**
 * 从持久化元数据重建 LRU 链表顺序
 * savedMeta.order 是从最旧到最新的 pageHash 数组
 * 按顺序 put 可以正确重建 LRU 的相对顺序
 *
 * @param {{ order: string[], nodes: object }} meta
 * @private
 */
function _restoreFromMeta(meta) {
  const { order, nodes } = meta;

  for (const pageHash of order) {
    const entry = nodes[pageHash];
    if (!entry) continue;

    // 校验恢复的音频文件是否仍存在（可能已被系统清理）
    const validEntry = { ...entry };
    if (validEntry.audioPath && !_fileExists(validEntry.audioPath)) {
      console.info('[Cache] 音频文件已不存在，清除 audioPath:', validEntry.audioPath);
      validEntry.audioPath = '';
    }

    // 按旧→新顺序 put，最后 put 的为 LRU 最新
    _cache.put(pageHash, validEntry);
  }
}

/**
 * 将当前 LRU 元数据序列化并写入 wx.storage
 * 使用 try/catch 防止 Storage 配额异常影响主流程
 * @private
 */
async function _persist() {
  try {
    const entries = _cache.entries(); // [最旧, ..., 最新]
    const order = entries.map(([key]) => key);
    const nodes = {};
    for (const [key, val] of entries) {
      nodes[key] = val;
    }

    const meta = {
      version: 1,
      capacity: CACHE_MAX_SIZE,
      size: _cache.size(),
      order,
      nodes,
    };

    wx.setStorageSync(CACHE_STORAGE_KEY, meta);
  } catch (err) {
    console.warn('[Cache] 持久化元数据失败:', err.message);
  }
}

/**
 * 非阻塞持久化（避免阻塞调用者）
 * @private
 */
function _persistAsync() {
  _persist().catch((err) => {
    console.warn('[Cache] 异步持久化失败:', err.message);
  });
}

// ─────────────────────────────────────────────────────────────────
//  LRU 淘汰回调
// ─────────────────────────────────────────────────────────────────

/**
 * LRU 淘汰回调：删除被淘汰条目的本地 MP3 文件
 * 在 LRU.put() 触发容量溢出时，由 LRUCache 内部调用
 *
 * @param {string}          key   - 被淘汰的 pageHash
 * @param {PageCacheEntry}  value - 被淘汰的缓存条目
 * @private
 */
function _onEvict(key, value) {
  console.info(`[Cache] 淘汰页面缓存: ${key}，audioPath: ${value?.audioPath || '无'}`);
  if (value?.audioPath) {
    _deleteAudioFile(value.audioPath);
  }
}

// ─────────────────────────────────────────────────────────────────
//  文件系统工具
// ─────────────────────────────────────────────────────────────────

/**
 * 删除本地 MP3 文件（静默处理，失败不抛异常）
 * @param {string} filePath
 * @private
 */
function _deleteAudioFile(filePath) {
  if (!filePath) return;

  wx.getFileSystemManager().unlink({
    filePath,
    success: () => console.info('[Cache] 已删除音频文件:', filePath),
    fail: (err) => console.warn('[Cache] 删除音频文件失败（可能已不存在）:', filePath, err.errMsg),
  });
}

/**
 * 同步检查文件是否存在
 * @param {string} filePath
 * @returns {boolean}
 * @private
 */
function _fileExists(filePath) {
  if (!filePath) return false;
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
  getStats,
  removePage,
  clearAll,
};
