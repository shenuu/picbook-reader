/**
 * @file services/book.service.js
 * @description 绘本管理服务
 *
 * 数据结构（BookEntry）：
 *  {
 *    bookId: string,        // 唯一 ID（timestamp + random）
 *    title: string,         // 用户命名
 *    pages: string[],       // 有序 pageHash 数组
 *    lastPageIndex: number, // 书签：最后阅读的页下标（-1 = 未读）
 *    createdAt: number,
 *    updatedAt: number,
 *  }
 *
 * 所有方法为 async，底层用 Promise 包装 wx.storage 读写。
 *
 * @author Jamie Park
 * @version 1.0.0
 */

'use strict';

const BOOKS_STORAGE_KEY = '__picbook_books_v1__';

// ─── 内存缓存 ─────────────────────────────────────────────
/** @type {Map<string, BookEntry>|null} */
let _books = null;
let _initPromise = null;

// ─── 初始化 ──────────────────────────────────────────────

async function _ensureInitialized() {
  if (_books) return;
  if (_initPromise) return _initPromise;
  _initPromise = _loadFromStorage();
  await _initPromise;
  _initPromise = null;
}

async function _loadFromStorage() {
  return new Promise((resolve) => {
    wx.getStorage({
      key: BOOKS_STORAGE_KEY,
      success: (res) => {
        try {
          const arr = JSON.parse(res.data) || [];
          _books = new Map(arr.map(b => [b.bookId, b]));
        } catch (_) {
          _books = new Map();
        }
        resolve();
      },
      fail: () => {
        _books = new Map();
        resolve();
      },
    });
  });
}

async function _persist() {
  const arr = Array.from(_books.values());
  return new Promise((resolve, reject) => {
    wx.setStorage({
      key: BOOKS_STORAGE_KEY,
      data: JSON.stringify(arr),
      success: resolve,
      fail: (err) => reject(new Error('保存书架失败: ' + err.errMsg)),
    });
  });
}

// ─── 公开接口 ─────────────────────────────────────────────

/**
 * 获取所有绘本（按 createdAt 降序，最新在前）
 * @returns {Promise<BookEntry[]>}
 */
async function getAllBooks() {
  await _ensureInitialized();
  const arr = Array.from(_books.values());
  arr.sort((a, b) => b.createdAt - a.createdAt);
  return arr;
}

/**
 * 根据 ID 获取单本绘本
 * @param {string} bookId
 * @returns {Promise<BookEntry|null>}
 */
async function getBook(bookId) {
  await _ensureInitialized();
  return _books.get(bookId) || null;
}

/**
 * 新建绘本
 * @param {string} title
 * @returns {Promise<BookEntry>}
 */
async function createBook(title) {
  await _ensureInitialized();
  const now = Date.now();
  const bookId = 'book_' + now + '_' + Math.random().toString(36).slice(2, 7);
  const book = {
    bookId,
    title: (title || '').trim() || '未命名绘本',
    pages: [],
    lastPageIndex: -1,
    createdAt: now,
    updatedAt: now,
  };
  _books.set(bookId, book);
  await _persist();
  return book;
}

/**
 * 将 pageHash 添加到绘本末尾（若已存在则跳过）
 * @param {string} bookId
 * @param {string} pageHash
 * @returns {Promise<number>} 该页在绑本中的下标
 */
async function addPage(bookId, pageHash) {
  await _ensureInitialized();
  const book = _books.get(bookId);
  if (!book) throw new Error('绘本不存在: ' + bookId);
  if (!book.pages.includes(pageHash)) {
    book.pages.push(pageHash);
  }
  book.updatedAt = Date.now();
  await _persist();
  return book.pages.indexOf(pageHash);
}

/**
 * 从绘本中删除某页（不删除 cache.service 中的 PageCacheEntry）
 * @param {string} bookId
 * @param {string} pageHash
 */
async function removePage(bookId, pageHash) {
  await _ensureInitialized();
  const book = _books.get(bookId);
  if (!book) return;
  const idx = book.pages.indexOf(pageHash);
  if (idx === -1) return;
  book.pages.splice(idx, 1);
  // 调整书签，避免越界
  if (book.lastPageIndex >= book.pages.length) {
    book.lastPageIndex = book.pages.length - 1;
  }
  book.updatedAt = Date.now();
  await _persist();
}

/**
 * 更新书签（记录最后阅读的页下标）
 * @param {string} bookId
 * @param {number} pageIndex
 */
async function updateBookmark(bookId, pageIndex) {
  await _ensureInitialized();
  const book = _books.get(bookId);
  if (!book) return;
  book.lastPageIndex = pageIndex;
  book.updatedAt = Date.now();
  await _persist();
}

/**
 * 重命名绘本
 * @param {string} bookId
 * @param {string} title
 */
async function renameBook(bookId, title) {
  await _ensureInitialized();
  const book = _books.get(bookId);
  if (!book) return;
  book.title = (title || '').trim() || book.title;
  book.updatedAt = Date.now();
  await _persist();
}

/**
 * 删除绘本（不删除 cache.service 中的 PageCacheEntry）
 * @param {string} bookId
 */
async function deleteBook(bookId) {
  await _ensureInitialized();
  _books.delete(bookId);
  await _persist();
}

module.exports = {
  getAllBooks,
  getBook,
  createBook,
  addPage,
  removePage,
  updateBookmark,
  renameBook,
  deleteBook,
};
