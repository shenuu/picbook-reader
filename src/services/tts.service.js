/**
 * @file services/tts.service.js
 * @description 绘本朗读助手 - TTS（文字转语音）服务
 *
 * 职责：
 *  1. 通过 BFF 获取讯飞 WebSocket 鉴权 Token（避免在小程序端暴露 AppSecret）
 *  2. 建立讯飞 TTS WebSocket（WSS）长连接
 *  3. 流式接收 Base64 编码的 MP3 音频帧
 *  4. 将所有帧拼接后写入本地文件系统（wx.getFileSystemManager）
 *  5. 返回本地文件路径，供播放器使用
 *  6. 支持进度回调 & 手动取消
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
 * @version 0.1.0
 */

const {
  BFF_BASE_URL,
  TTS_WS_CONNECT_TIMEOUT_MS,
  TTS_MAX_RETRY,
  TTS_RETRY_BASE_DELAY_MS,
  AUDIO_STORAGE_DIR,
  DEFAULT_VOICE_TYPE,
  VOICE_CONFIG,
} = require('../config');

/** 本地音频文件存储目录（wx.env.USER_DATA_PATH 下） */
const AUDIO_DIR = `${wx.env.USER_DATA_PATH}/${AUDIO_STORAGE_DIR}`;

/** 讯飞 TTS 业务参数默认值 */
const DEFAULT_BUSINESS_PARAMS = {
  aue: 'lame',    // 音频编码：MP3
  sfl: 1,         // 流式返回
  auf: 'audio/L16;rate=16000',
  vcn: VOICE_CONFIG[DEFAULT_VOICE_TYPE]?.vcn || 'x_xiaoyan', // 默认发音人
  speed: VOICE_CONFIG[DEFAULT_VOICE_TYPE]?.speed || 50,       // 语速 0-100
  volume: 50,     // 音量
  pitch: 50,      // 音调
  tte: 'utf8',    // 文本编码
};

/** 当前 WebSocket 任务引用（用于 cancel()） */
let _currentSocketTask = null;

// ─────────────────────────────────────────────────────────────────
//  公开接口
// ─────────────────────────────────────────────────────────────────

/**
 * 合成文字到本地 MP3 文件
 * 内部自动重试（最多 TTS_MAX_RETRY 次，指数退避）
 *
 * @param {string} text                    - 待合成的文字（≤ 8000 字节）
 * @param {object} [options]
 * @param {Function} [options.onProgress]  - 进度回调 (percent: number) => void
 * @param {object}  [options.voice]        - 覆盖默认发音人参数，如 { vcn: 'x_xiaoming', speed: 50 }
 * @returns {Promise<string>}              - 本地 MP3 文件路径
 *
 * @example
 *   const path = await ttsService.synthesize('床前明月光', { onProgress: p => console.log(p) });
 */
