# Liquidation Scanner

Real-time Bybit USDT perpetual futures liquidation monitoring system with adaptive baseline detection and multi-phase post-signal reaction analysis.

- **Two WebSocket connections** — liquidation stream + price/ticker stream
- **Sliding window** (3s) liquidation aggregation
- **Adaptive baseline** — 75th percentile over 5min history, warmup mode for sparse markets
- **Spike alerts** via Telegram + Pushover
- **Post-signal reaction analysis** — multi-phase price & OI tracking at +5s, +15s, +60s
- **Confidence scoring** — 0–10 signal strength with WEAK / MEDIUM / STRONG / EXTREME labels
- **Market context** — multi-timeframe price range positioning (5m + 30m)
- **Periodic symbol refresh** — picks up new listings every 10 minutes

---

## Quick Start

```bash
npm install
```

Create `.env` in the project root with your configuration (see Configuration section below), then:

```bash
npm start              # production
npm run dev            # development (with --watch)
```

A **startup greeting** is sent to all configured alert channels before monitoring begins.

---

## Architecture

```
app.js
 ├── symbolService              → fetches/filters symbols from Bybit REST
 ├── liquidationStreamService   → Bybit WebSocket #1: allLiquidation.* topics
 ├── priceStreamService         → Bybit WebSocket #2: ticker.* topics
 │    └── provides snapshots & price ranges for reaction analysis
 ├── liquidationTracker         → sliding windows → percentile baseline → signal detection
 │    ├── PRIMARY ALERT → alertService.sendAlert()
 │    └── startTracking  → signalReactionTracker
 │         ├── +5s  → capture price_5s
 │         ├── +15s → capture price_15s
 │         ├── +60s → capture price_60s + oi_60s
 │         │    ├── classify (STRONG_CONTINUATION | REVERSAL | ABSORPTION | NO_FOLLOW_THROUGH)
 │         │    ├── score  (signalScorer → 0–10 confidence)
 │         │    └── SECONDARY REACTION ALERT → alertService.sendReaction()
 │         └── +90s → auto-cleanup
 └── alertService               → Telegram + Pushover dispatch
```

### Key Modules

| Module | Path | Role |
|---|---|---|
| `liquidationTracker` | `services/liquidationTracker.js` | Sliding window aggregation, percentile baseline, spike detection |
| `liquidationStreamService` | `services/liquidationStreamService.js` | Bybit WebSocket client for liquidation events |
| `priceStreamService` | `services/priceStreamService.js` | Bybit WebSocket client for ticker data (price + OI buffer) |
| `signalReactionTracker` | `services/signalReactionTracker.js` | Post-signal multi-phase price/ΔOI tracking & classification |
| `signalScorer` | `services/signalScorer.js` | 0–10 confidence score: ratio strength, price reaction, OI, market context |
| `alertService` | `services/alertService.js` | Telegram + Pushover dispatch, cooldown throttling |
| `symbolService` | `services/symbolService.js` | REST API: fetch, filter, refresh USDT perpetual symbols |
| `bybitClient` | `services/bybitClient.js` | Shared Bybit REST helpers |
| `utils/median.js` | `utils/median.js` | `median()` and `getPercentile()` (nearest-rank method) |
| `utils/formatters.js` | `utils/formatters.js` | `formatUSD()` |

---

## Primary Alert

Sent immediately when a liquidation spike crosses detection thresholds.

```
📊 Symbol: BTCUSDT
📉 Type: LONG LIQUIDATIONS 🟢
💰 Size (3s): $1.20M
📏 Baseline: $450k
📈 Ratio: 2.7x
⚠️ Warmup mode (limited history)

🔗 Bybit: https://www.bybit.com/trade/usdt/BTCUSDT
🔗 Coinglass: https://www.coinglass.com/tv/BTCUSDT
```

The ⚠️ warmup line appears only during the first 50 windows (~4 minutes of 5s intervals) when the percentile baseline hasn't stabilized yet.

---

## Secondary Reaction Alert

Arrives **~60 seconds after** the primary alert. It answers: *did the market follow through, reverse, or absorb the liquidation event?*

### Example Output

