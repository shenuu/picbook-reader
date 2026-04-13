/**
 * @file pages/home/index.js
 * @description 绘本朗读助手 - 首页
 *
 * 职责：
 *  1. 提供进入拍照引导页的入口
 *  2. 提供缓存管理入口（查看/清除已缓存绘本页）
 *  3. 实时显示网络在线状态（离线时给出提示）
 *
 * 依赖：
 *  - services/cache.service.js  缓存统计展示
 *  - utils/network.js           在线状态订阅
 *
 * @author Jamie Park
 * @version 0.1.0
 */

const cacheService = require('../../services/cache.service');
const network = require('../../utils/network');

Page({

  // ─────────────────────────────────────────────
  //  数据层
  // ─────────────────────────────────────────────
  data: {
    /** 是否在线 */
    isOnline: true,
    /** 网络类型，如 wifi / 4g / none */
    networkType: 'wifi',
    /** 缓存统计：已缓存页数 / 上限 */
    cacheStats: {
      count: 0,
      maxCount: 20,
      totalSizeKB: 0,
    },
    /** 是否正在加载缓存统计（首屏骨架屏用） */
    loadingStats: true,
  },

  // ─────────────────────────────────────────────
  //  生命周期
  // ─────────────────────────────────────────────

  /**
   * 页面加载：初始化网络监听 & 获取缓存统计
   * @param {object} options - 页面参数（暂无）
   */
  onLoad(options) {
    this._initNetworkListener();
    this._loadCacheStats();
  },

  /**
   * 页面显示：每次回到首页刷新缓存统计（用户可能刚清了缓存）
   */
  onShow() {
    this._loadCacheStats();
  },

  /**
   * 页面卸载：移除网络监听，防止内存泄漏
   */
  onUnload() {
    network.offNetworkStatusChange(this._onNetworkChange);
  },

  // ─────────────────────────────────────────────
  //  网络状态
  // ─────────────────────────────────────────────

  /**
   * 初始化网络状态监听
   * 首次进入同步获取当前状态，然后订阅变化事件
   * @private
   */
  _initNetworkListener() {
    // TODO: 调用 network.getNetworkStatus() 获取初始状态并 setData
    // TODO: 调用 network.onNetworkStatusChange(this._onNetworkChange) 注册回调
  },

  /**
   * 网络状态变化回调
   * @private
   * @param {{ isConnected: boolean, networkType: string }} status
   */
  _onNetworkChange(status) {
    // TODO: setData({ isOnline: status.isConnected, networkType: status.networkType })
    // TODO: 若从离线恢复在线，可 toast 提示"已恢复网络连接"
  },

  // ─────────────────────────────────────────────
  //  缓存统计
  // ─────────────────────────────────────────────

  /**
   * 加载缓存统计数据并更新 data.cacheStats
   * @private
   */
  async _loadCacheStats() {
    this.setData({ loadingStats: true });
    try {
      // TODO: const stats = await cacheService.getStats();
      // TODO: this.setData({ cacheStats: stats, loadingStats: false });
    } catch (err) {
      console.error('[Home] 获取缓存统计失败', err);
      this.setData({ loadingStats: false });
    }
  },

  // ─────────────────────────────────────────────
  //  用户交互事件
  // ─────────────────────────────────────────────

  /**
   * 点击"开始拍照"按钮 → 跳转拍照引导页
   */
  onTapStartScan() {
    // TODO: 若离线且无缓存可用，弹窗提示"请连接网络后再使用"
    wx.navigateTo({ url: '/pages/guide/index' });
  },

  /**
   * 点击"缓存管理"按钮 → 跳转缓存列表页
   * （缓存列表页为后续迭代，暂时用 showModal 展示统计）
   */
  onTapCacheManager() {
    const { count, maxCount, totalSizeKB } = this.data.cacheStats;
    wx.showModal({
      title: '缓存状态',
      content: `已缓存 ${count}/${maxCount} 页\n占用空间约 ${totalSizeKB} KB`,
      showCancel: true,
      cancelText: '清除缓存',
      confirmText: '关闭',
      success: (res) => {
        if (res.cancel) {
          this._handleClearCache();
        }
      },
    });
  },

  /**
   * 清除全部缓存
   * @private
   */
  async _handleClearCache() {
    wx.showLoading({ title: '清除中…' });
    try {
      // TODO: await cacheService.clearAll();
      // TODO: this._loadCacheStats();
      wx.showToast({ title: '缓存已清除', icon: 'success' });
    } catch (err) {
      console.error('[Home] 清除缓存失败', err);
      wx.showToast({ title: '清除失败', icon: 'error' });
    } finally {
      wx.hideLoading();
    }
  },
});
