# 整本绘本管理 + 书签进度记忆 实现计划

> **For Hermes:** Use subagent-driven-development skill to implement this plan task-by-task.

**Goal:** 在现有单页拍照→朗读流程上叠加「书架」概念——用户可将散页归入绑本、记录阅读进度，下次直接从上次读到的位置继续。

**Architecture:**
- `book.service.js` 新增服务：在 wx.storage 中独立存储绘本（Book）数据，页面内容（text/audio）仍走现有 `cache.service.js`。
- Book = `{ bookId, title, pages: string[], lastPageIndex, createdAt, updatedAt }`，`pages[]` 是 pageHash 有序数组，通过 hash 关联到 cache.service 的 PageCacheEntry。
- 两个新页面：`shelf`（书架列表）、`book`（绘本详情/翻页）。
- result 页新增「加入书架」按钮；当从书架打开时额外显示「上一页/下一页」并在离开时自动写书签。

**Tech Stack:** 微信小程序原生，wx.storage，无新 npm 依赖。

---

## Task 1: 新建 `src/services/book.service.js`

**Objective:** 管理绘本数据的 CRUD 和书签更新，存储于 wx.storage（key: `__picbook_books_v1__`）

**Files:**
- Create: `src/services/book.service.js`

**完整代码:**

```js
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
 * 所有方法为 async，底层用 Promise 包装 wx.storage 同步读写。
 */

'use strict';

const BOOKS_STORAGE_KEY = '__picbook_books_v1__';

// 内存缓存，避免每次都读 Storage
let _books = null; // Map<bookId, BookEntry>
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
  const book = { bookId, title: title.trim() || '未命名绘本', pages: [], lastPageIndex: -1, createdAt: now, updatedAt: now };
  _books.set(bookId, book);
  await _persist();
  return book;
}

/**
 * 将 pageHash 添加到绘本末尾（若已存在则跳过）
 * @param {string} bookId
 * @param {string} pageHash
 * @returns {Promise<number>} 新页的下标
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
  // 调整书签
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
 * 更新绘本标题
 * @param {string} bookId
 * @param {string} title
 */
async function renameBook(bookId, title) {
  await _ensureInitialized();
  const book = _books.get(bookId);
  if (!book) return;
  book.title = title.trim() || book.title;
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
```

**验证：** 文件存在，`require('../../services/book.service')` 不报错。

---

## Task 2: 新建 `src/pages/shelf/` 书架页（4 个文件）

**Objective:** 列出所有绘本，支持新建、删除，点击进入绘本详情。

**Files:**
- Create: `src/pages/shelf/index.js`
- Create: `src/pages/shelf/index.json`
- Create: `src/pages/shelf/index.wxml`
- Create: `src/pages/shelf/index.wxss`

### index.json
```json
{
  "navigationBarTitleText": "我的书架",
  "navigationBarBackgroundColor": "#FF7043",
  "navigationBarTextStyle": "white",
  "backgroundColor": "#FFFDF8"
}
```

### index.js
```js
/**
 * @file pages/shelf/index.js
 * @description 书架页 - 显示所有绘本列表
 */
const bookService = require('../../services/book.service');

Page({
  data: {
    books: [],        // BookEntry[]
    loading: true,
  },

  onLoad() {
    this._loadBooks();
  },

  onShow() {
    // 每次回到书架都刷新（用户可能刚添加了页面）
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

  /** 点击绘本 → 绘本详情页 */
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
        if (!res.confirm || !res.content.trim()) return;
        await bookService.createBook(res.content.trim());
        this._loadBooks();
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
      success: async (res) => {
        if (!res.confirm) return;
        await bookService.deleteBook(bookId);
        this._loadBooks();
      },
    });
  },
});
```

