import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  AlertTriangle,
  BarChart3,
  BrainCircuit,
  Database,
  History,
  Loader2,
  RefreshCw,
  Search,
  TrendingDown,
  TrendingUp,
} from 'lucide-react'
import {
  CartesianGrid,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts'
import './App.css'

type Sentiment = 'Bullish' | 'Neutral' | 'Bearish'
type RiskLevel = 'Low' | 'Medium' | 'High'

type PricePoint = {
  date: string
  open: number
  high: number
  low: number
  close: number
  volume: number
}

type Quote = {
  symbol: string
  latestDate: string
  open: number
  high: number
  low: number
  close: number
  volume: number
  change: number
  changePercent: number
  recentPrices: PricePoint[]
}

type Analysis = {
  summary: string
  sentiment: Sentiment
  risk_level: RiskLevel
}

type AnalyzeResponse = {
  symbol: string
  quote: Quote
  analysis: Analysis
  persisted: boolean
  id: string | null
  warning: string | null
}

type HistoryRecord = {
  id: string
  symbol: string
  quote: Quote
  analysis: Analysis
  created_at: string
}

async function apiRequest<T>(url: string, options?: RequestInit): Promise<T> {
  const response = await fetch(url, options)
  const payload = await response.json().catch(() => ({}))

  if (!response.ok) {
    throw new Error(payload.error || `请求失败：${response.status}`)
  }

  return payload as T
}

function formatMoney(value: number) {
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    maximumFractionDigits: 2,
  }).format(value)
}

function formatNumber(value: number) {
  return new Intl.NumberFormat('en-US').format(Math.round(value || 0))
}

function formatPercent(value: number) {
  const sign = value > 0 ? '+' : ''
  return `${sign}${value.toFixed(2)}%`
}

function formatDate(value: string) {
  return new Intl.DateTimeFormat('zh-CN', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  }).format(new Date(value))
}

function MetricCard({
  label,
  value,
  tone,
}: {
  label: string
  value: string
  tone?: 'positive' | 'negative' | 'neutral'
}) {
  return (
    <div className={`metric-card ${tone || 'neutral'}`}>
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  )
}

