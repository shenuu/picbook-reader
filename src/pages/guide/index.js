/**
 * @file pages/guide/index.js
 * @description 绘本朗读助手 - 拍照引导页
 *
 * 职责：
 *  1. 引导用户拍摄绘本页面（使用 wx.chooseMedia）
 *  2. 对选取图片进行压缩（imageUtils.compressToTarget，目标 ≤ 500 KB）
 *  3. 计算图片内容 djb2 哈希指纹（P1-1：改用文件内容哈希，降低碰撞率）
 *  4. 检查缓存命中 → 命中则直接跳转结果页；未命中则调用 OCR 服务
 *  5. 上传期间展示进度/加载状态
 *
 * 流程：
 *  拍照/选图 → 压缩 → 计算内容指纹 → 查缓存
 *      ├── 命中 → 跳转结果页（携带缓存数据）
 *      └── 未命中 → 调用 OCR → 存入缓存 → 跳转结果页
 *
 * 已修复问题：
 *  - P0-5: wx.chooseMedia 包装为 Promise，async/await 异常不再被吞掉
 *  - P1-1: _getCacheKey 改用 djb2 算法对文件内容 base64 前 512 字节哈希
 *  - P1-2: 跳转结果页改用 EventChannel 传递 OCR 文字，避免 URL 超 1024 字符限制
 *
 * 依赖：
 *  - services/ocr.service.js    OCR 识别
 *  - services/cache.service.js  缓存读取
 *  - utils/image.js             压缩
 *  - utils/network.js           离线检测
 *  - src/config.js              IMAGE_TARGET_SIZE_BYTES
 *
 * @author Jamie Park
 * @version 0.2.0
 */

const ocrService   = require('../../services/ocr.service');
const cacheService = require('../../services/cache.service');
const imageUtils   = require('../../utils/image');
const network      = require('../../utils/network');
const { IMAGE_TARGET_SIZE_BYTES } = require('../../config');

/** 拍照/选图时允许的最大文件数（单次只处理 1 页） */
const MAX_MEDIA_COUNT = 1;

/**
 * P3-1: 哈希采样升级
 * 采样首/中/尾三段各 512 字符（共 1536 字符），覆盖文件头部 JPEG 标记、
 * 中部图像数据和末尾 EOI 标记，大幅降低不同绘本页的哈希碰撞概率。
 * 原来只取前 512 字符，两张结构相似的绘本页（如同一本书相邻两页）
 * 可能因头部元数据相同而产生哈希碰撞。
 */
const DJB2_SAMPLE_LEN = 512;
/** P3-1: 多段采样片段数（首/中/尾） */
const DJB2_SAMPLE_SEGMENTS = 3;

