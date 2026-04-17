/**
 * @file pages/book/index.js
 * @description 绘本详情页 - 展示某本绘本的所有页，支持翻页阅读和书签继续
 *
 * @author Jamie Park
 * @version 1.0.0
 */

const bookService  = require('../../services/book.service');
const cacheService = require('../../services/cache.service');

Page({

  data: {
    /** @type {BookEntry|null} */
    book: null,
    /**
     * 页面摘要列表
     * @type {{ index: number, pageHash: string, text: string, hasAudio: boolean, isCurrent: boolean }[]}
     */
    pages: [],
    loading: true,
  },

  /** 保存当前 bookId，onShow 刷新时用 */
  _bookId: '',

  async onLoad(options) {
    this._bookId = options.bookId || '';
    await this._loadBook();
  },

  /** 回来时刷新书签显示（如刚从 result 页保存了书签） */
  onShow() {
    if (this._bookId) this._loadBook();
  },

  async _loadBook() {
    this.setData({ loading: true });
    try {
      const book = await bookService.getBook(this._bookId);
      if (!book) {
        wx.showToast({ title: '绘本不存在', icon: 'none' });
        wx.navigateBack();
        return;
      }

      // 并行加载每页的缓存摘要
      const pages = await Promise.all(
        book.pages.map(async (hash, index) => {
          const entry = await cacheService.getPage(hash);
          const rawText = entry ? entry.text : '';
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

      wx.setNavigationBarTitle({ title: book.title });
      this.setData({ book, pages, loading: false });
    } catch (err) {
      console.error('[Book] 加载失败:', err.message);
      this.setData({ loading: false });
      wx.showToast({ title: '加载失败，请重试', icon: 'none' });
    }
  },

  /**
   * 点击某页 → result 页
   * 通过 URL 参数传 bookId + pageIndex，result 页据此显示翻页栏和保存书签
   */
  onTapPage(e) {
    const { pageIndex, pageHash } = e.currentTarget.dataset;
    const entry = this.data.pages[pageIndex];
    wx.navigateTo({
      url: `/src/pages/result/index?hash=${pageHash}&fromCache=true&bookId=${this._bookId}&pageIndex=${pageIndex}`,
      events: {},
      success: (res) => {
        res.eventChannel.emit('ocrData', {
          text: entry ? entry.text : '',
          fromCache: true,
          hash: pageHash,
        });
      },
    });
  },

  /**
   * 继续阅读：从书签位置（无书签则第 1 页）开始
   */
  onTapContinue() {
    const { book, pages } = this.data;
    if (!book || book.pages.length === 0) return;
    const idx = book.lastPageIndex >= 0 ? book.lastPageIndex : 0;
    const pageHash = book.pages[idx];
    const entry = pages[idx];
    wx.navigateTo({
      url: `/src/pages/result/index?hash=${pageHash}&fromCache=true&bookId=${this._bookId}&pageIndex=${idx}`,
      events: {},
      success: (res) => {
        res.eventChannel.emit('ocrData', {
          text: entry ? entry.text : '',
          fromCache: true,
          hash: pageHash,
        });
      },
    });
  },

  /** 重命名绘本 */
  onTapRename() {
    const { book } = this.data;
    if (!book) return;
    wx.showModal({
      title: '重命名绘本',
      editable: true,
      content: book.title,
      success: async (res) => {
        if (!res.confirm || !(res.content || '').trim()) return;
        try {
          await bookService.renameBook(this._bookId, res.content.trim());
          this._loadBook();
        } catch (err) {
          wx.showToast({ title: '重命名失败', icon: 'none' });
        }
      },
    });
  },
});