```
📊 BTCUSDT SHORT LIQUIDATION CASCADE 🔴 (4.2x) (merged x2)

Δ5s:  +0.38%
Δ15s: +0.21%
Δ60s: +0.44%
ΔOI:  +2.30% 🟢 entering

Position 5m: 0.85
Position 30m: 0.72
→ Strong resistance (multi-timeframe)

→ STRONG CONTINUATION
→ market continued liquidation direction
→ momentum remains strong

Confidence: 8/10 (STRONG)
```

### Line-by-line Breakdown

#### Header: `📊 BTCUSDT SHORT LIQUIDATION CASCADE 🔴 (4.2x)`

| Part | Meaning |
|---|---|
| `BTCUSDT` | The symbol |
| `LONG SQUEEZE 🟢` | Short positions were forcibly liquidated → buying pressure pushed price up |
| `SHORT LIQUIDATION CASCADE 🔴` | Longs got liquidated → selling pressure pushed price down |
| `(4.2x)` | The original spike was 4.2× the percentile baseline |
| `(merged x2)` | Optional. Two consecutive liquidation waves merged into one analysis |

#### Price Deltas: `Δ5s`, `Δ15s`, `Δ60s`

Percentage price changes over **three sequential time windows**, starting from signal time. These are **sequential, not cumulative** — each shows the change within its own window.

```
Δ5s:  +0.38%    ← seconds 0–5  (immediate reaction)
Δ15s: +0.21%    ← seconds 5–15 (follow-through)
Δ60s: +0.44%    ← seconds 15–60 (sustained move)
```

#### Open Interest: `ΔOI: +2.30% 🟢 entering`

Change in Open Interest from signal time to 60 seconds later.

| ΔOI | Label | Meaning |
|---|---|---|
| ΔOI > +0.2% | 🟢 entering | Fresh capital entering — the move is fueled by conviction |
| ΔOI < −0.2% | 🔴 closing | Traders are closing — move may be short-lived |
| −0.2% ≤ ΔOI ≤ +0.2% | (unchanged) | No meaningful OI change |

#### Market Context: `Position 5m / 30m`

Shows where current price sits within the 5-minute and 30-minute high-low ranges (0 = low, 1 = high). Context labels indicate multi-timeframe alignment:

- **Strong resistance/support** — both 5m and 30m near same extreme
- **Local high/low, no HTF** — only 5m at extreme, 30m mid-range
- **Range expansion / conflicting** — one TF near high, other near low

---

## Classification Reference

Every reaction is classified into one of four categories. Each produces a **3-line human-readable block** in the alert:

### 🟢 STRONG CONTINUATION

```
→ STRONG CONTINUATION
→ market continued liquidation direction
→ momentum remains strong
```

**Conditions:** ΔP5 ≥ +0.25%  ∧  ΔP15 ≥ +0.15%  ∧  ΔP60 ≥ +0.3%

Liquidation triggered a sustained directional move. **Highest conviction.**

### 🔴 REVERSAL

```
→ REVERSAL
→ market rejected liquidation direction
→ reversal pressure detected
```

**Conditions:** ΔP5 ≥ +0.25%  ∧  ΔP15 ≤ −0.15%  ∧  ΔP60 ≤ −0.2%

Price spiked initially but **completely reversed**. The market absorbed the liquidation and pushed the other way.

### 🟡 ABSORPTION

```
→ ABSORPTION
→ liquidation was absorbed by market
→ low directional follow-through
```

**Conditions:** ΔP5 ≥ +0.25%  ∧  |ΔP15| < 0.1%  ∧  |ΔP60| < 0.1%

Price moved initially, then **flattened**. Market absorbed with no lasting impact.

### ⚪ NO FOLLOW-THROUGH

```
→ NO FOLLOW-THROUGH
→ liquidation had weak market impact
→ momentum faded quickly
```

**Conditions:** Everything else — no clean pattern.

Liquidation occurred but the market did not meaningfully react. Low momentum environment.

---

## Confidence Scoring

Each reaction is scored **0–10** using a weighted model:

