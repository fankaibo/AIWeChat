# Weixin AgentOS：AI Session 交接说明

最后更新：2026-08-10

本文面向后续参与本项目的 Claude、Codex 或其他 AI coding session。开始工作前先阅读本文和 `README.md`，再以当前代码、测试和本机健康接口为最终事实来源。

## 1. 项目目标

这是用户自己在一台 Mac 上使用的微信只读 Agent 工作台。产品目标是：

1. 在不干扰原生微信和用户当前操作的前提下，持续读取 App Store 版微信的本地消息。
2. 用本机网页替代大部分“阅读、搜索、整理和分析”流程。
3. 允许用户把明确选中的聊天上下文发送给自己配置的 LLM，并保留可追溯的原文引用。
4. 始终把本地数据安全、只读性和可恢复性置于功能扩张之前。

当前不是微信官方客户端，也不是自动回复机器人。消息发送功能被有意禁用。

## 2. 不可破坏的约束

以下规则属于用户已经明确确认的产品边界，除非用户在新的请求中明确改变授权，否则不能绕过：

- 微信原始数据目录是不可变输入。禁止写入、迁移、修复或更改其中任何 SQLite、WAL、媒体或配置文件。
- 所有 SQLite 打开方式必须保持 `readOnly: true`，并执行 `PRAGMA query_only=ON`。
- 禁止通过截图、OCR、鼠标、键盘、辅助功能或前台窗口自动化发送微信消息。旧方案曾遮挡用户工作并发错联系人。
- 禁止添加自动发送、AI 回复、写已读状态或联系人修改接口。
- 正常运行期禁止扫描微信进程内存、注入或重新签名微信、关闭 SIP。仓库里的密钥捕获辅助代码只能在用户明确授权的诊断/重新捕获场景中单独评估，不能成为常驻链路。
- 后端只监听 `127.0.0.1`。不得为了“方便访问”改成 `0.0.0.0`，也不得扩大 CORS。
- 不得读取后在回答、日志、补丁或提交中暴露 API Key、数据库密钥、真实聊天内容、联系人、账号标识或解密快照内容。
- 不得提交 `.env`、`.local/`、数据库、日志、聊天导出或 `~/Documents/LLMApiKey.rtf`。`.gitignore` 已覆盖这些路径。
- 不要把本项目部署到公网。`.openai/hosting.json` 是现有项目脚手架，不代表用户授权上传本地聊天数据或部署服务。

## 3. 当前运行架构

### 进程与端口

`local/dev.mjs` 是本机总进程，启动三个子服务：

1. `local/live-sync.mjs`：监控并发布微信只读快照。
2. `local/server.mjs`：本地 HTTP API，默认 `127.0.0.1:8787`。
3. `vinext dev`：React 网页，默认 `localhost:3000`。

后台常驻可以基于 `local/launchd/com.example.weixin-agentos.plist.example` 配置。实际 label、Node 路径和工作目录属于机器私有配置，不应提交。`KeepAlive=true` 时，任何子进程异常都会使父进程退出并由 launchd 重启。

### 数据流

```text
微信加密 DB/WAL（只读）
  -> live-sync 检测签名变化并等待写入稳定
  -> create-readonly-snapshot 冻结、解密、应用已提交 WAL
  -> 对变更 DB 执行 PRAGMA quick_check
  -> 原子切换 .local/wechat-live/current
  -> ReadonlyStore 打开已发布快照
  -> 8787 本地 API
  -> 3000 网页
```

同步默认轮询间隔为 1500ms，代码下限为 750ms；settle 默认 1200ms。版本化快照默认保留至少 3 版，未变化数据库通过只读硬链接复用。失败时旧的 `current` 版本继续可用。

### 数据模式

- `local-live`：`WEIXIN_DECRYPTED_DIR` 指向同步器的 `current`，并配置状态文件。
- `local-snapshot`：只配置一个静态解密目录。
- `demo`：没有可用的联系人/会话核心数据库时使用演示数据。

## 4. 关键文件

### 前端

- `app/page.tsx`：绝大部分产品状态和 UI。包括会话/公众号/联系人/搜索/隐私首页、消息分页、媒体卡片、统计、热力图、LLM 和历史。
- `app/globals.css`：三栏布局、消息气泡、媒体、灯箱、LLM Markdown、联系人抽屉和响应式样式。
- `app/layout.tsx`：页面 metadata 和根布局。
- `app/chatgpt-auth.ts`：Sites/ChatGPT 环境的鉴权辅助，目前本机主链路不依赖它。

### 后端与数据

