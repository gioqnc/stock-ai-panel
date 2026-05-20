import { z } from "zod";
import { AppError } from "./stockApi.js";

export const AnalysisSchema = z.object({
  summary: z.string().min(8),
  sentiment: z.enum(["Bullish", "Neutral", "Bearish"]),
  risk_level: z.enum(["Low", "Medium", "High"]),
});

const analysisJsonSchema = {
  type: "object",
  required: ["summary", "sentiment", "risk_level"],
  additionalProperties: false,
  properties: {
    summary: { type: "string" },
    sentiment: { type: "string", enum: ["Bullish", "Neutral", "Bearish"] },
    risk_level: { type: "string", enum: ["Low", "Medium", "High"] },
  },
};

function buildPrompt(stockData) {
  return `Analyze the following stock market data.
Return ONLY valid JSON. Do not include markdown, comments, explanations, or extra text.

The JSON must match this schema exactly:
${JSON.stringify(analysisJsonSchema, null, 2)}

Rules:
- sentiment must be one of: Bullish, Neutral, Bearish.
- risk_level must be one of: Low, Medium, High.
- Do not provide investment advice.
- Base your answer only on the provided data.
- The summary should be 1-3 concise sentences.

Stock data:
${JSON.stringify(stockData, null, 2)}`;
}

function parseLlmJson(content) {
  try {
    return JSON.parse(content);
  } catch {
    throw new AppError("LLM 返回内容不是合法 JSON，请重试", 502, content);
  }
}

function createRequestBody(model, stockData, includeResponseFormat) {
  return {
    model,
    temperature: 0.2,
    ...(includeResponseFormat ? { response_format: { type: "json_object" } } : {}),
    messages: [
      {
        role: "system",
        content:
          "You are a financial data analysis assistant. You must return only strict JSON that matches the requested schema.",
      },
      { role: "user", content: buildPrompt(stockData) },
    ],
  };
}

async function requestChatCompletion({ baseUrl, apiKey, model, stockData, includeResponseFormat }) {
  const response = await fetch(`${baseUrl.replace(/\/$/, "")}/chat/completions`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(createRequestBody(model, stockData, includeResponseFormat)),
  });

  const payload = await response.json().catch(() => ({}));
  return { response, payload };
}

function isUnsupportedResponseFormat(response, payload) {
  if (![400, 422].includes(response.status)) {
    return false;
  }
  return JSON.stringify(payload).toLowerCase().includes("response_format");
}

export async function analyzeStock(stockData) {
  const apiKey = process.env.LLM_API_KEY;
  const baseUrl = process.env.LLM_BASE_URL || "https://api.openai.com/v1";
  const model = process.env.LLM_MODEL || "gpt-4o-mini";

  if (!apiKey) {
    throw new AppError("缺少 LLM_API_KEY，请先配置大模型 API Key", 500);
  }

  let { response, payload } = await requestChatCompletion({
    baseUrl,
    apiKey,
    model,
    stockData,
    includeResponseFormat: true,
  });

  if (!response.ok && isUnsupportedResponseFormat(response, payload)) {
    ({ response, payload } = await requestChatCompletion({
      baseUrl,
      apiKey,
      model,
      stockData,
      includeResponseFormat: false,
    }));
  }

  if (!response.ok) {
    throw new AppError("LLM API 请求失败", response.status, payload);
  }

  const content = payload.choices?.[0]?.message?.content;
  if (!content) {
    throw new AppError("LLM API 未返回分析内容", 502, payload);
  }

  const parsed = parseLlmJson(content);
  const result = AnalysisSchema.safeParse(parsed);
  if (!result.success) {
    throw new AppError("LLM 返回 JSON 字段不符合要求", 502, result.error.flatten());
  }

  return result.data;
}

export const promptTemplate = buildPrompt({
  symbol: "IBM",
  recentPrices: [
    { date: "2026-05-19", open: 120.1, high: 125, low: 119.8, close: 123.4, volume: 1234567 },
  ],
});
