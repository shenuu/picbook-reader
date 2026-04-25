/**
 * @file src/utils/swipe-behavior.js
 * @description 左滑露出删除按钮 — 可复用的 WeChat Behavior
 *
 * 使用方式（Page 或 Component）：
 *   const SwipeBehavior = require('../../utils/swipe-behavior');
 *   Page({ behaviors: [SwipeBehavior], data: { swipeX: {}, swipeOpenKey: '' }, ... })
 *
 * WXML 要求：
 *   - 每个可滑动条目绑定：
 *       bindtouchstart="onSwipeTouchStart"
 *       bindtouchmove="onSwipeTouchMove"
 *       bindtouchend="onSwipeTouchEnd"
 *     并通过 data-swipe-key="{{唯一标识}}" 声明该条目的 key
 *   - 删除按钮绑定 catchtap="onSwipeDeleteTap"（Behavior 不实现删除逻辑，只关闭面板）
 *   - 页面根节点绑定 catchtap="onSwipeClose" 以关闭已打开的面板
 *
 * 宿主页面须提供 data 字段：
 *   swipeX        {Object}  各条目的 translateX（px），格式：{ [key]: number }
 *   swipeOpenKey  {string}  当前打开的条目 key，'' = 无
 *
 * 宿主页面需在 onLoad 中调用 this._swipeInit() 以缓存屏幕宽度。
 */

'use strict';

/** 删除按钮宽度 rpx（与 WXML/WXSS 保持一致） */
const DELETE_REVEAL_RPX = 160;
/** 确定横向滑动方向的最小位移 px */
const DIRECTION_THRESHOLD = 8;

const SwipeBehavior = Behavior({
  data: {},

  // ── 内部状态（不需要渲染，挂在实例上）────────────────
  // _swipe_windowWidth: number   屏幕宽度，onLoad 时缓存
  // _swipe_startX: number
  // _swipe_startY: number
  // _swipe_direction: null | 'h' | 'v'
  // _swipe_startOffsetX: number  滑动开始时该条目的 translateX
  // _swipe_key: string           当前操作的条目 key

  methods: {
    /** 宿主在 onLoad 中调用，缓存屏幕宽度避免重复 getSystemInfoSync */
    _swipeInit() {
      const { windowWidth } = wx.getSystemInfoSync();
      this._swipe_windowWidth = windowWidth;
    },

    /** rpx → px */
    _swipeRpxToPx(rpx) {
      return (rpx / 750) * (this._swipe_windowWidth || 375);
    },

    /** 关闭当前打开的面板 */
    _swipeClose() {
      const key = this.data.swipeOpenKey;
      if (key !== undefined && key !== '' && key !== -1) {
        this.setData({
          [`swipeX.${key}`]: 0,
          swipeOpenKey: typeof key === 'number' ? -1 : '',
        });
      }
    },

    // ── touch 事件处理 ───────────────────────────────

    onSwipeClose() {
      this._swipeClose();
    },

    onSwipeTouchStart(e) {
      const touch = e.touches[0];
      this._swipe_startX = touch.clientX;
      this._swipe_startY = touch.clientY;
      this._swipe_direction = null;
      const key = e.currentTarget.dataset.swipeKey;
      this._swipe_key = key;
      this._swipe_startOffsetX = this.data.swipeX[key] || 0;
    },

    onSwipeTouchMove(e) {
      const touch = e.touches[0];
      const dx = touch.clientX - this._swipe_startX;
      const dy = touch.clientY - this._swipe_startY;

      if (this._swipe_direction === null) {
        if (Math.abs(dx) > DIRECTION_THRESHOLD || Math.abs(dy) > DIRECTION_THRESHOLD) {
          this._swipe_direction = Math.abs(dx) > Math.abs(dy) ? 'h' : 'v';
        } else {
          return;
        }
      }

      if (this._swipe_direction !== 'h') return;

      const key = this._swipe_key;
      const deleteW = this._swipeRpxToPx(DELETE_REVEAL_RPX);
      let newX = this._swipe_startOffsetX + dx;
      newX = Math.max(-deleteW, Math.min(0, newX));

      this.setData({ [`swipeX.${key}`]: newX });
      e.stopPropagation && e.stopPropagation();
    },

    onSwipeTouchEnd() {
      if (this._swipe_direction !== 'h') return;

      const key = this._swipe_key;
      const curX = this.data.swipeX[key] || 0;
      const deleteW = this._swipeRpxToPx(DELETE_REVEAL_RPX);

      if (curX < -(deleteW / 2)) {
        // 超过一半 → 完全打开
        this.setData({
          [`swipeX.${key}`]: -deleteW,
          swipeOpenKey: key,
        });
      } else {
        this._swipeClose();
      }
    },
  },
});

module.exports = SwipeBehavior;
