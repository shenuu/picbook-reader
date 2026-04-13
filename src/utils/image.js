/**
 * @file utils/image.js
 * @description 绘本朗读助手 - 图片工具模块
 *
 * 职责：
 *  1. 图片压缩：迭代调整 quality，使文件体积压缩到目标大小以下
 *  2. XOR Hash 指纹计算：对图片文件采样 128 字节，逐字节 XOR，生成 16 进制摘要
 *     - 采样策略：均匀分布于文件首/中/尾，兼顾速度与区分度
 *     - 相同图片（即使经不同路径）应得到相同 hash
 *
 * 性能考量：
 *  - 指纹计算在小程序 JS 线程中同步执行（文件读取仍为异步）
 *  - 压缩采用二分搜索质量参数，最多 6 次迭代
 *
 * 局限性：
 *  - XOR Hash 碰撞率较高，仅用于快速近似匹配，不做安全用途
 *  - 若需更强唯一性可替换为 CRC32 / MD5（需引入额外库）
 *
 * @author Jamie Park
 * @version 0.1.0
 */

/** 压缩质量搜索最大迭代次数 */
const MAX_COMPRESS_ITERATIONS = 6;

/** XOR Hash 采样字节数 */
const HASH_SAMPLE_SIZE = 128;

/** 压缩质量范围 */
const QUALITY_MIN = 10;
const QUALITY_MAX = 80;

// ─────────────────────────────────────────────────────────────────
//  公开接口 — 图片压缩
// ─────────────────────────────────────────────────────────────────

/**
 * 将图片压缩至目标大小以下（二分搜索最优 quality）
 *
 * 算法：
 *  1. 先用 quality=80 压缩，若已满足目标大小则直接返回
 *  2. 否则用二分法在 [QUALITY_MIN, QUALITY_MAX] 区间搜索最大可用 quality
 *  3. 超过最大迭代次数后，返回当前最优结果（允许略超目标大小）
 *
 * @param {string} srcPath          - 原始图片路径（本地临时路径）
 * @param {number} targetSizeBytes  - 目标大小（字节），如 500 * 1024
 * @returns {Promise<string>}       - 压缩后的临时文件路径
 *
 * @example
 *   const path = await imageUtils.compressToTarget('/tmp/photo.jpg', 500 * 1024);
 */
async function compressToTarget(srcPath, targetSizeBytes) {
  // 先获取原始文件大小
  const originalSize = await _getFileSize(srcPath);

  if (originalSize <= targetSizeBytes) {
    // 原始图片已满足要求，直接返回
    console.info('[Image] 图片已满足大小要求，跳过压缩:', originalSize, 'bytes');
    return srcPath;
  }

  console.info(`[Image] 开始压缩，原始大小: ${originalSize} bytes，目标: ${targetSizeBytes} bytes`);

  let lo = QUALITY_MIN;
  let hi = QUALITY_MAX;
  let bestPath = srcPath;
  let bestSize = originalSize;

  for (let i = 0; i < MAX_COMPRESS_ITERATIONS; i++) {
    const quality = Math.round((lo + hi) / 2);
    const compressedPath = await _wxCompressImage(srcPath, quality);
    const compressedSize = await _getFileSize(compressedPath);

    console.info(`[Image] 压缩迭代 ${i + 1}: quality=${quality}, size=${compressedSize}`);

    if (compressedSize <= targetSizeBytes) {
      // 满足要求，记录为当前最优，尝试提高 quality（增大文件以改善清晰度）
      bestPath = compressedPath;
      bestSize = compressedSize;
      lo = quality + 1;
    } else {
      // 还是超了，降低 quality
      hi = quality - 1;
    }

    if (lo > hi) break;
  }

  console.info(`[Image] 压缩完成，最终大小: ${bestSize} bytes`);
  return bestPath;
}

// ─────────────────────────────────────────────────────────────────
//  公开接口 — 指纹计算
// ─────────────────────────────────────────────────────────────────

