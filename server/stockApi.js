import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const ALPHA_VANTAGE_URL = "https://www.alphavantage.co/query";
const stockCache = new Map();

export class AppError extends Error {
  constructor(message, status = 500, details = undefined) {
    super(message);
    this.status = status;
    this.details = details;
  }
}

function toNumber(value) {
  const num = Number(value);
  return Number.isFinite(num) ? num : 0;
}

function normalizeSymbol(symbol) {
  return String(symbol || "")
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9.\-]/g, "");
}

function getCacheTtlMs() {
  const minutes = Number(process.env.ALPHA_VANTAGE_CACHE_TTL_MINUTES || 720);
  return Number.isFinite(minutes) && minutes > 0 ? minutes * 60 * 1000 : 720 * 60 * 1000;
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function readCachedStockData(symbol, { allowExpired = false } = {}) {
  const entry = stockCache.get(symbol);
  if (!entry) {
    return null;
  }

  const ageMs = Date.now() - entry.cachedAt;
  if (!allowExpired && ageMs > getCacheTtlMs()) {
    stockCache.delete(symbol);
    return null;
  }

  return {
    ...clone(entry.data),
    cache: {
      source: entry.source,
      cachedAt: new Date(entry.cachedAt).toISOString(),
      stale: ageMs > getCacheTtlMs(),
    },
  };
}

function writeCachedStockData(symbol, data, source = "alpha_vantage") {
  stockCache.set(symbol, {
    data: clone(data),
    source,
    cachedAt: Date.now(),
  });
}

async function fetchLatestSupabaseQuote(symbol) {
  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
    return null;
  }

  try {
    const url = new URL(`${process.env.SUPABASE_URL.replace(/\/$/, "")}/rest/v1/stock_analyses`);
    url.searchParams.set("select", "quote");
    url.searchParams.set("symbol", `eq.${symbol}`);
    url.searchParams.set("order", "created_at.desc");
    url.searchParams.set("limit", "1");

    const response = await fetch(url, {
      headers: {
        apikey: process.env.SUPABASE_SERVICE_ROLE_KEY,
        Authorization: `Bearer ${process.env.SUPABASE_SERVICE_ROLE_KEY}`,
      },
    });

    if (!response.ok) {
      return null;
    }

    const rows = await response.json();
    const quote = rows?.[0]?.quote;
    if (!quote || quote.symbol !== symbol) {
      return null;
    }

    writeCachedStockData(symbol, quote, "supabase_history");
    return readCachedStockData(symbol, { allowExpired: true });
  } catch {
    return null;
  }
}

async function getFallbackStockData(symbol) {
  const staleCached = readCachedStockData(symbol, { allowExpired: true });
  if (staleCached) {
    return staleCached;
  }

  return fetchLatestSupabaseQuote(symbol);
}

export function validateSymbol(symbol) {
  const normalized = normalizeSymbol(symbol);
  if (!normalized) {
    throw new AppError("请输入股票代码", 400);
  }
  if (normalized.length > 12) {
    throw new AppError("股票代码过长，请检查输入", 400);
  }
  return normalized;
}

function normalizeStockPayload(normalized, payload) {
  const series = payload["Time Series (Daily)"];
  if (!series || typeof series !== "object") {
    throw new AppError("行情 API 返回结构异常", 502, payload);
  }

  const recentPrices = Object.entries(series)
    .sort(([a], [b]) => b.localeCompare(a))
    .slice(0, 16)
    .map(([date, values]) => ({
      date,
      open: toNumber(values["1. open"]),
      high: toNumber(values["2. high"]),
      low: toNumber(values["3. low"]),
      close: toNumber(values["4. close"]),
      volume: toNumber(values["5. volume"]),
    }));

  const latest = recentPrices[0];
  const previous = recentPrices[1];
  const change = previous ? latest.close - previous.close : 0;
  const changePercent = previous && previous.close ? (change / previous.close) * 100 : 0;

  return {
    symbol: normalized,
    latestDate: latest.date,
    open: latest.open,
    high: latest.high,
    low: latest.low,
    close: latest.close,
    volume: latest.volume,
    change,
    changePercent,
    recentPrices: [...recentPrices].reverse(),
  };
}

async function fetchJsonWithLocalFallback(url) {
  try {
    const response = await fetch(url);
    if (!response.ok) {
      throw new AppError(`行情 API 请求失败：${response.status}`, 502);
    }
    return response.json();
  } catch (error) {
    if (process.platform !== "win32") {
      throw error;
    }

    const command = [
      "$ErrorActionPreference = 'Stop';",
      "$payload = Invoke-RestMethod -Uri $env:STOCK_API_URL -TimeoutSec 20;",
      "$payload | ConvertTo-Json -Depth 20 -Compress",
    ].join(" ");

    const { stdout } = await execFileAsync(
      "powershell.exe",
      ["-NoProfile", "-Command", command],
      {
        env: { ...process.env, STOCK_API_URL: url.toString() },
        maxBuffer: 4 * 1024 * 1024,
      },
    );

    return JSON.parse(stdout);
  }
}

export async function fetchStockData(symbol) {
  const apiKey = process.env.ALPHA_VANTAGE_API_KEY;
  const normalized = validateSymbol(symbol);

  const cached = readCachedStockData(normalized);
  if (cached) {
    return cached;
  }

  if (!apiKey) {
    throw new AppError("缺少 ALPHA_VANTAGE_API_KEY，请先配置行情 API Key", 500);
  }

  const url = new URL(ALPHA_VANTAGE_URL);
  url.searchParams.set("function", "TIME_SERIES_DAILY");
  url.searchParams.set("symbol", normalized);
  url.searchParams.set("outputsize", "compact");
  url.searchParams.set("apikey", apiKey);

  let payload;
  try {
    payload = await fetchJsonWithLocalFallback(url);
  } catch (error) {
    const fallback = await getFallbackStockData(normalized);
    if (fallback) {
      return fallback;
    }
    throw error;
  }

  if (payload["Error Message"]) {
    throw new AppError("行情 API 未找到该股票代码", 404, payload["Error Message"]);
  }
  if (payload.Note || payload.Information) {
    const fallback = await getFallbackStockData(normalized);
    if (fallback) {
      return fallback;
    }
    throw new AppError("行情 API 频率受限，请稍后重试或更换 API Key", 429, payload.Note || payload.Information);
  }

  const stockData = normalizeStockPayload(normalized, payload);
  writeCachedStockData(normalized, stockData);
  return stockData;
}
