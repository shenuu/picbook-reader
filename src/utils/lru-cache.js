/**
 * @file utils/lru-cache.js
 * @description 绘本朗读助手 - LRU Cache 核心数据结构
 *
 * 实现：哈希表 + 双向链表（O(1) get / put / evict）
 *
 * 特性：
 *  - capacity  最大容量，超出时自动淘汰最久未访问的条目
 *  - onEvict   可选的淘汰回调，用于清理外部资源（如文件）
 *  - values()  按 LRU 顺序（最旧 → 最新）返回所有值的快照
 *  - clear()   清空所有条目
 *  - size()    当前条目数
 *
 * 不依赖任何外部库，可直接在微信小程序环境中运行。
 *
 * @example
 *   const cache = new LRUCache(3, (key, val) => console.log('evicted', key));
 *   cache.put('a', 1);
 *   cache.put('b', 2);
 *   cache.put('c', 3);
 *   cache.get('a');     // 访问 'a'，'b' 变为最旧
 *   cache.put('d', 4);  // 淘汰 'b'
 *
 * @author Jamie Park
 * @version 0.1.0
 */

// ─────────────────────────────────────────────────────────────────
//  双向链表节点
// ─────────────────────────────────────────────────────────────────

/**
 * @private
 * @template K, V
 */
class ListNode {
  /**
   * @param {K} key
   * @param {V} value
   */
  constructor(key, value) {
    this.key = key;
    this.value = value;
    /** @type {ListNode<K,V>|null} */
    this.prev = null;
    /** @type {ListNode<K,V>|null} */
    this.next = null;
  }
}

// ─────────────────────────────────────────────────────────────────
//  LRU Cache
// ─────────────────────────────────────────────────────────────────

/**
 * LRU Cache（最近最少使用缓存）
 * @template K, V
 */
class LRUCache {
  /**
   * @param {number}                    capacity  - 最大容量（>= 1）
   * @param {(key: K, value: V) => void} [onEvict] - 淘汰回调
   */
  constructor(capacity, onEvict) {
    if (!Number.isInteger(capacity) || capacity < 1) {
      throw new Error('LRUCache: capacity 必须是正整数');
    }

    this._capacity = capacity;
    this._onEvict = typeof onEvict === 'function' ? onEvict : null;

    /**
     * 哈希表：key → ListNode
     * @type {Map<K, ListNode<K,V>>}
     */
    this._map = new Map();

    /**
     * 双向链表的哨兵头尾节点（不存储实际数据）
     * head.next → 最旧节点（下一个被淘汰）
     * tail.prev → 最新节点（最近访问）
     */
    this._head = new ListNode(null, null); // 最旧端哨兵
    this._tail = new ListNode(null, null); // 最新端哨兵
    this._head.next = this._tail;
    this._tail.prev = this._head;
  }

  // ───────────────────────────────────────────
  //  公开方法
  // ───────────────────────────────────────────

  /**
   * 获取缓存值，同时将该节点移到"最新"位置
   * @param {K} key
   * @returns {V|null} 不存在时返回 null
   */
  get(key) {
    const node = this._map.get(key);
    if (!node) return null;

    // 移到尾部（最新）
    this._moveToTail(node);
    return node.value;
  }

  /**
   * 写入缓存：
   *  - key 已存在：更新 value，移到最新
   *  - key 不存在且未满：插入到最新
   *  - key 不存在且已满：淘汰最旧节点，再插入
   *
   * @param {K} key
   * @param {V} value
   */
  put(key, value) {
    if (this._map.has(key)) {
      // 更新已有节点
      const node = this._map.get(key);
      node.value = value;
      this._moveToTail(node);
      return;
    }

    // 容量检查
    if (this._map.size >= this._capacity) {
      this._evictOldest();
    }

    // 插入新节点到尾部
    const newNode = new ListNode(key, value);
    this._map.set(key, newNode);
    this._insertBefore(this._tail, newNode);
  }

  /**
   * 当前缓存条目数
   * @returns {number}
   */
  size() {
    return this._map.size;
  }

  /**
   * 按 LRU 顺序（最旧 → 最新）返回所有值的数组快照
   * @returns {V[]}
   */
  values() {
    const result = [];
    let cur = this._head.next;
    while (cur !== this._tail) {
      result.push(cur.value);
      cur = cur.next;
    }
    return result;
  }

  /**
   * 按 LRU 顺序返回所有 [key, value] 键值对
   * @returns {Array<[K, V]>}
   */
  entries() {
    const result = [];
    let cur = this._head.next;
    while (cur !== this._tail) {
      result.push([cur.key, cur.value]);
      cur = cur.next;
    }
    return result;
  }

  /**
   * 清空所有缓存（不触发 onEvict）
   */
  clear() {
    this._map.clear();
    this._head.next = this._tail;
    this._tail.prev = this._head;
  }

  /**
   * 判断 key 是否存在（不更新 LRU 顺序）
   * @param {K} key
   * @returns {boolean}
   */
  has(key) {
    return this._map.has(key);
  }

  /**
   * 删除指定 key（不触发 onEvict）
   * @param {K} key
   * @returns {boolean} 是否成功删除
   */
  delete(key) {
    const node = this._map.get(key);
    if (!node) return false;
    this._removeNode(node);
    this._map.delete(key);
    return true;
  }

  // ───────────────────────────────────────────
  //  内部链表操作
  // ───────────────────────────────────────────

  /**
   * 淘汰最旧节点（head.next），并触发 onEvict 回调
   * @private
   */
  _evictOldest() {
    const oldest = this._head.next;
    if (oldest === this._tail) return; // 空链表

    this._removeNode(oldest);
    this._map.delete(oldest.key);

    if (this._onEvict) {
      try {
        this._onEvict(oldest.key, oldest.value);
      } catch (err) {
        console.error('[LRUCache] onEvict 回调出错', err);
      }
    }
  }

  /**
   * 将节点移到链表尾部（最新位置）
   * @param {ListNode} node
   * @private
   */
  _moveToTail(node) {
    this._removeNode(node);
    this._insertBefore(this._tail, node);
  }

  /**
   * 将 node 插入到 refNode 之前
   * @param {ListNode} refNode
   * @param {ListNode} node
   * @private
   */
  _insertBefore(refNode, node) {
    node.prev = refNode.prev;
    node.next = refNode;
    refNode.prev.next = node;
    refNode.prev = node;
  }

  /**
   * 从链表中摘除节点（不删除 Map 中的引用）
   * @param {ListNode} node
   * @private
   */
  _removeNode(node) {
    node.prev.next = node.next;
    node.next.prev = node.prev;
    node.prev = null;
    node.next = null;
  }
}

// ─────────────────────────────────────────────────────────────────
//  模块导出
// ─────────────────────────────────────────────────────────────────

module.exports = LRUCache;
