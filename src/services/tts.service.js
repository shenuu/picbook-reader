/**
 * @file services/tts.service.js
 * @description 绘本朗读助手 - TTS（文字转语音）服务
 *
 * 职责：
 *  1. 通过 BFF 云函数获取讯飞 WebSocket 带签名 URL（P0-1/P0-2：密钥不再出现在前端）
 *  2. 建立讯飞 TTS WebSocket（WSS）长连接
 *  3. 流式接收 Base64 编码的 MP3 音频帧（P0-3：aue=lame 输出 MP3）
 *  4. 将所有帧拼接后写入本地文件系统（wx.getFileSystemManager）
 *  5. 返回本地文件路径，供播放器使用
 *  6. 支持进度回调 & 手动取消 & onPlayStart 回调（P1-3）
 *
 * P0 修复说明：
 *  - P0-1/P0-2: 删除 _hmacSHA256 / _buildAuthParams；新增 _getSignedWsUrl()
 *               通过 BFF（云函数 tts-sign）获取签名 URL，密钥不暴露前端
 *  - P0-3: aue 改为 'lame'，auf 改为 'audio/mpeg'，文件扩展名改为 .mp3
 *  - P0-4: 添加 settled 标志 + safeReject/safeResolve + 15s 全局超时兜底
 *            防止 onError 后 onClose 不触发导致 Promise 永久 pending
 *
 * P1-3 修复说明：
 *  - synthesize() 支持 onPlayStart 回调选项
 *  - 合成完成开始调用播放时通过 onPlayStart 通知上层切换到 PLAYING 状态
 *
 * 讯飞 TTS WebSocket 协议简述：
 *  - 地址: wss://tts-api.xfyun.cn/v2/tts?...（带鉴权参数）
 *  - 发送: JSON { common, business, data }
 *  - 接收: JSON { code, data: { audio (base64), status } }
 *    - status=1: 中间帧  status=2: 最后一帧
 *
 * @see https://www.xfyun.cn/doc/tts/online_tts/API.html
 *
 * @author Jamie Park
 * @version 0.2.0
 */

const {
  TTS_WS_SIGN_URL,
  TTS_APP_ID,
  TTS_WS_CONNECT_TIMEOUT_MS,
  TTS_GLOBAL_TIMEOUT_MS,
  TTS_MAX_RETRY,
  TTS_RETRY_BASE_DELAY_MS,
  AUDIO_STORAGE_DIR,
  DEFAULT_VOICE_TYPE,
  VOICE_CONFIG,
} = require('../config');

const { processForTts } = require('./text-processor.service');
const ttsTencentService = require('./tts-tencent.service');

/** 本地音频文件存储目录（wx.env.USER_DATA_PATH 下） */
const AUDIO_DIR = `${wx.env.USER_DATA_PATH}/${AUDIO_STORAGE_DIR}`;

/**
 * 讯飞 TTS 业务参数默认值
 * P0-3: aue 改为 'lame'（MP3），auf 改为 'audio/mpeg'
 */
const DEFAULT_BUSINESS_PARAMS = {
  aue: 'lame',         // P0-3: 音频编码改为 MP3（原来是 'raw'）
  sfl: 1,              // 流式返回
  auf: 'audio/mpeg',   // P0-3: 音频格式改为 audio/mpeg（原来是 audio/L16;rate=16000）
  vcn: VOICE_CONFIG[DEFAULT_VOICE_TYPE]?.vcn || 'xiaoyan', // 默认发音人
  speed: VOICE_CONFIG[DEFAULT_VOICE_TYPE]?.speed || 50,    // 语速 0-100
  volume: 50,          // 音量
  pitch: 50,           // 音调
  tte: 'utf8',         // 文本编码
  reg: '2',            // 英文单词按整词朗读（'1'=逐字母，'2'=按单词）
  rdn: '0',            // 数字按优先策略读
};

/** 当前 WebSocket 任务引用（用于 cancel()） */
let _currentSocketTask = null;
let _firstFrameReceived = false;

// ─────────────────────────────────────────────────────────────────
//  公开接口
// ─────────────────────────────────────────────────────────────────