function App() {
  const [symbol, setSymbol] = useState('IBM')
  const [quote, setQuote] = useState<Quote | null>(null)
  const [analysis, setAnalysis] = useState<Analysis | null>(null)
  const [history, setHistory] = useState<HistoryRecord[]>([])
  const [loadingQuote, setLoadingQuote] = useState(false)
  const [loadingAnalysis, setLoadingAnalysis] = useState(false)
  const [loadingHistory, setLoadingHistory] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')

  const normalizedSymbol = symbol.trim().toUpperCase()

  const trendTone = useMemo(() => {
    if (!quote) return 'neutral'
    return quote.changePercent >= 0 ? 'positive' : 'negative'
  }, [quote])

  const loadHistory = useCallback(async () => {
    setLoadingHistory(true)
    try {
      const data = await apiRequest<{ records: HistoryRecord[]; persisted: boolean }>('/api/analyses')
      setHistory(data.records)
      if (!data.persisted) {
        setNotice('Supabase 未配置，历史记录暂不可用')
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : '历史记录读取失败')
    } finally {
      setLoadingHistory(false)
    }
  }, [])

  useEffect(() => {
    const timer = window.setTimeout(() => {
      void loadHistory()
    }, 0)
    return () => window.clearTimeout(timer)
  }, [loadHistory])

  async function handleFetchQuote() {
    if (!normalizedSymbol) {
      setError('请输入股票代码')
      return
    }

    setError('')
    setNotice('')
    setLoadingQuote(true)

    try {
      const data = await apiRequest<{ quote: Quote }>(`/api/stock/${normalizedSymbol}`)
      setQuote(data.quote)
      setAnalysis(null)
    } catch (err) {
      setError(err instanceof Error ? err.message : '行情数据获取失败')
    } finally {
      setLoadingQuote(false)
    }
  }

  async function handleAnalyze() {
    if (!normalizedSymbol) {
      setError('请输入股票代码')
      return
    }

    setError('')
    setNotice('')
    setLoadingAnalysis(true)

    try {
      const data = await apiRequest<AnalyzeResponse>('/api/analyze', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ symbol: normalizedSymbol }),
      })
      setQuote(data.quote)
      setAnalysis(data.analysis)
      setNotice(data.warning || '分析已完成并保存')
      await loadHistory()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'AI 分析失败')
    } finally {
      setLoadingAnalysis(false)
    }
  }

  function selectHistoryRecord(record: HistoryRecord) {
    setSymbol(record.symbol)
    setQuote(record.quote)
    setAnalysis(record.analysis)
    setError('')
    setNotice(`已载入 ${record.symbol} 的历史分析`)
  }

  const chartData = quote?.recentPrices.map((point) => ({
    ...point,
    closeLabel: Number(point.close.toFixed(2)),
    shortDate: point.date.slice(5),
  }))

  return (
    <div className="app-shell">
      <header className="app-header">
        <div className="brand-lockup">
          <span className="brand-mark">
            <BarChart3 size={22} strokeWidth={2.4} />
          </span>
          <div>
            <p className="eyebrow">AI Stock Panel</p>
            <h1>AI 股票分析面板</h1>
          </div>
        </div>
        <span className="disclaimer">仅供技术演示，不构成投资建议</span>
      </header>

      <main className="dashboard-grid">
        <section className="panel control-panel">
          <div className="section-title">
            <Search size={18} />
            <h2>股票代码</h2>
          </div>

          <form
            className="symbol-form"
            onSubmit={(event) => {
              event.preventDefault()
              void handleAnalyze()
            }}
          >
            <label htmlFor="symbol">Symbol</label>
            <div className="input-row">
              <input
                id="symbol"
                value={symbol}
                onChange={(event) => setSymbol(event.target.value)}
                placeholder="IBM"
                autoComplete="off"
              />
              <button
                type="button"
                className="icon-button"
                title="刷新行情"
                aria-label="刷新行情"
                onClick={() => void handleFetchQuote()}
                disabled={loadingQuote || loadingAnalysis}
              >
                {loadingQuote ? <Loader2 className="spin" size={18} /> : <RefreshCw size={18} />}
              </button>
            </div>

            <div className="button-row">
              <button
                type="button"
                className="secondary-button"
                onClick={() => void handleFetchQuote()}
                disabled={loadingQuote || loadingAnalysis}
              >
                {loadingQuote ? <Loader2 className="spin" size={17} /> : <Search size={17} />}
                获取行情
              </button>
              <button className="primary-button" disabled={loadingQuote || loadingAnalysis}>
                {loadingAnalysis ? <Loader2 className="spin" size={17} /> : <BrainCircuit size={17} />}
                AI 分析并保存
              </button>
            </div>
          </form>

          {error && (
            <div className="message error-message">
              <AlertTriangle size={17} />
              <span>{error}</span>
            </div>
          )}
          {notice && !error && <div className="message notice-message">{notice}</div>}
        </section>

        <section className="panel quote-panel">
          <div className="section-title spread">
            <div>
              <p className="eyebrow">Market Data</p>
              <h2>{quote ? quote.symbol : normalizedSymbol || 'IBM'}</h2>
            </div>
            <span className={`trend-badge ${trendTone}`}>
              {trendTone === 'negative' ? <TrendingDown size={16} /> : <TrendingUp size={16} />}
              {quote ? formatPercent(quote.changePercent) : '等待数据'}
            </span>
          </div>

          <div className="metric-grid">
            <MetricCard label="最新收盘" value={quote ? formatMoney(quote.close) : '-'} tone={trendTone} />
            <MetricCard label="成交量" value={quote ? formatNumber(quote.volume) : '-'} />
            <MetricCard label="最高价" value={quote ? formatMoney(quote.high) : '-'} />
            <MetricCard label="最低价" value={quote ? formatMoney(quote.low) : '-'} />
          </div>

          <div className="chart-frame">
            {chartData?.length ? (
              <ResponsiveContainer width="100%" height="100%">
                <LineChart data={chartData} margin={{ top: 8, right: 18, bottom: 0, left: 0 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="rgba(99, 116, 139, 0.18)" />
                  <XAxis dataKey="shortDate" tickLine={false} axisLine={false} minTickGap={16} />
                  <YAxis
                    width={54}
                    tickLine={false}
                    axisLine={false}
                    domain={['dataMin', 'dataMax']}
                    tickFormatter={(value) => `$${Number(value).toFixed(0)}`}
                  />
                  <Tooltip
                    formatter={(value) => [formatMoney(Number(value)), '收盘价']}
                    labelFormatter={(label) => `日期 ${label}`}
                  />
                  <Line
                    type="monotone"
                    dataKey="closeLabel"
                    stroke={trendTone === 'positive' ? '#0f9f6e' : '#dc2626'}
                    strokeWidth={2.5}
                    dot={false}
                    activeDot={{ r: 5 }}
                  />
                </LineChart>
              </ResponsiveContainer>
            ) : (
              <div className="empty-state">行情图表将在获取数据后显示</div>
            )}
          </div>
        </section>

        <section className="panel analysis-panel">
          <div className="section-title">
            <BrainCircuit size={18} />
            <h2>AI JSON 分析</h2>
          </div>

          {analysis ? (
            <div className="analysis-content">
              <p>{analysis.summary}</p>
              <div className="badge-row">
                <span className={`pill sentiment-${analysis.sentiment.toLowerCase()}`}>
                  {analysis.sentiment}
                </span>
                <span className={`pill risk-${analysis.risk_level.toLowerCase()}`}>
                  Risk: {analysis.risk_level}
                </span>
              </div>
              <pre>{JSON.stringify(analysis, null, 2)}</pre>
            </div>
          ) : (
            <div className="empty-state">点击 AI 分析后显示严格 JSON 结果</div>
          )}
        </section>

        <section className="panel history-panel">
          <div className="section-title spread">
            <div className="section-title compact">
              <History size={18} />
              <h2>历史记录</h2>
            </div>
            <button
              type="button"
              className="icon-button"
              title="刷新历史记录"
              aria-label="刷新历史记录"
              onClick={() => void loadHistory()}
              disabled={loadingHistory}
            >
              {loadingHistory ? <Loader2 className="spin" size={18} /> : <Database size={18} />}
            </button>
          </div>

          <div className="history-list">
            {history.length ? (
              history.map((record) => (
                <button
                  key={record.id}
                  type="button"
                  className="history-item"
                  onClick={() => selectHistoryRecord(record)}
                >
                  <span>
                    <strong>{record.symbol}</strong>
                    <small>{formatDate(record.created_at)}</small>
                  </span>
                  <span className={`pill sentiment-${record.analysis.sentiment.toLowerCase()}`}>
                    {record.analysis.sentiment}
                  </span>
                </button>
              ))
            ) : (
              <div className="empty-state">暂无历史记录</div>
            )}
          </div>
        </section>
      </main>
    </div>
  )
}

export default App
