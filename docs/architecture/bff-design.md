# 绘本朗读助手小程序 BFF 实现方案

**作者**：Sam Rivera（Tech Lead）  
**日期**：2026-04-13  
**状态**：待 Jamie 实现

---

## 一、目录结构

```
picbook-bff/
├── src/
│   ├── index.js                  # SCF 入口，路由分发
│   ├── router.js                 # 路由表注册
│   ├── middleware/
│   │   ├── auth.js               # 微信 session 鉴权中间件
│   │   ├── rateLimit.js          # 限流中间件（内存 + 可选 Redis）
│   │   └── validator.js          # 入参校验中间件
│   ├── handlers/
│   │   ├── login.js              # POST /api/login
│   │   ├── ocr.js                # POST /api/ocr
│   │   └── ttsSign.js            # GET  /api/tts/sign
│   ├── services/
│   │   ├── wechat.js             # 微信 code2session 封装
│   │   ├── tencentOcr.js         # 腾讯云 OCR SDK 封装
│   │   └── xfyunSign.js          # 讯飞 HMAC-SHA256 签名 URL 生成
│   ├── utils/
│   │   ├── response.js           # 统一响应格式
│   │   ├── crypto.js             # HMAC-SHA256 / Base64 工具
│   │   └── logger.js             # 结构化日志（CLS 友好）
│   └── config.js                 # 环境变量统一读取，启动时校验
├── tests/
│   ├── login.test.js
│   ├── ocr.test.js
│   └── ttsSign.test.js
├── serverless.yml                # SCF 部署配置（Serverless Framework）
├── package.json
└── .env.example                  # 环境变量模板（不提交真实值）
```

---

## 二、接口详细设计

### 2.1 统一约定

```
Base URL (SCF API 网关触发器):
  https://<service-id>.apigw.tencentcs.com/release/api

请求头:
  Content-Type: application/json
  X-Session-Token: <sessionToken>   （除 /login 外所有接口必须携带）

统一响应格式:
  {
    "code": 0,          // 0=成功，非0=业务错误
    "msg": "ok",
    "data": { ... },
    "requestId": "uuid"
  }

HTTP 状态码语义:
  200 - 业务逻辑层面的成功或失败（code 字段区分）
  400 - 请求格式/参数错误
  401 - 未鉴权或 token 失效
  429 - 触发限流
  500 - 服务端内部异常
```

---

### 2.2 POST /api/login — 微信登录鉴权

**功能**：接收 wx.login() 返回的临时 code，换取 openid + session_key，生成服务端 sessionToken 下发客户端。

#### 入参
```json
{
  "code": "wx.login 返回的临时 code，字符串，必填"
}
```

#### 处理流程
```
1. 校验 code 非空、长度合理（≤64字符）
2. 调用微信 code2session 接口:
   GET https://api.weixin.qq.com/sns/jscode2session
     ?appid=APPID&secret=APPSECRET&js_code=CODE&grant_type=authorization_code
3. 若返回 errcode != 0，映射为业务错误码返回
4. 以 openid 为 key，生成 sessionToken:
   token = sha256(openid + timestamp + SERVER_SECRET)
5. 将 openid <-> token 存入内存 Map（TTL = 7200s）
6. 返回 sessionToken，不返回 openid/session_key
```

#### 出参（成功）
```json
{
  "code": 0,
  "msg": "ok",
  "data": {
    "sessionToken": "xxxxxxxxxxxxxxxx",
    "expiresIn": 7200
  },
  "requestId": "uuid"
}
```

#### 错误码
```
40001  code 参数缺失或格式非法
40002  微信 code 已过期或已使用（wx errcode: 40029）
40003  微信 code 频率限制（wx errcode: 45011）
50001  调用微信接口超时或网络异常
```

---

### 2.3 POST /api/ocr — 腾讯云 OCR 转发

**功能**：接收小程序上传的图片 base64，转发腾讯云 GeneralBasicOCR，返回识别文字列表。

#### 鉴权
请求头必须携带有效的 X-Session-Token。

#### 限流
每个 openid，每 60 秒最多 10 次 OCR 请求（超限返回 HTTP 429 + code 42901）。

#### 入参
```json
{
  "imageBase64": "base64 编码的图片，纯数据不含 data:image 前缀，必填",
  "imageUrl": "图片 URL，与 imageBase64 二选一，选填",
  "languageType": "auto | zh | en | ...，选填，默认 auto"
}
```