/**
 * 合成文字到本地 MP3 文件
 * 内部自动重试（最多 TTS_MAX_RETRY 次，指数退避）
 *
 * @param {string} text                      - 待合成的文字（≤ 8000 字节）
 * @param {object} [options]
 * @param {Function} [options.onProgress]    - 进度回调 (percent: number) => void
 * @param {Function} [options.onPlayStart]   - P1-3: 合成完毕开始播放时回调，上层切换到 PLAYING 状态
 * @param {object}   [options.voice]         - 覆盖默认发音人参数，如 { vcn: 'xiaoyan', speed: 50 }
 * @returns {Promise<string>}                - 本地 MP3 文件路径
 *
 * @example
 *   const path = await ttsService.synthesize('床前明月光', {
 *     onProgress: p => console.log(p),
 *     onPlayStart: () => page.setData({ playStatus: 'playing' }),
 *   });
 */
async function synthesize(text, options = {}) {
  const { onProgress, onPlayStart, voice = {} } = options;

  // ── 文本预处理：OCR 噪声清洗 + 语种检测 + 英文增强 + 字节截断 ──
  const { processedText, language, truncated } = processForTts(text);
  if (truncated) {
    console.warn('[TTS] 文本超长已截断');
  }
  console.info(`[TTS] 语种检测: ${language.type}，英文占比 ${(language.englishRatio * 100).toFixed(0)}%`);

  // 把语种信息透传给调用方（result 页面可用来显示提示 badge）
  if (typeof options.onLanguageDetected === 'function') {
    options.onLanguageDetected(language);
  }

  // ── 语种路由 ──────────────────────────────────────────────────
  // english / mixed → 腾讯云大模型 TTS（VoiceType 1001，支持中英双语）
  // chinese         → 讯飞 WebSocket TTS（免费发音人 xiaoyan 等）
  if (language.type === 'english' || language.type === 'mixed') {
    console.info(`[TTS] ${language.type} 文本 → 腾讯云大模型 TTS`);
    return ttsTencentService.synthesize(processedText, {
      languageType: language.type,
      onProgress,
      onPlayStart,
    });
  }

  // 中文：走讯飞 WebSocket TTS
  console.info('[TTS] 中文文本 → 讯飞 TTS');

  // 合并发音人参数（options.voice 可覆盖默认值）
  const businessParams = { ...DEFAULT_BUSINESS_PARAMS, ...voice };

  let lastError;
  for (let attempt = 0; attempt <= TTS_MAX_RETRY; attempt++) {
    if (attempt > 0) {
      // 重试前强制关闭上一次的 WebSocket 连接
      if (_currentSocketTask) {
        try { _currentSocketTask.close({ code: 1000, reason: '重试关闭' }); } catch (_) {}
        _currentSocketTask = null;
      }
      // 指数退避：第1次重试等 500ms，第2次等 1000ms
      await _delay(TTS_RETRY_BASE_DELAY_MS * Math.pow(2, attempt - 1));
      console.info(`[TTS] 第 ${attempt} 次重试…`);
    }
    try {
      const localPath = await _doSynthesize(processedText, businessParams, onProgress);
      // P1-3: 合成完成，通知上层现在可以切换到 PLAYING 状态
      if (typeof onPlayStart === 'function') {
        onPlayStart();
      }
      return localPath;
    } catch (err) {
      lastError = err;
      console.warn(`[TTS] 第 ${attempt + 1} 次合成失败:`, err.message);
    }
  }

  throw new Error(`TTS 合成失败（已重试 ${TTS_MAX_RETRY} 次）: ${lastError?.message}`);
}

/**
 * 取消当前正在进行的 TTS 合成（主动关闭 WebSocket）
 */
function cancel() {
  if (_currentSocketTask) {
    try {
      _currentSocketTask.close({ code: 1000, reason: '用户取消' });
    } catch (_) {
      // 忽略关闭时的错误
    }
    _currentSocketTask = null;
  }
  console.info('[TTS] 已取消合成');
}

// ─────────────────────────────────────────────────────────────────
//  主流程
// ─────────────────────────────────────────────────────────────────

