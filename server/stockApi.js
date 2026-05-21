import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const ALPHA_VANTAGE_URL = "https://www.alphavantage.co/query";
const STOOQ_URL = "https://stooq.com/q/d/l/";
const YAHOO_CHART_URL = "https://query1.finance.yahoo.com/v8/finance/chart";
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
  const minutes = Number(
    process.env.STOCK_CACHE_TTL_MINUTES || process.env.ALPHA_VANTAGE_CACHE_TTL_MINUTES || 720,
  );
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

function writeCachedStockData(symbol, data, source = "stock_provider") {
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

function buildStockDataFromPrices(normalized, prices) {
  const recentPrices = prices
    .filter((point) => point.date && Number.isFinite(point.close))
    .sort((a, b) => b.date.localeCompare(a.date))
    .slice(0, 16);

  const latest = recentPrices[0];
  const previous = recentPrices[1];
  if (!latest) {
    throw new AppError("行情 API 未返回有效价格数据", 502);
  }

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

function normalizeAlphaVantagePayload(normalized, payload) {
  const series = payload["Time Series (Daily)"];
  if (!series || typeof series !== "object") {
    throw new AppError("行情 API 返回结构异常", 502, payload);
  }

  const prices = Object.entries(series).map(([date, values]) => ({
    date,
    open: toNumber(values["1. open"]),
    high: toNumber(values["2. high"]),
    low: toNumber(values["3. low"]),
    close: toNumber(values["4. close"]),
    volume: toNumber(values["5. volume"]),
  }));

  return buildStockDataFromPrices(normalized, prices);
}

async function fetchTextWithLocalFallback(url) {
  try {
    const response = await fetch(url);
    if (!response.ok) {
      throw new AppError(`行情 API 请求失败：${response.status}`, 502);
    }
    return response.text();
  } catch (error) {
    if (process.platform !== "win32") {
      throw error;
    }

    const command = [
      "$ErrorActionPreference = 'Stop';",
      "$payload = Invoke-RestMethod -Uri $env:STOCK_API_URL -TimeoutSec 20;",
      "if ($payload -is [string]) { $payload } else { $payload | ConvertTo-Json -Depth 20 -Compress }",
    ].join(" ");

    const { stdout } = await execFileAsync(
      "powershell.exe",
      ["-NoProfile", "-Command", command],
      {
        env: { ...process.env, STOCK_API_URL: url.toString() },
        maxBuffer: 4 * 1024 * 1024,
      },
    );

    return stdout;
  }
}

async function fetchJsonWithLocalFallback(url) {
  const text = await fetchTextWithLocalFallback(url);
  return JSON.parse(text);
}

function toStooqSymbol(symbol) {
  const lower = symbol.toLowerCase();
  return lower.includes(".") ? lower : `${lower}.us`;
}

function parseStooqCsv(normalized, csvText) {
  const lines = csvText.trim().split(/\r?\n/);
  const header = lines[0]?.trim().toLowerCase();
  if (header !== "date,open,high,low,close,volume") {
    return null;
  }

  const prices = lines.slice(1).map((line) => {
    const [date, open, high, low, close, volume] = line.split(",");
    return {
      date,
      open: toNumber(open),
      high: toNumber(high),
      low: toNumber(low),
      close: toNumber(close),
      volume: toNumber(volume),
    };
  });

  return buildStockDataFromPrices(normalized, prices);
}

async function fetchStooqStockData(normalized) {
  const apiKey = process.env.STOOQ_API_KEY;
  if (!apiKey) {
    return null;
  }

  const url = new URL(STOOQ_URL);
  url.searchParams.set("s", toStooqSymbol(normalized));
  url.searchParams.set("i", "d");
  url.searchParams.set("apikey", apiKey);

  const csvText = await fetchTextWithLocalFallback(url);
  return parseStooqCsv(normalized, csvText);
}

async function fetchYahooStockData(normalized) {
  const yahooSymbol = normalized.replace(/\./g, "-");
  const url = new URL(`${YAHOO_CHART_URL}/${encodeURIComponent(yahooSymbol)}`);
  url.searchParams.set("range", "1mo");
  url.searchParams.set("interval", "1d");

  const payload = await fetchJsonWithLocalFallback(url);
  const result = payload.chart?.result?.[0];
  if (!result) {
    return null;
  }

  const timestamps = result.timestamp || [];
  const quote = result.indicators?.quote?.[0] || {};
  const prices = timestamps.map((timestamp, index) => ({
    date: new Date(timestamp * 1000).toISOString().slice(0, 10),
    open: toNumber(quote.open?.[index]),
    high: toNumber(quote.high?.[index]),
    low: toNumber(quote.low?.[index]),
    close: toNumber(quote.close?.[index]),
    volume: toNumber(quote.volume?.[index]),
  }));

  return buildStockDataFromPrices(normalized, prices);
}

async function fetchAlphaVantageStockData(normalized) {
  const apiKey = process.env.ALPHA_VANTAGE_API_KEY;
  if (!apiKey) {
    return null;
  }

  const url = new URL(ALPHA_VANTAGE_URL);
  url.searchParams.set("function", "TIME_SERIES_DAILY");
  url.searchParams.set("symbol", normalized);
  url.searchParams.set("outputsize", "compact");
  url.searchParams.set("apikey", apiKey);

  const payload = await fetchJsonWithLocalFallback(url);

  if (payload["Error Message"]) {
    throw new AppError("行情 API 未找到该股票代码", 404, payload["Error Message"]);
  }
  if (payload.Note || payload.Information) {
    throw new AppError("行情 API 频率受限，请稍后重试或更换 API Key", 429, payload.Note || payload.Information);
  }

  return normalizeAlphaVantagePayload(normalized, payload);
}

async function tryProvider(providerName, providerFn, normalized) {
  try {
    const stockData = await providerFn(normalized);
    if (!stockData) {
      return null;
    }
    writeCachedStockData(normalized, stockData, providerName);
    return readCachedStockData(normalized);
  } catch {
    return null;
  }
}

export async function fetchStockData(symbol) {
  const normalized = validateSymbol(symbol);

  const cached = readCachedStockData(normalized);
  if (cached) {
    return cached;
  }

  const stooqData = await tryProvider("stooq", fetchStooqStockData, normalized);
  if (stooqData) {
    return stooqData;
  }

  const yahooData = await tryProvider("yahoo_finance", fetchYahooStockData, normalized);
  if (yahooData) {
    return yahooData;
  }

  const alphaVantageData = await tryProvider("alpha_vantage", fetchAlphaVantageStockData, normalized);
  if (alphaVantageData) {
    return alphaVantageData;
  }

  const fallback = await getFallbackStockData(normalized);
  if (fallback) {
    return fallback;
  }

  throw new AppError("行情数据获取失败，请稍后重试或更换股票代码", 502);
}
