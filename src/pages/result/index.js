/**
 * @file pages/result/index.js
 * @description 绘本朗读助手 - 识别结果页
 *
 * 职责：
 *  1. 展示 OCR 识别出的文字内容
 *  2. 提供"朗读"按钮，触发 TTS 播放（流式接收 MP3）
 *  3. 显示当前内容的缓存状态（已缓存 / 未缓存 / 缓存中）
 *  4. 支持播放/暂停/重播控制
 *  5. TTS 完成后将音频路径写回缓存
 *
 * URL 参数：
 *  - hash       {string}  图片指纹，用于读取缓存
 *  - fromCache  {string}  '0'|'1'，是否来自缓存命中
 *
 * 依赖：
 *  - services/tts.service.js    TTS 合成与播放
 *  - services/cache.service.js  缓存读取 & 音频路径回写
 *  - utils/network.js           在线状态
 *
 * @author Jamie Park
 * @version 0.1.0
 */

const ttsService = require('../../services/tts.service');
const cacheService = require('../../services/cache.service');
const network = require('../../utils/network');

/** 内置背景音乐管理器，用于播放 TTS 生成的 MP3 */
const innerAudioCtx = wx.createInnerAudioContext();

Page({

  // ─────────────────────────────────────────────
  //  数据层
  // ─────────────────────────────────────────────
  data: {
    /** 图片指纹 */
    hash: '',
    /** 是否来自缓存命中 */
    fromCache: false,
    /** OCR 识别文字 */
    ocrText: '',
    /**
     * 缓存状态
     * none | cached | saving
     */
    cacheStatus: 'none',
    /**
     * 播放状态机
     * idle | loading | playing | paused | error
     */
    playStatus: 'idle',
    /** TTS 合成进度（0-100） */
    ttsProgress: 0,
    /** 本地 MP3 路径（缓存时从 cacheService 获取） */
    audioPath: '',
    /** 播放时长（秒） */
    duration: 0,
    /** 当前播放位置（秒） */
    currentTime: 0,
    /** 错误信息 */
    errorMsg: '',
  },

  // ─────────────────────────────────────────────
  //  生命周期
  // ─────────────────────────────────────────────

  /**
   * 接收上一页传来的 hash / fromCache 参数，加载内容
   * @param {{ hash: string, fromCache: string }} options
   */
  async onLoad(options) {
    const hash = decodeURIComponent(options.hash || '');
    const fromCache = options.fromCache === 'true';

    this.setData({ hash, fromCache });

    // 从缓存服务读取文字 & 音频路径
    await this._loadPageData(hash);

    // 注册音频上下文事件
    this._setupAudioContext();
  },

  onUnload() {
    // 销毁音频上下文，释放系统资源
    innerAudioCtx.destroy();
    // TODO: 若 TTS 正在合成，调用 ttsService.cancel() 终止 WebSocket
  },

  // ─────────────────────────────────────────────
  //  数据加载
  // ─────────────────────────────────────────────

  /**
   * 从缓存服务加载页面数据（文字 + 音频路径）
   * @param {string} hash
   * @private
   */
  async _loadPageData(hash) {
    try {
      const page = await cacheService.getPage(hash);
      if (page) {
        this.setData({
          ocrText: page.text || '',
          audioPath: page.audioPath || '',
          cacheStatus: 'cached',
        });
      } else {
        // 缓存中无此条目（理论上不应出现，OCR完成后已写入）
        console.warn('[Result] 缓存中未找到 hash:', hash);
        this.setData({ cacheStatus: 'none' });
      }
    } catch (err) {
      console.error('[Result] 加载页面数据失败', err);
    }
  },

  // ─────────────────────────────────────────────
  //  TTS 播放
  // ─────────────────────────────────────────────

  /**
   * 点击"朗读"按钮
   * - 若已有本地音频缓存 → 直接播放
   * - 若无缓存且在线    → TTS 合成后播放
   * - 若无缓存且离线    → 提示错误
   */
  async onTapPlay() {
    const { playStatus, audioPath, ocrText } = this.data;

    // 暂停/继续切换
    if (playStatus === 'playing') {
      innerAudioCtx.pause();
      this.setData({ playStatus: 'paused' });
      return;
    }
    if (playStatus === 'paused') {
      innerAudioCtx.play();
      this.setData({ playStatus: 'playing' });
      return;
    }

    // 有本地音频路径，直接播放
    if (audioPath) {
      this._playAudio(audioPath);
      return;
    }

    // 无音频，需要合成
    if (!network.isOnline()) {
      this.setData({ errorMsg: '离线状态下无法合成语音', playStatus: 'error' });
      wx.showToast({ title: '请联网后重试', icon: 'none' });
      return;
    }

    await this._synthesizeAndPlay(ocrText);
  },

  /**
   * 调用 TTS 服务合成语音，完成后播放并写入缓存
   * @param {string} text - 待合成文本
   * @private
   */
  async _synthesizeAndPlay(text) {
    if (!text || !text.trim()) {
      wx.showToast({ title: '文字内容为空，无法朗读', icon: 'none' });
      return;
    }

    this.setData({ playStatus: 'loading', ttsProgress: 0 });

    try {
      // TODO: 调用 ttsService.synthesize，流式接收 MP3 并写入本地文件
      const localPath = await ttsService.synthesize(text, {
        onProgress: (pct) => this.setData({ ttsProgress: pct }),
      });

      // 合成完成，将音频路径写回缓存
      this.setData({ audioPath: localPath, cacheStatus: 'saving' });
      await this._saveAudioToCache(localPath);

      this._playAudio(localPath);
    } catch (err) {
      console.error('[Result] TTS 合成失败', err);
      this.setData({ playStatus: 'error', errorMsg: err.message || 'TTS 失败' });
      wx.showToast({ title: '语音合成失败，请重试', icon: 'none' });
    }
  },

  /**
   * 将合成好的音频路径回写到缓存条目
   * @param {string} audioPath
   * @private
   */
  async _saveAudioToCache(audioPath) {
    try {
      // TODO: await cacheService.updateAudioPath(this.data.hash, audioPath);
      this.setData({ cacheStatus: 'cached' });
    } catch (err) {
      console.warn('[Result] 音频路径写回缓存失败', err);
      this.setData({ cacheStatus: 'none' });
    }
  },

  /**
   * 使用 innerAudioContext 播放本地 MP3
   * @param {string} filePath - 本地文件路径
   * @private
   */
  _playAudio(filePath) {
    innerAudioCtx.src = filePath;
    innerAudioCtx.play();
    this.setData({ playStatus: 'playing' });
  },

  /**
   * 重播（回到起点）
   */
  onTapReplay() {
    // TODO: innerAudioCtx.seek(0); innerAudioCtx.play();
    this.setData({ playStatus: 'playing', currentTime: 0 });
  },

  // ─────────────────────────────────────────────
  //  音频上下文事件
  // ─────────────────────────────────────────────

  /**
   * 设置 innerAudioContext 的各类回调
   * @private
   */
  _setupAudioContext() {
    innerAudioCtx.onPlay(() => {
      // TODO: this.setData({ playStatus: 'playing' });
    });

    innerAudioCtx.onPause(() => {
      // TODO: this.setData({ playStatus: 'paused' });
    });

    innerAudioCtx.onEnded(() => {
      this.setData({ playStatus: 'idle', currentTime: 0 });
    });

    innerAudioCtx.onTimeUpdate(() => {
      // 每 500ms 触发一次，更新进度
      // TODO: this.setData({ currentTime: innerAudioCtx.currentTime, duration: innerAudioCtx.duration });
    });

    innerAudioCtx.onError((err) => {
      console.error('[Result] 音频播放错误', err);
      this.setData({ playStatus: 'error', errorMsg: '播放出错' });
    });
  },
});
