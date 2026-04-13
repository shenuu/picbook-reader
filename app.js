/**
 * @file app.js
 * @description 绘本朗读助手 - 小程序入口
 *
 * 职责：
 *  1. App 全局初始化：设置全局数据（globalData）
 *  2. 启动网络监听（network.js 模块加载时自动初始化）
 *  3. 预热缓存服务（冷启动从 wx.storage 恢复 LRU 元数据）
 *  4. 全局未捕获异常兜底处理
 *
 * 注意：
 *  - network.js 在被 require 时会自动调用 wx.getNetworkType + wx.onNetworkStatusChange
 *    因此只需 require 即可完成网络监听初始化，无需手动调用
 *  - 缓存服务为懒初始化（首次 getPage/setPage 时才从 Storage 读取），
 *    此处提前 require 可触发模块加载，但不阻塞启动
 *
 * @author Jamie Park
 * @version 0.1.0
 */

const network = require('./src/utils/network');
const cacheService = require('./src/services/cache.service');

App({

  // ─────────────────────────────────────────────
  //  全局数据
  // ─────────────────────────────────────────────
  globalData: {
    /**
     * 讯飞开放平台 AppID
     * 由 TTS 服务在构建合成 Payload 时使用
     * 生产环境通过 CI 注入或在登录后从 BFF 获取
     */
    xfyunAppId: '',

    /**
     * 当前登录用户信息（如需用户体系可在此扩展）
     * @type {{ openid: string, nickName: string, avatarUrl: string } | null}
     */
    userInfo: null,

    /** 全局在线状态（由 network.js 维护，此处同步一份供非响应式场景使用） */
    isOnline: true,
  },

  // ─────────────────────────────────────────────
  //  生命周期
  // ─────────────────────────────────────────────

  /**
   * 小程序启动时调用（仅执行一次）
   */
  onLaunch(options) {
    console.info('[App] 小程序启动', options);

    // 初始化网络监听（network.js 被 require 时已自动触发，此处同步全局数据）
    this._syncNetworkStatus();
    this._registerNetworkListener();

    // 预热缓存服务：提前触发 Storage 读取，减少首次进入结果页的延迟
    this._warmUpCache();
  },

  /**
   * 小程序切回前台（每次都触发）
   */
  onShow() {
    // 切回前台时重新同步网络状态，以防后台时状态已变
    this._syncNetworkStatus();
  },

  /**
   * 小程序切到后台
   */
  onHide() {
    // 可在此暂停正在进行的操作（如 TTS 合成），当前版本不做处理
  },

  /**
   * 全局 JS 错误兜底
   * @param {string} message  - 错误信息
   * @param {string} source   - 出错文件
   * @param {number} lineno   - 行号
   * @param {number} colno    - 列号
   * @param {Error}  error    - Error 对象
   */
  onError(message, source, lineno, colno, error) {
    console.error('[App] 未捕获的全局错误:', { message, source, lineno, colno, error });
    // 生产环境可在此上报到错误监控平台（如腾讯云 Badjs）
  },

  /**
   * 小程序版本更新（微信客户端发现有新版本时触发）
   */
  onPageNotFound(res) {
    console.warn('[App] 页面未找到:', res.path);
    // 重定向到首页，避免用户看到白屏
    wx.switchTab({ url: '/pages/home/index' });
  },

  // ─────────────────────────────────────────────
  //  私有方法
  // ─────────────────────────────────────────────

  /**
   * 同步获取当前网络状态，写入 globalData
   * @private
   */
  _syncNetworkStatus() {
    network.getNetworkStatus().then((status) => {
      this.globalData.isOnline = status.isConnected;
      console.info('[App] 网络状态:', status.networkType, '在线:', status.isConnected);
    }).catch(() => {
      // 静默处理
    });
  },

  /**
   * 注册全局网络状态变化监听（同步到 globalData）
   * 页面级监听在各自 Page 中注册/注销
   * @private
   */
  _registerNetworkListener() {
    network.onNetworkStatusChange((status) => {
      this.globalData.isOnline = status.isConnected;
    });
  },

  /**
   * 预热缓存服务（触发懒初始化，异步不阻塞）
   * 好处：首次进入结果页时 getPage() 无需等待 Storage 读取
   * @private
   */
  _warmUpCache() {
    cacheService.getStats().then((stats) => {
      console.info('[App] 缓存服务预热完成，已缓存页数:', stats.count);
    }).catch((err) => {
      console.warn('[App] 缓存服务预热失败:', err.message);
    });
  },
});