- `local/server.mjs`：所有 `/api/*` 路由、CORS、安全响应头、媒体进程编排、LLM 和历史落盘。
- `local/readonly-store.mjs`：联系人、会话、群成员、消息、搜索、分页、热力图和消息格式解析。修改微信 schema 兼容逻辑时首先看这里。
- `local/live-sync.mjs`：变化检测、退避、状态发布、快照切换和旧版本清理。
- `local/create-readonly-snapshot.mjs`：数据库页解密、WAL 应用、增量复用和 manifest。
- `local/wechat-media.mjs`：微信图片资源定位与解码。
- `local/media-worker.mjs`：图片解码隔离进程。
- `local/video-worker.mjs`：视频路径/封面解析隔离进程。不要把视频目录扫描重新放回消息列表主请求。
- `local/voice-transcriber.mjs`：读取语音、SILK/ffmpeg 转码、Whisper 质量参数和按模型版本隔离的本机缓存。
- `local/agent.mjs`：纯本地规则总结/问答，不调用 LLM。
- `local/llm.mjs`：相关上下文选择、Responses/Chat Completions 请求和引用映射。
- `local/model-catalog.mjs`：解析凭据文件、构造公开模型目录。默认模型 ID 是 `opencode-gpt-5.6-sol`。
- `local/llm-history.mjs`：`.local/llm-history.json` 的权限、清理、列表和恢复。
- `local/demo-data.mjs`：服务未连接时的非真实演示数据。

### 配置与测试

- `.env.example`：唯一可提交的 env 模板。
- `local/launchd/com.example.weixin-agentos.plist.example`：不含个人路径的后台常驻模板；实际 `.plist` 被 Git 忽略。
- `tests/*.test.mjs`：同步、联系人、折叠会话、消息回复解析、媒体、Whisper、LLM、历史、本地 API 和页面 HTML 回归测试。

## 5. 已实现的产品行为

后续 session 不应误把以下能力当作待开发项：

- 真实会话、联系人和群成员已从快照读取；联系人有详情和发起现有会话入口。
- 好友/群聊与公众号/服务号已独立分栏。
- 微信折叠群聊聚合项及其成员会话不会在普通列表重复显示，也不展示聚合未读/摘要。
- 会话打开时直接展示最新消息，不播放从顶部滚到底部的动画。
- 实时 revision 会刷新会话列表和未读状态。当前会话的新消息会自动合并：用户停留在底部时自动跟随，正在阅读旧消息时只提示已有更新而不强制滚动；其他会话的新消息不能切换当前会话或改变阅读位置。
- 每页 160 条仅是分页大小，不是消息总数限制；向上滚动会加载更早消息，并去重。
- 未读数字以微信 `SessionTable` 为准。网页不能写已读，只能等原生微信更新后由下一版快照同步。
- 文本保留换行/段落；长 URL 和长单词不会撑出消息气泡。
- 图片支持缩略图、原图优先的灯箱预览和实际像素模式。
- 视频由浏览器按需请求后端解析，避免阻塞会话加载。
- 当前已加载会话中的语音会最新优先、串行调用本机 Whisper 自动转写；不会主动扫描未打开的全量历史，失败项允许手动重试，结果只缓存到 `.local/voice-transcripts/`。
- 链接、文件、系统消息、引用回复、合并聊天记录摘要已有渲染；引用消息会尽可能恢复头像/发送者/正文并跳回原文。
- 月度聊天热力图支持当前聊天和全部聊天统计。
- 本地标签是无模型的规则分析，支持结论/待办/风险筛选，关键信号按时间倒序。
- LLM 模型选择已并入输入区，当前引用显示在输入框上方，默认选择 GPT 5.6 Sol。
- LLM 回答通过本地 SSE 增量展示，支持易读 Markdown、引用标记和跳回消息；历史在完整回答结束后写入，可查询、恢复和继续。
- 点击自己的头像会进入隐私首页，同时隐藏会话栏目和聊天详情。
- 没有任何消息发送接口。

## 6. LLM 约定

- 默认凭据文件：`~/Documents/LLMApiKey.rtf`，也可用 `WEIXIN_LLM_KEY_FILE` 覆盖或设为 `disabled`。
- 绝对不能读取凭据后把值输出到终端、对话或日志。调试只能检查模型 ID、提供方、是否配置、HTTP 状态和经过净化的错误信息。
- Key 只存在于后端模型目录中。`publicModelCatalog()` 只能返回无秘密元数据。
- OpenAI Responses 请求保持 `store: false`。
- 默认相关上下文上限是 120 条消息，环境变量允许 20–300；这不是 token 预算。
- 手动引用最多 20 个 ID；前端当前保留最近 6 条待引用消息。
- `/api/llm/chat` 在 `stream: true` 时返回本地 SSE 事件：`start`、`delta`、`done` 或 `error`；非流式分支保留用于兼容和探测。默认 90 秒超时，环境上限 180 秒。
- 历史默认写入 `.local/llm-history.json`，只保留问答、引用和模型元数据，不要扩展成完整聊天镜像。
- 模型可用性在用户主动探测或首次提问后更新；不要在启动时对所有计费端点批量请求。

## 7. API 速查