/**
 * 执行一次完整的 TTS 合成流程：
 *  1. 通过 BFF 获取签名 URL（P0-1/P0-2）
 *  2. 建立 WebSocket，流式接收音频帧
 *  3. 写入本地 MP3 文件，返回路径
 *
 * @param {string}   text            - 合成文本
 * @param {object}   businessParams  - 讯飞业务参数
 * @param {Function} [onProgress]    - 进度回调
 * @returns {Promise<string>}        - 本地 MP3 文件路径
 * @private
 */
async function _doSynthesize(text, businessParams, onProgress) {
  // Step 1: 从 BFF 云函数获取带签名的 wss URL
  if (typeof onProgress === 'function') onProgress(5);
  const wsUrl = await _getSignedWsUrl();

  // Step 2: 建立 WebSocket 连接并流式接收音频帧（返回完整 Base64 字符串）
  if (typeof onProgress === 'function') onProgress(10);
  const fullBase64 = await _streamTts(wsUrl, text, businessParams, onProgress);

  // Step 3: 将 Base64 数据写入本地文件（P0-3: 扩展名 .mp3）
  if (typeof onProgress === 'function') onProgress(95);
  const localPath = await _writeAudioFile(fullBase64);

  if (typeof onProgress === 'function') onProgress(100);
  return localPath;
}

// ─────────────────────────────────────────────────────────────────
//  Step 1 — 获取 BFF 签名 URL（P0-1/P0-2）
// ─────────────────────────────────────────────────────────────────

/**
 * 向 BFF 云函数请求带 HMAC-SHA256 签名的讯飞 TTS WebSocket URL
 *
 * BFF 端（cloud-functions/tts-sign/index.js）负责：
 *  - 从 process.env.TTS_API_KEY / TTS_API_SECRET 读取密钥
 *  - 生成 RFC3339 格式时间戳
 *  - 计算 HMAC-SHA256 签名
 *  - 拼装并返回 wss://tts-api.xfyun.cn/v2/tts?authorization=...&... URL
 *
 * BFF 接口：GET /tts-sign
 * 响应：{ code: 0, data: { wsUrl: string } }
 *
 * @returns {Promise<string>} 带签名的 wss:// URL
 * @private
 */
function _getSignedWsUrl() {
  return new Promise((resolve, reject) => {
    wx.request({
      url: TTS_WS_SIGN_URL,
      method: 'GET',
      timeout: 8000,
      success: (res) => {
        if (res.statusCode !== 200) {
          reject(new Error(`获取 TTS 签名 URL 失败，HTTP ${res.statusCode}`));
          return;
        }
        if (res.data?.code === 0 && res.data?.data?.wsUrl) {
          resolve(res.data.data.wsUrl);
        } else {
          reject(new Error('BFF 返回格式异常: ' + JSON.stringify(res.data)));
        }
      },
      fail: (err) => reject(new Error('获取 TTS 签名 URL 请求失败: ' + err.errMsg)),
    });
  });
}

// ─────────────────────────────────────────────────────────────────
//  Step 2 — WebSocket 流式合成（P0-4: settled 标志 + 全局超时兜底）
// ─────────────────────────────────────────────────────────────────

/**
 * 建立讯飞 TTS WebSocket 连接，发送文本，流式接收 Base64 MP3 帧
 *
 * P0-4 修复：
 *  - 添加 settled 标志，确保 Promise 只能 resolve/reject 一次
 *  - safeResolve / safeReject 封装防止多次触发
 *  - 添加 TTS_GLOBAL_TIMEOUT_MS（15s）全局超时兜底：
 *    onError 后 onClose 不一定触发，全局超时可防止 Promise 永久 pending
 *
 * @param {string}   wsUrl           - 带鉴权参数的 wss 地址
 * @param {string}   text            - 合成文本
 * @param {object}   businessParams  - 讯飞业务参数
 * @param {Function} [onProgress]    - 进度回调 (0-90)
 * @returns {Promise<string>}        - 完整 MP3 的 Base64 字符串
 * @private
 */