### index.wxml
```xml
<view class="page">
  <view class="toolbar">
    <button class="btn-create" bindtap="onTapCreate">＋ 新建绘本</button>
  </view>

  <block wx:if="{{loading}}">
    <view class="hint">加载中…</view>
  </block>

  <block wx:elif="{{books.length === 0}}">
    <view class="empty">
      <text class="empty__icon">📚</text>
      <text class="empty__text">书架空空如也，先去拍照然后「加入书架」吧～</text>
    </view>
  </block>

  <scroll-view wx:else scroll-y class="list">
    <view
      wx:for="{{books}}"
      wx:key="bookId"
      class="book-item"
      data-book-id="{{item.bookId}}"
      data-title="{{item.title}}"
      bindtap="onTapBook"
      bindlongpress="onLongPressBook"
    >
      <view class="book-item__icon">📖</view>
      <view class="book-item__info">
        <text class="book-item__title">{{item.title}}</text>
        <text class="book-item__meta">
          {{item.pages.length}} 页
          {{item.lastPageIndex >= 0 ? ' · 读到第 ' + (item.lastPageIndex + 1) + ' 页' : ' · 未开始'}}
        </text>
      </view>
      <view class="book-item__arrow">›</view>
    </view>
  </scroll-view>
</view>
```

### index.wxss
```css
.page { display: flex; flex-direction: column; min-height: 100vh; background: #FFFDF8; }
.toolbar { padding: 20rpx 32rpx; }
.btn-create { background: #FF7043; color: #fff; border-radius: 48rpx; font-size: 28rpx; padding: 16rpx 40rpx; border: none; }
.hint, .empty { display: flex; flex-direction: column; align-items: center; padding: 120rpx 32rpx; gap: 24rpx; }
.empty__icon { font-size: 80rpx; }
.empty__text { font-size: 28rpx; color: #999; text-align: center; line-height: 1.6; }
.list { flex: 1; }
.book-item { display: flex; align-items: center; padding: 28rpx 32rpx; background: #fff; margin: 16rpx 24rpx; border-radius: 20rpx; box-shadow: 0 2rpx 12rpx rgba(0,0,0,0.06); gap: 24rpx; }
.book-item__icon { font-size: 56rpx; flex-shrink: 0; }
.book-item__info { flex: 1; }
.book-item__title { font-size: 32rpx; font-weight: 600; color: #222; display: block; }
.book-item__meta { font-size: 24rpx; color: #888; margin-top: 6rpx; display: block; }
.book-item__arrow { font-size: 40rpx; color: #ccc; }
```

---

## Task 3: 新建 `src/pages/book/` 绘本详情页（4 个文件）

**Objective:** 列出绑本的所有页，显示书签，点击任意页跳到 result 页并记录书签。

**Files:**
- Create: `src/pages/book/index.js`
- Create: `src/pages/book/index.json`
- Create: `src/pages/book/index.wxml`
- Create: `src/pages/book/index.wxss`

### index.json
```json
{
  "navigationBarTitleText": "绘本详情",
  "navigationBarBackgroundColor": "#FF7043",
  "navigationBarTextStyle": "white",
  "backgroundColor": "#FFFDF8"
}
```

