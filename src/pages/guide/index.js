/**
 * @file pages/guide/index.js
 * @description 绘本朗读助手 - 拍照引导页
 *
 * 职责：
 *  1. 引导用户拍摄绘本页面（使用 wx.chooseMedia）
 *  2. 对选取图片进行压缩（wx.compressImage，目标 ≤ 500 KB）
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
 *
 * @author Jamie Park
 * @version 0.1.0
 */

const ocrService = require('../../services/ocr.service');
const cacheService = require('../../services/cache.service');
const imageUtils = require('../../utils/image');
const network = require('../../utils/network');

/** 拍照/选图时允许的最大文件数 */
const MAX_MEDIA_COUNT = 1;

/** 压缩目标大小（字节），约 500 KB */
const TARGET_COMPRESS_SIZE = 500 * 1024;

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

  onLoad(options) {
    // TODO: 可从 options 接收 bookId 等上下文参数
  },

  onUnload() {
    // TODO: 若有正在进行的 OCR 请求，调用 ocrService.abort() 取消
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

      // Step 1: 压缩图片
      const compressedPath = await this._compressImage(tempPath);
      this.setData({ compressedPath, status: 'hashing' });

      // Step 2: 计算指纹
      const imageHash = await this._calcImageHash(compressedPath);
      this.setData({ imageHash });

      // Step 3: 检查缓存
      const cached = await cacheService.getPage(imageHash);
      if (cached) {
        console.info('[Guide] 缓存命中，hash =', imageHash);
        this._navigateToResult({ fromCache: true, hash: imageHash });
        return;
      }

      // Step 4: 离线检查
      if (!network.isOnline()) {
        this._setError('当前无网络，且未找到缓存，请联网后重试');
        return;
      }

      // Step 5: OCR 识别
      this.setData({ status: 'recognizing', progress: 10 });
      const ocrResult = await ocrService.recognize(compressedPath, {
        onProgress: (pct) => this.setData({ progress: pct }),
      });

      // Step 6: 写入缓存
      await cacheService.setPage(imageHash, {
        text: ocrResult.text,
        imagePath: compressedPath,
        // audioPath 在结果页 TTS 完成后补充
      });

      this.setData({ status: 'done', progress: 100 });
      this._navigateToResult({ fromCache: false, hash: imageHash, text: ocrResult.text });

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
   * 压缩图片到目标大小
   * 内部调用 imageUtils.compressToTarget，该工具会迭代调整 quality
   * @param {string} src - 原始临时路径
   * @returns {Promise<string>} 压缩后的临时路径
   * @private
   */
  async _compressImage(src) {
    // TODO: return imageUtils.compressToTarget(src, TARGET_COMPRESS_SIZE);
    // 占位：直接返回原路径（完整实现需替换）
    return src;
  },

  /**
   * 计算图片 XOR Hash 指纹
   * @param {string} filePath - 图片路径
   * @returns {Promise<string>} 16进制 hash 字符串
   * @private
   */
  async _calcImageHash(filePath) {
    // TODO: return imageUtils.calcXorHash(filePath);
    return 'placeholder_hash';
  },

  // ─────────────────────────────────────────────
  //  导航 & 错误处理
  // ─────────────────────────────────────────────

  /**
   * 跳转结果页，通过 URL 参数传递必要信息
   * @param {{ fromCache: boolean, hash: string, text?: string }} params
   * @private
   */
  _navigateToResult({ fromCache, hash, text }) {
    const query = `hash=${encodeURIComponent(hash)}&fromCache=${fromCache}`;
    wx.navigateTo({ url: `/pages/result/index?${query}` });
  },

  /**
   * 设置错误状态
   * @param {string} msg
   * @private
   */
  _setError(msg) {
    this.setData({ status: 'error', errorMsg: msg });
    wx.showToast({ title: msg, icon: 'none', duration: 3000 });
  },

  /**
   * 用户点击"重新拍照"按钮，重置状态
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
