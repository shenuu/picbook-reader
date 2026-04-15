/**
 * @file pages/offline/index.js
 * @description 绘本朗读助手 - 离线降级页
 *
 * 功能：
 *  1. 显示离线提示 + 儿童友好图标（🦊）
 *  2. 从缓存中展示"最近朗读过的绘本"列表（最多5条）
 *  3. 点击可直接进入 result 页重播（使用 EventChannel 传递文字）
 *  4. 底部"检测网络"按钮：重新检测联网状态，若已联网则返回 guide 页
 *
 * 触发场景：
 *  - home 页 / guide 页检测到无网络时，通过 redirectTo/navigateTo 跳转此页
 *  - 或 guide 页 OCR 失败且缓存未命中时提示用户跳转此页
 *
 * @author Jamie Park
 * @version 1.0.0
 */

const cacheService = require('../../services/cache.service');
const network      = require('../../utils/network');

/** 最多展示的最近缓存条目数 */
const MAX_RECENT_ENTRIES = 5;

Page({

  // ─────────────────────────────────────────────
  //  数据层
  // ─────────────────────────────────────────────
  data: {
    /** 最近朗读的绘本列表（最多5条，从缓存取） */
    recentEntries: [],
    /**
     * 页面状态：
     * 'offline'   - 已确认无网络
     * 'checking'  - 正在检测网络
     * 'online'    - 检测到已联网（即将跳走）
     */
    status: 'offline',
    /** 是否有可重播的缓存数据 */
    hasCache: false,
  },

  // ─────────────────────────────────────────────
  //  生命周期
  // ─────────────────────────────────────────────

  /**
   * 页面加载：读取最近缓存条目
   */
  async onLoad() {
    await this._loadRecentEntries();
  },

  /**
   * 页面显示：清理超时的离线队列任务（防止积压僵尸任务）
   */
  onShow() {
    network.pruneExpired();
  },

  // ─────────────────────────────────────────────
  //  数据加载
  // ─────────────────────────────────────────────

  /**
   * 从缓存服务读取最近朗读过的绘本（最多5条，最新在前）
   * @private
   */
  async _loadRecentEntries() {
    try {
      const allEntries = await cacheService.getAllEntries();

      // 取最新的 MAX_RECENT_ENTRIES 条（getAllEntries 返回最旧→最新，反转后取前5）
      const recent = allEntries
        .slice()
        .reverse()
        .slice(0, MAX_RECENT_ENTRIES)
        .map((entry) => ({
          pageHash: entry.pageHash,
          preview: (entry.text || '（无文字）').slice(0, 30),
          timeLabel: _formatTimestamp(entry.timestamp),
          hasAudio: !!entry.audioPath,
          text: entry.text || '',
        }));

      this.setData({
        recentEntries: recent,
        hasCache: recent.length > 0,
      });
    } catch (err) {
      console.warn('[Offline] 读取缓存失败:', err.message);
      this.setData({ hasCache: false });
    }
  },

  // ─────────────────────────────────────────────
  //  用户操作
  // ─────────────────────────────────────────────

  /**
   * 点击缓存条目 → 跳转 result 页重播
   * 离线模式下已缓存的音频可以直接播放，无需网络
   * @param {WechatMiniprogram.CustomEvent} e - dataset.hash, dataset.text
   */
  onTapReplay(e) {
    const { hash, text } = e.currentTarget.dataset;
    if (!text) {
      wx.showToast({ title: '缓存数据不完整', icon: 'none' });
      return;
    }

    wx.navigateTo({
      url: `/src/pages/result/index?hash=${encodeURIComponent(hash)}&fromCache=true`,
      success: (res) => {
        // P1-2 规范：通过 EventChannel 传递文字
        res.eventChannel.emit('ocrData', {
          text,
          fromCache: true,
          hash,
        });
      },
      fail: (err) => {
        console.error('[Offline] 跳转失败:', err.errMsg);
        wx.showToast({ title: '跳转失败，请重试', icon: 'none' });
      },
    });
  },

  /**
   * 点击"检测网络"按钮
   * 重新检测联网状态：
   *  - 如果已联网 → 显示提示 → 返回 guide 页
   *  - 如果仍离线 → 提示用户继续等待
   */
  async onTapCheckNetwork() {
    this.setData({ status: 'checking' });

    try {
      // 通过 wx.getNetworkType 进行真实网络检测
      const isOnline = await _checkNetwork();

      if (isOnline) {
        this.setData({ status: 'online' });
        wx.showToast({
          title: '网络已连接！',
          icon: 'success',
          duration: 1500,
        });

        // 短暂延迟后跳转（让用户看到"已连接"提示）
        setTimeout(() => {
          // 尝试返回 guide 页；若没有上一页则 redirectTo
          if (getCurrentPages().length > 1) {
            wx.navigateBack({ delta: 1 });
          } else {
            wx.redirectTo({ url: '/src/pages/guide/index' });
          }
        }, 1600);
      } else {
        this.setData({ status: 'offline' });
        wx.showToast({
          title: '仍未连接到网络',
          icon: 'none',
          duration: 2000,
        });
      }
    } catch (err) {
      this.setData({ status: 'offline' });
      wx.showToast({ title: '检测失败，请重试', icon: 'none' });
    }
  },
});

// ─────────────────────────────────────────────────────────────────
//  工具函数
// ─────────────────────────────────────────────────────────────────

/**
 * 通过 wx.getNetworkType 进行真实网络状态检测
 * 返回 true 表示已联网（非 none）
 * @returns {Promise<boolean>}
 */
function _checkNetwork() {
  return new Promise((resolve, reject) => {
    wx.getNetworkType({
      success: (res) => resolve(res.networkType !== 'none'),
      fail: (err) => reject(new Error(err.errMsg)),
    });
  });
}

/**
 * 将时间戳格式化为友好字符串
 * @param {number} ts - Unix 时间戳（毫秒）
 * @returns {string}
 */
function _formatTimestamp(ts) {
  if (!ts) return '未知时间';
  const d = new Date(ts);
  const now = new Date();
  const diffMin = Math.floor((now - d) / 60000);
  const diffHour = Math.floor((now - d) / 3600000);
  const diffDay = Math.floor((now - d) / 86400000);

  if (diffMin < 1) return '刚刚';
  if (diffMin < 60) return `${diffMin} 分钟前`;
  if (diffHour < 24) return `${diffHour} 小时前`;
  if (diffDay < 7) return `${diffDay} 天前`;

  const mo = (d.getMonth() + 1).toString().padStart(2, '0');
  const dd = d.getDate().toString().padStart(2, '0');
  return `${mo}-${dd}`;
}
