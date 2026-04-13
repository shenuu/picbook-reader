/**
 * @file utils/network.js
 * @description 绘本朗读助手 - 网络工具模块
 *
 * 职责：
 *  1. 在线状态检测（同步读取当前状态）
 *  2. 订阅/取消订阅 wx.onNetworkStatusChange，提供统一的事件总线
 *  3. 离线请求队列：网络断开时将请求加入队列，恢复后自动重新执行
 *
 * 设计说明：
 *  - 模块加载时立即调用 wx.getNetworkType 初始化状态
 *  - 通过 wx.onNetworkStatusChange 保持状态实时同步
 *  - 支持多个监听者通过 onNetworkStatusChange / offNetworkStatusChange 注册回调
 *  - 队列中的任务在网络恢复时按 FIFO 顺序依次执行
 *
 * @author Jamie Park
 * @version 0.1.0
 */

// ─────────────────────────────────────────────────────────────────
//  模块级状态（单例）
// ─────────────────────────────────────────────────────────────────

/** 当前是否在线 */
let _isOnline = true;

/** 当前网络类型，如 'wifi' | '4g' | '3g' | '2g' | 'none' | 'unknown' */
let _networkType = 'unknown';

/**
 * 外部注册的网络状态变化监听器集合
 * @type {Set<Function>}
 */
const _listeners = new Set();

/**
 * 离线请求队列
 * 每项结构：{ fn: Function, resolve: Function, reject: Function, addedAt: number }
 * @type {Array<{ fn: Function, resolve: Function, reject: Function, addedAt: number }>}
 */
const _requestQueue = [];

/** 队列最大长度（防止内存溢出） */
const QUEUE_MAX_SIZE = 50;

// ─────────────────────────────────────────────────────────────────
//  初始化（模块加载时自动执行）
// ─────────────────────────────────────────────────────────────────

/**
 * 初始化网络状态：同步获取初始值，并注册全局变化监听
 * 模块被 require 时自动调用
 */
function _init() {
  // 1. 获取初始网络状态（异步，但尽早触发）
  wx.getNetworkType({
    success: (res) => {
      _networkType = res.networkType;
      _isOnline = res.networkType !== 'none';
      console.info('[Network] 初始状态:', _networkType, '| 在线:', _isOnline);
    },
    fail: () => {
      console.warn('[Network] 无法获取初始网络状态，默认设为在线');
    },
  });

  // 2. 注册全局网络变化监听（整个小程序生命周期内有效）
  wx.onNetworkStatusChange((res) => {
    const wasOnline = _isOnline;
    _isOnline = res.isConnected;
    _networkType = res.networkType;

    console.info('[Network] 网络变化:', _networkType, '| 在线:', _isOnline);

    // 通知所有外部监听者
    _listeners.forEach((cb) => {
      try {
        cb({ isConnected: _isOnline, networkType: _networkType });
      } catch (err) {
        console.error('[Network] 监听回调执行出错', err);
      }
    });

    // 网络从断开恢复在线时，排空请求队列
    if (!wasOnline && _isOnline) {
      _flushQueue();
    }
  });
}

// 模块加载时立即初始化
_init();

// ─────────────────────────────────────────────────────────────────
//  公开接口 — 状态查询
// ─────────────────────────────────────────────────────────────────

/**
 * 同步获取当前是否在线
 * @returns {boolean}
 */
function isOnline() {
  return _isOnline;
}

/**
 * 同步获取当前网络类型
 * @returns {string} 'wifi' | '4g' | '3g' | '2g' | 'none' | 'unknown'
 */
function getNetworkType() {
  return _networkType;
}

/**
 * 异步获取网络状态（封装 wx.getNetworkType，返回 Promise）
 * @returns {Promise<{ isConnected: boolean, networkType: string }>}
 */
function getNetworkStatus() {
  return new Promise((resolve, reject) => {
    wx.getNetworkType({
      success: (res) => {
        _networkType = res.networkType;
        _isOnline = res.networkType !== 'none';
        resolve({ isConnected: _isOnline, networkType: _networkType });
      },
      fail: (err) => reject(new Error('获取网络状态失败: ' + err.errMsg)),
    });
  });
}

// ─────────────────────────────────────────────────────────────────
//  公开接口 — 事件监听
// ─────────────────────────────────────────────────────────────────

/**
 * 注册网络状态变化监听器
 * @param {(status: { isConnected: boolean, networkType: string }) => void} callback
 */
function onNetworkStatusChange(callback) {
  if (typeof callback !== 'function') {
    console.warn('[Network] onNetworkStatusChange: callback 必须是函数');
    return;
  }
  _listeners.add(callback);
}

/**
 * 取消注册网络状态变化监听器
 * @param {Function} callback - 与注册时同一引用
 */
function offNetworkStatusChange(callback) {
  _listeners.delete(callback);
}

// ─────────────────────────────────────────────────────────────────
//  公开接口 — 请求队列
// ─────────────────────────────────────────────────────────────────

/**
 * 将一个异步任务加入请求队列
 * - 若当前在线，直接执行
 * - 若当前离线，加入队列等待网络恢复
 *
 * @param {() => Promise<any>} fn - 返回 Promise 的任务函数
 * @returns {Promise<any>} 任务执行结果
 *
 * @example
 *   const result = await network.enqueue(() => ocrService.recognize(path));
 */
function enqueue(fn) {
  if (_isOnline) {
    // 在线直接执行
    return fn();
  }

  if (_requestQueue.length >= QUEUE_MAX_SIZE) {
    return Promise.reject(new Error('离线请求队列已满，请稍后重试'));
  }

  // 加入队列，返回 Promise（网络恢复时 resolve/reject）
  return new Promise((resolve, reject) => {
    _requestQueue.push({ fn, resolve, reject, addedAt: Date.now() });
    console.info(`[Network] 任务已加入离线队列，当前队列长度: ${_requestQueue.length}`);
  });
}

/**
 * 清空请求队列（不执行，全部 reject）
 * 场景：页面卸载时调用，防止僵尸任务
 *
 * @param {string} [reason='队列已手动清空']
 */
function clearQueue(reason = '队列已手动清空') {
  while (_requestQueue.length > 0) {
    const task = _requestQueue.shift();
    task.reject(new Error(reason));
  }
  console.info('[Network] 请求队列已清空');
}

/**
 * 获取当前队列长度
 * @returns {number}
 */
function getQueueLength() {
  return _requestQueue.length;
}

// ─────────────────────────────────────────────────────────────────
//  内部工具
// ─────────────────────────────────────────────────────────────────

/**
 * 网络恢复时，依次执行队列中的所有任务（FIFO）
 * 每个任务独立执行，失败不影响后续任务
 * @private
 */
async function _flushQueue() {
  if (_requestQueue.length === 0) return;
  console.info(`[Network] 网络已恢复，开始执行离线队列，共 ${_requestQueue.length} 个任务`);

  // 取出队列快照（执行期间可能有新任务加入）
  const tasks = _requestQueue.splice(0, _requestQueue.length);

  for (const task of tasks) {
    try {
      const result = await task.fn();
      task.resolve(result);
    } catch (err) {
      console.warn('[Network] 离线队列任务执行失败', err);
      task.reject(err);
    }
  }
}

// ─────────────────────────────────────────────────────────────────
//  模块导出
// ─────────────────────────────────────────────────────────────────

module.exports = {
  isOnline,
  getNetworkType,
  getNetworkStatus,
  onNetworkStatusChange,
  offNetworkStatusChange,
  enqueue,
  clearQueue,
  getQueueLength,
};
