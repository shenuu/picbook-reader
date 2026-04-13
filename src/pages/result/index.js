/**
 * @file pages/result/index.js
 * @description 绘本朗读助手 - 识别结果页
 *
 * 职责：
 *  1. 展示 OCR 识别出的文字内容
 *  2. 提供"朗读"按钮，触发 TTS 播放（讯飞流式 WebSocket → 本地 MP3）
 *  3. 显示当前内容的缓存状态（已缓存 / 未缓存 / 保存中）
 *  4. 支持播放/暂停/重播控制
 *  5. TTS 完成后将音频路径写回缓存
 *
 * URL 参数：
 *  - hash       {string}  图片指纹，用于读取缓存
 *  - fromCache  {string}  'true'|'false'，是否来自缓存命中
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
     * 播放状态机（4状态）
     * idle | loading | playing | finished
     * （另有内部的 paused 状态，可从 playing 切换，不单独在 UI 分类）
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
    /** 格式化后的当前时间标签，如 "01:23" */
    currentTimeLabel: '00:00',
    /** 格式化后的总时长标签 */
    durationLabel: '00:00',
    /** 错误信息 */
    errorMsg: '',
  },

  // ─────────────────────────────────────────────
  //  私有引用（不放进 data，避免触发不必要的 setData 代价）
  // ─────────────────────────────────────────────

  /** @type {WechatMiniprogram.InnerAudioContext} */
  _audioCtx: null,

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

    // 创建音频上下文（每个页面实例独立创建，不使用模块级全局变量）
    this._audioCtx = wx.createInnerAudioContext();
    this._setupAudioContext();

    // 从缓存服务读取文字 & 音频路径
    await this._loadPageData(hash);
  },

  /**
   * 页面卸载：销毁音频上下文，取消正在进行的 TTS 合成
   */
  onUnload() {
    // 销毁音频上下文，释放系统资源（避免后台持续占用）
    if (this._audioCtx) {
      this._audioCtx.destroy();
      this._audioCtx = null;
    }
    // 若 TTS WebSocket 仍在合成，主动关闭
    ttsService.cancel();
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
   * 点击"朗读"按钮（状态机驱动）
   *
   * - idle / finished → 若有音频则直接播放；否则合成后再播
   * - loading         → 忽略（合成中）
   * - playing         → 暂停
   * - paused          → 继续播放
   * - error           → 重新尝试合成
   */
  async onTapPlay() {
    const { playStatus, audioPath, ocrText } = this.data;

    switch (playStatus) {
      case 'playing':
        // 暂停（未列入 4 状态 UI 枚举，但保留内部状态支持）
        this._audioCtx.pause();
        this.setData({ playStatus: 'idle' }); // UI 回到 idle，显示播放按钮
        return;

      case 'loading':
        // 合成中，不响应点击
        return;

      default:
        break;
    }

    // idle / finished / error 状态：开始或重新播放
    if (audioPath) {
      // 已有本地音频，直接播放（支持重播）
      this._playAudio(audioPath);
      return;
    }

    // 需要合成语音
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

    this.setData({ playStatus: 'loading', ttsProgress: 0, errorMsg: '' });

    try {
      // 流式 TTS：BFF 签名 URL → WebSocket → 逐帧接收 Base64 → 写入本地 MP3
      const localPath = await ttsService.synthesize(text, {
        onProgress: (pct) => this.setData({ ttsProgress: pct }),
      });

      // 合成完成：将音频路径持久化到缓存（下次直接播放，无需重新合成）
      this.setData({ audioPath: localPath, cacheStatus: 'saving' });
      await this._saveAudioToCache(localPath);

      // 立即播放
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
      await cacheService.updateAudioPath(this.data.hash, audioPath);
      this.setData({ cacheStatus: 'cached' });
    } catch (err) {
      console.warn('[Result] 音频路径写回缓存失败', err);
      this.setData({ cacheStatus: 'none' });
    }
  },

  /**
   * 使用 innerAudioContext 播放本地 MP3
   * 每次调用都从头开始（seek(0)）以支持重播
   *
   * @param {string} filePath - 本地文件路径
   * @private
   */
  _playAudio(filePath) {
    if (!this._audioCtx) return;
    this._audioCtx.src = filePath;
    this._audioCtx.seek(0);
    this._audioCtx.play();
    this.setData({ playStatus: 'playing', currentTime: 0 });
  },

  /**
   * 重播（回到起点继续播放）
   * 仅在 finished 状态下由 UI 按钮触发
   */
  onTapReplay() {
    const { audioPath } = this.data;
    if (audioPath && this._audioCtx) {
      this._audioCtx.seek(0);
      this._audioCtx.play();
      this.setData({ playStatus: 'playing', currentTime: 0 });
    }
  },

  // ─────────────────────────────────────────────
  //  音频上下文事件
  // ─────────────────────────────────────────────

  /**
   * 设置 innerAudioContext 的各类回调
   * 在 onLoad 中的 _audioCtx 创建后立即调用
   * @private
   */
  _setupAudioContext() {
    const ctx = this._audioCtx;
    if (!ctx) return;

    // 音频开始/恢复播放
    ctx.onPlay(() => {
      this.setData({ playStatus: 'playing' });
    });

    // 音频暂停
    ctx.onPause(() => {
      // 不强制设置 playStatus，由 onTapPlay 驱动状态机
    });

    // 音频自然播放完毕 → 进入 finished 状态，显示重播按钮
    ctx.onEnded(() => {
      this.setData({ playStatus: 'finished', currentTime: 0 });
    });

    // 进度更新（约每 500ms 触发一次）
    ctx.onTimeUpdate(() => {
      const currentTime = ctx.currentTime || 0;
      const duration    = ctx.duration    || 0;
      this.setData({
        currentTime,
        duration,
        currentTimeLabel: _formatTime(currentTime),
        durationLabel:    _formatTime(duration),
      });
    });

    // 播放出错
    ctx.onError((err) => {
      console.error('[Result] 音频播放错误', err);
      this.setData({ playStatus: 'error', errorMsg: '播放出错，请重试' });
    });
  },
});

// ─────────────────────────────────────────────────────────────────
//  页面级工具函数（在 Page() 外，供 _setupAudioContext 内调用）
// ─────────────────────────────────────────────────────────────────

/**
 * 将秒数格式化为 mm:ss 字符串
 * @param {number} totalSeconds
 * @returns {string} 如 "01:23" 或 "00:00"
 */
function _formatTime(totalSeconds) {
  const s = Math.floor(totalSeconds || 0);
  const mm = Math.floor(s / 60).toString().padStart(2, '0');
  const ss = (s % 60).toString().padStart(2, '0');
  return `${mm}:${ss}`;
}