| 方法 | 路径 | 用途 |
| --- | --- | --- |
| GET | `/api/health` | 服务、数据源、同步和 LLM 总状态 |
| GET | `/api/sync/status` | 实时只读同步状态 |
| GET | `/api/sessions` | 会话列表；支持 `limit` 和 `category` |
| GET | `/api/contacts` | 联系人目录和 revision；支持 `q` |
| GET | `/api/contacts/:username` | 联系人详情 |
| GET | `/api/groups/:username/members` | 群成员 |
| GET | `/api/chats/:username/messages` | 游标分页消息和真实总数 |
| POST | `/api/chats/:username/voice/:localId/transcript` | 单条语音本机转写 |
| GET/HEAD | `/api/media/:username/:localId/:variant` | 图片缩略图/原图 |
| GET/HEAD | `/api/video/:username/:localId/:variant` | 视频封面/内容 |
| GET | `/api/search` | 全局消息搜索 |
| GET | `/api/heatmap` | 指定月份聊天计数 |
| GET | `/api/stats` | 当前时段本地规则统计 |
| POST | `/api/agent/summarize` | 本地规则总结 |
| POST | `/api/agent/ask` | 本地规则问答 |
| GET | `/api/llm/status` | 无秘密的模型与历史状态 |
| POST | `/api/llm/probe` | 用户触发的单模型可用性探测 |
| POST | `/api/llm/chat` | LLM 对话、引用和历史记录；`stream: true` 返回 SSE |
| GET | `/api/llm/history` | LLM 历史列表 |
| GET | `/api/llm/history/:id` | 恢复一条历史 |

所有响应默认 `Cache-Control: no-store`。二进制媒体是本机私有缓存，且使用 `Content-Disposition: inline`。

## 8. 后续 session 的安全工作流

1. 阅读 `CLAUDE.md` 和 `README.md`，确认用户当前请求是否改变了只读边界。
2. 用只读命令检查当前状态：

   ```bash
   curl http://127.0.0.1:8787/api/health
   launchctl print "gui/$(id -u)/<your-launchd-label>"
   ```

3. 只检查与问题直接相关的源文件。不要为了排障打印 `.env`、keys 文件、数据库内容或真实 API payload。
4. 修改文件使用小范围补丁，保留用户已有改动。不要重置工作树或清理 `.local/`。
5. 修改后运行 `npm run check`；它包含类型检查、Lint、构建和全部测试。
6. 后端 `local/*.mjs` 修改后，构建不会自动重载常驻 Node 进程。验证前应重启 launchd 父服务：

   ```bash
   launchctl kickstart -k "gui/$(id -u)/<your-launchd-label>"
   ```

7. 重启后再次检查 `/api/health`，并确认页面仍是 `local-live` 或预期的数据模式。
8. 最终回复说明修改内容、验证结果和仍存在的真实限制，不要声称未测试的媒体或外部模型已经可用。

## 9. 测试与验收

标准验证：

```bash
npm ci
npm run check
```

测试中使用临时数据库和假上游，不需要读取用户的真实微信或 LLM Key。`tests/llm.test.mjs` 和 `tests/local-api.test.mjs` 会监听本机临时端口；受限沙箱中若出现 `EPERM`，应在允许回环监听的环境复跑这两个测试，不能删除测试或放宽生产监听地址。

修改后的最低验收要求：

- 不产生新的 build、lint 或相关测试失败。
- `/api/health` 返回正常，API 仍只监听 `127.0.0.1`。
- 原始微信目录没有写操作。
- 页面不暴露 API Key、数据库 key 或本机绝对敏感路径。
- 新的数据解析失败时有安全占位或降级，不阻塞整个会话。
- 耗时媒体任务保持按需、可超时、与主 API 请求隔离。

## 10. 已知限制与适合的下一步

- LLM 已流式输出，但还没有手动“停止生成”按钮。
- LLM 上下文选择按消息数，尚未做精确 token 预算和会话级语义索引。
- 合并聊天记录只展示摘要，尚未展开所有嵌套项。
- 历史媒体可能已被微信删除或未下载；这类资源无法从数据库凭空恢复。
- 微信 SILK 语音是否可转写取决于本机 Whisper、ffmpeg、`silk-python` 解码环境，以及只读快照是否包含已解密的 `message/media_*.db`。默认 `small + beam_size 5`，可通过环境变量覆盖模型和术语提示。
- 微信版本/schema/媒体算法变化时，应先用复制出的测试快照做只读兼容分析，再改解析器。
- 若未来确实需要“创建待办”等本地联动，优先设计显式用户确认的本机 action adapter；不要让 LLM 直接执行副作用操作，也不要把它与微信发送能力混在一起。

## 11. 机密数据清单

以下内容只能在本机运行时存在，永远不要复制进文档、测试 fixture、截图说明或提交：

- `~/Documents/LLMApiKey.rtf` 的内容。
- `.env` 的内容。
- `.local/wechat-live/keys.json`。
- `.local/wechat-live/revisions/` 和 `current` 中的解密数据库。
- `.local/logs/`、`.local/llm-history.json` 和 `.local/voice-transcripts/` 的真实内容。
- 用户的微信账号目录名、联系人、群名、消息、头像 URL 和媒体路径。

需要说明状态时，只报告匿名化指标，例如数据模式、revision 是否变化、数据库数量、HTTP 状态、测试通过数和耗时。