function _streamTts(wsUrl, text, businessParams, onProgress) {
  return new Promise((resolve, reject) => {
    /** 收集所有帧解码后的字节数组 */
    const audioByteArrays = [];
    let totalFrames = 0;

    /**
     * P0-4: settled 标志 — 防止 Promise 被 resolve/reject 多次
     * onError 与 onClose 都可能触发 fail，settled 确保只有第一次生效
     */
    let settled = false;

    const safeResolve = (val) => {
      if (settled) return;
      settled = true;
      clearTimeout(connectTimer);
      clearTimeout(globalTimer);
      resolve(val);
    };

    const safeReject = (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(connectTimer);
      clearTimeout(globalTimer);
      reject(err);
    };

    // 连接超时保护：若超时内未建立连接则 reject
    const connectTimer = setTimeout(() => {
      safeReject(new Error(`TTS WebSocket 连接超时（${TTS_WS_CONNECT_TIMEOUT_MS}ms）`));
      if (_currentSocketTask) {
        try { _currentSocketTask.close({}); } catch (_) {}
        _currentSocketTask = null;
      }
    }, TTS_WS_CONNECT_TIMEOUT_MS);

    /**
     * P0-4: 全局兜底超时（15秒）
     * 场景：onError 已触发但 onClose 迟迟不触发 → settled 未设置 → Promise 永久 pending
     * 此 timer 确保 15s 后强制 reject，释放等待方
     */
    const globalTimer = setTimeout(() => {
      console.warn('[TTS] 全局超时兜底触发，强制 reject');
      safeReject(new Error(`TTS 合成全局超时（${TTS_GLOBAL_TIMEOUT_MS}ms）`));
      if (_currentSocketTask) {
        try { _currentSocketTask.close({}); } catch (_) {}
        _currentSocketTask = null;
      }
    }, TTS_GLOBAL_TIMEOUT_MS);

    console.info('[TTS] 正在连接 wsUrl:', wsUrl.slice(0, 80));
    _firstFrameReceived = false;
    const socketTask = wx.connectSocket({
      url: wsUrl,
      fail: (err) => {
        wx.showModal({ title: 'WS连接fail', content: err.errMsg, showCancel: false });
        safeReject(new Error('WebSocket 连接失败: ' + err.errMsg));
      },
    });

    // 保存到模块级变量，供 cancel() 使用
    _currentSocketTask = socketTask;

    socketTask.onOpen(() => {
      clearTimeout(connectTimer);
      console.info('[TTS] WebSocket 已连接');

      try {
        const payload = _buildTtsPayload(text, businessParams);
        const payloadStr = JSON.stringify(payload);
        console.info('[TTS] payload vcn:', payload.business?.vcn, 'app_id:', payload.common?.app_id);
        socketTask.send({
          data: payloadStr,
          success: () => {
            console.info('[TTS] payload 发送成功');
          },
          fail: (err) => {
            wx.showModal({ title: 'send失败', content: err.errMsg, showCancel: false });
            safeReject(new Error('发送 TTS 请求失败: ' + err.errMsg));
          },
        });
      } catch (e) {
        wx.showModal({ title: 'onOpen异常', content: e.message || String(e), showCancel: false });
        safeReject(new Error('onOpen 异常: ' + (e.message || String(e))));
      }
    });

    socketTask.onMessage((event) => {
      try {
        console.info('[TTS] 收到消息:', typeof event.data === 'string' ? event.data.slice(0, 200) : event.data);
        const frame = JSON.parse(event.data);
        if (frame.code !== 0) {
          wx.showModal({ title: '讯飞错误', content: `code=${frame.code}: ${frame.message}`, showCancel: false });
        }

        // 讯飞错误码非 0 时视为失败
        if (frame.code !== 0) {
          safeReject(new Error(`讯飞 TTS 错误 code=${frame.code}: ${frame.message}`));
          try { socketTask.close({}); } catch (_) {}
          return;
        }

        const { audio, status } = frame.data || {};

        if (audio) {
          audioByteArrays.push(_base64Decode(audio)); // 解码为字节数组
          totalFrames++;

          // 根据已收帧数估算进度（10~90 区间，留头尾给 token 获取和文件写入）
          if (typeof onProgress === 'function') {
            const estimated = status === 2
              ? 90
              : Math.min(10 + totalFrames * 5, 85);
            onProgress(estimated);
          }
        }

        // status=2 代表最后一帧，合成完毕
        if (status === 2) {
          try { socketTask.close({}); } catch (_) {}
          _currentSocketTask = null;
          // 合并所有字节数组，重新编码为 Base64
          const totalLen = audioByteArrays.reduce((s, a) => s + a.length, 0);
          const merged = new Uint8Array(totalLen);
          let offset = 0;
          for (const arr of audioByteArrays) {
            merged.set(arr, offset);
            offset += arr.length;
          }
          const fullBase64 = _uint8ArrayToBase64(merged);
          console.info(`[TTS] 合成完成，共 ${totalFrames} 帧，字节数: ${totalLen}，Base64长度: ${fullBase64.length}`);
          safeResolve(fullBase64);
        }
      } catch (parseErr) {
        safeReject(new Error('TTS 帧解析失败: ' + parseErr.message));
        try { socketTask.close({}); } catch (_) {}
      }
    });

    /**
     * P0-4: onError 后 safeReject
     * 原代码直接调用 fail()，但没有 settled 保护；
     * 修复后：safeReject 保证只触发一次，全局 timer 作为 onClose 不触发时的最后防线
     */
    socketTask.onError((err) => {
      const msg = err.errMsg || JSON.stringify(err);
      console.error('[TTS] WebSocket 错误:', msg);
      wx.showModal({ title: 'WS onError', content: msg, showCancel: false });
      safeReject(new Error('WebSocket 错误: ' + msg));
      // 主动关闭，触发 onClose 以释放资源（但 onClose 内的 safeReject 会因 settled=true 被忽略）
      try { socketTask.close({}); } catch (_) {}
    });

    socketTask.onClose((res) => {
      console.info('[TTS] WebSocket 关闭，code:', res.code, '原因:', res.reason);
      // 若 WebSocket 在未收到 status=2 的情况下关闭，视为异常
      // settled=true 时此处调用是无操作（P0-4 保证）
      safeReject(new Error('WebSocket 意外关闭，可能未收到完整音频'));
      _currentSocketTask = null;
    });
  });
}