| Factor | Max Points | Criteria |
|---|---|---|
| **Liquidation strength** | +3 | ratio ≥ 8 → +3, ≥ 6 → +2, ≥ 4 → +1 |
| **Price reaction** | +5 | ΔP magnitude across the 3 phases (varies by classification) |
| **Open Interest** | +1 | ΔOI > +1% → +1 |
| **Market context** | +2 | Both TFs aligned at extreme → +2 |
| **Context conflict** | −1 | TFs diverging (one high, one low) → −1 |
| **Low data coverage** | −1 | Either TF < 50% coverage → −1 |
| **Small absolute size** | −1 | L_now < 2× absThreshold → −1 |

| Score Range | Label |
|---|---|
| 9–10 | EXTREME |
| 7–8 | STRONG |
| 4–6 | MEDIUM |
| 0–3 | WEAK |

---

## Adaptive Baseline

The baseline is the **75th percentile** of liquidation volumes over the 5-minute history window (nearest-rank method). This makes the system robust against skewed distributions — a few outlier windows won't inflate the baseline.

### Warmup Mode

When fewer than 50 history windows exist (~4 minutes after startup), the system uses `minBaseline` as a floor value. This prevents false negatives in sparse markets. Alerts during warmup include a `⚠️ Warmup mode` notice.

```
baseline = max(75th_percentile(history), minBaseline)   // normal operation
baseline = minBaseline                                     // warmup (< 50 windows)
```

### Alert Trigger Logic

An alert fires when ALL of these conditions are met:

1. **L_now ≥ absThreshold** — volume crosses the absolute floor
2. **L_now ≥ baseline × ratio** — volume is ratio× above the percentile baseline
3. **Previous window was below threshold** — prevents repeat alerts for the same spike

---

## Configuration

All settings via `.env` file:

### REST API & Symbol Filtering

| Variable | Default | Description |
|---|---|---|
| `BYBIT_BASE_URL` | `https://api.bybit.com` | Bybit REST API base URL |
| `FETCH_INTERVAL_MS` | `600000` | Symbol refresh interval (10 min) |
| `FILTER_VOLUME_THRESHOLD` | `30000000` | Min 24h volume (USD) for symbol inclusion |
| `FILTER_OI_THRESHOLD` | `10000000` | Min open interest (USD) for symbol inclusion |

### WebSocket

| Variable | Default | Description |
|---|---|---|
| `BYBIT_WS_URL` | `wss://stream.bybit.com/v5/public/linear` | Liquidation WebSocket endpoint |
| `PRICE_WS_URL` | `wss://stream.bybit.com/v5/public/linear` | Ticker WebSocket endpoint |
| `WS_RECONNECT_DELAY` | `5000` | Reconnect delay in ms |
| `WS_PING_INTERVAL_MS` | `20000` | Ping interval for keepalive |
| `PRICE_BUFFER_MAX_AGE_MS` | `1800000` | Max age of price snapshots in buffer (30 min) |
| `PRICE_THROTTLE_MS` | `1000` | Min interval between ticker updates per symbol |

### Windows & Timing

| Variable | Default | Description |
|---|---|---|
| `BUFFER_DURATION_MS` | `20000` | Event buffer size in ms |
| `WINDOW_SIZE_MS` | `3000` | Sliding window size (3s) |
| `WINDOW_TICK_MS` | `500` | Tick interval for window calculation |
| `HISTORY_DURATION_MS` | `300000` | Baseline history window (5 min) |
| `MIN_HISTORY_WINDOWS` | `50` | Windows required before percentile baseline activates |

### Market Context

| Variable | Default | Description |
|---|---|---|
| `CONTEXT_SHORT_RANGE_MS` | `300000` | Short-range window for price context (5 min) |
| `CONTEXT_MID_RANGE_MS` | `1800000` | Mid-range window for price context (30 min) |
| `CONTEXT_MIN_COVERAGE` | `0.5` | Minimum data coverage ratio (0–1) for reliable context |

### Alerting

| Variable | Default | Description |
|---|---|---|
| `ALERT_COOLDOWN_MS` | `10000` | Cooldown between alerts per symbol+side |
| `TELEGRAM_BOT_TOKEN` | — | Telegram Bot API token (from @BotFather) |
| `TELEGRAM_CHAT_ID` | — | Telegram chat ID to send alerts to |
| `PUSHOVER_USER_KEY` | — | Pushover user key |
| `PUSHOVER_APP_TOKEN` | — | Pushover application token |
| `LOG_LEVEL` | `info` | Logging level (debug/info/warn/error) |