#### 出参（成功）
```json
{
  "code": 0,
  "msg": "ok",
  "data": {
    "words": [
      {
        "text": "识别到的文字",
        "confidence": 98,
        "polygon": [[x1,y1],[x2,y2],[x3,y3],[x4,y4]]
      }
    ],
    "fullText": "所有文字拼接，按行用\n分隔"
  },
  "requestId": "uuid"
}
```

#### 错误码
```
40101  X-Session-Token 缺失
40102  X-Session-Token 非法或已过期
40201  imageBase64 和 imageUrl 均未提供
40202  imageBase64 超过大小限制（>4MB）
42901  OCR 限流，每分钟最多 10 次
50101  腾讯云 OCR 接口调用失败
50102  腾讯云 OCR 超时
```

---

### 2.4 GET /api/tts/sign — 讯飞 TTS 签名 URL 生成

**功能**：服务端生成带签名的讯飞 WSS URL（有效期 5 分钟），下发客户端直连讯飞 TTS。

#### 鉴权
请求头必须携带有效的 X-Session-Token。

#### Query 参数
```
voiceType  选填，发音人，默认 xiaoyan
speed      选填，语速 0-100，默认 50
pitch      选填，音调 0-100，默认 50
volume     选填，音量 0-100，默认 50
```

#### 出参（成功）
```json
{
  "code": 0,
  "msg": "ok",
  "data": {
    "signedUrl": "wss://tts-api.xfyun.cn/v2/tts?...",
    "expiresAt": 1713000300,
    "params": {
      "voiceType": "xiaoyan",
      "speed": 50,
      "pitch": 50,
      "volume": 50
    }
  },
  "requestId": "uuid"
}
```

#### 错误码
```
40101  X-Session-Token 缺失
40102  X-Session-Token 非法或已过期
50201  签名生成失败（内部异常）
```

---

## 三、讯飞签名 URL 生成算法

### 3.1 算法说明（官方规范）

```
签名原文 = "host: " + Host + "\n"
         + "date: " + RFC1123Date + "\n"
         + "GET /v2/tts HTTP/1.1"

Signature = Base64( HMAC-SHA256(APISecret, 签名原文) )

Authorization = Base64(
  'api_key="' + APIKey + '", '
  + 'algorithm="hmac-sha256", '
  + 'headers="host date request-line", '
  + 'signature="' + Signature + '"'
)

最终 URL = wss://tts-api.xfyun.cn/v2/tts
           ?authorization=<URL_ENCODE(Authorization)>
           &date=<URL_ENCODE(RFC1123Date)>
           &host=tts-api.xfyun.cn
```

### 3.2 Node.js 实现（services/xfyunSign.js）

```javascript
const crypto = require('crypto');
const { XFYUN_API_KEY, XFYUN_API_SECRET } = require('../config');

function generateTtsSignedUrl(opts = {}) {
  const host = 'tts-api.xfyun.cn';
  const path = '/v2/tts';

  // RFC 1123 时间，讯飞要求 GMT
  const date = new Date().toUTCString();

  // 签名原文：严格三行
  const signatureOrigin = [
    `host: ${host}`,
    `date: ${date}`,
    `GET ${path} HTTP/1.1`
  ].join('\n');

  // HMAC-SHA256 → Base64
  const signatureBase64 = crypto
    .createHmac('sha256', XFYUN_API_SECRET)
    .update(signatureOrigin)
    .digest('base64');

  // Authorization 原文
  const authorizationOrigin =
    `api_key="${XFYUN_API_KEY}", ` +
    `algorithm="hmac-sha256", ` +
    `headers="host date request-line", ` +
    `signature="${signatureBase64}"`;

  // Base64 编码整个 Authorization
  const authorization = Buffer
    .from(authorizationOrigin, 'utf8')
    .toString('base64');

  // 拼接最终 URL
  const query = new URLSearchParams({ authorization, date, host }).toString();
  const signedUrl = `wss://${host}${path}?${query}`;
  const expiresAt = Math.floor(Date.now() / 1000) + 300;

  return { signedUrl, expiresAt };
}

