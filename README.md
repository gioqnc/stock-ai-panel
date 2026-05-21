# AI 股票分析面板（精简版）

一个全栈股票分析演示应用：用户输入股票代码，后端调用免费行情 API 获取数据，再调用 LLM 输出严格 JSON 分析结果，并把记录保存到 Supabase。

> 免责声明：本项目仅用于技术演示，不构成任何投资建议。

## 在线访问

Render URL：部署后填写，例如 `https://stock-ai-panel.onrender.com`

## 功能

- 输入股票代码获取最近日线行情
- 展示最新收盘价、涨跌幅、成交量、最高价、最低价
- 用折线图展示近期收盘价趋势
- 调用 LLM 返回严格 JSON：
  - `summary`
  - `sentiment`: `Bullish | Neutral | Bearish`
  - `risk_level`: `Low | Medium | High`
- 将行情快照和 AI 分析结果保存到 Supabase
- 读取最近 20 条历史分析记录

## 技术栈

- React + TypeScript + Vite
- Express
- Yahoo Finance chart endpoint + optional Stooq CSV + Alpha Vantage fallback
- OpenAI-compatible Chat Completions API
- Supabase Postgres
- Render

## 本地运行

```bash
npm install
copy .env.example .env
npm run dev
```

打开：

```text
http://localhost:5173
```

后端 API：

```text
http://localhost:3000/api/health
```

## 环境变量

`.env.example`：

```env
ALPHA_VANTAGE_API_KEY=
STOCK_CACHE_TTL_MINUTES=720
STOOQ_API_KEY=
LLM_API_KEY=
LLM_BASE_URL=https://api.openai.com/v1
LLM_MODEL=gpt-4o-mini
SUPABASE_URL=
SUPABASE_SERVICE_ROLE_KEY=
CLIENT_ORIGIN=http://localhost:5173
PORT=3000
```

说明：

- `ALPHA_VANTAGE_API_KEY`：备用行情 API Key；主行情源失败时使用。
- `STOCK_CACHE_TTL_MINUTES`：行情缓存时间，默认 720 分钟。
- `STOOQ_API_KEY`：可选。Stooq CSV 下载 key；不填时使用 Yahoo Finance 免 key 行情源。
- `LLM_API_KEY`：用于调用大模型。
- `LLM_BASE_URL`：兼容 OpenAI Chat Completions 的接口地址。
- `LLM_MODEL`：使用的模型名称。
- `SUPABASE_SERVICE_ROLE_KEY`：只允许放在后端环境变量中，不要暴露给前端。

## Supabase 建表 SQL

在 Supabase SQL Editor 中执行：

```sql
create table if not exists stock_analyses (
  id uuid primary key default gen_random_uuid(),
  symbol text not null,
  quote jsonb not null,
  analysis jsonb not null,
  created_at timestamptz not null default now()
);

create index if not exists idx_stock_analyses_symbol
on stock_analyses(symbol);
```

## Prompt 设计

项目后端文件：`server/llm.js`

核心 Prompt：

```text
Analyze the following stock market data.
Return ONLY valid JSON. Do not include markdown, comments, explanations, or extra text.

The JSON must match this schema exactly:
{
  "type": "object",
  "required": ["summary", "sentiment", "risk_level"],
  "additionalProperties": false,
  "properties": {
    "summary": { "type": "string" },
    "sentiment": { "type": "string", "enum": ["Bullish", "Neutral", "Bearish"] },
    "risk_level": { "type": "string", "enum": ["Low", "Medium", "High"] }
  }
}

Rules:
- sentiment must be one of: Bullish, Neutral, Bearish.
- risk_level must be one of: Low, Medium, High.
- Do not provide investment advice.
- Base your answer only on the provided data.
- The summary should be 1-3 concise sentences.

Stock data:
{{stock_data_json}}
```

后端还使用 `zod` 做二次校验：

```js
export const AnalysisSchema = z.object({
  summary: z.string().min(8),
  sentiment: z.enum(["Bullish", "Neutral", "Bearish"]),
  risk_level: z.enum(["Low", "Medium", "High"]),
});
```

## API

| 方法 | 路径 | 说明 |
|---|---|---|
| `GET` | `/api/health` | 查看环境变量配置状态 |
| `GET` | `/api/stock/:symbol` | 获取股票行情 |
| `POST` | `/api/stock-analysis` | 获取行情、调用 LLM、保存 Supabase |
| `POST` | `/api/analyze` | 兼容旧版本的分析接口 |
| `GET` | `/api/analyses` | 获取历史分析记录 |
| `GET` | `/api/prompt-template` | 查看 Prompt 模板 |

`POST /api/stock-analysis` 请求体：

```json
{
  "symbol": "IBM"
}
```

## Render 部署

1. 将代码提交到 GitHub。
2. 在 Render 新建 Web Service。
3. 连接 GitHub 仓库。
4. Build Command：

```bash
npm install && npm run build
```

5. Start Command：

```bash
npm start
```

6. Environment Variables 填入：

```text
ALPHA_VANTAGE_API_KEY
LLM_API_KEY
LLM_BASE_URL
LLM_MODEL
SUPABASE_URL
SUPABASE_SERVICE_ROLE_KEY
CLIENT_ORIGIN
PORT
```

部署到 Render 后，建议把 `CLIENT_ORIGIN` 改成你的 Render 域名。

## Debug 记录

### 问题：LLM 偶尔返回 Markdown 代码块，导致 JSON 解析失败

现象：

```text
LLM 返回内容不是合法 JSON，请重试
```

排查：

我让 AI 工具检查 Prompt 和后端解析逻辑，发现只写“返回 JSON”不够稳定，模型可能返回：

````text
```json
{ "summary": "...", "sentiment": "Neutral", "risk_level": "Medium" }
```
````

解决：

1. Prompt 增加 `Return ONLY valid JSON. Do not include markdown, comments, explanations, or extra text.`
2. API 请求增加 `response_format: { type: "json_object" }`
3. 后端用 `zod` 校验字段和枚举值

结果：

后端只接受这种结构：

```json
{
  "summary": "Recent prices show moderate movement with no strong trend.",
  "sentiment": "Neutral",
  "risk_level": "Medium"
}
```

### 问题：本地前端请求后端出现 CORS 或 404

现象：

```text
GET http://localhost:5173/api/health 404
```

解决：

在 `vite.config.ts` 中配置代理：

```ts
server: {
  proxy: {
    '/api': 'http://localhost:3000',
  },
}
```

同时后端启用：

```js
app.use(cors({ origin: clientOrigin, credentials: false }));
```

## 参考链接

- Alpha Vantage API 文档：https://www.alphavantage.co/documentation/
- Supabase JavaScript 文档：https://supabase.com/docs/reference/javascript/insert
- Render Node Express 部署文档：https://render.com/docs/deploy-node-express-app
- OpenAI Structured Outputs 文档：https://platform.openai.com/docs/guides/structured-outputs