### Reaction Classification Thresholds

| Variable | Default | Description |
|---|---|---|
| `REACTION_DP5_STRONG` | `0.25` | ΔP5 threshold for strong initial move (%) |
| `REACTION_DP15_CONTINUATION` | `0.15` | ΔP15 threshold for continuation (%) |
| `REACTION_DP15_REVERSAL` | `-0.15` | ΔP15 threshold for reversal (%) |
| `REACTION_DP60_CONTINUATION` | `0.3` | ΔP60 threshold for continuation (%) |
| `REACTION_DP60_REVERSAL` | `-0.2` | ΔP60 threshold for reversal (%) |
| `REACTION_ABSORPTION_MAX` | `0.1` | Maximum absolute ΔP for absorption classification (%) |
| `REACTION_MERGE_WINDOW_MS` | `10000` | Merge window for cascading signals |
| `REACTION_MAX_ACTIVE_SIGNALS` | `3` | Max concurrent signals per symbol+side |

### Per-Symbol Thresholds: `THRESHOLD_CONFIG`

JSON object with per-symbol overrides. Each entry has:

- **`minBaseline`** — floor value used during warmup and as minimum baseline
- **`absThreshold`** — minimum 3s window volume to trigger a check
- **`ratio`** — multiplier over baseline required to fire an alert

```json
{
  "BTCUSDT": { "minBaseline": 150000, "absThreshold": 800000, "ratio": 3 },
  "ETHUSDT": { "minBaseline": 80000, "absThreshold": 400000, "ratio": 3 },
  "SOLUSDT": { "minBaseline": 50000, "absThreshold": 200000, "ratio": 3 },
  "default":  { "minBaseline": 30000, "absThreshold": 100000, "ratio": 4 }
}
```

Symbols not listed fall back to the `"default"` entry.

---

## How to Act On Signals

| Classification + Context | Interpretation | Action |
|---|---|---|
| **STRONG CONTINUATION + OI up** | Trend with fresh positions entering. Self-reinforcing cascade. | **Follow the direction** |
| **STRONG CONTINUATION + OI down** | Price moving but positions closing — possibly the last gasp. | **Caution** |
| **REVERSAL** | Market rejected the liquidation-driven move. The initial spike was a trap. | **Fade the move** |
| **ABSORPTION** | Liquidation happened, market doesn't care. No edge. | **Stand aside** |
| **NO FOLLOW-THROUGH** | Weak market impact. Momentum faded quickly. | **Stand aside** |

> **Always check market context.** A STRONG CONTINUATION near multi-timeframe support/resistance carries higher conviction than one in mid-range.

---

## The Merged Signal Tag

When two or more liquidation spikes for the same symbol+side arrive within 10 seconds, they are merged into a single reaction track:

- `L_now` (total volume) is summed across all merged signals
- `ratio` shows the **peak** value
- Price deltas are computed from the **first** signal's timestamp
- `(merged x2)` tag indicates a cascade, not a single isolated event

---

## Timeline

```
TIME 0s     → PRIMARY ALERT:    "BTCUSDT LONG LIQUIDATIONS, $1.2M, 2.7x"
TIME 0–5s   → Δ5s  measured
TIME 5–15s  → Δ15s measured
TIME 15–60s → Δ60s + ΔOI measured
TIME 60s    → SECONDARY ALERT:  "→ STRONG CONTINUATION | Confidence: 8/10 (STRONG)"
TIME 90s    → Signal cleaned from memory
```

The primary alert tells you **that** something happened. The secondary alert tells you **what it meant** and **how confident** the system is.

---

## Dependencies

- **Node.js** ≥ 18
- [ws](https://github.com/websockets/ws) — WebSocket client
- [winston](https://github.com/winstonjs/winston) — structured logging
- [dotenv](https://github.com/motdotla/dotenv) — environment variable loading
- [node-telegram-bot-api](https://github.com/yagop/node-telegram-bot-api) — Telegram Bot API

---

## License

MIT