module.exports = { generateTtsSignedUrl };
```

> ⚠️ 注意：不要缓存签名 URL 重复下发，每次请求重新生成。

---

## 四、SCF 部署配置（serverless.yml）

```yaml
service: picbook-bff

provider:
  name: tencent
  runtime: Nodejs18.15
  region: ap-guangzhou
  memorySize: 256
  timeout: 10
  environment:
    NODE_ENV: production

functions:
  bff:
    handler: src/index.main
    events:
      - apigw:
          parameters:
            protocols:
              - https
            serviceName: picbook-bff-apigw
            environment: release
            endpoints:
              - path: /api/login
                method: POST
              - path: /api/ocr
                method: POST
              - path: /api/tts/sign
                method: GET
              - path: /api/health
                method: GET

plugins:
  - serverless-tencent-scf
```

**API 网关配置要点**：
- CORS：开启，Origin 限制为 `https://servicewechat.com`
- 请求体大小：调大到 **6MB**（兼容图片 base64 上传）
- 日志：开启 CLS，保留 7 天

---

## 五、环境变量清单

| 变量名 | 说明 | 敏感级别 |
|--------|------|---------|
| `NODE_ENV` | 运行环境（production） | 低 |
| `WX_APP_ID` | 微信小程序 AppID | 中 |
| `WX_APP_SECRET` | 微信小程序 AppSecret | 高 |
| `TENCENT_SECRET_ID` | 腾讯云 SecretId | 高 |
| `TENCENT_SECRET_KEY` | 腾讯云 SecretKey | 高 |
| `TENCENT_OCR_REGION` | OCR 服务地域（ap-guangzhou） | 低 |
| `XFYUN_APP_ID` | 讯飞 APPID | 中 |
| `XFYUN_API_KEY` | 讯飞 APIKey | 高 |
| `XFYUN_API_SECRET` | 讯飞 APISecret | 高 |
| `SESSION_SECRET` | 生成 sessionToken 的服务端盐（随机32位）| 高 |
| `RATE_LIMIT_OCR_PER_MIN` | OCR 限流阈值（默认 10）| 低 |
| `LOG_LEVEL` | 日志级别（info） | 低 |

> 所有高敏感变量通过 SCF 控制台「环境变量」注入，禁止写入代码仓库。

---

## 六、关键风险点

### 6.1 SCF 跨实例限流不精确（⚠️ 中）
SCF 弹性扩容时各实例内存独立，限流计数无法共享。  
**MVP方案**：接受偏差，真实用户操作频率不会触发。  
**后续**：引入腾讯云 Redis，INCR + EXPIRE 精确滑动窗口。

### 6.2 SessionToken 内存存储（⚠️ 中）
实例回收后 token 失效，用户需重新登录。  
**方案**：小程序侧检测到 401 自动 re-login，用户无感知。后续迁移 Redis。

### 6.3 图片 base64 体积超限（⚠️ 高）
拍照图片可达 5MB，base64 后超过 API 网关默认 1MB 限制。  
**方案**：API 网关调大到 8MB + 小程序端压缩到 ≤500KB + BFF 校验上限。

### 6.4 讯飞签名 URL 重放（⚠️ 低）
签名 URL 泄漏后 5 分钟内可被滥用。  
**方案**：对 /api/tts/sign 限流（每用户每分钟 ≤20 次）+ 日志不打印完整 URL。

### 6.5 腾讯云 OCR 费用风险（⚠️ 中）
限流失效可能产生意外费用。  
**方案**：控制台设置每日用量告警（500次）+ 每月费用上限。

---

## 七、接口时序总结

```
小程序           BFF SCF          微信服务器      腾讯云 OCR      讯飞 TTS
  |-- POST /login -->|
  |   { code }       |-- code2session -->|
  |                  |<-- openid --------|
  |<-- sessionToken --|
  |
  |-- POST /ocr ----->|  验证token+限流
  |  { imageBase64 }  |-- GeneralBasicOCR -->|
  |                   |<-- TextDetections ----|
  |<-- { words } -----|
  |
  |-- GET /tts/sign ->|  验证token，生成signedUrl
  |<-- { signedUrl } -|
  |
  |------- WSS 直连 --------------------------------->|
  |        使用 signedUrl 建立 WebSocket              |
  |<------ 音频流 ------------------------------------|
```

---

*文档维护：Sam Rivera | 对应实现：Jamie Park*
