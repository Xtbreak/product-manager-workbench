# 工作台（Workbench）

**在一个桌面窗口里，用 AI 协作、用飞书整理信息、用独立浏览器管理账号。**

产品设计与维护：**Xtbreak** · [项目仓库](https://github.com/Xtbreak/workbench) · [GitHub @Xtbreak](https://github.com/Xtbreak)

## 一个窗口，三个工作区

- **左侧 AI 对话**：围绕本地项目与资料协作，也可以通过对话执行评论同步、发送回复和结果核对。
- **中间飞书表格**：集中查看评论、填写回复、跟踪处理状态。
- **右侧账号浏览器**：为账号保留独立的浏览器环境和登录状态，可调整宽度，也可展开浏览器并保留飞书入口。

## 评论与多轮回复

工作台支持小红书和抖音自己账号发布的作品，将评论整理到飞书，并按具体评论及回复关系对应多轮对话。

1. 登录平台账号，配置飞书授权和回复表，绑定自己的作品。
2. 点击顶部同步图标，或在左侧对话中要求同步评论。
3. 在飞书的“我的回复”列填写内容，再点击工作台顶部“发送评论”，发送本次已填写、尚未回复的内容。
4. 也可以点击“原评论”中的链接，到平台手动回复；再次同步时，平台实际回复回填飞书并显示“已回复”，替换未发送草稿。

回复表默认展示 **用户、时间、评论、原评论、我的回复、状态**。技术字段保留在后台映射中，不占用日常阅读视图。本人回复会与客户评论区分处理。

发送由用户手动发起，不会自动轮询发送。遇到平台验证或结果不确定时，需要完成验证或核对后再继续。评论链接在工作台内可定位到对应账号和评论；外部浏览器通常只能打开作品页。评论采集受平台页面和加载范围影响，不保证覆盖所有分页。

详细配置与操作见[工作台使用说明](AionUi/docs/contributing/workbench.md)。

## 其他能力

支持本地项目资料协作、助手与定时任务，以及 2～4 个模型的回答对比。模型对比支持独立流式输出、停止、重试与保存记录，详见[模型对比台说明](AionUi/docs/guides/model-bench.zh-CN.md)。AI 模型与服务接口需要自行配置。

## 项目结构

```text
workbench/
├── AionUi/       # Electron 桌面端与前端
├── AionCore/     # Rust 后端与接口
├── docs/         # 产品资料与作者说明
├── LICENSE      # Apache 2.0 许可证
└── NOTICE       # 上游归属与版权说明
```

## 开发与使用

保留 `AionUi` 与 `AionCore` 的同级目录关系，并按文档准备环境、安装依赖与构建：

- [桌面端文档](AionUi/readme.md) · [前端脚本](AionUi/package.json)
- [后端架构](AionCore/ARCHITECTURE.zh-CN.md) · [后端任务](AionCore/justfile)
- [工作台配置与操作](AionUi/docs/contributing/workbench.md)

仓库提供源码，不包含本机依赖、编译产物、账号凭据或聊天记录。浏览器登录与飞书 CLI 授权需要在本机完成。

## 开源来源与版权

基于 [AionUi](https://github.com/iOfficeAI/AionUi) 与 [AionCore](https://github.com/iOfficeAI/AionCore) 二次开发，感谢上游作者和贡献者。`AionUi`、`AionCore` 目录保留原始项目名称与上游文档。

**Copyright 2026 Xtbreak — 由 Xtbreak 享有权利的原创新增内容及修改部分。** 上游代码与素材的版权仍归原权利人所有，原有声明完整保留。

本仓库中由 Xtbreak 新增与修改的部分采用 Apache-2.0 许可；相关使用、修改和分发须遵守许可证。产品署名不构成上游官方背书，也不授予任何第三方商标权。详见 [LICENSE](LICENSE)、[NOTICE](NOTICE)、[AionUi/LICENSE](AionUi/LICENSE) 与 [AionCore/LICENSE](AionCore/LICENSE)。
