/**
 * @file pages/guide/index.js
 * @description 绘本朗读助手 - 拍照引导页
 *
 * 职责：
 *  1. 引导用户拍摄绘本页面（使用 wx.chooseMedia）
 *  2. 对选取图片进行压缩（imageUtils.compressToTarget，目标 ≤ 500 KB）
 *  3. 计算图片 XOR Hash 指纹，用于命中缓存
 *  4. 检查缓存命中 → 命中则直接跳转结果页；未命中则调用 OCR 服务
 *  5. 上传期间展示进度/加载状态
 *
 * 流程：
 *  拍照/选图 → 压缩 → 计算指纹 → 查缓存
 *      ├── 命中 → 跳转结果页（携带缓存数据）
 *      └── 未命中 → 调用 OCR → 存入缓存 → 跳转结果页
 *
 * 依赖：
 *  - services/ocr.service.js    OCR 识别
 *  - services/cache.service.js  缓存读取
 *  - utils/image.js             压缩 & 指纹
 *  - utils/network.js           离线检测
 *  - src/config.js              IMAGE_TARGET_SIZE_BYTES
 *
 * @author Jamie Park
 * @version 0.1.0
 */

const ocrService = require('../../services/ocr.service');
const cacheService = require('../../services/cache.service');
const imageUtils = require('../../utils/image');
const network = require('../../utils/network');
const { IMAGE_TARGET_SIZE_BYTES } = require('../../config');

/** 拍照/选图时允许的最大文件数（单次只处理 1 页） */
const MAX_MEDIA_COUNT = 1;

Page({

  // ─────────────────────────────────────────────
  //  数据层
  // ─────────────────────────────────────────────
  data: {
    /** 当前选取/拍摄的图片临时路径 */
    imagePath: '',
    /** 压缩后图片路径 */
    compressedPath: '',
    /** 图片 XOR Hash 指纹（16进制字符串） */
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
   * 页面卸载：若有正在进行的 OCR 请求，取消（释放网络资源）
   */
  onUnload() {
    // ocrService 目前通过超时+重试处理，无显式 abort；
    // 若后续升级为 AbortController，在此调用 ocrService.abort()
    network.clearQueue('页面已卸载');
  },

  // ─────────────────────────────────────────────
  //  主流程入口
  // ─────────────────────────────────────────────

  /**
   * 点击"拍照 / 从相册选图"按钮
   * 触发 wx.chooseMedia，成功后进入压缩 → 指纹 → OCR 流程
   */
  async onTapChooseImage() {
    if (this.data.status !== 'idle' && this.data.status !== 'error') {
      // 正在处理中，防止重复点击
      return;
    }

    try {
      const tempPath = await this._chooseMedia();
      if (!tempPath) return; // 用户取消

      this.setData({ imagePath: tempPath, status: 'compressing', progress: 0 });

      // Step 1: 压缩图片（二分法搜索最优 quality，目标 ≤ IMAGE_TARGET_SIZE_BYTES）
      const compressedPath = await this._compressImage(tempPath);
      this.setData({ compressedPath, status: 'hashing' });

      // Step 2: 计算 XOR 指纹（采样 128 字节，O(fileSize) 一次读取）
      const imageHash = await this._calcImageHash(compressedPath);
      this.setData({ imageHash });

      // Step 3: 检查 LRU 缓存
      const cached = await cacheService.getPage(imageHash);
      if (cached) {
        console.info('[Guide] 缓存命中，hash =', imageHash);
        this.setData({ status: 'done', progress: 100 });
        this._navigateToResult({ fromCache: true, hash: imageHash });
        return;
      }

      // Step 4: 离线检查（缓存未命中时才需要网络）
      if (!network.isOnline()) {
        this._setError('当前无网络，且未找到缓存，请联网后重试');
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
      this._navigateToResult({
        fromCache: false,
        hash: imageHash,
        text: ocrResult.text,
      });

    } catch (err) {
      console.error('[Guide] 处理流程出错', err);
      this._setError(err.message || '识别失败，请重试');
    }
  },

  // ─────────────────────────────────────────────
  //  内部步骤方法
  // ─────────────────────────────────────────────

  /**
   * 调用 wx.chooseMedia 让用户拍照或从相册选取图片
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
          // res.tempFiles[0].tempFilePath
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
   * 压缩图片到目标大小（二分搜索最优 quality，最多 6 次迭代）
   * 若原始图片已满足大小要求，则跳过压缩直接返回原路径
   *
   * @param {string} src - 原始临时路径
   * @returns {Promise<string>} 压缩后的临时路径
   * @private
   */
  async _compressImage(src) {
    return imageUtils.compressToTarget(src, IMAGE_TARGET_SIZE_BYTES);
  },

  /**
   * 计算图片 XOR Hash 指纹
   * 均匀采样 128 字节，分 16 组 XOR，输出 32 位 16 进制字符串
   *
   * @param {string} filePath - 图片路径
   * @returns {Promise<string>} 16进制 hash 字符串
   * @private
   */
  async _calcImageHash(filePath) {
    return imageUtils.calcXorHash(filePath);
  },

  // ─────────────────────────────────────────────
  //  导航 & 错误处理
  // ─────────────────────────────────────────────

  /**
   * 跳转结果页，通过 URL 参数传递必要信息
   * 结果页从 cacheService 读取 text，无需在 URL 中传递完整文字（可能过长）
   *
   * @param {{ fromCache: boolean, hash: string }} params
   * @private
   */
  _navigateToResult({ fromCache, hash }) {
    const query = `hash=${encodeURIComponent(hash)}&fromCache=${fromCache}`;
    wx.navigateTo({ url: `/pages/result/index?${query}` });
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