### index.js
```js
/**
 * @file pages/book/index.js
 * @description 绘本详情页 - 展示某本绘本的所有页，支持点击阅读
 */
const bookService   = require('../../services/book.service');
const cacheService  = require('../../services/cache.service');

Page({
  data: {
    book: null,      // BookEntry
    pages: [],       // { index, pageHash, text, hasAudio }[]
    loading: true,
  },

  async onLoad(options) {
    this._bookId = options.bookId;
    await this._loadBook();
  },

  onShow() {
    // 回来时刷新书签显示
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

      // 加载每页的缓存摘要
      const pages = await Promise.all(
        book.pages.map(async (hash, index) => {
          const entry = await cacheService.getPage(hash);
          return {
            index,
            pageHash: hash,
            text: entry ? (entry.text.slice(0, 40) + (entry.text.length > 40 ? '…' : '')) : '（缓存已过期）',
            hasAudio: !!(entry && entry.audioPath),
            isCurrent: index === book.lastPageIndex,
          };
        })
      );

      // 更新导航栏标题
      wx.setNavigationBarTitle({ title: book.title });

      this.setData({ book, pages, loading: false });
    } catch (err) {
      console.error('[Book] 加载失败:', err.message);
      this.setData({ loading: false });
    }
  },

  /** 点击某页 → result 页（带 bookId + pageIndex，result 页会自动显示上/下页按钮） */
  onTapPage(e) {
    const { pageIndex, pageHash } = e.currentTarget.dataset;
    wx.navigateTo({
      url: `/src/pages/result/index?hash=${pageHash}&fromCache=true&bookId=${this._bookId}&pageIndex=${pageIndex}`,
      events: {},
      success: (res) => {
        const entry = this.data.pages[pageIndex];
        res.eventChannel.emit('ocrData', {
          text: entry ? entry.text : '',  // 摘要，result 页会从 cache 重新读完整文字
          fromCache: true,
          hash: pageHash,
        });
      },
    });
  },

  /** 点击继续阅读（从书签位置） */
  onTapContinue() {
    const { book } = this.data;
    const idx = book.lastPageIndex >= 0 ? book.lastPageIndex : 0;
    if (book.pages.length === 0) return;
    const pageHash = book.pages[idx];
    const entry = this.data.pages[idx];
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
    wx.showModal({
      title: '重命名绘本',
      editable: true,
      content: this.data.book.title,
      success: async (res) => {
        if (!res.confirm || !res.content.trim()) return;
        await bookService.renameBook(this._bookId, res.content.trim());
        this._loadBook();
      },
    });
  },
});
```

### index.wxml
```xml
<view class="page">
  <block wx:if="{{loading}}">
    <view class="hint">加载中…</view>
  </block>

  <block wx:elif="{{book}}">
    <!-- 绑本信息头部 -->
    <view class="book-header">
      <view class="book-header__info">
        <text class="book-header__title">{{book.title}}</text>
        <text class="book-header__meta">共 {{book.pages.length}} 页
          {{book.lastPageIndex >= 0 ? ' · 上次读到第 ' + (book.lastPageIndex + 1) + ' 页' : ''}}</text>
      </view>
      <button class="btn-rename" bindtap="onTapRename">改名</button>
    </view>

    <!-- 继续阅读按钮（有进度时显示） -->
    <view wx:if="{{book.pages.length > 0}}" class="continue-bar">
      <button class="btn-continue" bindtap="onTapContinue">
        {{book.lastPageIndex >= 0 ? '▶ 继续阅读（第 ' + (book.lastPageIndex + 1) + ' 页）' : '▶ 从第 1 页开始'}}
      </button>
    </view>

    <!-- 空书 -->
    <view wx:if="{{book.pages.length === 0}}" class="empty">
      <text class="empty__icon">📄</text>
      <text class="empty__text">还没有页面，拍照识别后在结果页点「加入书架」即可</text>
    </view>

    <!-- 页面列表 -->
    <scroll-view scroll-y class="list">
      <view
        wx:for="{{pages}}"
        wx:key="pageHash"
        class="page-item {{item.isCurrent ? 'page-item--current' : ''}}"
        data-page-index="{{item.index}}"
        data-page-hash="{{item.pageHash}}"
        bindtap="onTapPage"
      >
        <view class="page-item__num">{{item.index + 1}}</view>
        <view class="page-item__content">
          <text class="page-item__text">{{item.text}}</text>
          <view class="page-item__tags">
            <text wx:if="{{item.hasAudio}}" class="tag tag--audio">🔊 已合成</text>
            <text wx:if="{{item.isCurrent}}" class="tag tag--bookmark">🔖 书签</text>
          </view>
        </view>
        <view class="page-item__arrow">›</view>
      </view>
    </scroll-view>
  </block>
</view>
```

