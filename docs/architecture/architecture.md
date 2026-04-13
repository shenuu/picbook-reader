# 绘本朗读助手 · 技术架构文档

**项目**：绘本朗读助手微信小程序  
**作者**：Sam Rivera（Tech Lead）  
**版本**：v1.0  
**日期**：2026-04-13  
**状态**：草稿 → 待团队评审

---

## 目录

1. [技术架构总览](#1-技术架构总览)
2. [核心流程设计](#2-核心流程设计)
3. [关键技术方案 ADR](#3-关键技术方案-adr)
4. [数据结构设计](#4-数据结构设计)
5. [API 接口规划](#5-api-接口规划)
6. [性能目标与监控方案](#6-性能目标与监控方案)
7. [安全考虑](#7-安全考虑)
8. [开发里程碑建议](#8-开发里程碑建议)

---

## 1. 技术架构总览

### 1.1 整体架构图（分层描述）

```
┌─────────────────────────────────────────────────────────────────┐
│                         用户端（微信小程序）                         │
│                                                                   │
│  ┌─────────────┐  ┌──────────────┐  ┌──────────────────────────┐ │
│  │  UI 层       │  │  业务逻辑层   │  │  本地缓存层               │ │
│  │             │  │              │  │                          │ │
│  │ · 首页       │  │ · CameraCtrl │  │ · LRU Cache（20页）      │ │
│  │ · 拍照引导   │  │ · OCRService │  │ · TTS AudioCache         │ │
│  │ · OCR加载   │  │ · TTSService │  │ · wx.storage             │ │
│  │ · 识别结果   │  │ · CacheLayer │  │ · TempFile Manager       │ │
│  │ · 识别失败   │  │ · NetworkMgr │  │                          │ │
│  │ · TTS播放器  │  │ · ErrorRetry │  │                          │ │
│  │ · 缓存管理   │  │              │  │                          │ │
│  └─────────────┘  └──────────────┘  └──────────────────────────┘ │
│                           │                                       │
│              ┌────────────┴────────────┐                         │
│              │      网络层（NetLayer）    │                         │
│              │  · 请求队列 + 超时管理     │                         │
│              │  · WebSocket 连接池      │                         │
│              │  · 离线检测（NetworkMgr） │                         │
│              └────────────┬────────────┘                         │
└───────────────────────────┼─────────────────────────────────────┘
                            │ HTTPS / WSS
          ┌─────────────────┼──────────────────────┐
          │                 │                       │
          ▼                 ▼                       ▼
┌──────────────┐  ┌──────────────────┐  ┌────────────────────┐
│  自建 BFF     │  │  腾讯云 OCR API  │  │  讯飞 TTS API      │
│  (Node/CF    │  │  （备选直连）     │  │  WebSocket WSS     │
│   Worker)    │  │                  │  │  tts-api.xfyun.cn  │
│              │  │ · 通用文字识别    │  │                    │
│ · API密钥托管 │  │ · 返回结构化文本  │  │ · 儿童男声 x_xiaoming│
│ · 图片压缩转发│  │                  │  │ · 儿童女声 x_xiaoyan │
│ · 请求鉴权   │  └──────────────────┘  │ · 播音腔  x_xiaochu  │
│ · 日志埋点   │                        └────────────────────┘
└──────────────┘
```

**架构说明**：
- **三层前端**：UI渲染层 → 业务逻辑层 → 本地缓存层，职责分离
- **BFF（Backend For Frontend）**：自建轻量中间层，承担API密钥保护、图片压缩、请求转发，部署在腾讯云函数或 Cloudflare Worker
- **外部服务**：腾讯云OCR + 讯飞TTS，均通过BFF中转（密钥不下发客户端）
- **离线优先**：网络层优先检测，离线时直接走缓存层，不发起API请求

---

### 1.2 技术栈选型

| 层次 | 技术选型 | 选型理由 |
|------|---------|---------|
| **前端框架** | **原生微信小程序** | 包体积最优、无框架overhead、调试链路短（详见ADR-001）|
| **OCR** | **腾讯云OCR · 通用印刷体识别** | 识别率高、延迟低、与小程序生态同源、价格合理（详见ADR-002）|
| **TTS** | **讯飞 WebSocket API** | PM已确认、儿童音色自然、流式返回（详见ADR-003）|
| **本地存储** | **自定义LRU + wx.storage** | 满足20页上限、支持TTL淘汰（详见ADR-004）|
| **动画** | **Lottie-miniprogram** | OCR加载页卡通动画，体积约80KB |
| **音频播放** | **wx.createInnerAudioContext** | 小程序原生API，支持后台播放 |
| **图片处理** | **wx.compressImage** | 上传前压缩到 ≤800KB，加速OCR传输 |
| **BFF运行时** | **腾讯云函数（SCF）** | 与腾讯云OCR同域，内网调用更快 |

---

## 2. 核心流程设计

### 2.1 拍照 → OCR → TTS 完整数据流

```
用户点击「拍照」
        │
        ▼
[拍照引导页] 展示取景框 + 防抖提示
  · wx.chooseMedia({ camera:'back', sizeType:['compressed'] })
  · 拍照完成，拿到 tempFilePath
        │
        ▼
[图片预处理] ← 客户端本地执行，~100ms
  · wx.compressImage({ quality: 80 }) → 压缩到 ≤800KB
  · 转 Base64 或直接传 tempFilePath
        │
        ▼
[缓存命中检查] ← 用图片内容Hash比较
  · 计算图片指纹（取前64字节XOR，轻量）
  · 查 LRU Cache：命中 → 直接跳到 [TTS播放]
        │ 未命中
        ▼
[OCR加载页] 展示 Lottie 卡通放大镜动画
  · 调用 BFF /ocr 接口（超时5s）
  · BFF → 腾讯云OCR → 返回文字列表
        │
  ┌─────┴──────────────────┐
  │ 识别成功                │ 识别失败 / 超时
  ▼                        ▼
[写入LRU缓存]          [识别失败页]
  · 存储 { hash, text,    · 展示重试按钮
    timestamp, voiceCache}· 最多自动重试2次
        │
        ▼
[识别结果页] 展示文字内容
  · 用户点击「播放」按钮
        │
        ▼
[TTS缓存检查]
  · 查 AudioCache：{ hash + voiceType } → 命中则直接播放本地文件
        │ 未命中
        ▼
[TTS请求 - WebSocket]
  · 建立 WSS 连接到讯飞 API
  · 流式接收 PCM/MP3 数据帧
  · 边接收边写入 TempFile（wx.getFileSystemManager）
  · 接收完毕 → 写入 AudioCache
        │
        ▼
[wx.createInnerAudioContext] 播放音频
  · 4状态机：IDLE → LOADING → PLAYING → DONE
  · 支持暂停/继续/重播
```

---

### 2.2 离线缓存读写逻辑

```
App启动 / 每次网络状态变化
        │
        ▼
NetworkManager.detectOnline()
  · wx.getNetworkType() → 判断 none / wifi / 4g
  · 注册 wx.onNetworkStatusChange 监听
        │
  ┌─────┴──────────────┐
  │ 在线                │ 离线
  ▼                    ▼
正常流程              [显示离线Toast] #FFF3E8 橙色
                      ·  showOfflineToast()
                              │
                              ▼
                      [查LRU缓存]
                       · 有命中 → 显示绿色云朵角标
                                  → 直接渲染文字 + 播放缓存音频
                       · 无命中 → 跳转[离线降级页]
                                  → 提示「暂无此绘本缓存」

─── 缓存写入逻辑 ───────────────────────────────────

OCR成功后：
  1. 生成 pageKey = SHA-like hash（图片指纹）
  2. LRU.set(pageKey, { text, timestamp, voiceCache:{} })
  3. 若缓存数量 > 20，LRU.evict() 淘汰最久未访问项
     · 同时删除对应的 TempFile（音频文件）
  4. 将 LRU 元数据序列化 → wx.setStorageSync('lru_meta', ...)

TTS成功后：
  1. 将音频写入本地文件：
     wx.getFileSystemManager().writeFile({
       filePath: `${wx.env.USER_DATA_PATH}/tts_${pageKey}_${voiceType}.mp3`,
       ...
     })
  2. 更新 LRU 节点：voiceCache[voiceType] = filePath
  3. 同步 lru_meta 到 wx.storage
```

---

### 2.3 错误处理和重试机制

```javascript
// 错误分类与处理策略
const ERROR_STRATEGY = {
  // 网络超时 → 自动重试，最多2次，指数退避
  NETWORK_TIMEOUT:    { retry: 2, backoff: 'exponential', fallback: 'offline_cache' },
  // OCR识别为空 → 提示用户重拍
  OCR_EMPTY_RESULT:   { retry: 0, fallback: 'retake_photo' },
  // OCR服务异常 → 重试1次，失败跳识别失败页
  OCR_SERVICE_ERROR:  { retry: 1, backoff: 'fixed_1s',   fallback: 'error_page' },
  // TTS连接失败 → 重试2次，失败降级提示「暂无语音」
  TTS_WS_FAILED:      { retry: 2, backoff: 'exponential', fallback: 'text_only' },
  // TTS数据损坏 → 清除缓存，重新请求
  TTS_AUDIO_CORRUPT:  { retry: 1, fallback: 'refetch_tts' },
  // 存储空间不足 → 触发LRU强制清理
  STORAGE_FULL:       { retry: 0, fallback: 'force_evict' },
};

// 重试执行器（指数退避）
async function retryWithBackoff(fn, maxRetries, baseDelay = 500) {
  for (let i = 0; i <= maxRetries; i++) {
    try {
      return await fn();
    } catch (err) {
      if (i === maxRetries) throw err;
      await sleep(baseDelay * Math.pow(2, i)); // 500ms → 1s → 2s
    }
  }
}
```

**降级链路**：
```
在线OCR失败 → 重试2次 → 仍失败 → 检查缓存 → 有缓存展示缓存 → 无缓存跳错误页
TTS失败    → 重试2次 → 仍失败 → 纯文字模式（展示识别文本，无语音）
完全离线   → 缓存优先 → 无缓存 → 离线降级页（温暖提示文案）
```

---

## 3. 关键技术方案 ADR

### ADR-001：前端框架选型（原生 vs Taro）

**状态**：已决策  
**日期**：2026-04-13

#### 背景
团队需要选择微信小程序的开发框架。主要候选：原生微信小程序 WXML/WXS 和 Taro（React语法跨端框架）。本项目仅需要微信小程序端，团队成员熟悉原生小程序开发。

#### 决策选项

| 维度 | 原生微信小程序 | Taro 3.x（React） |
|------|--------------|-----------------|
| 包体积 | ✅ 最小，无框架运行时 | ⚠️ 增加约200-300KB运行时 |
| 性能 | ✅ 无抽象层overhead | ⚠️ 多一层虚拟DOM | 
| 跨端能力 | ❌ 仅微信 | ✅ 可扩展到支付宝/H5 |
| 开发效率 | ⚠️ 模板语法较繁琐 | ✅ React生态，组件复用好 |
| 微信新API兼容 | ✅ 第一时间支持 | ⚠️ 需等Taro适配 |
| 包体积硬约束 | 主包剩余：2MB - Lottie(80KB) ≈ 1.9MB | 主包剩余：2MB - 300KB运行时 - 80KB = 1.6MB |
| 调试难度 | ✅ 直接看WXML | ⚠️ 需要source-map |

#### 最终选择
**✅ 原生微信小程序**

#### 理由
1. **包体积约束决定性**：2MB主包限制下，Taro运行时占用宝贵空间，增加分包管理复杂度
2. **性能优先**：拍照→OCR→TTS链路对响应速度敏感，消除框架层overhead
3. **单端产品**：PM确认当前仅需微信端，Taro的跨端优势无法体现
4. **团队技能匹配**：团队成员有原生小程序经验，学习成本低
5. **新API及时性**：`wx.chooseMedia`、`wx.compressImage`等图像API在原生中第一时间可用

#### 风险
- **组件复用相对弱**：通过封装自定义组件（Component）缓解，建立统一组件库
- **代码量略多**：接受此权衡，配合ESLint + 代码规范管控质量
- **若未来需要扩端**：可迁移到Taro，原生组件逻辑可复用

---

### ADR-002：OCR方案选型

**状态**：已决策  
**日期**：2026-04-13

#### 背景
需要对绘本页面图片进行文字识别。绘本文字特点：字号大、字体印刷清晰、文字量少（通常每页5-30字）、背景多为彩色插画。

#### 决策选项

| 维度 | 微信内置 wx.scanCode | 腾讯云OCR（通用印刷体） | 百度OCR | 本地NCNN模型 |
|------|---------------------|----------------------|--------|------------|
| 识别场景 | 仅二维码/条码 | ✅ 通用文字，绘本适配好 | ✅ 通用文字 | ✅ 离线可用 |
| 识别准确率 | ❌ 不适用 | ✅ 98%+ 印刷体 | ✅ 98%+ | ⚠️ 小模型约90% |
| 延迟 | - | ✅ 约300-800ms | ⚠️ 约500-1200ms | ⚠️ 本地约1-3s |
| 价格 | 免费 | ✅ 1000次/天免费 | 1000次/天免费 | 免费 |
| 包体积影响 | 无 | 无（云端） | 无（云端） | ❌ 模型约10-50MB |
| 离线支持 | ❌ | ❌ | ❌ | ✅ |
| 微信生态集成 | ✅ 原生 | ✅ 同源，内网加速 | ⚠️ 跨厂商 |  ❌ |

> **注**：`wx.scanCode` 仅支持二维码/条码识别，无法用于绘本文字OCR。

#### 最终选择
**✅ 腾讯云OCR · 通用印刷体识别（GeneralBasicOCR）**  
主力方案，通过BFF中转

#### 理由
1. **准确率最优**：绘本为印刷体，腾讯云印刷体识别准确率>98%，实测绘本场景表现好
2. **延迟最低**：与微信/小程序同属腾讯，BFF部署在腾讯云后可走内网，RTT更低
3. **成本可控**：每天1000次免费额度，按用量约0.01元/次，产品初期成本极低
4. **无包体积影响**：纯API调用，不占主包空间
5. **结构化返回**：返回文字+坐标，便于后续高亮展示等产品扩展

#### 风险及缓解
- **网络依赖**：离线时无法使用 → 已有LRU缓存方案兜底
- **API调用成本**：高频调用会产生费用 → 客户端图片Hash去重，相同图片不重复调用
- **超出免费额度**：产品爆量时 → 设置调用量告警，预留付费方案

#### 降级策略
```
主：腾讯云OCR（BFF中转）
↓ 失败
备：直连腾讯云OCR（绕过BFF，降低延迟）
↓ 失败
降级：缓存 → 提示用户重试
```

---

### ADR-003：TTS接入方案（讯飞 WebSocket API）

**状态**：已决策（PM已确认使用讯飞）  
**日期**：2026-04-13

#### 背景
PM已确定使用讯飞开放平台儿童音色，需要设计具体的接入技术方案。讯飞TTS提供 HTTP 和 WebSocket 两种接口，需要选择适合小程序的接入方式。

#### 方案对比：HTTP vs WebSocket

| 维度 | HTTP REST API | WebSocket API |
|------|--------------|--------------|
| 接入复杂度 | ✅ 简单，一次请求返回完整音频 | ⚠️ 需要维护连接状态机 |
| 首包延迟 | ❌ 需等待全部合成完成再返回 | ✅ 流式返回，首帧更快 |
| 用户体验 | ⚠️ 等待感强，LOADING时间长 | ✅ 可实现边合成边播放 |
| 小程序WebSocket | ✅ wx.connectSocket 支持 | ✅ 同上 |
| 连接复用 | N/A | ✅ 短连接（每次合成独立连接）|
| 错误处理 | 简单 | 需要处理断连/重连 |

#### 最终选择
**✅ 讯飞 WebSocket TTS API（流式接入）**

#### 具体技术方案

```
讯飞 WebSocket TTS 接入流程：

1. 鉴权URL构造（由 BFF 代为生成，避免密钥下发）
   BFF /tts/token → 返回带签名的临时WSS URL（有效期5分钟）
   URL格式: wss://tts-api.xfyun.cn/v2/tts?authorization=...&date=...&host=...

2. 小程序端建立 WebSocket 连接
   const socket = wx.connectSocket({ url: signedWssUrl })

3. 发送合成请求（握手后立即发送）
   {
     "common": { "app_id": "xxx" },
     "business": {
       "aue": "lame",        // MP3格式
       "vcn": "x_xiaoming",  // 儿童男声（可切换）
       "speed": 50,          // 语速（0-100）
       "volume": 80,
       "pitch": 50,
       "tte": "UTF8"
     },
     "data": {
       "status": 2,
       "text": "<Base64编码文字>"
     }
   }

4. 接收流式音频帧
   onMessage: 收到 { data: { audio: "base64_mp3_chunk", status: 1|2 } }
   · status=1: 合成中，继续接收
   · status=2: 合成完毕，关闭连接

5. 音频拼接与播放
   · 每帧 Base64 解码 → ArrayBuffer
   · 写入 FileSystemManager（追加模式）
   · 合成完毕后：wx.createInnerAudioContext.src = filePath → play()

6. 缓存写入
   · 写入 AudioCache：key = pageHash + voiceType
   · 下次播放同页同音色 → 直接读本地文件，跳过WebSocket
```

#### 音色配置

```javascript
const VOICE_CONFIG = {
  child_male:   { vcn: 'x_xiaoming', label: '儿童男声', speed: 50 },
  child_female: { vcn: 'x_xiaoyan',  label: '儿童女声', speed: 50 },
  broadcaster:  { vcn: 'x_xiaochu',  label: '播音腔',   speed: 45 },
};
```

#### 风险及缓解
- **WebSocket连接失败**：实现3次重试 + 超时降级到纯文本模式
- **音频帧乱序**：讯飞API保证有序，但需校验 status 字段
- **连接泄漏**：每次TTS完成或失败后强制 socket.close()，在 App.onHide 中也清理
- **BFF签名过期**：Token有效期5分钟，TTS请求需在5分钟内完成（绘本文字量小，<10秒足够）

---

### ADR-004：缓存方案设计

**状态**：已决策  
**日期**：2026-04-13

#### 背景
需要缓存最近20页绘本的OCR文字和TTS音频，实现离线可用。需要在 `wx.storage`（KV存储，上限10MB）和自定义LRU缓存之间做选择。

#### 决策选项

| 维度 | 纯 wx.storage | 自定义LRU + wx.storage |
|------|--------------|----------------------|
| 实现复杂度 | ✅ 简单 | ⚠️ 需实现LRU算法 |
| 20页上限控制 | ❌ 手动管理，容易出错 | ✅ 自动淘汰最久未访问 |
| 访问局部性利用 | ❌ 无 | ✅ 热点页优先保留 |
| 存储上限保护 | ❌ 需手动判断 | ✅ 内建容量控制 |
| 音频文件管理 | ❌ 文件和KV需手动联动 | ✅ 淘汰时自动删除文件 |
| 持久化 | ✅ 原生支持 | ✅ LRU元数据持久化到wx.storage |

#### 最终选择
**✅ 自定义 LRU Cache + wx.storage 持久化 + FileSystemManager 音频存储**

#### 理由
1. **自动淘汰语义**：LRU天然满足「最近20页」需求，无需业务层手动计数
2. **联动文件删除**：淘汰KV节点时同步删除音频TempFile，避免存储泄漏
3. **实现成本低**：LRU用双向链表+HashMap，约100行JS即可实现
4. **存储分层清晰**：
   - wx.storage：LRU元数据（文字、哈希、时间戳）约几KB
   - FileSystemManager：MP3音频文件，约50-200KB/页/音色

#### 风险
- **冷启动加载**：App启动时从wx.storage反序列化LRU → 约10-20ms，可接受
- **wx.storage上限10MB**：仅存元数据，实际用量<100KB，无问题
- **FileSystem配额**：USER_DATA_PATH约50MB（机型相关），20页×3音色×150KB ≈ 9MB，安全

---

## 4. 数据结构设计

### 4.1 LRU 缓存节点结构

```typescript
// LRU 双向链表节点
interface LRUNode {
  key: string;              // 图片指纹（hash）
  prev: LRUNode | null;
  next: LRUNode | null;
  data: PageCacheData;
}

// 页面缓存数据
interface PageCacheData {
  pageHash: string;         // 图片内容指纹（轻量hash）
  ocrText: string;          // OCR识别的完整文字
  ocrWords: OcrWord[];      // 文字+坐标（用于高亮展示）
  timestamp: number;        // 首次缓存时间（Unix ms）
  lastAccessAt: number;     // 最后访问时间（用于LRU排序展示）
  imageThumb: string;       // Base64缩略图（64×64，用于缓存管理页展示）
  voiceCache: {
    [voiceType: string]: VoiceCacheEntry;  // key: 'child_male' | 'child_female' | 'broadcaster'
  };
}

interface OcrWord {
  text: string;
  confidence: number;       // 置信度 0-1
  boundingBox: {
    x: number; y: number; w: number; h: number;  // 归一化坐标
  };
}

interface VoiceCacheEntry {
  filePath: string;         // 本地MP3文件路径
  duration: number;         // 音频时长（秒）
  fileSize: number;         // 文件大小（字节）
  cachedAt: number;         // 缓存时间
}

// LRU Cache 完整结构（序列化到 wx.storage）
interface LRUMetaStore {
  version: number;          // 元数据版本（用于迁移）
  capacity: number;         // 上限，固定20
  size: number;             // 当前节点数
  order: string[];          // 从最新到最旧的 pageHash 数组（用于重建链表）
  nodes: {
    [pageHash: string]: PageCacheData;
  };
}
```

### 4.2 wx.storage Key 设计

```
命名规范：{namespace}_{domain}_{identifier}

├── app_config              # 应用配置
│   key: "app_config"
│   value: { version, voiceType, playbackSpeed }
│
├── lru_meta                # LRU缓存元数据（主存储）
│   key: "lru_meta"
│   value: LRUMetaStore（见上方）
│
├── perf_log                # 性能日志缓存（批量上报前暂存）
│   key: "perf_log_buffer"
│   value: PerfEvent[]（最多50条）
│
└── user_prefs              # 用户偏好
    key: "user_prefs"
    value: { defaultVoice, fontSize, hapticsEnabled }
```

### 4.3 文件系统路径设计

```
${wx.env.USER_DATA_PATH}/
  └── picbook/
      └── tts/
          ├── {pageHash}_child_male.mp3
          ├── {pageHash}_child_female.mp3
          └── {pageHash}_broadcaster.mp3

路径示例：
/wx_user_data/picbook/tts/a3f8c2d1_child_male.mp3
```

### 4.4 图片指纹算法

```javascript
// 轻量指纹：读取图片前128字节做XOR，避免全文件MD5的性能开销
async function computeImageHash(tempFilePath) {
  return new Promise((resolve) => {
    const fs = wx.getFileSystemManager();
    fs.readFile({
      filePath: tempFilePath,
      length: 128,
      success: ({ data }) => {
        const bytes = new Uint8Array(data);
        let hash = 0;
        bytes.forEach((b, i) => { hash = ((hash << 5) - hash + b * (i + 1)) | 0; });
        resolve(Math.abs(hash).toString(36));
      },
      fail: () => resolve(Date.now().toString(36))  // 降级：用时间戳
    });
  });
}
```

---

## 5. API 接口规划

### 5.1 BFF 接口（自建）

#### POST /api/ocr
**描述**：图片OCR识别，BFF转发至腾讯云OCR

**Request**
```json
{
  "imageBase64": "data:image/jpeg;base64,...",
  "imageUrl": "",          // 二选一（base64 或 url）
  "imageHash": "a3f8c2d1"  // 客户端传入，用于服务端去重日志
}
```

**Response（成功）**
```json
{
  "code": 0,
  "data": {
    "text": "小熊在森林里散步，遇见了小兔子。",
    "words": [
      {
        "text": "小熊在森林里散步",
        "confidence": 0.99,
        "boundingBox": { "x": 0.1, "y": 0.2, "w": 0.8, "h": 0.05 }
      }
    ],
    "language": "zh",
    "processingMs": 320
  }
}
```

**Response（失败）**
```json
{
  "code": 4001,
  "message": "图片内容为空或无法识别文字",
  "data": null
}
```

---

#### GET /api/tts/token
**描述**：获取讯飞WebSocket签名URL（防止密钥下发客户端）

**Request**（Query）
```
GET /api/tts/token?voiceType=child_male&text=小熊在森林里
```

**Response**
```json
{
  "code": 0,
  "data": {
    "wssUrl": "wss://tts-api.xfyun.cn/v2/tts?authorization=eyJ...&date=Mon%2C+13+Apr+2026&host=tts-api.xfyun.cn",
    "expiresAt": 1744530660000,  // 5分钟有效期
    "requestId": "req_abc123"
  }
}
```

---

### 5.2 讯飞 TTS WebSocket 协议摘要

**连接**：使用 BFF 返回的签名 `wssUrl`

**上行帧（发送合成请求）**
```json
{
  "common": { "app_id": "{{BFF注入，客户端不见}}" },
  "business": {
    "aue": "lame",
    "vcn": "x_xiaoming",
    "speed": 50,
    "volume": 80,
    "pitch": 50,
    "tte": "UTF8"
  },
  "data": {
    "status": 2,
    "text": "5bCP54+t5Zyo5q森5p2-6YKu5q+b"  // UTF-8 Base64
  }
}
```

**下行帧（接收音频流）**
```json
{
  "code": 0,
  "message": "success",
  "data": {
    "audio": "//OExAAA...",  // Base64 MP3 chunk
    "ced": "50",             // 合成进度
    "status": 1              // 1=合成中，2=合成完毕
  }
}
```

---

### 5.3 错误码定义

```
BFF 业务错误码

1xxx - 客户端参数错误
  1001  参数缺失（imageBase64 或 imageUrl 必填一个）
  1002  图片格式不支持（仅支持 jpg/png/webp）
  1003  图片体积超限（最大 4MB）
  1004  文字内容为空（TTS无法合成空字符串）

2xxx - OCR 服务错误
  2001  OCR 服务暂时不可用
  2002  图片无法识别（模糊/光线不足/无文字区域）
  2003  OCR 调用超出频率限制

3xxx - TTS 服务错误
  3001  讯飞 WebSocket 连接失败
  3002  TTS 合成失败（服务端错误）
  3003  TTS Token 已过期（重新获取）
  3004  音色不支持

4xxx - 客户端业务错误
  4001  缓存写入失败（存储空间不足）
  4002  音频文件损坏（需重新合成）
  4003  网络离线（无对应缓存）

5xxx - 服务器内部错误
  5001  BFF 内部异常
  5002  依赖服务超时
```

---

## 6. 性能目标与监控方案

### 6.1 3秒响应目标拆解

**目标**：从用户点击「确认拍照」到听到 TTS 声音 ≤ 3000ms（P90）

```
时间轴（P50目标 / P90目标）：

0ms      用户确认拍照，进入 OCR 加载页
  │
  ▼ [图片压缩]         ≤ 100ms / ≤ 150ms
  │  wx.compressImage，本地处理
  │
  ▼ [图片上传 + BFF转发 + 腾讯云OCR]  ≤ 800ms / ≤ 1200ms
  │  · 网络RTT：50-150ms（国内4G）
  │  · BFF处理：20-50ms
  │  · 腾讯云OCR：200-600ms
  │
  ▼ [结果渲染]         ≤ 50ms / ≤ 100ms
  │  文字写入页面，setData
  │
  ▼ [TTS Token获取]    ≤ 100ms / ≤ 150ms
  │  GET /api/tts/token（若未预取）
  │
  ▼ [WebSocket握手]    ≤ 150ms / ≤ 300ms
  │  建立WSS连接
  │
  ▼ [讯飞TTS首帧]      ≤ 600ms / ≤ 1000ms
  │  发送请求→收到第一帧音频→开始播放
  │
  ▼ 🔊 开始播放
总计                   ≤ 1800ms / ≤ 2900ms ✅

缓存命中路径（无网或已缓存）：
  图片Hash → 命中LRU → 渲染文字 → 播放本地MP3
  总计：≤ 300ms ✅
```

**性能预算总结**：

| 阶段 | P50 预算 | P90 预算 | 超时阈值 |
|------|---------|---------|---------|
| 图片压缩 | 100ms | 150ms | 500ms |
| OCR（网络+计算） | 800ms | 1200ms | 5000ms |
| 结果渲染 | 50ms | 100ms | - |
| TTS Token | 100ms | 150ms | 2000ms |
| WebSocket握手 | 150ms | 300ms | 3000ms |
| TTS首帧 | 600ms | 1000ms | 5000ms |
| **全链路** | **1800ms** | **2900ms** | **8000ms** |

> 超过 8000ms 全链路超时 → 展示错误页

**优化手段**：
- **TTS Token 预取**：OCR请求发出的同时，并行请求 TTS Token（节省100-150ms）
- **WebSocket预热**：进入拍照引导页时预建立WS连接（节省150-300ms）
- **图片压缩优化**：quality=80，目标300-600KB（加快上传）

---

### 6.2 性能埋点方案

```javascript
// 埋点事件定义
const PERF_EVENTS = {
  // 用户行为
  EVT_PHOTO_START:      'photo_start',        // 点击拍照
  EVT_PHOTO_CONFIRM:    'photo_confirm',       // 确认图片
  EVT_OCR_REQUEST:      'ocr_request',         // OCR请求发出
  EVT_OCR_SUCCESS:      'ocr_success',         // OCR返回成功
  EVT_OCR_FAIL:         'ocr_fail',            // OCR失败
  EVT_TTS_REQUEST:      'tts_request',         // TTS请求发出
  EVT_TTS_FIRST_FRAME:  'tts_first_frame',     // TTS首帧到达
  EVT_TTS_PLAY_START:   'tts_play_start',      // 开始播放
  EVT_CACHE_HIT:        'cache_hit',           // 缓存命中
  EVT_OFFLINE_DETECTED: 'offline_detected',    // 检测到离线
};

// 性能追踪器
class PerfTracker {
  constructor() {
    this.traces = {};       // requestId → { events: [] }
    this.buffer = [];       // 待上报缓冲
  }

  // 开始一次完整链路追踪
  startTrace(requestId) {
    this.traces[requestId] = {
      requestId,
      startAt: Date.now(),
      events: [],
      meta: {
        networkType: wx.getNetworkType(),
        platform: wx.getSystemInfoSync().platform,
      }
    };
  }

  // 记录阶段耗时
  mark(requestId, eventName, extra = {}) {
    const trace = this.traces[requestId];
    if (!trace) return;
    trace.events.push({
      name: eventName,
      ts: Date.now(),
      elapsed: Date.now() - trace.startAt,
      ...extra
    });
  }

  // 结束追踪，写入上报缓冲
  endTrace(requestId, status = 'success') {
    const trace = this.traces[requestId];
    if (!trace) return;
    trace.endAt = Date.now();
    trace.totalMs = trace.endAt - trace.startAt;
    trace.status = status;
    this.buffer.push(trace);
    delete this.traces[requestId];

    // 超过20条批量上报
    if (this.buffer.length >= 20) this.flush();
  }

  // 批量上报到 BFF（非关键路径，失败不影响用户）
  async flush() {
    const batch = this.buffer.splice(0, 20);
    try {
      await wx.request({ url: '/api/perf/batch', method: 'POST', data: batch });
    } catch (e) {
      // 上报失败：写入本地，下次启动重试
      wx.setStorage({ key: 'perf_log_buffer', data: batch });
    }
  }
}
```

**关键监控指标**：
- `ocr_p90_ms`：OCR接口P90延迟，告警阈值 >2000ms
- `tts_first_frame_p90_ms`：TTS首帧P90，告警阈值 >1500ms  
- `full_chain_p90_ms`：全链路P90，告警阈值 >3000ms
- `ocr_error_rate`：OCR失败率，告警阈值 >5%
- `cache_hit_rate`：缓存命中率，目标 >30%
- `offline_rate`：离线用户比例，关注用户网络质量

---

## 7. 安全考虑

### 7.1 API 密钥保护

**核心原则：API密钥绝不下发到客户端代码**

```
客户端小程序代码
  ↓  只知道 BFF 地址
BFF（腾讯云函数）
  ↓  持有并使用密钥
腾讯云OCR API / 讯飞TTS API
```

**具体措施**：

| 密钥 | 存储位置 | 访问方式 |
|------|---------|---------|
| 腾讯云 SecretKey | 云函数环境变量 | BFF服务端读取，直接调用OCR |
| 讯飞 APISecret | 云函数环境变量 | BFF生成签名URL，下发给客户端（5分钟有效）|
| BFF 调用凭证 | 微信登录态（wx.login → code2session）| 每次请求携带 session_token |

**讯飞Token设计**：
```
BFF 使用 HMAC-SHA256 生成讯飞签名 URL：
· URL有效期：5分钟
· 包含时间戳、Nonce防重放
· 客户端拿到的是一次性签名URL，即使泄露，5分钟后失效
· 不包含 APISecret 本身
```

**防滥用**：
```
BFF 接入层限流：
· 单用户（openid）限制：20次OCR/小时，50次TTS/小时
· 全局QPS：100 req/s
· 异常检测：单IP 1分钟内超过10次 → 临时封禁
```

---

### 7.2 用户数据隐私

**数据最小化原则**：

| 数据类型 | 处理方式 | 保留策略 |
|---------|---------|---------|
| 拍照图片 | 仅作OCR用途，BFF不持久化存储 | 处理完立即丢弃，不上传任何图库 |
| OCR文字 | 仅本地缓存，不上传至服务器 | 用户清除缓存时删除 |
| TTS音频 | 仅本地缓存 | LRU淘汰时自动删除 |
| 性能日志 | 上报时脱敏，不含文字内容 | BFF端保留30天 |
| 用户标识 | 使用微信 openid（不可逆） | 不存储，仅用于限流 |

**隐私声明要点**（需在小程序授权页展示）：
1. 拍照仅用于文字识别，不保存到云端
2. 所有缓存数据仅存储于用户本机
3. 性能数据匿名化处理，不含个人信息
4. 不收集、不分析儿童个人信息

**合规注意**：
- 小程序需配置相机权限使用说明（`wx.chooseMedia` 触发前需展示用途说明）
- 遵守《个人信息保护法》数据最小化要求
- 如日活超过100万，需进行安全评估

---

## 8. 开发里程碑建议

### Phase 1：核心MVP（2周）

**目标**：实现拍照→OCR→TTS完整主路径，无缓存，无离线

**交付物**：
- [ ] 首页 + 拍照引导页（相机 + 防抖提示）
- [ ] OCR加载页（Lottie动画）
- [ ] 识别结果页（文字展示）
- [ ] 识别失败页（重试）
- [ ] TTS播放器（4状态）+ 声音切换（3种音色）
- [ ] BFF基础版：OCR转发接口 + TTS Token接口
- [ ] 错误处理：OCR失败重试、TTS失败降级文本模式

**验收标准**：
- [ ] 全链路 P50 ≤ 2000ms（WiFi环境）
- [ ] OCR识别率（测试集20张标准绘本图片）≥ 90%
- [ ] TTS播放3种音色正常
- [ ] 微信开发者工具审核无报错

---

### Phase 2：缓存与离线（1.5周）

**目标**：实现LRU缓存、离线降级、缓存管理

**交付物**：
- [ ] 自定义LRU Cache实现（含单元测试）
- [ ] 图片指纹算法（缓存命中）
- [ ] TTS音频本地缓存（FileSystemManager）
- [ ] 离线检测（NetworkManager）
- [ ] 离线Toast（橙色 #FFF3E8）
- [ ] 绿色云朵角标（已缓存内容标记）
- [ ] 离线降级页
- [ ] 缓存管理页（查看/清除缓存）

**验收标准**：
- [ ] 缓存命中路径 ≤ 300ms
- [ ] 离线时已缓存页面可正常展示和播放
- [ ] LRU容量超过20页时正确淘汰最久未访问
- [ ] 缓存管理页展示正确的缓存大小和页数
- [ ] 卸载重装后缓存清空

---

### Phase 3：性能优化与监控（1周）

**目标**：达到3秒P90目标，接入监控告警

**交付物**：
- [ ] TTS Token预取优化（与OCR并行）
- [ ] WebSocket预热（拍照引导页阶段预建连接）
- [ ] 性能埋点接入（PerfTracker）
- [ ] BFF限流防刷
- [ ] 安全审查（密钥保护确认）
- [ ] 真机测试：iOS + Android 各5台覆盖主流机型
- [ ] 性能测试报告（含P50/P90数据）

**验收标准**：
- [ ] 全链路 P90 ≤ 3000ms（4G环境，非首帧缓存场景）
- [ ] OCR错误率 ≤ 5%
- [ ] 缓存命中率 ≥ 25%（压测20次同页调用）
- [ ] 微信审核通过，可提审上线

---

### 里程碑总览

```
Week 1-2          Week 3-4          Week 4.5-5.5
┌──────────────┐  ┌──────────────┐  ┌──────────────┐
│   Phase 1    │  │   Phase 2    │  │   Phase 3    │
│   核心MVP    │→ │ 缓存+离线    │→ │ 性能+监控    │
│              │  │              │  │              │
│ · 拍照链路   │  │ · LRU缓存   │  │ · 预取优化   │
│ · OCR接入   │  │ · 离线降级   │  │ · 性能埋点   │
│ · TTS接入   │  │ · 缓存管理   │  │ · 安全加固   │
│ · 错误处理   │  │              │  │ · 审核上线   │
└──────────────┘  └──────────────┘  └──────────────┘
   可用MVP ✓          完整功能 ✓         可上线 ✓
```

**风险提示**：
- 讯飞API需提前申请（审核周期1-3个工作日），**立即申请**
- 腾讯云OCR需开通服务并配置，**第1天完成**
- 小程序需已有微信公众平台账号并完成认证，**提前确认**

---

*文档维护：Sam Rivera | 下次评审：架构评审会（本周五）*
