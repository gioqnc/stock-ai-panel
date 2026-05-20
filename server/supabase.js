import { createClient } from "@supabase/supabase-js";
import { AppError } from "./stockApi.js";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export function isSupabaseConfigured() {
  return Boolean(process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY);
}

function getClient() {
  if (!isSupabaseConfigured()) {
    return null;
  }

  return createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false },
  });
}

function shouldUseLocalPowerShellFallback(error) {
  const text = JSON.stringify({
    message: error?.message,
    details: error?.details,
    hint: error?.hint,
    code: error?.code,
    raw: String(error),
  });
  return process.platform === "win32" && text.includes("fetch failed");
}

async function requestSupabaseRest({ method, path, body }) {
  const url = `${process.env.SUPABASE_URL.replace(/\/$/, "")}/rest/v1/${path}`;
  const headers = {
    apikey: process.env.SUPABASE_SERVICE_ROLE_KEY,
    Authorization: `Bearer ${process.env.SUPABASE_SERVICE_ROLE_KEY}`,
    "Content-Type": "application/json",
    Prefer: "return=representation",
  };

  const command = [
    "$ErrorActionPreference = 'Stop';",
    "$headers = @{",
    "'apikey' = $env:SUPABASE_KEY;",
    "'Authorization' = \"Bearer $env:SUPABASE_KEY\";",
    "'Content-Type' = 'application/json';",
    "'Prefer' = 'return=representation'",
    "};",
    "$params = @{ Uri = $env:SUPABASE_REST_URL; Method = $env:SUPABASE_METHOD; Headers = $headers; TimeoutSec = 30 };",
    "if ($env:SUPABASE_BODY) { $params.Body = $env:SUPABASE_BODY };",
    "$payload = Invoke-RestMethod @params;",
    "$payload | ConvertTo-Json -Depth 30 -Compress",
  ].join(" ");

  const { stdout } = await execFileAsync(
    "powershell.exe",
    ["-NoProfile", "-Command", command],
    {
      env: {
        ...process.env,
        SUPABASE_REST_URL: url,
        SUPABASE_METHOD: method,
        SUPABASE_KEY: process.env.SUPABASE_SERVICE_ROLE_KEY,
        SUPABASE_BODY: body ? JSON.stringify(body) : "",
      },
      maxBuffer: 4 * 1024 * 1024,
    },
  );

  return stdout.trim() ? JSON.parse(stdout) : null;
}

export async function saveAnalysis({ symbol, quote, analysis }) {
  const supabase = getClient();
  if (!supabase) {
    return { persisted: false, id: null };
  }

  try {
    const { data, error } = await supabase
      .from("stock_analyses")
      .insert({ symbol, quote, analysis })
      .select("id")
      .single();

    if (error) {
      if (shouldUseLocalPowerShellFallback(error)) {
        throw error;
      }
      throw new AppError("Supabase 保存失败", 500, error.message);
    }

    return { persisted: true, id: data.id };
  } catch (error) {
    if (!shouldUseLocalPowerShellFallback(error)) {
      throw new AppError("Supabase 保存失败", 500, error.message);
    }

    const rows = await requestSupabaseRest({
      method: "Post",
      path: "stock_analyses?select=id",
      body: { symbol, quote, analysis },
    });

    return { persisted: true, id: Array.isArray(rows) ? rows[0]?.id : rows?.id };
  }
}

export async function listAnalyses() {
  const supabase = getClient();
  if (!supabase) {
    return { records: [], persisted: false };
  }

  try {
    const { data, error } = await supabase
      .from("stock_analyses")
      .select("id,symbol,quote,analysis,created_at")
      .order("created_at", { ascending: false })
      .limit(20);

    if (error) {
      if (shouldUseLocalPowerShellFallback(error)) {
        throw error;
      }
      throw new AppError("Supabase 历史记录读取失败", 500, error.message);
    }

    return { records: data || [], persisted: true };
  } catch (error) {
    if (!shouldUseLocalPowerShellFallback(error)) {
      throw new AppError("Supabase 历史记录读取失败", 500, error.message);
    }

    const rows = await requestSupabaseRest({
      method: "Get",
      path: "stock_analyses?select=id,symbol,quote,analysis,created_at&order=created_at.desc&limit=20",
    });

    return { records: rows || [], persisted: true };
  }
}