/**
 * 构建讯飞 TTS 请求 Payload
 * @param {string} text
 * @param {object} businessParams
 * @returns {object}
 * @private
 */
function _buildTtsPayload(text, businessParams) {
  return {
    common: { app_id: TTS_APP_ID },
    business: businessParams,
    data: {
      status: 2,               // 一次性发送全部文本
      text: _base64Encode(text), // 文本须 Base64 编码
    },
  };
}

// ─────────────────────────────────────────────────────────────────
//  Step 3 — 写入本地文件（P0-3: 扩展名改为 .mp3）
// ─────────────────────────────────────────────────────────────────

/**
 * 将 MP3 Base64 数据写入本地文件系统
 * P0-3: 文件扩展名已为 .mp3（匹配 aue=lame 输出格式）
 *
 * @param {string} base64Data - MP3 的 Base64 字符串
 * @returns {Promise<string>}   本地文件绝对路径
 * @private
 */
function _writeAudioFile(base64Data) {
  return new Promise((resolve, reject) => {
    const fs = wx.getFileSystemManager();
    // P0-3: 确保扩展名为 .mp3
    const fileName = `tts_${Date.now()}_${Math.random().toString(36).slice(2, 7)}.mp3`;
    const filePath = `${AUDIO_DIR}/${fileName}`;

    // 确保存储目录存在（若已存在会抛异常，忽略即可）
    try {
      fs.mkdirSync(AUDIO_DIR, true);
    } catch (_) {
      // 目录已存在，继续执行
    }

    fs.writeFile({
      filePath,
      data: base64Data,
      encoding: 'base64',
      success: () => {
        // 验证文件实际大小
        try {
          const stat = fs.statSync(filePath);
          console.info('[TTS] 音频文件已写入:', filePath, '大小:', stat.size, 'bytes');
          if (stat.size < 100) {
            reject(new Error(`写入的文件过小(${stat.size}字节)，可能不是有效MP3`));
            return;
          }
        } catch (e) {
          console.warn('[TTS] stat失败:', e.message);
        }
        resolve(filePath);
      },
      fail: (err) => reject(new Error('写入音频文件失败: ' + err.errMsg)),
    });
  });
}

