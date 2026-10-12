# 高情商回复生成器

输入对方原话或描述沟通场景，生成 1 条主推 + 2 条备选的高情商回复。每条附「为什么这么说」与语气风险提示；支持「换一批」（与上一批不重复）与一键复制。

**移动端优先**：320px 起可用，无横向滚动，可点元素 ≥44×44px，软键盘不遮挡，适配刘海屏安全区，深色模式跟随系统。页面不存储任何输入内容。

## 技术栈

- 后端：Node.js（≥18.12）+ Express 4 + dotenv，零数据库、零日志落盘
- 前端：原生 HTML / CSS / JS，无构建步骤、无 CDN 依赖（4G 首屏可交互 ≤3s）
- 模型：DeepSeek `deepseek-chat`（OpenAI 兼容协议，原生 `fetch` 调用）

## 目录结构

```
高情商回复工具/
├── server.js              # 服务入口（静态资源 + API + 限流 + 错误兜底）
├── lib/
│   ├── config.js          # 环境变量读取与校验
│   ├── rate-limit.js      # 内存滑动窗口限流
│   ├── validate.js        # 输入校验（码点计数，不静默截断）
│   ├── dedupe.js          # 2-gram Jaccard 相似度（换一批去重兜底）
│   ├── prompt.js          # 系统提示词与用户消息构造
│   └── generate.js        # 模型调用（超时/重试/解析/撞车再生成）与 mock
├── public/
│   ├── index.html         # 单页应用
│   ├── 404.html
│   ├── style.css          # 移动端优先样式（safe-area / 深色模式）
│   └── app.js             # 前端逻辑（防重复提交/复制降级/键盘适配/自测模式）
├── test/
│   ├── server-self-test.js  # 服务端 API 自测（npm run test）
│   └── browser-self-test.js # 无头浏览器自测（npm run test:browser）
├── package.json
├── .env.example
├── Dockerfile
└── README.md
```

## 本地启动

### 1. 准备环境变量

```bash
cp .env.example .env
```

编辑 `.env`，填入你的 DeepSeek API Key：

```ini
DEEPSEEK_API_KEY=sk-xxxxxxxxxxxxxxxx
DEEPSEEK_BASE_URL=https://api.deepseek.com
DEEPSEEK_MODEL=deepseek-chat
MOCK_MODE=0
PORT=3000
```

> 没有 API Key 也可以先体验完整功能：设 `MOCK_MODE=1`（此时无需 Key，返回内置示例回复）。

### 2. 安装依赖并启动

```bash
npm install
npm start        # 启动：http://localhost:3000
npm run dev      # 开发模式（文件变更自动重启）
```

或使用 pnpm：

```bash
pnpm install
pnpm start
```

### 3. 自测

```bash
npm test            # 服务端 API 自测（自动以 mock 模式起临时服务，跑完自动关闭）
npm run test:browser # 无头 Edge 浏览器自测（需本机已安装 Microsoft Edge）
```

详细自测结论见 [自测清单.md](./自测清单.md)。

## 环境变量

| 变量 | 默认值 | 说明 |
|---|---|---|
| `DEEPSEEK_API_KEY` | 无 | DeepSeek API Key（`MOCK_MODE=0` 时必填，缺失则启动报错） |
| `DEEPSEEK_BASE_URL` | `https://api.deepseek.com` | API 基础地址（兼容 OpenAI 协议的网关均可替换） |
| `DEEPSEEK_MODEL` | `deepseek-chat` | 模型名 |
| `MOCK_MODE` | `0` | `1` = 不调模型，返回内置示例（用于体验与自测） |
| `MOCK_DELAY_MS` | `500` | mock 模式模拟延迟（毫秒） |
| `PORT` | `3000` | 服务端口 |
| `MAX_INPUT_LENGTH` | `2000` | 输入上限（按 Unicode 码点计数，前端通过 `/api/health` 同步此值） |
| `RATE_LIMIT_PER_MIN` | `6` | 每 IP 每分钟生成请求上限 |
| `MODEL_TIMEOUT_MS` | `25000` | 服务端等待模型响应的超时（前端另有 30s 兜底） |

## 接口

### `GET /api/health`

```json
{ "ok": true, "mock": false, "maxInputLength": 2000 }
```

### `POST /api/generate`

请求：

```json
{ "input": "对方原话或场景描述", "tone": "warm", "length": "medium", "avoid": ["上一批的回复文本…"] }
```

- `tone`：`warm`（温和，默认）/ `formal`（正式）/ `humorous`（幽默）
- `length`：`short`（约 40–60 字）/ `medium`（约 60–120 字，默认）/ `long`（约 120–200 字）
- `avoid`：换一批去重——传入上一批的全部回复文本

成功（200）：

```json
{
  "main": { "text": "主推回复", "reason": "这么说的理由", "risk": "风险提示或 null" },
  "alternatives": [ { "text": "备选1", "reason": "…", "risk": null }, { "text": "备选2", "reason": "…", "risk": null } ],
  "notes": "需要用户补充的信息（可为 null）"
}
```

失败：

```json
{ "error": { "code": "RATE_LIMITED", "message": "请求太频繁了，请稍后再试。", "retryable": true, "retryAfterSec": 42 } }
```

错误码：`INVALID_INPUT`（400）、`RATE_LIMITED`（429）、`MODEL_TIMEOUT` / `MODEL_ERROR` / `PARSE_ERROR` / `UPSTREAM_ERROR`（502）。前端按错误码分类提示，可重试的错误保留用户输入并提供重试按钮。

## 部署

### Docker

```bash
docker build -t eq-reply .
docker run -p 3000:3000 --env-file .env eq-reply
```

### 云主机（裸跑）

```bash
npm ci --omit=dev
NODE_ENV=production npm start
```

建议放在 Nginx/Caddy 反代后开启 HTTPS——剪贴板 API 在 HTTPS 下体验最好；HTTP 环境页面会自动降级为「手动长按复制」，功能不缺失。

**安全注意**：`DEEPSEEK_API_KEY` 只存在于服务端 `.env`，绝不出现在任何前端产物中（自测清单第 10 条有检索证据）。

## 隐私说明

- 不提供账号、不保存历史，**输入内容与生成结果均不落盘**；
- 服务端日志只记录错误码与时间戳，不记录用户原文；
- 输入内容仅用于当次生成请求，发送至 DeepSeek API；
- 限流为每 IP 每分钟 6 次（可在 `.env` 调整）。

## 已知限制

1. **无账号与历史**：刷新页面后上一批结果不保留，换一批只能基于当前页面内的一批去重。
2. **换一批去重是「尽力而为」**：采用「请求带 avoid + 提示词避开 + 服务端 2-gram Jaccard 相似度校验（阈值 0.55）」，撞车时自动重新生成（最多 3 次模型调用）；模型输出高度随机时仍可能偶发相似表述。
3. **限流为单进程内存实现**：多实例部署时每个实例独立计数；如需全局限流请在前置网关配置。
4. **模型调用依赖 DeepSeek 服务可用性**：超时（25s）或上游异常会给出分类错误提示与重试入口，不影响页面可用。
5. **自测环境**：无头浏览器自测基于本机 Edge；iOS Safari / 微信内置浏览器的真机验证结果见 [自测清单.md](./自测清单.md)（该两项依赖真机环境，标记为等效验证或待真机复验）。
6. `notes` 中的「可根据实际情况补充细节」提示由模型生成，文案可能与原文略有差异。
