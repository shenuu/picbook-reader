/**
 * @file pages/shelf/index.js
 * @description 书架页 - 显示所有绘本列表，支持新建、删除
 *
 * @author Jamie Park
 * @version 1.0.0
 */

const bookService = require('../../services/book.service');

Page({

  data: {
    /** @type {BookEntry[]} */
    books: [],
    loading: true,
  },

  onLoad() {
    this._loadBooks();
  },

  /** 每次回到书架刷新（用户可能刚在 result 页加入了新页） */
  onShow() {
    this._loadBooks();
  },

  async _loadBooks() {
    this.setData({ loading: true });
    try {
      const books = await bookService.getAllBooks();
      this.setData({ books, loading: false });
    } catch (err) {
      console.error('[Shelf] 加载书架失败:', err.message);
      this.setData({ loading: false });
    }
  },

  /** 点击绘本 → 绑本详情页 */
  onTapBook(e) {
    const { bookId } = e.currentTarget.dataset;
    wx.navigateTo({ url: `/src/pages/book/index?bookId=${bookId}` });
  },

  /** 新建绘本 */
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
          wx.showToast({ title: '创建失败', icon: 'none' });
        }
      },
    });
  },

  /** 长按删除绘本 */
  onLongPressBook(e) {
    const { bookId, title } = e.currentTarget.dataset;
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
