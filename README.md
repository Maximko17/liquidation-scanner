# Liquidation Scanner

Real-time Bybit USDT perpetual futures liquidation monitoring system.

- **Single WebSocket connection** to Bybit v5 public stream
- **Sliding window** (3s) liquidation aggregation
- **Baseline detection** (median of 5-minute history)
- **Spike alerts** via Telegram + Pushover
- **Post-signal reaction analysis** (multi-phase price & OI tracking)

---

## Primary Alert

Sent immediately when a liquidation spike is detected.

```
📊 Symbol: BTCUSDT
📉 Type: LONG LIQUIDATIONS 🟢
💰 Size (3s): $1.20M
📏 Baseline: $300k
📈 Ratio: 4.0x

🔗 Bybit: https://www.bybit.com/trade/usdt/BTCUSDT
🔗 Coinglass: https://www.coinglass.com/tv/BTCUSDT
```

---

## Post-Signal Reaction Alert (Secondary)

Arrives **~60 seconds after** the primary alert. It answers: *did the market follow through, reverse, or ignore the liquidation event?*

### Anatomy of the Alert

```
📊 BTCUSDT LONG SQUEEZE 🟢 (4.2x) (merged x2)

Δ5s:  +0.38%
Δ15s: +0.21%
Δ60s: +0.44%
ΔOI:  +2.30%

→ STRONG_CONTINUATION
🟢 OI: new positions entering
```

### Line-by-line Breakdown

#### Header: `📊 BTCUSDT LONG SQUEEZE 🟢 (4.2x)`

| Part | Meaning |
|---|---|
| `BTCUSDT` | The symbol |
| `LONG SQUEEZE 🟢` | Short positions were forcibly liquidated → buying pressure pushed price up |
| `SHORT LIQUIDATION CASCADE 🔴` | (alternative) Longs got liquidated → selling pressure pushed price down |
| `(4.2x)` | The original spike was 4.2× the median baseline (context from primary alert) |
| `(merged x2)` | Optional. Two consecutive liquidation waves merged into one analysis |

#### Price Deltas: `Δ5s`, `Δ15s`, `Δ60s`

Percentage price changes over **three sequential time windows**, starting from signal time. These are **sequential, not cumulative** — each shows the change within its own window.

```
Δ5s:  +0.38%    ← seconds 0–5  (immediate reaction)
Δ15s: +0.21%    ← seconds 5–15 (follow-through)
Δ60s: +0.44%    ← seconds 15–60 (sustained move)
```

**For a LONG SQUEEZE 🟢 (price should rise):**

- **Δ5s ≥ +0.25%** → market noticed the liquidations
- **Δ15s positive** → momentum is continuing
- **Δ60s ≥ +0.3%** → trend stuck — strong continuation

**For a SHORT LIQUIDATION CASCADE 🔴 (price should fall):** signs are negative — a strong move is ≤ −0.25%, continuation ≤ −0.15%, etc.

#### Open Interest: `ΔOI: +2.30%`

Change in Open Interest from signal time to 60 seconds later.

| ΔOI | Indicator | Meaning |
|---|---|---|
| `🟢 OI: new positions entering` | ΔOI > +0.5% | Fresh capital entering — the move is fueled by conviction |
| `🔴 OI: positions closing` | ΔOI < −0.5% | Traders are closing — move may be short-lived |
| `⚪ OI: unchanged` | ΔOI within ±0.5% | No meaningful OI change |

### Classification

The machine classifies every signal into one of four categories:

| Classification | Delta Conditions | Meaning |
|---|---|---|
| **STRONG_CONTINUATION** | ΔP5 ≥ +0.25% ∧ ΔP15 ≥ +0.15% ∧ ΔP60 ≥ +0.3% | Liquidation triggered a sustained directional move. **Highest conviction.** |
| **REVERSAL** | ΔP5 ≥ +0.25% ∧ ΔP15 ≤ −0.15% ∧ ΔP60 ≤ −0.2% | Price spiked initially but **completely reversed**. The market absorbed the liquidation and pushed the other way. |
| **ABSORPTION** | ΔP5 ≥ +0.25% ∧ \|ΔP15\| < 0.1% ∧ \|ΔP60\| < 0.1% | Price moved initially, then **flattened**. Market absorbed with no lasting impact. |
| **IGNORE** | Everything else | No clean pattern — noise. |

