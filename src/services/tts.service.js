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

const BASE_URL = getApp().globalData?.bffBaseUrl || 'https://api.example.com';

/** 讯飞 TTS WebSocket 连接超时（毫秒） */
const WS_CONNECT_TIMEOUT_MS = 8000;

/** 本地音频文件存储目录（wx.env.USER_DATA_PATH 下） */
const AUDIO_DIR = `${wx.env.USER_DATA_PATH}/tts_audio`;

/** 讯飞 TTS 业务参数默认值 */
const DEFAULT_BUSINESS_PARAMS = {
  aue: 'lame',       // 音频编码：MP3
  sfl: 1,            // 流式返回
  auf: 'audio/L16;rate=16000',
  vcn: 'xiaoyan',    // 发音人
  speed: 50,         // 语速 0-100
  volume: 50,        // 音量
  pitch: 50,         // 音调
  tte: 'utf8',       // 文本编码
};

// ─────────────────────────────────────────────────────────────────
//  公开接口
// ─────────────────────────────────────────────────────────────────

/**
 * 合成文字到本地 MP3 文件
 *
 * @param {string} text                    - 待合成的文字（≤ 8000 字节）
 * @param {object} [options]
 * @param {Function} [options.onProgress]  - 进度回调 (percent: number) => void
 * @param {object}  [options.voice]        - 覆盖默认发音人参数
 * @returns {Promise<string>}              - 本地 MP3 文件路径
 *
 * @example
 *   const path = await ttsService.synthesize('床前明月光', { onProgress: p => console.log(p) });
 */
async function synthesize(text, options = {}) {
  const { onProgress, voice = {} } = options;

  // Step 1: 从 BFF 获取鉴权 URL（避免在前端暴露 AppSecret）
  const wsUrl = await _fetchTtsToken();

  // Step 2: 建立 WebSocket 连接并流式接收音频帧
  const audioBuffer = await _streamTts(wsUrl, text, { ...DEFAULT_BUSINESS_PARAMS, ...voice }, onProgress);

  // Step 3: 将 Buffer 写入本地文件
  const localPath = await _writeAudioFile(audioBuffer);

  return localPath;
}

/**
 * 取消当前正在进行的 TTS 合成
 * （如果 WebSocket 仍连接，主动关闭）
 */
function cancel() {
  // TODO: 持有当前 socketTask 引用并调用 socketTask.close()
  console.info('[TTS] 已取消合成');
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
      url: `${BASE_URL}/api/tts/token`,
      method: 'GET',
      // TODO: 附加 Authorization header
      success: (res) => {
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
 *
 * @param {string}   wsUrl           - 带鉴权参数的 wss 地址
 * @param {string}   text            - 合成文本
 * @param {object}   businessParams  - 讯飞业务参数
 * @param {Function} [onProgress]    - 进度回调
 * @returns {Promise<ArrayBuffer>}   - 完整 MP3 数据
 * @private
 */
function _streamTts(wsUrl, text, businessParams, onProgress) {
  return new Promise((resolve, reject) => {
    /** 收集所有 Base64 音频帧（字符串拼接后再 decode） */
    const audioChunks = [];
    let totalFrames = 0;

    // 连接超时保护
    const connectTimer = setTimeout(() => {
      reject(new Error(`TTS WebSocket 连接超时（${WS_CONNECT_TIMEOUT_MS}ms）`));
    }, WS_CONNECT_TIMEOUT_MS);

    const socketTask = wx.connectSocket({
      url: wsUrl,
      fail: (err) => {
        clearTimeout(connectTimer);
        reject(new Error('WebSocket 连接失败: ' + err.errMsg));
      },
    });

    socketTask.onOpen(() => {
      clearTimeout(connectTimer);
      console.info('[TTS] WebSocket 已连接');

      // 发送合成请求（讯飞协议格式）
      const payload = _buildTtsPayload(text, businessParams);
      socketTask.send({
        data: JSON.stringify(payload),
        fail: (err) => reject(new Error('发送 TTS 请求失败: ' + err.errMsg)),
      });
    });

    socketTask.onMessage((event) => {
      try {
        const frame = JSON.parse(event.data);

        if (frame.code !== 0) {
          reject(new Error(`讯飞 TTS 错误 code=${frame.code}: ${frame.message}`));
          socketTask.close({});
          return;
        }

        const { audio, status } = frame.data || {};

        if (audio) {
          audioChunks.push(audio); // Base64 字符串
          totalFrames++;
          // TODO: 根据 status 估算进度（status=2 表示最后帧）
          if (typeof onProgress === 'function') {
            onProgress(status === 2 ? 95 : Math.min(10 + totalFrames * 5, 90));
          }
        }

        // status=2 代表最后一帧，合成完毕
        if (status === 2) {
          socketTask.close({});
          const fullBase64 = audioChunks.join('');
          // TODO: 将 Base64 转为 ArrayBuffer
          // const buffer = _base64ToArrayBuffer(fullBase64);
          // resolve(buffer);
          resolve(fullBase64); // 占位，实际需转换
        }
      } catch (parseErr) {
        reject(new Error('TTS 帧解析失败: ' + parseErr.message));
        socketTask.close({});
      }
    });

    socketTask.onError((err) => {
      reject(new Error('WebSocket 错误: ' + err.errMsg));
    });

    socketTask.onClose((res) => {
      console.info('[TTS] WebSocket 关闭', res.code, res.reason);
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
      status: 2,        // 一次性发送全部文本
      text: _base64Encode(text),
    },
  };
}

// ─────────────────────────────────────────────────────────────────
//  Step 3 — 写入本地文件
// ─────────────────────────────────────────────────────────────────

/**
 * 将 MP3 数据写入本地文件系统
 *
 * @param {string|ArrayBuffer} audioData - MP3 数据（Base64 字符串或 ArrayBuffer）
 * @returns {Promise<string>} 本地文件绝对路径
 * @private
 */
function _writeAudioFile(audioData) {
  return new Promise((resolve, reject) => {
    const fs = wx.getFileSystemManager();
    const fileName = `tts_${Date.now()}.mp3`;
    const filePath = `${AUDIO_DIR}/${fileName}`;

    // 确保目录存在
    // TODO: fs.mkdirSync(AUDIO_DIR, true) 需在 try/catch 中处理"目录已存在"
    try {
      fs.mkdirSync(AUDIO_DIR, true);
    } catch (_) { /* 目录已存在，忽略 */ }

    fs.writeFile({
      filePath,
      data: audioData,
      encoding: 'base64',  // 若 audioData 为 ArrayBuffer 则改为 'binary'
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
 * Base64 编码（微信小程序环境可用 btoa，但中文需先 encodeURIComponent）
 * @param {string} str
 * @returns {string}
 * @private
 */
function _base64Encode(str) {
  // TODO: 处理中文字符的 Base64 编码
  // return btoa(encodeURIComponent(str).replace(/%([0-9A-F]{2})/g, (_, p1) => String.fromCharCode('0x' + p1)));
  return btoa(unescape(encodeURIComponent(str)));
}

/**
 * Base64 转 ArrayBuffer
 * @param {string} base64
 * @returns {ArrayBuffer}
 * @private
 */
function _base64ToArrayBuffer(base64) {
  // TODO: 使用 wx 提供的 API 或手动转换
  // const binary = atob(base64);
  // const bytes = new Uint8Array(binary.length);
  // for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  // return bytes.buffer;
}

// ─────────────────────────────────────────────────────────────────
//  模块导出
// ─────────────────────────────────────────────────────────────────

module.exports = {
  synthesize,
  cancel,
};