### index.wxss
```css
.page { display: flex; flex-direction: column; min-height: 100vh; background: #FFFDF8; }
.hint { padding: 120rpx; text-align: center; color: #999; }
.book-header { display: flex; align-items: center; padding: 28rpx 32rpx; background: #fff; border-bottom: 1rpx solid #f0e8e0; gap: 16rpx; }
.book-header__info { flex: 1; }
.book-header__title { font-size: 36rpx; font-weight: 700; color: #222; display: block; }
.book-header__meta { font-size: 24rpx; color: #888; display: block; margin-top: 6rpx; }
.btn-rename { font-size: 24rpx; color: #FF7043; background: transparent; border: 1rpx solid #FF7043; border-radius: 32rpx; padding: 8rpx 24rpx; }
.continue-bar { padding: 20rpx 32rpx; background: #FFF3E0; }
.btn-continue { background: #FF7043; color: #fff; border-radius: 48rpx; font-size: 28rpx; padding: 20rpx; width: 100%; border: none; }
.empty { display: flex; flex-direction: column; align-items: center; padding: 120rpx 32rpx; gap: 24rpx; }
.empty__icon { font-size: 80rpx; }
.empty__text { font-size: 28rpx; color: #999; text-align: center; line-height: 1.6; }
.list { flex: 1; }
.page-item { display: flex; align-items: center; padding: 24rpx 32rpx; background: #fff; margin: 12rpx 24rpx; border-radius: 16rpx; box-shadow: 0 2rpx 8rpx rgba(0,0,0,0.05); gap: 20rpx; }
.page-item--current { border: 2rpx solid #FF7043; }
.page-item__num { width: 56rpx; height: 56rpx; background: #FF7043; color: #fff; border-radius: 50%; display: flex; align-items: center; justify-content: center; font-size: 24rpx; font-weight: 700; flex-shrink: 0; }
.page-item__content { flex: 1; }
.page-item__text { font-size: 26rpx; color: #444; line-height: 1.5; display: block; }
.page-item__tags { display: flex; gap: 12rpx; margin-top: 8rpx; flex-wrap: wrap; }
.tag { font-size: 20rpx; padding: 4rpx 14rpx; border-radius: 24rpx; }
.tag--audio { background: #E8F5E9; color: #388E3C; }
.tag--bookmark { background: #FFF3E0; color: #E65100; }
.page-item__arrow { font-size: 40rpx; color: #ccc; }
```

---

## Task 4: 修改 `app.json` — 注册新页面

**Objective:** 将 shelf 和 book 页面添加到 pages 列表。

**File:** `app.json`

在 `"src/pages/cache/index"` 后面添加：
```json
"src/pages/shelf/index",
"src/pages/book/index"
```

---

## Task 5: 修改 `src/pages/home/index.{js,wxml}` — 添加书架入口

**Objective:** 首页增加「我的书架」按钮。

### home/index.js
在 `onTapCacheManager` 函数附近添加：
```js
/** 跳转书架页 */
onTapShelf() {
  wx.navigateTo({ url: '/src/pages/shelf/index' });
},
```

### home/index.wxml
在「开始拍照识别」按钮下方，现有「缓存管理」按钮之前，添加：
```xml
<!-- 书架入口 -->
<button
  class="btn-secondary btn-shelf"
  bindtap="onTapShelf"
  hover-class="btn-secondary--hover"
>
  <text class="btn-shelf__icon">📚</text>
  <text>我的书架</text>
</button>
```

---

## Task 6: 修改 `src/pages/result/index.{js,wxml}` — 加入书架 + 上/下页 + 书签

**Objective:** result 页新增三项能力：
1. 「加入书架」按钮（新扫描的页）
2. 从书详情进来时显示「上一页/下一页」翻页按钮
3. 离开页面时自动将当前 pageIndex 写为书签

### result/index.js 修改点

**① data 新增字段**（在现有 data 块末尾添加）：
```js
// ── 书架/书签相关 ──
bookId: '',           // 来自 URL 参数，有值时说明从书架打开
bookTitle: '',        // 绑本标题（展示用）
pageIndex: -1,        // 当前页在绑本中的下标
totalPages: 0,        // 绑本总页数
hasPrev: false,
hasNext: false,
showAddToBook: true,  // 「加入书架」按钮（非书架模式时显示）
```

**② onLoad 修改**（在现有 hash/fromCache 解析后追加）：
```js
const { bookId = '', pageIndex = '-1' } = options;
const idx = parseInt(pageIndex, 10);

if (bookId) {
  this.setData({ bookId, pageIndex: idx, showAddToBook: false });
  this._loadBookContext(bookId, idx);
}
```