### How to Act On It

| Classification + OI | Interpretation | Trading Signal |
|---|---|---|
| **STRONG_CONTINUATION + OI up** | Mass liquidation triggered a trend with fresh positions entering. Self-reinforcing cascade. | **Follow the direction** |
| **STRONG_CONTINUATION + OI down** | Price moving but positions closing — possibly the last gasp. Weaker conviction. | **Caution** |
| **REVERSAL + any OI** | Market rejected the liquidation-driven move within 15 seconds. The initial spike was a trap. | **Fade the move** |
| **ABSORPTION + any OI** | Liquidation happened, market doesn't care. No edge. | **Ignore** |
| **IGNORE** | No clean signal. | **Ignore** |

### The "merged x2" Tag

When two or more liquidation spikes for the same symbol+side arrive within 10 seconds, they are merged into a single reaction track:

- `L_now` (total volume) is summed across all merged signals
- `ratio` shows the **peak** value
- Price deltas are computed from the **first** signal's timestamp
- The merge tag tells you this was a cascade, not a single isolated event

### Timeline

```
TIME 0s     → PRIMARY ALERT:    "BTCUSDT LONG LIQUIDATIONS, $1.2M, 4.2x"
TIME 0–5s   → Δ5s  measured
TIME 5–15s  → Δ15s measured
TIME 15–60s → Δ60s + ΔOI measured
TIME 60s    → SECONDARY ALERT:  "→ STRONG_CONTINUATION"
TIME 90s    → Signal cleaned from memory
```

The primary alert tells you **that** something happened. The secondary alert tells you **what it meant**.

---

## Configuration

Copy `.env.example` → `.env` and configure:

| Variable | Description |
|---|---|
| `FILTER_VOLUME_THRESHOLD` | Min 24h volume (USD) for symbol inclusion |
| `FILTER_OI_THRESHOLD` | Min open interest (USD) for symbol inclusion |
| `TELEGRAM_BOT_TOKEN` | Telegram Bot API token (from @BotFather) |
| `TELEGRAM_CHAT_ID` | Telegram chat ID to send alerts to |
| `PUSHOVER_USER_KEY` | Pushover user key |
| `PUSHOVER_APP_TOKEN` | Pushover application token |
| `THRESHOLD_CONFIG` | JSON: per-symbol `{ minBaseline, absThreshold, ratio }` |
| `REACTION_DP5_STRONG` | ΔP5 threshold for strong move (default 0.25) |
| `REACTION_MERGE_WINDOW_MS` | Merge window for cascading signals (default 10000) |
| `REACTION_MAX_ACTIVE_SIGNALS` | Max concurrent signals per symbol+side (default 3) |

### Threshold Config Example

```json
{
  "BTCUSDT": { "minBaseline": 300000, "absThreshold": 1000000, "ratio": 3 },
  "ETHUSDT": { "minBaseline": 150000, "absThreshold": 600000, "ratio": 3.5 },
  "SOLUSDT": { "minBaseline": 100000, "absThreshold": 300000, "ratio": 4 },
  "default":  { "minBaseline": 100000, "absThreshold": 300000, "ratio": 4 }
}
```

---

## Quick Start

```bash
npm install
cp .env.example .env   # edit with your tokens
npm start              # or npm run dev (with --watch)
```

---

## Architecture

```
app.js
 ├── symbolService         → fetches/filters symbols from REST
 ├── wsClient (WebSocket)  → single connection, batch subscribe
 │    └── allLiquidation.* topics
 ├── liquidationTracker    → sliding window, baseline, signal detection
 │    ├── PRIMARY ALERT → alertService.sendAlert()
 │    └── startTracking  → signalReactionTracker
 │         ├── +5s  → capture price_5s
 │         ├── +15s → capture price_15s
 │         ├── +60s → capture price_60s + oi_60s
 │         │    └── classify → SECONDARY ALERT → alertService.sendReaction()
 │         └── +90s → auto-cleanup
 └── alertService          → Telegram + Pushover dispatch
```

---

## License

MIT