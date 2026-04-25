/**
 * @file pages/book/index.js
 * @description 绘本详情页
 *
 * 交互：
 *  - 单击某页 → 导航到 result 页重播
 *  - 左滑某页 → 右侧显示「删除」按钮（SwipeBehavior）
 *  - 长按某页 → 进入拖拽排序模式
 *  - 点「连续播放」→ 从书签页开始，无音频时自动 TTS 合成并缓存
 */

const bookService    = require('../../services/book.service');
const cacheService   = require('../../services/cache.service');
const ttsService     = require('../../services/tts.service');
const SwipeBehavior  = require('../../utils/swipe-behavior');
const { DEFAULT_TTS_VOICE_ID, TTS_VOICES } = require('../../config');

/** 删除按钮宽度 rpx（与 SwipeBehavior 及 WXSS 保持一致） */
const DELETE_REVEAL_RPX = 160;

Page({

  behaviors: [SwipeBehavior],

  data: {
    book: null,
    pages: [],
    loading: true,

    // ── 播放状态 ────────────────────────────────
    /** 'idle' | 'loading' | 'playing' | 'paused' | 'finished' */
    playStatus: 'idle',
    playIndex: -1,
    playText: '',
    /** 合成进度(0-100)，loading 阶段显示 */
    synthProgress: 0,

    // ── 手势：左滑露出删除（由 SwipeBehavior 驱动）──
    swipeX: {},
    swipeOpenKey: -1,   // 整数 index（-1 = 无）

    // ── 手势：拖拽排序 ─────────────────────────
    isDragging: false,
    /** 被拖拽的条目下标 */
    dragIndex: -1,
    /** 拖拽时浮动卡片的 top (px) */
    dragFloatTop: 0,
    /** 当前悬停的目标位置（插入线显示在该位置上方） */
    dragOverIndex: -1,
  },

  _bookId: '',
  /** @type {WechatMiniprogram.InnerAudioContext|null} */
  _audio: null,
  /** 跳过页面时的 setTimeout 句柄，Stop 时需要取消 */
  _skipTimer: null,
  /**
   * 完整文本缓存（不放入 setData，避免大对象推送到渲染层）
   * @type {Object.<number, string>}  { [pageIndex]: fullText }
   */
  _fullTextMap: {},

  // ── 拖拽临时状态 ──
  _isDragging: false,
  _dragItemHeightPx: 88,   // 通过 query 更新
  _listTopPx: 0,
  _scrollTop: 0,           // scroll-view 当前滚动偏移
  _dragOffsetY: 0,         // 手指按下时相对于条目顶部的偏移，让浮动卡片不跳
  _longPressIndex: -1,
  _longPressTimer: null,

  // ─────────────────────────────────────────────
  //  生命周期
  // ─────────────────────────────────────────────

  async onLoad(options) {
    this._swipeInit();   // 缓存屏幕宽度（来自 SwipeBehavior）
    this._bookId = options.bookId || '';
    await this._loadBook();
  },

  onShow() {
    if (this._bookId) this._loadBook();
  },

  onUnload() {
    this._stopAudio();
    ttsService.cancel();
  },

  // ─────────────────────────────────────────────
  //  数据加载
  // ─────────────────────────────────────────────

  async _loadBook() {
    this.setData({ loading: true });
    try {
      const book = await bookService.getBook(this._bookId);
      if (!book) {
        wx.showToast({ title: '绘本不存在', icon: 'none' });
        wx.navigateBack();
        return;
      }

      // fullText 存到实例变量，不进入渲染层（fix #8）
      const fullTextMap = {};
      const pages = await Promise.all(
        book.pages.map(async (hash, index) => {
          const entry = await cacheService.getPage(hash);
          const rawText = entry ? entry.text : '';
          fullTextMap[index] = rawText;
          return {
            index,
            pageHash: hash,
            text: rawText
              ? (rawText.slice(0, 40) + (rawText.length > 40 ? '…' : ''))
              : '（缓存已过期）',
            hasAudio: !!(entry && entry.audioPath),
            isCurrent: index === book.lastPageIndex,
          };
        })
      );
      this._fullTextMap = fullTextMap;

      wx.setNavigationBarTitle({ title: book.title });
      // fix #4: _queryItemHeight 在 setData 回调中执行，确保 DOM 已更新
      this.setData({ book, pages, swipeX: {}, swipeOpenKey: -1, loading: false }, () => {
        this._queryItemHeight();
      });
    } catch (err) {
      console.error('[Book] 加载失败:', err.message);
      this.setData({ loading: false });
      wx.showToast({ title: '加载失败，请重试', icon: 'none' });
    }
  },

  /** 查询第一个条目的高度和列表顶部偏移（在 setData 回调中调用） */
  _queryItemHeight() {
    wx.createSelectorQuery()
      .select('.page-item')
      .boundingClientRect((rect) => {
        if (rect) this._dragItemHeightPx = rect.height;
      })
      .exec();

    wx.createSelectorQuery()
      .select('.list')
      .boundingClientRect((rect) => {
        if (rect) this._listTopPx = rect.top;
      })
      .exec();
  },

  // ─────────────────────────────────────────────
  //  单击 → 进入 result 页
  // ─────────────────────────────────────────────

  onTapPage(e) {
    // 如果有滑动打开的条目，先关闭
    if (this.data.swipeOpenKey !== -1) {
      this._swipeClose();
      return;
    }
    // 拖拽中不响应
    if (this._isDragging) return;

    const { pageHash, pageIndex } = e.currentTarget.dataset;
    const idx = parseInt(pageIndex, 10);
    const fullText = this._fullTextMap[idx];
    if (!fullText) {
      wx.showToast({ title: '缓存已过期，请重新识别', icon: 'none' });
      return;
    }

    wx.navigateTo({
      url: `/src/pages/result/index?hash=${encodeURIComponent(pageHash)}&fromCache=true&bookId=${this._bookId}&pageIndex=${pageIndex}`,
      success(res) {
        res.eventChannel.emit('ocrData', {
          text: fullText,
          fromCache: true,
          hash: pageHash,
        });
      },
    });
  },

  // ─────────────────────────────────────────────
  //  连续播放
  // ─────────────────────────────────────────────

  onTapContinue() {
    const { book } = this.data;
    if (!book || book.pages.length === 0) return;
    const startIdx = book.lastPageIndex >= 0 ? book.lastPageIndex : 0;
    this._playPage(startIdx);
  },

  onTapPlayFromStart() {
    this._playPage(0);
  },

  /** 点击某页右侧的 ▶ 按钮，从该页开始连续播放 */
  onTapPlayFrom(e) {
    const idx = parseInt(e.currentTarget.dataset.pageIndex, 10);
    this._playPage(idx);
  },

  async _playPage(index) {
    const { pages, book } = this.data;

    if (!book || index < 0 || index >= pages.length) {
      this.setData({ playStatus: 'finished', playIndex: Math.max(0, index - 1) });
      this._stopAudio();
      wx.showToast({ title: '全部播放完毕 🎉', icon: 'none' });
      return;
    }

    const page = pages[index];
    this.setData({ playStatus: 'loading', playIndex: index, playText: page.text, synthProgress: 0 });

    // 更新书签
    try { await bookService.updateBookmark(this._bookId, index); } catch (_) {}

    // 刷新 isCurrent 标记
    this.setData({
      pages: pages.map((p) => ({ ...p, isCurrent: p.index === index })),
    });

    // 获取或合成音频
    const entry = await cacheService.getPage(page.pageHash);
    let audioPath = entry && entry.audioPath;

    if (!audioPath) {
      // ── 自动合成 TTS ──────────────────────────
      const text = entry && entry.text;
      if (!text) {
        wx.showToast({ title: `第 ${index + 1} 页缓存已过期，跳过`, icon: 'none', duration: 1200 });
        // fix #2: 保存句柄，Stop 时可取消
        this._skipTimer = setTimeout(() => this._playPage(index + 1), 1400);
        return;
      }

      wx.showToast({ title: `第 ${index + 1} 页合成中…`, icon: 'loading', duration: 5000 });

      try {
        const voice = TTS_VOICES.find(v => v.id === DEFAULT_TTS_VOICE_ID) || TTS_VOICES[0];
        audioPath = await ttsService.synthesize(text, {
          onProgress: (pct) => this.setData({ synthProgress: pct }),
          voice: { vcn: voice.vcn, speed: voice.speed },
        });

        // 写入缓存
        await cacheService.updateAudioPath(page.pageHash, audioPath);
        wx.hideToast();

        // 更新列表 hasAudio 标记
        const updatedPages = this.data.pages.map((p) =>
          p.index === index ? { ...p, hasAudio: true } : p
        );
        this.setData({ pages: updatedPages });
      } catch (err) {
        console.error('[Book] TTS 合成失败:', err.message);
        wx.showToast({ title: `第 ${index + 1} 页合成失败，跳过`, icon: 'none', duration: 1200 });
        // fix #2: 保存句柄，Stop 时可取消
        this._skipTimer = setTimeout(() => this._playPage(index + 1), 1400);
        return;
      }
    }

    this._stopAudio();

    // iOS 音频路由重新配置是异步的：必须等 success 回调后再创建 context 并播放
    wx.setInnerAudioOption({
      speakerOn: true,
      success: () => {
        const audio = wx.createInnerAudioContext();
        this._audio = audio;
        audio.obeyMuteSwitch = false;
        audio.src = audioPath;
        audio.autoplay = true;
        this.setData({ playStatus: 'playing' });

        audio.onEnded(() => { this._playPage(index + 1); });
        audio.onError((err) => {
          console.error('[Book] 音频播放出错:', err);
          wx.showToast({ title: `第 ${index + 1} 页播放失败，跳过`, icon: 'none', duration: 1200 });
          this._skipTimer = setTimeout(() => this._playPage(index + 1), 1400);
        });
      },
      fail: () => {
        // 降级：直接播放
        const audio = wx.createInnerAudioContext();
        this._audio = audio;
        audio.obeyMuteSwitch = false;
        audio.src = audioPath;
        audio.autoplay = true;
        this.setData({ playStatus: 'playing' });
        audio.onEnded(() => { this._playPage(index + 1); });
        audio.onError((err) => {
          console.error('[Book] 音频播放出错(降级):', err);
          this._skipTimer = setTimeout(() => this._playPage(index + 1), 1400);
        });
      },
    });
  },

  onTapTogglePause() {
    const { playStatus } = this.data;
    if (!this._audio) return;
    if (playStatus === 'playing') {
      this._audio.pause();
      this.setData({ playStatus: 'paused' });
    } else if (playStatus === 'paused') {
      this._audio.play();
      this.setData({ playStatus: 'playing' });
    }
  },

  onTapPrev() {
    const { playIndex } = this.data;
    if (playIndex <= 0) return;
    this._stopAudio();
    this._playPage(playIndex - 1);
  },

  onTapNext() {
    const { playIndex, pages } = this.data;
    if (playIndex >= pages.length - 1) return;
    this._stopAudio();
    this._playPage(playIndex + 1);
  },

  onTapStop() {
    this._stopAudio();
    ttsService.cancel();
    this.setData({ playStatus: 'idle', playIndex: -1, playText: '' });
  },

  _stopAudio() {
    // fix #2: 取消 skip 计时器，防止 Stop 后幽灵跳转
    if (this._skipTimer) {
      clearTimeout(this._skipTimer);
      this._skipTimer = null;
    }
    if (this._audio) {
      try { this._audio.stop(); this._audio.destroy(); } catch (_) {}
      this._audio = null;
    }
  },

  // ─────────────────────────────────────────────
  //  手势：左滑露出删除（SwipeBehavior 提供核心逻辑）
  //  WXML 中将 bindtouchstart/move/end 改为 onSwipeTouchStart/Move/End
  //  并在每个可滑动条目上加 data-swipe-key="{{item.index}}"
  // ─────────────────────────────────────────────

  onItemTouchStart(e) {
    if (this._isDragging) return;

    // 转发给 SwipeBehavior
    this.onSwipeTouchStart(e);

    const touch = e.touches[0];
    const idx = parseInt(e.currentTarget.dataset.pageIndex, 10);

    // 长按定时器（500ms）→ 拖拽排序
    this._longPressTimer = setTimeout(() => {
      // 已判定为滑动方向则不启动拖拽
      if (this._swipe_direction === 'v' || this._swipe_direction === 'h') return;
      wx.createSelectorQuery()
        .selectAll('.page-item')
        .boundingClientRect((rects) => {
          if (rects && rects[idx]) {
            const rect = rects[idx];
            this._dragOffsetY = touch.clientY - rect.top;
            this._startDrag(idx, rect.top);
          } else {
            this._startDrag(idx, touch.clientY - this._dragOffsetY);
          }
        })
        .exec();
    }, 500);
  },

  onItemTouchMove(e) {
    if (this._isDragging) {
      this._onDragMove(e.touches[0].clientY);
      return;
    }
    // 转发给 SwipeBehavior（内部会取消长按若已判定为横向）
    this.onSwipeTouchMove(e);
    // 横向滑动确认后取消长按
    if (this._swipe_direction === 'h' && this._longPressTimer) {
      clearTimeout(this._longPressTimer);
      this._longPressTimer = null;
    }
  },

  onItemTouchEnd(e) {
    if (this._longPressTimer) {
      clearTimeout(this._longPressTimer);
      this._longPressTimer = null;
    }
    if (this._isDragging) {
      this._endDrag();
      return;
    }
    this.onSwipeTouchEnd(e);
  },

  /** 点击「删除」按钮 */
  async onTapDeletePage(e) {
    const { pageHash } = e.currentTarget.dataset;
    this._swipeClose();

    const confirmed = await new Promise((resolve) => {
      wx.showModal({
        title: '移出绘本',
        content: '将此页从绘本中移除（缓存数据保留）？',
        confirmText: '移除',
        confirmColor: '#E53935',
        success: (res) => resolve(res.confirm),
      });
    });
    if (!confirmed) return;

    try {
      await bookService.removePage(this._bookId, pageHash);
      await this._loadBook();
    } catch (err) {
      wx.showToast({ title: '删除失败', icon: 'none' });
    }
  },

  // ─────────────────────────────────────────────
  //  手势：长按拖拽排序
  // ─────────────────────────────────────────────

  _startDrag(index, itemFloatTop) {
    this._isDragging = true;
    this._longPressIndex = index;
    wx.vibrateShort({ type: 'heavy' });

    this.setData({
      isDragging: true,
      dragIndex: index,
      dragOverIndex: index,
      dragFloatTop: itemFloatTop,
    });
  },

  _onDragMove(clientY) {
    const { pages } = this.data;
    const h = this._dragItemHeightPx;

    const floatTop = clientY - this._dragOffsetY;
    const relY = floatTop - this._listTopPx + this._scrollTop + h / 2;
    let overIndex = Math.floor(relY / h);
    overIndex = Math.max(0, Math.min(pages.length - 1, overIndex));

    this.setData({ dragFloatTop: floatTop, dragOverIndex: overIndex });
  },

  _endDrag() {
    const { dragIndex, dragOverIndex } = this.data;
    this._isDragging = false;

    this.setData({ isDragging: false, dragIndex: -1, dragOverIndex: -1 });

    if (dragIndex !== dragOverIndex && dragIndex !== -1) {
      bookService.movePage(this._bookId, dragIndex, dragOverIndex)
        .then(() => this._loadBook())
        .catch(() => wx.showToast({ title: '移动失败', icon: 'none' }));
    }
  },

  onListScroll(e) {
    this._scrollTop = e.detail.scrollTop;
  },

  onDragOverlayMove(e) {
    if (!this._isDragging) return;
    this._onDragMove(e.touches[0].clientY);
  },

  onDragOverlayEnd() {
    if (this._isDragging) this._endDrag();
  },
});
