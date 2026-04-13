# 📖 绘本朗读助手

> 微信小程序 · 幼儿绘本拍照识字 + TTS 朗读

[![状态](https://img.shields.io/badge/状态-开发中-yellow)]()
[![版本](https://img.shields.io/badge/版本-Phase_1-blue)]()

## 项目简介

面向 **2–6 岁幼儿家长**的微信小程序。

**核心功能**：拍照绘本页面 → OCR 自动识别文字 → 讯飞儿童 TTS 朗读，目标响应时间 **≤ 3 秒（P90）**。

```
拍照 → 图片压缩 → OCR识别（腾讯云）→ 文字展示 → TTS朗读（讯飞）
                    ↓ 并行
               LRU缓存（20页）← 离线降级
```

## 目录结构

```
picbook-reader/
├── docs/
│   ├── design/
│   │   ├── PRD.md              # 产品需求文档 v1.0（Alex Chen, PM）
│   │   ├── PM-decisions.md     # PM 决策记录 v1.1
│   │   └── UI-UX-spec.md       # UI/UX 设计规范（Riley Morgan, UX）
│   └── architecture/
│       └── architecture.md     # 技术架构文档 + ADR（Sam Rivera, Tech Lead）
├── src/
│   ├── pages/
│   │   ├── home/               # 首页
│   │   ├── guide/              # 拍照引导页
│   │   ├── result/             # 识别结果页
│   │   ├── player/             # TTS 播放器（独立组件）
│   │   └── cache-manager/      # 缓存管理页
│   ├── services/
│   │   ├── ocr.service.js      # OCR 服务（腾讯云 + BFF）
│   │   ├── tts.service.js      # TTS 服务（讯飞 WebSocket 流式）
│   │   └── cache.service.js    # LRU 缓存服务
│   ├── utils/
│   │   ├── lru-cache.js        # LRU Cache 实现（哈希表 + 双向链表）
│   │   ├── network.js          # 网络状态管理
│   │   └── image.js            # 图片压缩 + 指纹计算
│   └── assets/                 # 静态资源
└── README.md
```

## 技术栈

| 层次 | 选型 | 说明 |
|------|------|------|
| 前端框架 | 原生微信小程序 | 包体积最优（2MB限制） |
| OCR | 腾讯云 GeneralBasicOCR | 98%+ 印刷体识别率，300-800ms |
| TTS | 讯飞 WebSocket 流式 API | 儿童音色，首帧快 |
| 本地存储 | wx.storage + FileSystemManager | 文字元数据 + MP3 文件 |
| 动画 | Lottie-miniprogram | OCR 加载动画 |
| BFF | 腾讯云函数 SCF | API 密钥保护、签名生成 |

## 开发里程碑

| 阶段 | 内容 | 时间 | 状态 |
|------|------|------|------|
| Phase 1 | 核心 MVP（拍照→OCR→TTS） | Week 1-2 | ⏳ 待开始 |
| Phase 2 | LRU 缓存 + 离线降级 | Week 3-4 | ⏳ 待开始 |
| Phase 3 | 性能优化 + 安全加固 + 上线 | Week 4.5-5.5 | ⏳ 待开始 |

## 立即行动项

- [ ] 申请讯飞开放平台账号（审核1-3工作日）
- [ ] 开通腾讯云 OCR 服务
- [ ] 确认微信小程序账号认证状态

## 团队

| 角色 | 成员 | 产出 |
|------|------|------|
| PM | Alex Chen | PRD, 决策记录 |
| Tech Lead | Sam Rivera | 架构文档, ADR |
| UX Designer | Riley Morgan | UI/UX 规范 |
| Developer | Jamie Park | 代码骨架 |
| QA | Morgan Lee | 测试计划（待完成） |

---

*项目由 AI 开发团队协作生成，人类负责最终决策和评审。*