Page({

  // ─────────────────────────────────────────────
  //  数据层
  // ─────────────────────────────────────────────
  data: {
    /** 当前选取/拍摄的图片临时路径 */
    imagePath: '',
    /** 压缩后图片路径 */
    compressedPath: '',
    /** 图片内容哈希指纹（djb2，16进制字符串） */
    imageHash: '',
    /**
     * 页面状态机
     * idle | choosing | compressing | hashing | recognizing | done | error
     */
    status: 'idle',
    /** 错误信息（status === 'error' 时显示） */
    errorMsg: '',
    /** OCR 识别进度百分比（0-100，用于进度条） */
    progress: 0,
  },

  // ─────────────────────────────────────────────
  //  生命周期
  // ─────────────────────────────────────────────

  /**
   * 页面加载：记录传入的上下文参数（如 bookId，当前 MVP 暂不使用）
   * @param {object} options - 页面参数
   */
  onLoad(options) {
    // 扩展点：可从 options 接收 bookId 等参数，用于绑定书目记录
    if (options.bookId) {
      console.info('[Guide] 关联书目 bookId:', options.bookId);
    }
  },

  /**
   * 页面卸载：清理网络队列
   */
  onUnload() {
    network.clearQueue('页面已卸载');
  },

  // ─────────────────────────────────────────────
  //  主流程入口
  // ─────────────────────────────────────────────

  /**
   * 点击"拍照 / 从相册选图"按钮
   *
   * P0-5 修复：
   *  - 将 wx.chooseMedia 包装为 Promise（_chooseMedia 方法）
   *  - 整个流程在一个 try/catch 块内，async/await 异常不再被吞掉
   *  - 原来 success 回调中 async 代码抛出的异常会被 wx 内部吞掉，
   *    包装后异常沿 await 链冒泡到外层 catch，统一处理
   */
  async onTapChooseImage() {
    if (this.data.status !== 'idle' && this.data.status !== 'error') {
      // 正在处理中，防止重复点击
      return;
    }

    try {
      // P0-5: chooseMedia 已包装为 Promise，await 可正确捕获异常
      const tempPath = await this._chooseMedia();
      if (!tempPath) return; // 用户取消

      this.setData({ imagePath: tempPath, status: 'compressing', progress: 0 });

      // Step 1: 压缩图片（二分法搜索最优 quality，目标 ≤ IMAGE_TARGET_SIZE_BYTES）
      const compressedPath = await this._compressImage(tempPath);
      this.setData({ compressedPath, status: 'hashing' });

      // Step 2: P1-1 计算文件内容哈希（djb2 对 base64 前 512 字节）
      const imageHash = await this._getCacheKey(compressedPath);
      this.setData({ imageHash });

      // Step 3: 检查 LRU 缓存
      const cached = await cacheService.getPage(imageHash);
      if (cached) {
        console.info('[Guide] 缓存命中，hash =', imageHash);
        this.setData({ status: 'done', progress: 100 });
        // P1-2: 缓存命中时也用 EventChannel 传递文字（result 页统一接收）
        this._navigateToResult({ fromCache: true, hash: imageHash, text: cached.text });
        return;
      }

      // Step 4: 离线检查（缓存未命中时才需要网络）
      if (!network.isOnline()) {
        wx.navigateTo({ url: '/src/pages/offline/index' });
        return;
      }

      // Step 5: OCR 识别（含 2 次指数退避重试）
      this.setData({ status: 'recognizing', progress: 10 });
      const ocrResult = await ocrService.recognize(compressedPath, {
        onProgress: (pct) => this.setData({ progress: pct }),
      });

      // Step 6: 将 OCR 结果写入缓存（audioPath 留空，TTS 完成后由结果页补写）
      await cacheService.setPage(imageHash, {
        text: ocrResult.text,
        imagePath: compressedPath,
      });

      this.setData({ status: 'done', progress: 100 });
      // P1-2: 通过 EventChannel 传递文字，避免 URL 超限
      this._navigateToResult({
        fromCache: false,
        hash: imageHash,
        text: ocrResult.text,
      });

    } catch (err) {
      // P0-5: 所有异常（包括 chooseMedia success 回调中的异常）都在此统一捕获
      console.error('[Guide] 处理流程出错', err);
      this._setError(err.message || '识别失败，请重试');
    }
  },

  // ─────────────────────────────────────────────
  //  内部步骤方法
  // ─────────────────────────────────────────────

  /**
   * 将 wx.chooseMedia 包装为 Promise
   *
   * P0-5 修复核心：
   *  原实现在 success 回调中使用 async/await，微信 JS 引擎不会将
   *  success 回调视为 Promise 链的一部分，抛出的异常会被吞掉。
   *  包装后：整个异步流程在 async onTapChooseImage 的 try/catch 内运行，
   *  任何异常都能被正确捕获并展示给用户。
   *
   * @returns {Promise<string|null>} 临时文件路径；用户取消返回 null
   * @private
   */
  _chooseMedia() {
    this.setData({ status: 'choosing' });
    return new Promise((resolve, reject) => {
      wx.chooseMedia({
        count: MAX_MEDIA_COUNT,
        mediaType: ['image'],
        sourceType: ['album', 'camera'],
        camera: 'back',
        success: (res) => {
          // P0-5: success 回调中只做同步操作（resolve），
          // 不再 async/await，避免异常被吞掉
          const file = res.tempFiles && res.tempFiles[0];
          resolve(file ? file.tempFilePath : null);
        },
        fail: (err) => {
          // 用户主动取消时 errMsg 包含 'cancel'，不视为错误
          if (err.errMsg && err.errMsg.includes('cancel')) {
            this.setData({ status: 'idle' });
            resolve(null);
          } else {
            reject(new Error('选取图片失败：' + err.errMsg));
          }
        },
      });
    });
  },

  /**
   * 压缩图片到目标大小
   * @param {string} src - 原始临时路径
   * @returns {Promise<string>} 压缩后的临时路径
   * @private
   */
  async _compressImage(src) {
    return imageUtils.compressToTarget(src, IMAGE_TARGET_SIZE_BYTES);
  },

  /**
   * P3-1: 计算图片内容哈希（djb2 多段采样升级版）
   *
   * 升级说明（相对 P1-1）：
   *  原实现仅取 base64 字符串头部 512 字符做 djb2 哈希。
   *  对于同一本绘本的相邻两页，JPEG 文件头（SOI、APP0/APP1 标记、EXIF 信息）
   *  通常完全相同，导致前 512 字符碰撞。
   *
   *  P3-1 改为：首/中/尾各取 DJB2_SAMPLE_LEN 字符，拼接后做 djb2，
   *  覆盖范围从 ~384B → ~1152B 真实图片数据，碰撞概率大幅下降。
   *
   *  首段（0..512）    → 覆盖 JPEG 头、EXIF、缩略图（文件特征）
   *  中段（mid..mid+512）→ 覆盖图像扫描数据（内容特征，每页差异最大）
   *  尾段（end-512..end）→ 覆盖 JPEG EOI 标记 + 末尾扫描块
   *
   * @param {string} filePath - 图片路径（压缩后）
   * @returns {Promise<string>} djb2 哈希的 16 进制字符串（8 位）
   * @private
   */
  async _getCacheKey(filePath) {
    return new Promise((resolve, reject) => {
      wx.getFileSystemManager().readFile({
        filePath,
        encoding: 'base64',
        success: (res) => {
          const b64 = res.data || '';
          const len = b64.length;

          // P3-1: 多段采样（首/中/尾），每段 DJB2_SAMPLE_LEN 字符
          const midStart = Math.max(0, Math.floor((len - DJB2_SAMPLE_LEN) / 2));
          const tailStart = Math.max(0, len - DJB2_SAMPLE_LEN);

          const headSample = b64.slice(0, DJB2_SAMPLE_LEN);
          const midSample  = b64.slice(midStart, midStart + DJB2_SAMPLE_LEN);
          const tailSample = b64.slice(tailStart);

          // 三段拼接后统一哈希（比分段哈希后 XOR 更均匀）
          const combined = headSample + midSample + tailSample;
          const hash = _djb2Hash(combined);

          // 转为 8 位 16 进制字符串（前补零）
          const hexStr = (hash >>> 0).toString(16).padStart(8, '0');
          resolve(hexStr);
        },
        fail: (err) => reject(new Error('读取文件哈希失败: ' + err.errMsg)),
      });
    });
  },

  // ─────────────────────────────────────────────
  //  导航 & 错误处理
  // ─────────────────────────────────────────────

  /**
   * P1-2: 通过 EventChannel 跳转结果页，传递 OCR 文字
   *
   * 修复说明：
   *  原实现用 encodeURIComponent(ocrText) 拼入 URL，
   *  若文字超过 1024 字符（约 300 中文字），微信会截断 URL 导致数据丢失。
   *  改用 wx.navigateTo 的 events 参数建立 EventChannel，
   *  文字通过 emit('ocrData', {...}) 发送，无大小限制。
   *
   * @param {{ fromCache: boolean, hash: string, text: string }} params
   * @private
   */
  _navigateToResult({ fromCache, hash, text }) {
    wx.navigateTo({
      // URL 只传不敏感的轻量参数（hash 用于缓存查找，fromCache 用于 UI 提示）
      url: `/src/pages/result/index?hash=${encodeURIComponent(hash)}&fromCache=${fromCache}`,
      // P1-2: EventChannel 注册事件监听，结果页调用 getOpenerEventChannel().on('ocrData') 接收
      events: {
        // 预留：结果页可通过此频道回传事件（如播放完成通知）
        playbackFinished: () => {},
      },
      success: (res) => {
        // 连接建立成功后立即发送数据，文字内容无大小限制
        res.eventChannel.emit('ocrData', {
          text: text || '',
          fromCache,
          hash,
        });
      },
      fail: (err) => {
        console.error('[Guide] 跳转结果页失败:', err.errMsg);
        this._setError('页面跳转失败，请重试');
      },
    });
  },

  /**
   * 设置错误状态，同时用 Toast 展示给用户
   * @param {string} msg
   * @private
   */
  _setError(msg) {
    this.setData({ status: 'error', errorMsg: msg, progress: 0 });
    wx.showToast({ title: msg, icon: 'none', duration: 3000 });
  },

  /**
   * 用户点击"重新拍照"按钮，重置状态机回到初始 idle
   */
  onTapReset() {
    this.setData({
      imagePath: '',
      compressedPath: '',
      imageHash: '',
      status: 'idle',
      errorMsg: '',
      progress: 0,
    });
  },
});

// ─────────────────────────────────────────────────────────────────
//  模块级工具函数
// ─────────────────────────────────────────────────────────────────

/**
 * P1-1: djb2 哈希算法
 *
 * 经典字符串哈希，由 Dan Bernstein 提出，碰撞率低、速度快。
 * 公式：hash = hash * 33 ^ charCode（位运算保持 32 位整数范围）
 *
 * @param {string} str - 输入字符串
 * @returns {number}   - 32 位无符号整数哈希值
 */
function _djb2Hash(str) {
  let hash = 5381; // 初始种子（djb2 标准值）
  for (let i = 0; i < str.length; i++) {
    // hash * 33 XOR charCode，用 | 0 保持 32 位整数
    hash = ((hash << 5) + hash) ^ str.charCodeAt(i);
    hash = hash | 0; // 强制转为 32 位有符号整数，防止溢出
  }
  return hash;
}