// ─────────────────────────────────────────────────────────────────
//  工具函数
// ─────────────────────────────────────────────────────────────────

/**
 * 将 UTF-8 字符串进行 Base64 编码（支持中文）
 * 流程：先 encodeURIComponent，再手动 decode 成 latin1 字节，最后 btoa
 *
 * @param {string} str - 任意 UTF-8 字符串
 * @returns {string}   - Base64 编码结果
 * @private
 */
/**
 * 将 Base64 字符串解码为 Uint8Array 字节数组
 */
function _base64Decode(base64) {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  const lookup = new Uint8Array(256);
  for (let i = 0; i < chars.length; i++) lookup[chars.charCodeAt(i)] = i;
  // 去掉 padding
  const clean = base64.replace(/=+$/, '');
  const len = Math.floor(clean.length * 3 / 4);
  const bytes = new Uint8Array(len);
  let byteIdx = 0;
  for (let i = 0; i < clean.length; i += 4) {
    const b0 = lookup[clean.charCodeAt(i)];
    const b1 = lookup[clean.charCodeAt(i + 1)];
    const b2 = lookup[clean.charCodeAt(i + 2)] || 0;
    const b3 = lookup[clean.charCodeAt(i + 3)] || 0;
    bytes[byteIdx++] = (b0 << 2) | (b1 >> 4);
    if (i + 2 < clean.length) bytes[byteIdx++] = ((b1 & 0xF) << 4) | (b2 >> 2);
    if (i + 3 < clean.length) bytes[byteIdx++] = ((b2 & 0x3) << 6) | b3;
  }
  return bytes.subarray(0, byteIdx);
}

/**
 * 将 Uint8Array 编码为 Base64 字符串
 */
function _uint8ArrayToBase64(bytes) {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  let result = '';
  for (let i = 0; i < bytes.length; i += 3) {
    const b0 = bytes[i];
    const b1 = bytes[i + 1] || 0;
    const b2 = bytes[i + 2] || 0;
    result += chars[b0 >> 2];
    result += chars[((b0 & 3) << 4) | (b1 >> 4)];
    result += i + 1 < bytes.length ? chars[((b1 & 0xF) << 2) | (b2 >> 6)] : '=';
    result += i + 2 < bytes.length ? chars[b2 & 0x3F] : '=';
  }
  return result;
}

function _base64Encode(str) {
  // 微信小程序不支持 btoa，使用自定义实现
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/=';
  // 先将字符串转为 UTF-8 字节数组
  const bytes = [];
  for (let i = 0; i < str.length; i++) {
    const code = str.charCodeAt(i);
    if (code < 0x80) {
      bytes.push(code);
    } else if (code < 0x800) {
      bytes.push(0xC0 | (code >> 6));
      bytes.push(0x80 | (code & 0x3F));
    } else {
      bytes.push(0xE0 | (code >> 12));
      bytes.push(0x80 | ((code >> 6) & 0x3F));
      bytes.push(0x80 | (code & 0x3F));
    }
  }
  let result = '';
  for (let i = 0; i < bytes.length; i += 3) {
    const b0 = bytes[i], b1 = bytes[i + 1], b2 = bytes[i + 2];
    result += chars[b0 >> 2];
    result += chars[((b0 & 3) << 4) | (b1 >> 4)];
    result += i + 1 < bytes.length ? chars[((b1 & 0xF) << 2) | (b2 >> 6)] : '=';
    result += i + 2 < bytes.length ? chars[b2 & 0x3F] : '=';
  }
  return result;
}

/**
 * 延迟工具
 * @param {number} ms
 * @returns {Promise<void>}
 * @private
 */
function _delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ─────────────────────────────────────────────────────────────────
//  模块导出
// ─────────────────────────────────────────────────────────────────

module.exports = {
  synthesize,
  cancel,
};
