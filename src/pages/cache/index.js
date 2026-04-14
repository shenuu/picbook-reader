/**
 * @file pages/cache/index.js
 * @description 绘本朗读助手 - 缓存管理页
 *
 * 功能：
 *  1. 展示缓存统计：条目数、命中率（来自 storage 统计）、占用大小
 *  2. 顶部 LRU 容量进度条（已用/最大容量）
 *  3. 列出所有缓存条目（时间、文字预览前30字）
 *  4. 支持单条删除 + 全部清空
 *
 * 缓存来源：cacheService（LRU 缓存 + wx.storage 持久化）
 *
 * @author Jamie Park
 * @version 1.0.0
 */

const cacheService = require('../../services/cache.service');

Page({

  // ─────────────────────────────────────────────
  //  数据层
  // ─────────────────────────────────────────────
  data: {
    // ── 统计数据 ───────────────────────────────
    /** 当前缓存条目数 */
    cacheCount: 0,
    /** LRU 最大容量 */
    cacheMaxCount: 20,
    /** 文字缓存占用（KB，粗略估算） */
    cacheSizeKB: 0,
    /** LRU 占用百分比（0-100），用于进度条 */
    capacityPercent: 0,

    // ── 命中率统计 ─────────────────────────────
    /**
     * 缓存命中次数（本次启动累计，来自 app.globalData）
     * 注意：热启动会重置，冷启动读取 Storage 中的历史值
     */
    hitCount: 0,
    /** 总查询次数 */
    totalCount: 0,
    /** 命中率百分比字符串，如 "67%" */
    hitRateLabel: '--',

    // ── 条目列表 ───────────────────────────────
    /** 缓存条目列表（最新 → 最旧），每项含 preview、timeLabel、hasAudio */
    entries: [],

    // ── 页面状态 ───────────────────────────────
    /** 是否正在加载 */
    loading: true,
    /** 是否正在执行清空操作 */
    clearing: false,
  },

  // ─────────────────────────────────────────────
  //  生命周期
  // ─────────────────────────────────────────────

  /**
   * 页面显示时刷新数据（每次进入都重新加载，确保数据最新）
   */
  onShow() {
    this._loadData();
  },

  // ─────────────────────────────────────────────
  //  数据加载
  // ─────────────────────────────────────────────

  /**
   * 加载缓存统计与条目列表
   * @private
   */
  async _loadData() {
    this.setData({ loading: true });

    try {
      // 获取统计信息
      const stats = await cacheService.getStats();
      const { count, maxCount, totalSizeKB } = stats;

      // 获取所有条目（从 cacheService 读取，最新在前）
      const rawEntries = await cacheService.getAllEntries();

      // 格式化条目列表（最新在前）
      const entries = rawEntries
        .slice()
        .reverse() // LRU 返回最旧→最新，取反后最新在前
        .map((entry) => ({
          pageHash: entry.pageHash,
          preview: (entry.text || '（无文字）').slice(0, 30),
          timeLabel: _formatTimestamp(entry.timestamp),
          hasAudio: !!entry.audioPath,
          audioPath: entry.audioPath || '',
          text: entry.text || '',
        }));

      // 命中率（从 app.globalData 读取，若无则显示 '--'）
      let hitCount = 0;
      let totalCount = 0;
      let hitRateLabel = '--';
      try {
        const app = getApp();
        hitCount = app.globalData?.cacheHitCount || 0;
        totalCount = app.globalData?.cacheTotalCount || 0;
        if (totalCount > 0) {
          hitRateLabel = Math.round((hitCount / totalCount) * 100) + '%';
        }
      } catch (_) {
        // getApp() 可能在某些情况下不可用
      }

      // 容量进度百分比
      const capacityPercent = maxCount > 0 ? Math.round((count / maxCount) * 100) : 0;

      this.setData({
        cacheCount: count,
        cacheMaxCount: maxCount,
        cacheSizeKB: totalSizeKB,
        capacityPercent,
        hitCount,
        totalCount,
        hitRateLabel,
        entries,
        loading: false,
      });

    } catch (err) {
      console.error('[Cache Page] 加载失败:', err.message);
      wx.showToast({ title: '加载失败', icon: 'none' });
      this.setData({ loading: false });
    }
  },

  // ─────────────────────────────────────────────
  //  用户操作
  // ─────────────────────────────────────────────

  /**
   * 删除单条缓存
   * @param {WechatMiniprogram.CustomEvent} e - currentTarget.dataset.hash
   */
  async onTapDelete(e) {
    const { hash } = e.currentTarget.dataset;
    if (!hash) return;

    // 二次确认
    const [confirm] = await new Promise((resolve) => {
      wx.showModal({
        title: '确认删除',
        content: '删除后该绘本页的缓存及音频将被清除，下次需重新识别。',
        confirmText: '删除',
        confirmColor: '#E53935',
        success: (res) => resolve([res.confirm]),
      });
    });

    if (!confirm) return;

    try {
      await cacheService.removePage(hash);
      wx.showToast({ title: '已删除', icon: 'success' });
      // 重新加载列表
      await this._loadData();
    } catch (err) {
      console.error('[Cache Page] 删除失败:', err.message);
      wx.showToast({ title: '删除失败', icon: 'none' });
    }
  },

  /**
   * 清空全部缓存
   */
  async onTapClearAll() {
    const { cacheCount } = this.data;

    if (cacheCount === 0) {
      wx.showToast({ title: '缓存已为空', icon: 'none' });
      return;
    }

    // 二次确认
    const [confirm] = await new Promise((resolve) => {
      wx.showModal({
        title: '清空全部缓存',
        content: `将删除全部 ${cacheCount} 条缓存记录及对应音频文件，此操作不可撤销。`,
        confirmText: '全部清空',
        confirmColor: '#E53935',
        success: (res) => resolve([res.confirm]),
      });
    });

    if (!confirm) return;

    this.setData({ clearing: true });

    try {
      await cacheService.clearAll();
      wx.showToast({ title: '已清空全部缓存', icon: 'success' });
      await this._loadData();
    } catch (err) {
      console.error('[Cache Page] 清空失败:', err.message);
      wx.showToast({ title: '清空失败', icon: 'none' });
    } finally {
      this.setData({ clearing: false });
    }
  },

  /**
   * 点击缓存条目 → 跳转 result 页重播
   * @param {WechatMiniprogram.CustomEvent} e - dataset.hash, dataset.text
   */
  onTapEntry(e) {
    const { hash, text } = e.currentTarget.dataset;
    if (!text) return;

    wx.navigateTo({
      url: `/src/pages/result/index?hash=${encodeURIComponent(hash)}&fromCache=true`,
      success: (res) => {
        res.eventChannel.emit('ocrData', {
          text,
          fromCache: true,
          hash,
        });
      },
    });
  },
});

// ─────────────────────────────────────────────────────────────────
//  工具函数
// ─────────────────────────────────────────────────────────────────

/**
 * 将时间戳格式化为友好的中文日期时间字符串
 * @param {number} ts - Unix 时间戳（毫秒）
 * @returns {string}
 */
function _formatTimestamp(ts) {
  if (!ts) return '未知时间';
  const d = new Date(ts);
  const now = new Date();
  const diffMs = now - d;
  const diffMin = Math.floor(diffMs / 60000);
  const diffHour = Math.floor(diffMs / 3600000);
  const diffDay = Math.floor(diffMs / 86400000);

  if (diffMin < 1) return '刚刚';
  if (diffMin < 60) return `${diffMin} 分钟前`;
  if (diffHour < 24) return `${diffHour} 小时前`;
  if (diffDay < 7) return `${diffDay} 天前`;

  // 超过7天显示具体日期
  const mo = (d.getMonth() + 1).toString().padStart(2, '0');
  const dd = d.getDate().toString().padStart(2, '0');
  const hh = d.getHours().toString().padStart(2, '0');
  const mm = d.getMinutes().toString().padStart(2, '0');
  return `${mo}-${dd} ${hh}:${mm}`;
}
