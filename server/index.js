import "dotenv/config";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import cors from "cors";
import express from "express";
import { analyzeStock, promptTemplate } from "./llm.js";
import { fetchStockData, validateSymbol } from "./stockApi.js";
import { isSupabaseConfigured, listAnalyses, saveAnalysis } from "./supabase.js";

const app = express();
const port = Number(process.env.PORT || 3000);
const clientOrigin = (process.env.CLIENT_ORIGIN || "http://localhost:5173").replace(/\/+$/, "");

app.use(cors({ origin: clientOrigin, credentials: false }));
app.use(express.json({ limit: "1mb" }));

app.get("/api/health", (req, res) => {
  let supabaseKeyRole = null;
  let supabaseKeyRef = null;
  let supabaseUrlHost = null;

  try {
    const key = process.env.SUPABASE_SERVICE_ROLE_KEY || "";
    const payload = JSON.parse(Buffer.from(key.split(".")[1] || "", "base64url").toString("utf8"));
    supabaseKeyRole = payload.role || null;
    supabaseKeyRef = payload.ref || null;
  } catch {
    supabaseKeyRole = "unreadable";
  }

  try {
    supabaseUrlHost = process.env.SUPABASE_URL ? new URL(process.env.SUPABASE_URL).host : null;
  } catch {
    supabaseUrlHost = "invalid";
  }

  res.json({
    ok: true,
    services: {
      alphaVantage: Boolean(process.env.ALPHA_VANTAGE_API_KEY),
      llm: Boolean(process.env.LLM_API_KEY),
      supabase: isSupabaseConfigured(),
    },
    supabase: {
      urlHost: supabaseUrlHost,
      keyRole: supabaseKeyRole,
      keyRef: supabaseKeyRef,
    },
  });
});

app.get("/api/prompt-template", (req, res) => {
  res.type("text/plain").send(promptTemplate);
});

app.get("/api/stock/:symbol", async (req, res, next) => {
  try {
    const quote = await fetchStockData(req.params.symbol);
    res.json({ quote });
  } catch (error) {
    next(error);
  }
});

app.post("/api/analyze", async (req, res, next) => {
  try {
    const symbol = validateSymbol(req.body?.symbol);
    const quote = await fetchStockData(symbol);
    const analysis = await analyzeStock(quote);
    const saved = await saveAnalysis({ symbol, quote, analysis });

    res.json({
      symbol,
      quote,
      analysis,
      persisted: saved.persisted,
      id: saved.id,
      warning: saved.persisted ? null : "Supabase 未配置，本次结果未写入数据库",
    });
  } catch (error) {
    next(error);
  }
});

app.get("/api/analyses", async (req, res, next) => {
  try {
    const result = await listAnalyses();
    res.json(result);
  } catch (error) {
    next(error);
  }
});

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const distPath = path.resolve(__dirname, "../dist");

if (fs.existsSync(distPath)) {
  app.use(express.static(distPath));
  app.get(/.*/, (req, res, next) => {
    if (req.path.startsWith("/api")) {
      next();
      return;
    }
    res.sendFile(path.join(distPath, "index.html"));
  });
}

app.use((error, req, res, next) => {
  const status = error.status || 500;
  const message = error.message || "服务器错误";
  if (status >= 500) {
    console.error(error);
  }
  res.status(status).json({
    error: message,
    details: error.details,
  });
});

app.listen(port, () => {
  console.log(`API server listening on http://localhost:${port}`);
});