/**
 * 计算图片 XOR Hash 指纹
 *
 * 算法：
 *  1. 读取图片文件的 ArrayBuffer
 *  2. 在文件中均匀采样 HASH_SAMPLE_SIZE 个字节（均匀间隔）
 *  3. 将采样字节分为 16 组，每组内部 XOR 累积，得到 16 字节结果
 *  4. 转为 32 位 16 进制字符串
 *
 * 注意：此 hash 不适用于安全场景，仅用于快速缓存命中判断
 *
 * @param {string} filePath - 图片本地路径
 * @returns {Promise<string>} 32 位 16 进制 hash 字符串
 *
 * @example
 *   const hash = await imageUtils.calcXorHash('/tmp/photo.jpg');
 *   // => 'a3f2c1d4e5b6a7f8c9d0e1f2a3b4c5d6'
 */
async function calcXorHash(filePath) {
  const buffer = await _readFileBuffer(filePath);
  const bytes = new Uint8Array(buffer);
  const fileSize = bytes.length;

  if (fileSize === 0) {
    return '0'.repeat(32);
  }

  // 均匀采样 HASH_SAMPLE_SIZE 个字节
  const sampledBytes = new Uint8Array(HASH_SAMPLE_SIZE);
  for (let i = 0; i < HASH_SAMPLE_SIZE; i++) {
    // 均匀分布：覆盖文件头、中部、尾部
    const pos = Math.floor((i / HASH_SAMPLE_SIZE) * fileSize);
    sampledBytes[i] = bytes[pos];
  }

  // 分为 16 组，每组 8 字节，组内 XOR 累积 → 得到 16 字节摘要
  const GROUP_COUNT = 16;
  const GROUP_SIZE = Math.ceil(HASH_SAMPLE_SIZE / GROUP_COUNT);
  const digest = new Uint8Array(GROUP_COUNT);

  for (let g = 0; g < GROUP_COUNT; g++) {
    let xorVal = 0;
    for (let j = 0; j < GROUP_SIZE; j++) {
      const idx = g * GROUP_SIZE + j;
      if (idx < HASH_SAMPLE_SIZE) {
        xorVal ^= sampledBytes[idx];
      }
    }
    digest[g] = xorVal;
  }

  // 转为 16 进制字符串（每字节 2 位，共 32 位）
  const hexHash = Array.from(digest)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');

  return hexHash;
}

// ─────────────────────────────────────────────────────────────────
//  内部工具
// ─────────────────────────────────────────────────────────────────

/**
 * 调用 wx.compressImage 进行一次压缩
 * @param {string} src      - 原始图片路径
 * @param {number} quality  - 压缩质量 0-100
 * @returns {Promise<string>} 压缩后临时路径
 * @private
 */
function _wxCompressImage(src, quality) {
  return new Promise((resolve, reject) => {
    wx.compressImage({
      src,
      quality,
      success: (res) => resolve(res.tempFilePath),
      fail: (err) => reject(new Error(`wx.compressImage 失败 (quality=${quality}): ${err.errMsg}`)),
    });
  });
}

/**
 * 获取本地文件大小（字节）
 * 使用 wx.getFileSystemManager().statSync
 *
 * @param {string} filePath
 * @returns {Promise<number>} 文件大小（字节）
 * @private
 */
function _getFileSize(filePath) {
  return new Promise((resolve, reject) => {
    wx.getFileSystemManager().stat({
      path: filePath,
      success: (res) => resolve(res.stats.size),
      fail: (err) => reject(new Error('获取文件大小失败: ' + err.errMsg)),
    });
  });
}

/**
 * 读取文件为 ArrayBuffer（供指纹计算使用）
 * @param {string} filePath
 * @returns {Promise<ArrayBuffer>}
 * @private
 */
function _readFileBuffer(filePath) {
  return new Promise((resolve, reject) => {
    wx.getFileSystemManager().readFile({
      filePath,
      success: (res) => resolve(res.data), // data 为 ArrayBuffer
      fail: (err) => reject(new Error('读取文件失败: ' + err.errMsg)),
    });
  });
}

// ─────────────────────────────────────────────────────────────────
//  模块导出
// ─────────────────────────────────────────────────────────────────

module.exports = {
  compressToTarget,
  calcXorHash,
};
