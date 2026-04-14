/**
 * @file pages/result/index.js
 * @description 绘本朗读助手 - 识别结果页
 *
 * 职责：
 *  1. 通过 EventChannel 接收来自 guide 页的 OCR 文字（P1-2）
 *  2. 展示识别文字内容
 *  3. 控制 TTS 合成与音频播放（状态机：idle → loading → playing → finished/error）
 *  4. Phase 2: 声音切换面板（底部 sheet 弹窗，切换后立即重播）
 *
 * 已修复问题：
 *  - P1-2: 改用 getOpenerEventChannel().on('ocrData') 接收文字，避免 URL 超 1024 字符限制
 *  - P1-3: TTS synthesize() 支持 onPlayStart 回调，合成完开始播放时切换 PLAYING 状态
 *           用户在合成完成后即可点击"暂停"按钮
 *
 * Phase 2 声音切换：
 *  - 底部 sheet 弹窗（showVoiceSheet 控制显示）
 *  - 3 个声音角色：xiaoyan（小燕）、aisjiuxu（爱思）、aisjinger（爱晶）
 *  - 切换后立即 cancel 当前播放，用新声音重新合成
 *
 * 状态机：
 *  idle       - 未开始（显示"朗读"按钮）
 *  loading    - TTS 合成中（显示进度条，按钮禁用）
 *  playing    - 播放中（显示"暂停"按钮，P1-3 修复）
 *  paused     - 已暂停（显示"继续"按钮）
 *  finished   - 播放完毕（显示"重新朗读"按钮）
 *  error      - 出错（显示"重试"按钮）
 *
 * @author Jamie Park
 * @version 0.2.0
 */

const ttsService   = require('../../services/tts.service');
const cacheService = require('../../services/cache.service');
const { TTS_VOICES, DEFAULT_TTS_VOICE_ID } = require('../../config');

// ─────────────────────────────────────────────────────────────────
//  页面配置
// ─────────────────────────────────────────────────────────────────