**③ onUnload 修改**（在现有 _destroyAudio 后追加）：
```js
// 自动保存书签
this._saveBookmark();
```

**④ 新增方法**：
```js
/** 加载绑本上下文（总页数 + 上/下页状态） */
async _loadBookContext(bookId, pageIndex) {
  try {
    const bookService = require('../../services/book.service');
    const book = await bookService.getBook(bookId);
    if (!book) return;
    this.setData({
      bookTitle: book.title,
      totalPages: book.pages.length,
      hasPrev: pageIndex > 0,
      hasNext: pageIndex < book.pages.length - 1,
    });
  } catch (err) {
    console.warn('[Result] 加载绑本上下文失败:', err.message);
  }
},

/** 离开页面时保存书签 */
async _saveBookmark() {
  const { bookId, pageIndex } = this.data;
  if (!bookId || pageIndex < 0) return;
  try {
    const bookService = require('../../services/book.service');
    await bookService.updateBookmark(bookId, pageIndex);
  } catch (err) {
    console.warn('[Result] 保存书签失败:', err.message);
  }
},

/** 上一页 */
async onTapPrevPage() {
  await this._navigateToBookPage(this.data.pageIndex - 1);
},

/** 下一页 */
async onTapNextPage() {
  await this._navigateToBookPage(this.data.pageIndex + 1);
},

/** 跳转到书中某页 */
async _navigateToBookPage(targetIndex) {
  const { bookId } = this.data;
  if (!bookId) return;
  try {
    const bookService  = require('../../services/book.service');
    const cacheService = require('../../services/cache.service');
    const book = await bookService.getBook(bookId);
    if (!book || targetIndex < 0 || targetIndex >= book.pages.length) return;

    const pageHash = book.pages[targetIndex];
    const entry = await cacheService.getPage(pageHash);

    // 先保存当前书签
    await bookService.updateBookmark(bookId, targetIndex);

    // 销毁当前音频
    this._destroyAudio();
    ttsService.cancel();

    wx.navigateTo({
      url: `/src/pages/result/index?hash=${pageHash}&fromCache=true&bookId=${bookId}&pageIndex=${targetIndex}`,
      events: {},
      success: (res) => {
        res.eventChannel.emit('ocrData', {
          text: entry ? entry.text : '',
          fromCache: true,
          hash: pageHash,
        });
      },
    });
  } catch (err) {
    console.error('[Result] 翻页失败:', err.message);
    wx.showToast({ title: '翻页失败', icon: 'none' });
  }
},

/** 加入书架 */
onTapAddToBook() {
  const { imageHash, ocrText } = this.data;
  if (!imageHash) {
    wx.showToast({ title: '页面尚未识别完成', icon: 'none' });
    return;
  }
  // 先获取书架列表，让用户选择或新建
  const bookService = require('../../services/book.service');
  bookService.getAllBooks().then((books) => {
    if (books.length === 0) {
      // 没有书，直接新建
      wx.showModal({
        title: '新建绘本',
        editable: true,
        placeholderText: '请输入绘本名称',
        success: async (res) => {
          if (!res.confirm || !res.content.trim()) return;
          const book = await bookService.createBook(res.content.trim());
          await bookService.addPage(book.bookId, imageHash);
          wx.showToast({ title: '已加入「' + book.title + '」', icon: 'success' });
          this.setData({ showAddToBook: false });
        },
      });
    } else {
      // 有书，弹出选择（最多显示前 6 本 + 新建选项）
      const items = books.slice(0, 6).map(b => b.title);
      items.push('＋ 新建绘本');
      wx.showActionSheet({
        itemList: items,
        success: async (res) => {
          if (res.tapIndex === items.length - 1) {
            // 新建
            wx.showModal({
              title: '新建绘本',
              editable: true,
              placeholderText: '请输入绘本名称',
              success: async (r2) => {
                if (!r2.confirm || !r2.content.trim()) return;
                const book = await bookService.createBook(r2.content.trim());
                await bookService.addPage(book.bookId, imageHash);
                wx.showToast({ title: '已加入「' + book.title + '」', icon: 'success' });
                this.setData({ showAddToBook: false });
              },
            });
          } else {
            // 选已有
            const book = books[res.tapIndex];
            await bookService.addPage(book.bookId, imageHash);
            wx.showToast({ title: '已加入「' + book.title + '」', icon: 'success' });
            this.setData({ showAddToBook: false });
          }
        },
      });
    }
  });
},
```