async function synthesize(text, options = {}) {
  const { onProgress, voice = {} } = options;

  // 合并发音人参数（options.voice 可覆盖默认值）
  const businessParams = { ...DEFAULT_BUSINESS_PARAMS, ...voice };

  let lastError;
  for (let attempt = 0; attempt <= TTS_MAX_RETRY; attempt++) {
    if (attempt > 0) {
      // 指数退避：第1次重试等 500ms，第2次等 1000ms
      await _delay(TTS_RETRY_BASE_DELAY_MS * Math.pow(2, attempt - 1));
      console.info(`[TTS] 第 ${attempt} 次重试…`);
    }
    try {
      const localPath = await _doSynthesize(text, businessParams, onProgress);
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
 *  1. 获取 BFF 签名 URL
 *  2. 建立 WebSocket，流式接收音频帧
 *  3. 写入本地文件，返回路径
 *
 * @param {string}   text            - 合成文本
 * @param {object}   businessParams  - 讯飞业务参数
 * @param {Function} [onProgress]    - 进度回调
 * @returns {Promise<string>}        - 本地 MP3 文件路径
 * @private
 */
async function _doSynthesize(text, businessParams, onProgress) {
  // Step 1: 从 BFF 获取鉴权 URL
  if (typeof onProgress === 'function') onProgress(5);
  const wsUrl = await _fetchTtsToken();

  // Step 2: 建立 WebSocket 连接并流式接收音频帧（返回完整 Base64 字符串）
  if (typeof onProgress === 'function') onProgress(10);
  const fullBase64 = await _streamTts(wsUrl, text, businessParams, onProgress);

  // Step 3: 将 Base64 数据写入本地文件
  if (typeof onProgress === 'function') onProgress(95);
  const localPath = await _writeAudioFile(fullBase64);

  if (typeof onProgress === 'function') onProgress(100);
  return localPath;
}

// ─────────────────────────────────────────────────────────────────
//  Step 1 — 获取鉴权 Token
// ─────────────────────────────────────────────────────────────────

/**
 * 从 BFF 获取带签名的讯飞 TTS WebSocket URL
 * BFF 负责用 AppSecret 生成 HMAC-SHA256 签名，避免前端泄漏密钥
 *
 * BFF 接口：GET /api/tts/token
 * 响应：{ code: 0, data: { wsUrl: string } }
 *
 * @returns {Promise<string>} wss:// 鉴权 URL
 * @private
 */
function _fetchTtsToken() {
  return new Promise((resolve, reject) => {
    wx.request({
      url: `${BFF_BASE_URL}/api/tts/token`,
      method: 'GET',
      header: {
        // 若 BFF 要求鉴权，此处附加 token
        // 'Authorization': `Bearer ${getApp().globalData.authToken}`,
      },
      timeout: 8000,
      success: (res) => {
        if (res.statusCode !== 200) {
          reject(new Error(`获取 TTS Token 失败，HTTP ${res.statusCode}`));
          return;
        }
        if (res.data?.code === 0 && res.data?.data?.wsUrl) {
          resolve(res.data.data.wsUrl);
        } else {
          reject(new Error('获取 TTS Token 失败: ' + JSON.stringify(res.data)));
        }
      },
      fail: (err) => reject(new Error('TTS Token 请求失败: ' + err.errMsg)),
    });
  });
}

// ─────────────────────────────────────────────────────────────────
//  Step 2 — WebSocket 流式合成
// ─────────────────────────────────────────────────────────────────

/**
 * 建立讯飞 TTS WebSocket 连接，发送文本，流式接收 Base64 MP3 帧
 * 将所有帧的 Base64 字符串拼接后返回（等到最后一帧再写文件，避免多次 IO）
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
    /** 收集所有 Base64 音频帧（字符串拼接后再 decode） */
    const audioChunks = [];
    let totalFrames = 0;
    let settled = false; // 防止 resolve/reject 多次触发

    /**
     * 安全 resolve/reject，避免 Promise 多次触发
     */
    const done = (val) => { if (!settled) { settled = true; resolve(val); } };
    const fail = (err) => { if (!settled) { settled = true; reject(err); } };

    // 连接超时保护：若超时内未收到任何消息则 reject
    const connectTimer = setTimeout(() => {
      fail(new Error(`TTS WebSocket 连接超时（${TTS_WS_CONNECT_TIMEOUT_MS}ms）`));
      if (_currentSocketTask) {
        _currentSocketTask.close({});
        _currentSocketTask = null;
      }
    }, TTS_WS_CONNECT_TIMEOUT_MS);

    const socketTask = wx.connectSocket({
      url: wsUrl,
      fail: (err) => {
        clearTimeout(connectTimer);
        fail(new Error('WebSocket 连接失败: ' + err.errMsg));
      },
    });

    // 保存到模块级变量，供 cancel() 使用
    _currentSocketTask = socketTask;

    socketTask.onOpen(() => {
      clearTimeout(connectTimer);
      console.info('[TTS] WebSocket 已连接');

      // 连接成功后立即发送合成请求（讯飞协议格式）
      const payload = _buildTtsPayload(text, businessParams);
      socketTask.send({
        data: JSON.stringify(payload),
        fail: (err) => fail(new Error('发送 TTS 请求失败: ' + err.errMsg)),
      });
    });

    socketTask.onMessage((event) => {
      try {
        const frame = JSON.parse(event.data);

        // 讯飞错误码非 0 时视为失败
        if (frame.code !== 0) {
          fail(new Error(`讯飞 TTS 错误 code=${frame.code}: ${frame.message}`));
          socketTask.close({});
          return;
        }

        const { audio, status } = frame.data || {};

        if (audio) {
          audioChunks.push(audio); // 收集 Base64 字符串片段
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
          socketTask.close({});
          _currentSocketTask = null;
          const fullBase64 = audioChunks.join('');
          console.info(`[TTS] 合成完成，共 ${totalFrames} 帧，Base64 长度: ${fullBase64.length}`);
          done(fullBase64);
        }
      } catch (parseErr) {
        fail(new Error('TTS 帧解析失败: ' + parseErr.message));
        socketTask.close({});
      }
    });

    socketTask.onError((err) => {
      clearTimeout(connectTimer);
      fail(new Error('WebSocket 错误: ' + (err.errMsg || JSON.stringify(err))));
    });

    socketTask.onClose((res) => {
      clearTimeout(connectTimer);
      console.info('[TTS] WebSocket 关闭，code:', res.code, '原因:', res.reason);
      // 若 WebSocket 在未收到 status=2 的情况下关闭，视为异常
      if (!settled) {
        fail(new Error('WebSocket 意外关闭，可能未收到完整音频'));
      }
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
  const appId = getApp().globalData?.xfyunAppId || '';
  return {
    common: { app_id: appId },
    business: businessParams,
    data: {
      status: 2,              // 一次性发送全部文本
      text: _base64Encode(text), // 文本须 Base64 编码
    },
  };
}

// ─────────────────────────────────────────────────────────────────
//  Step 3 — 写入本地文件
// ─────────────────────────────────────────────────────────────────

/**
 * 将 MP3 Base64 数据写入本地文件系统
 * 文件名含时间戳，避免名称冲突
 *
 * @param {string} base64Data - MP3 的 Base64 字符串
 * @returns {Promise<string>}   本地文件绝对路径
 * @private
 */
function _writeAudioFile(base64Data) {
  return new Promise((resolve, reject) => {
    const fs = wx.getFileSystemManager();
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
      encoding: 'base64', // 告知 wx 将 base64 字符串解码后写入二进制文件
      success: () => {
        console.info('[TTS] 音频文件已写入:', filePath);
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
function _base64Encode(str) {
  // encodeURIComponent → %XX 形式（UTF-8 字节）
  // replace → 将 %XX 转为 latin1 字符（btoa 只支持 latin1）
  return btoa(
    encodeURIComponent(str).replace(/%([0-9A-F]{2})/gi, (_, hex) =>
      String.fromCharCode(parseInt(hex, 16))
    )
  );
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