Page({

  // ─────────────────────────────────────────────
  //  数据层
  // ─────────────────────────────────────────────
  data: {
    // ── OCR 数据 ──────────────────────────────
    /** 识别到的原始文字 */
    ocrText: '',
    /** 图片内容哈希（用于缓存更新） */
    imageHash: '',
    /** 是否来自缓存（显示"来自缓存"标签） */
    fromCache: false,
    /** 缓存状态：'none' | 'saving' | 'cached' */
    cacheStatus: 'none',

    // ── 播放状态 ───────────────────────────────
    /**
     * 播放状态机
     * 'idle' | 'loading' | 'playing' | 'paused' | 'finished' | 'error'
     */
    playStatus: 'idle',
    /** TTS 合成进度 0-100（loading 状态显示） */
    ttsProgress: 0,
    /** 错误信息（error 状态显示） */
    errorMsg: '',

    // ── 音频进度 ───────────────────────────────
    /** 当前播放时间（秒） */
    currentTime: 0,
    /** 音频总时长（秒） */
    duration: 0,
    /** 当前时间格式化字符串，如 "0:12" */
    currentTimeLabel: '0:00',
    /** 总时长格式化字符串 */
    durationLabel: '0:00',
    /** 本地 MP3 文件路径 */
    audioPath: '',

    // ── Phase 2: 声音切换面板 ──────────────────
    /** 声音选择器面板是否显示 */
    showVoiceSheet: false,
    /** 当前选中的声音 ID */
    selectedVoiceId: DEFAULT_TTS_VOICE_ID,
    /** 声音列表（来自 config.TTS_VOICES） */
    voices: TTS_VOICES,
    /** 当前选中的声音对象（P1-A: 避免 WXML 中 findIndex 越界） */
    selectedVoice: null,
  },

  // ─────────────────────────────────────────────
  //  生命周期
  // ─────────────────────────────────────────────

  /**
   * 页面加载
   * P1-2: 从 URL 取轻量参数，通过 EventChannel 接收 OCR 文字
   *
   * @param {object} options - 页面 URL 参数
   * @param {string} options.hash      - 图片哈希，用于缓存更新
   * @param {string} options.fromCache - '1'|'true' 表示来自缓存
   */
  onLoad(options) {
    const { hash = '', fromCache = '' } = options;
    const isCached = fromCache === 'true' || fromCache === '1';

    this.setData({
      imageHash: hash,
      fromCache: isCached,
      cacheStatus: isCached ? 'cached' : 'none',
    });

    // P1-2: 通过 EventChannel 接收 guide 页 emit 的 ocrData
    this._receiveOcrData();
    // P1-A: 初始化时同步 selectedVoice
    this._syncSelectedVoice();
  },

  /**
   * 页面卸载：释放音频资源
   */
  onUnload() {
    this._destroyAudio();
    ttsService.cancel();
  },

  // ─────────────────────────────────────────────
  //  P1-2: EventChannel 接收 OCR 数据
  // ─────────────────────────────────────────────

  /**
   * 通过 EventChannel 接收 guide 页传递的 ocrData
   *
   * 为什么改 EventChannel：
   *  - 原 URL 传参：encodeURIComponent(text) 拼入 URL，超过 1024 字节时被微信截断
   *  - 新 EventChannel：emit/on 方式传输 JS 对象，无大小限制
   *
   * @private
   */
  _receiveOcrData() {
    try {
      const eventChannel = this.getOpenerEventChannel();
      eventChannel.on('ocrData', (data) => {
        const { text = '', fromCache, hash } = data;
        const updates = { ocrText: text };

        if (fromCache) {
          updates.cacheStatus = 'cached';
        }
        if (hash) {
          updates.imageHash = hash;
        }

        this.setData(updates);
        console.info('[Result] 收到 OCR 数据，文字长度:', text.length);
      });
    } catch (err) {
      // 直接打开 result 页时无 EventChannel，非致命错误
      console.warn('[Result] getOpenerEventChannel 不可用（可能是直接打开）:', err.message);
    }
  },

  // ─────────────────────────────────────────────
  //  TTS 控制
  // ─────────────────────────────────────────────

  /**
   * 点击主播放按钮
   * 根据当前状态决定行为：
   *  idle     → 开始合成播放
   *  loading  → 禁用（UI 已 disabled）
   *  playing  → 暂停
   *  paused   → 继续
   *  finished → 重播
   *  error    → 重试
   */
  onTapPlay() {
    const { playStatus, audioPath, ocrText } = this.data;

    if (playStatus === 'idle' || playStatus === 'error') {
      this._startPlayback(ocrText);
    } else if (playStatus === 'playing') {
      this._pausePlayback();
    } else if (playStatus === 'paused') {
      this._resumePlayback();
    } else if (playStatus === 'finished') {
      this._replayFromStart();
    }
  },

  /**
   * 点击"↩ 从头朗读"按钮（playing 状态时显示）
   */
  onTapReplay() {
    this._replayFromStart();
  },

  /**
   * 开始 TTS 合成并播放
   * @param {string} text - 待合成文字
   * @private
   */
  async _startPlayback(text) {
    if (!text || !text.trim()) {
      this.setData({ playStatus: 'error', errorMsg: '识别文字为空，无法朗读' });
      return;
    }

    // 如果有已合成的音频路径，直接播放（跳过 TTS 合成）
    if (this.data.audioPath) {
      this._playAudio(this.data.audioPath);
      return;
    }

    this.setData({ playStatus: 'loading', ttsProgress: 0, errorMsg: '' });

    try {
      const { selectedVoiceId, voices, imageHash } = this.data;

      // 找到当前选中的声音配置
      const voiceConfig = voices.find(v => v.id === selectedVoiceId) || voices[0];

      const localPath = await ttsService.synthesize(text, {
        onProgress: (pct) => this.setData({ ttsProgress: pct }),
        /**
         * P1-3: onPlayStart 回调
         * 合成完成、即将开始播放时，TTS Service 调用此回调
         * 上层立即将状态切换到 'playing'，用户此时可点击"暂停"
         * 不再等到音频加载完才切换（原来 loading → playing 延迟过长）
         */
        onPlayStart: () => {
          this.setData({ playStatus: 'playing' });
        },
        voice: {
          vcn: voiceConfig.vcn,
          speed: voiceConfig.speed,
        },
      });

      // 将音频路径写回缓存
      if (imageHash) {
        this.setData({ cacheStatus: 'saving' });
        await cacheService.updateAudioPath(imageHash, localPath);
        this.setData({ cacheStatus: 'cached' });
      }

      this.setData({ audioPath: localPath });
      this._playAudio(localPath);

    } catch (err) {
      console.error('[Result] TTS 合成失败:', err.message);
      this.setData({
        playStatus: 'error',
        errorMsg: err.message || 'TTS 合成失败，请重试',
      });
    }
  },

  /**
   * 使用 InnerAudioContext 播放 MP3 文件
   * @param {string} filePath - 本地 MP3 文件路径
   * @private
   */
  _playAudio(filePath) {
    // 销毁旧的 Audio 实例
    this._destroyAudio();

    const audio = wx.createInnerAudioContext();
    audio.src = filePath;
    audio.autoplay = false;

    // 监听 canplay，首次加载成功后开始播放
    audio.onCanplay(() => {
      audio.play();
    });

    // 时间更新
    audio.onTimeUpdate(() => {
      const cur = audio.currentTime;
      const dur = audio.duration;
      this.setData({
        currentTime: cur,
        duration: dur,
        currentTimeLabel: _formatTime(cur),
        durationLabel: _formatTime(dur),
      });
    });

    // 播放结束
    audio.onEnded(() => {
      this.setData({ playStatus: 'finished' });
    });

    // 播放出错
    audio.onError((err) => {
      console.error('[Result] 音频播放出错:', err);
      this.setData({
        playStatus: 'error',
        errorMsg: '音频播放出错：' + (err.errMsg || JSON.stringify(err)),
      });
    });

    this._audioCtx = audio;
    // P1-3: 如果 onPlayStart 已将状态切换为 playing，这里保持不变
    // 否则在此设置（兜底）
    if (this.data.playStatus !== 'playing') {
      this.setData({ playStatus: 'playing' });
    }
  },

  /**
   * 暂停播放
   * @private
   */
  _pausePlayback() {
    if (this._audioCtx) {
      this._audioCtx.pause();
      this.setData({ playStatus: 'paused' });
    }
  },

  /**
   * 继续播放
   * @private
   */
  _resumePlayback() {
    if (this._audioCtx) {
      this._audioCtx.play();
      this.setData({ playStatus: 'playing' });
    }
  },

  /**
   * 从头重播（seek 到 0 再 play）
   * @private
   */
  _replayFromStart() {
    if (this._audioCtx) {
      this._audioCtx.seek(0);
      this._audioCtx.play();
      this.setData({ playStatus: 'playing' });
    }
  },

  /**
   * 销毁 InnerAudioContext，释放系统音频资源
   * @private
   */
  _destroyAudio() {
    if (this._audioCtx) {
      try {
        this._audioCtx.stop();
        this._audioCtx.destroy();
      } catch (_) {
        // 忽略销毁时的错误
      }
      this._audioCtx = null;
    }
  },

  // ─────────────────────────────────────────────
  //  Phase 2: 声音切换面板
  // ─────────────────────────────────────────────

  /**
   * 点击底部声音切换按钮，显示/隐藏声音选择 Sheet
   */
  onTapVoiceToggle() {
    this.setData({ showVoiceSheet: !this.data.showVoiceSheet });
  },

  /**
   * 点击遮罩层，关闭声音选择 Sheet
   */
  onTapVoiceSheetMask() {
    this.setData({ showVoiceSheet: false });
  },

  /**
   * P0-A: 防止声音选择 Sheet 遮罩层滑动穿透
   * catchtouchmove 事件处理器，空函数即可阻止冒泡
   */
  onVoiceSheetPrevent() {},

  /**
   * P1-A: 同步 selectedVoice 数据到 data
   * 从 voices 数组中找到 selectedVoiceId 对应的声音对象，
   * 避免 WXML 中使用 findIndex 时越界（findIndex 返回 -1 时 voices[-1] 为 undefined）
   * @private
   */
  _syncSelectedVoice() {
    const voice = (this.data.voices || []).find(v => v.id === this.data.selectedVoiceId)
      || (this.data.voices || [])[0]
      || null;
    this.setData({ selectedVoice: voice });
  },

  /**
   * 选择一个声音角色
   * 切换后：立即停止当前播放，清除已缓存的音频路径，用新声音重新合成
   *
   * @param {WechatMiniprogram.CustomEvent} e - detail.voiceId: string
   */
  onTapSelectVoice(e) {
    const { voiceId } = e.currentTarget.dataset;
    if (!voiceId) return;

    const { selectedVoiceId, ocrText } = this.data;

    if (voiceId === selectedVoiceId) {
      // 选了同一个声音，关闭面板即可
      this.setData({ showVoiceSheet: false });
      return;
    }

    // 停止当前播放，清除旧音频路径（强制用新声音重新合成）
    ttsService.cancel();
    this._destroyAudio();

    this.setData({
      selectedVoiceId: voiceId,
      audioPath: '',        // 清除旧音频，触发重新合成
      playStatus: 'idle',
      ttsProgress: 0,
      currentTime: 0,
      duration: 0,
      currentTimeLabel: '0:00',
      durationLabel: '0:00',
      showVoiceSheet: false,
    });

    // P1-A: 切换声音后同步 selectedVoice
    this._syncSelectedVoice();

    // 立即用新声音开始播放
    if (ocrText && ocrText.trim()) {
      this._startPlayback(ocrText);
    }
  },
});

// ─────────────────────────────────────────────────────────────────
//  工具函数
// ─────────────────────────────────────────────────────────────────

/**
 * 将秒数格式化为 "m:ss" 形式，如 65 → "1:05"
 * @param {number} seconds - 秒数（可能含小数）
 * @returns {string}
 */
function _formatTime(seconds) {
  if (!seconds || isNaN(seconds)) return '0:00';
  const s = Math.floor(seconds);
  const min = Math.floor(s / 60);
  const sec = s % 60;
  return `${min}:${sec.toString().padStart(2, '0')}`;
}