### result/index.wxml 修改点

**① 顶部绑本导航栏**（在 `<view class="page">` 内最顶部添加，bookId 有值时出现）：
```xml
<!-- ── 绑本翻页栏（从书架进入时显示） ── -->
<view wx:if="{{bookId}}" class="book-nav">
  <button
    class="book-nav__btn {{hasPrev ? '' : 'book-nav__btn--disabled'}}"
    disabled="{{!hasPrev}}"
    bindtap="onTapPrevPage"
  >‹ 上一页</button>
  <text class="book-nav__title">{{bookTitle}} · 第 {{pageIndex + 1}}/{{totalPages}} 页</text>
  <button
    class="book-nav__btn {{hasNext ? '' : 'book-nav__btn--disabled'}}"
    disabled="{{!hasNext}}"
    bindtap="onTapNextPage"
  >下一页 ›</button>
</view>
```

**② 「加入书架」按钮**（在已有的操作按钮区末尾添加，showAddToBook 为 true 时显示）：
```xml
<button
  wx:if="{{showAddToBook && imageHash}}"
  class="btn-add-book"
  bindtap="onTapAddToBook"
>📚 加入书架</button>
```

**③ result/index.wxss 追加样式**：
```css
/* 绑本翻页栏 */
.book-nav { display: flex; align-items: center; justify-content: space-between; padding: 16rpx 24rpx; background: #FFF3E0; border-bottom: 1rpx solid #FFE0B2; }
.book-nav__title { font-size: 24rpx; color: #E65100; flex: 1; text-align: center; }
.book-nav__btn { font-size: 26rpx; color: #FF7043; background: transparent; border: none; padding: 8rpx 20rpx; }
.book-nav__btn--disabled { color: #ccc; }
/* 加入书架按钮 */
.btn-add-book { margin: 16rpx 32rpx 0; background: transparent; border: 2rpx solid #FF7043; color: #FF7043; border-radius: 48rpx; font-size: 28rpx; padding: 16rpx; }
```

---

## Task 7: 修复 result/index.js 中 `_receiveOcrData` — 从缓存读完整文字

**Objective:** 从书架打开页面时，EventChannel 只发了文字摘要（40字），需要从缓存取完整文字。

在 `_receiveOcrData` 的 `eventChannel.on('ocrData', ...)` 回调中，增加：

```js
eventChannel.on('ocrData', async (data) => {
  const { text = '', fromCache, hash } = data;

  // 若来自书架（text 是摘要），从缓存读完整文字
  let fullText = text;
  if (fromCache && hash) {
    try {
      const entry = await cacheService.getPage(hash);
      if (entry && entry.text) fullText = entry.text;
    } catch (_) {}
  }

  const updates = { ocrText: fullText };
  if (fromCache) updates.cacheStatus = 'cached';
  if (hash) updates.imageHash = hash;
  this.setData(updates);
  console.info('[Result] 收到 OCR 数据，文字长度:', fullText.length);
});
```

---

## 执行顺序

1. Task 1 → `book.service.js`（基础服务，其他都依赖它）
2. Task 2 → shelf 页
3. Task 3 → book 页
4. Task 4 → `app.json` 注册页面
5. Task 5 → home 页添加书架入口
6. Task 6 → result 页改造（加入书架 + 翻页 + 书签）
7. Task 7 → result 页 receiveOcrData 修复

每个 Task 完成后在开发者工具编译通过（无红色报错）即可继续下一个。
全部完成后，回归测试：拍照 → 结果页 → 加入书架 → 书架列表 → 绑本详情 → 翻页 → 书签保存。
