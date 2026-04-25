/**
 * @file pages/shelf/index.js
 * @description 书架页 - 显示所有绘本列表，支持新建、重命名、左滑删除
 */

const bookService   = require('../../services/book.service');
const SwipeBehavior = require('../../utils/swipe-behavior');

Page({

  behaviors: [SwipeBehavior],

  data: {
    /** @type {BookEntry[]} */
    books: [],
    loading: true,

    // ── 左滑删除状态（由 SwipeBehavior 驱动）──
    swipeX: {},
    swipeOpenKey: '',   // bookId 字符串，'' = 无
  },

  onLoad() {
    this._swipeInit();   // 缓存屏幕宽度（来自 SwipeBehavior）
    this._loadBooks();
  },

  onShow() {
    this._loadBooks();
  },

  async _loadBooks() {
    this.setData({ loading: true });
    try {
      const books = await bookService.getAllBooks();
      this.setData({ books, swipeX: {}, swipeOpenKey: '', loading: false });
    } catch (err) {
      console.error('[Shelf] 加载书架失败:', err.message);
      this.setData({ loading: false });
    }
  },

  // ─────────────────────────────────────────────
  //  手势：左滑露出删除（转发给 SwipeBehavior）
  //  WXML 中使用 onSwipeTouchStart/Move/End
  //  并在每个条目上加 data-swipe-key="{{item.bookId}}"
  // ─────────────────────────────────────────────

  // ─────────────────────────────────────────────
  //  点击跳转
  // ─────────────────────────────────────────────

  onTapBook(e) {
    // 有面板打开时先关闭，不跳转
    if (this.data.swipeOpenKey) {
      this._swipeClose();
      return;
    }
    const { bookId } = e.currentTarget.dataset;
    wx.navigateTo({ url: `/src/pages/book/index?bookId=${bookId}` });
  },

  // ─────────────────────────────────────────────
  //  新建 / 重命名 / 删除
  // ─────────────────────────────────────────────

  onTapCreate() {
    wx.showModal({
      title: '新建绘本',
      placeholderText: '请输入绘本名称',
      editable: true,
      success: async (res) => {
        if (!res.confirm) return;
        const title = (res.content || '').trim();
        try {
          await bookService.createBook(title || '未命名绘本');
          this._loadBooks();
        } catch (err) {
          wx.showToast({ title: err.message || '创建失败', icon: 'none', duration: 2500 });
        }
      },
    });
  },

  onTapRenameBook(e) {
    const { bookId, title } = e.currentTarget.dataset;
    wx.showModal({
      title: '重命名绘本',
      editable: true,
      content: title,
      success: async (res) => {
        if (!res.confirm || !(res.content || '').trim()) return;
        try {
          await bookService.renameBook(bookId, res.content.trim());
          this._loadBooks();
        } catch (err) {
          wx.showToast({ title: '重命名失败', icon: 'none' });
        }
      },
    });
  },

  onTapDeleteBook(e) {
    const { bookId, title } = e.currentTarget.dataset;
    this._swipeClose();
    wx.showModal({
      title: '删除绘本',
      content: `确认删除「${title}」？绘本内的页面缓存不受影响。`,
      confirmColor: '#E53935',
      confirmText: '删除',
      success: async (res) => {
        if (!res.confirm) return;
        try {
          await bookService.deleteBook(bookId);
          this._loadBooks();
        } catch (err) {
          wx.showToast({ title: '删除失败', icon: 'none' });
        }
      },
    });
  },
});
