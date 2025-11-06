const express = require('express');
const axios = require('axios');
const TelegramBot = require('node-telegram-bot-api');

const app = express();
app.use(express.json());

// Configuration
const CONFIG = {
  TELEGRAM_BOT_TOKEN: process.env.TELEGRAM_BOT_TOKEN,
  TELEGRAM_CHAT_ID: process.env.TELEGRAM_CHAT_ID,
  CHECK_INTERVAL: 5000, // 5 seconds
  MIN_VOLUME_INCREASE: 150, // 150% volume increase threshold
  MIN_PRICE_INCREASE: 2, // 2% price increase in short timeframe
  LOOKBACK_PERIOD: 60000, // 1 minute lookback
  MIN_24H_VOLUME_USDT: 100000, // Minimum 24h volume to filter low liquidity
  ORDER_BOOK_IMBALANCE_THRESHOLD: 1.5, // Buy/Sell ratio threshold
  TRADE_VELOCITY_THRESHOLD: 2.5, // Trade frequency multiplier
};

let bot;
if (CONFIG.TELEGRAM_BOT_TOKEN) {
  bot = new TelegramBot(CONFIG.TELEGRAM_BOT_TOKEN, { polling: false });
}

// Store historical data
const priceHistory = new Map();
const volumeHistory = new Map();
const alertedCoins = new Set();
const recentTrades = new Map();

class PumpDetector {
  constructor() {
    this.isRunning = false;
    this.symbols = [];
    this.lastCheck = Date.now();
  }

  async initialize() {
    await this.updateSymbolList();
  }

  async updateSymbolList() {
    try {
      const response = await axios.get('https://api.binance.com/api/v3/exchangeInfo');
      this.symbols = response.data.symbols
        .filter(s => s.status === 'TRADING' && s.quoteAsset === 'USDT')
        .map(s => s.symbol);
      console.log(`Monitoring ${this.symbols.length} USDT pairs`);
    } catch (error) {
      console.error('Error fetching symbol list:', error.message);
    }
  }

  async getTickerData() {
    try {
      const response = await axios.get('https://api.binance.com/api/v3/ticker/24hr');
      return response.data.filter(ticker =>
        ticker.symbol.endsWith('USDT') &&
        parseFloat(ticker.quoteVolume) > CONFIG.MIN_24H_VOLUME_USDT
      );
    } catch (error) {
      console.error('Error fetching ticker data:', error.message);
      return [];
    }
  }

  async getOrderBook(symbol) {
    try {
      const response = await axios.get(`https://api.binance.com/api/v3/depth`, {
        params: { symbol, limit: 20 }
      });
      return response.data;
    } catch (error) {
      return null;
    }
  }

  async getRecentTrades(symbol) {
    try {
      const response = await axios.get(`https://api.binance.com/api/v3/trades`, {
        params: { symbol, limit: 100 }
      });
      return response.data;
    } catch (error) {
      return null;
    }
  }

  calculateOrderBookImbalance(orderBook) {
    if (!orderBook || !orderBook.bids || !orderBook.asks) return 0;

    const bidVolume = orderBook.bids.slice(0, 10).reduce((sum, [price, qty]) =>
      sum + parseFloat(price) * parseFloat(qty), 0
    );
    const askVolume = orderBook.asks.slice(0, 10).reduce((sum, [price, qty]) =>
      sum + parseFloat(price) * parseFloat(qty), 0
    );

    return askVolume > 0 ? bidVolume / askVolume : 0;
  }

  calculateTradeVelocity(trades) {
    if (!trades || trades.length < 2) return 0;

    const now = Date.now();
    const recentTrades = trades.filter(t => now - t.time < 60000); // Last 1 minute
    const olderTrades = trades.filter(t =>
      now - t.time >= 60000 && now - t.time < 120000
    );

    const recentCount = recentTrades.length;
    const olderCount = olderTrades.length || 1;

    return recentCount / olderCount;
  }

  analyzeBuyPressure(trades) {
    if (!trades || trades.length === 0) return 0;

    const buyVolume = trades
      .filter(t => t.isBuyerMaker === false)
      .reduce((sum, t) => sum + parseFloat(t.qty) * parseFloat(t.price), 0);

    const sellVolume = trades
      .filter(t => t.isBuyerMaker === true)
      .reduce((sum, t) => sum + parseFloat(t.qty) * parseFloat(t.price), 0);

    const totalVolume = buyVolume + sellVolume;
    return totalVolume > 0 ? (buyVolume / totalVolume) * 100 : 0;
  }

  async detectPump(ticker) {
    const symbol = ticker.symbol;
    const currentPrice = parseFloat(ticker.lastPrice);
    const currentVolume = parseFloat(ticker.volume);
    const priceChangePercent = parseFloat(ticker.priceChangePercent);

    // Skip if already alerted recently (within 15 minutes)
    if (alertedCoins.has(symbol)) {
      const alertTime = alertedCoins.get(symbol);
      if (Date.now() - alertTime < 900000) return null;
      alertedCoins.delete(symbol);
    }

    // Initialize historical data
    if (!priceHistory.has(symbol)) {
      priceHistory.set(symbol, []);
      volumeHistory.set(symbol, []);
    }

    const prices = priceHistory.get(symbol);
    const volumes = volumeHistory.get(symbol);

    // Store current data
    prices.push({ price: currentPrice, time: Date.now() });
    volumes.push({ volume: currentVolume, time: Date.now() });

    // Keep only recent data (last 5 minutes)
    const fiveMinutesAgo = Date.now() - 300000;
    priceHistory.set(symbol, prices.filter(p => p.time > fiveMinutesAgo));
    volumeHistory.set(symbol, volumes.filter(v => v.time > fiveMinutesAgo));

    // Need at least 10 data points for analysis
    if (prices.length < 10) return null;

    // Calculate short-term metrics
    const recentPrices = prices.slice(-5);
    const olderPrices = prices.slice(-10, -5);

    const recentAvg = recentPrices.reduce((sum, p) => sum + p.price, 0) / recentPrices.length;
    const olderAvg = olderPrices.reduce((sum, p) => sum + p.price, 0) / olderPrices.length;

    const shortTermPriceIncrease = ((recentAvg - olderAvg) / olderAvg) * 100;

    // Volume spike detection
    const recentVolumes = volumes.slice(-3);
    const olderVolumes = volumes.slice(-10, -3);

    const recentVolAvg = recentVolumes.reduce((sum, v) => sum + v.volume, 0) / recentVolumes.length;
    const olderVolAvg = olderVolumes.reduce((sum, v) => sum + v.volume, 0) / olderVolumes.length;

    const volumeIncreasePercent = olderVolAvg > 0 ? ((recentVolAvg - olderVolAvg) / olderVolAvg) * 100 : 0;

    // Advanced analysis: Order book and trade analysis
    const [orderBook, trades] = await Promise.all([
      this.getOrderBook(symbol),
      this.getRecentTrades(symbol)
    ]);

    const orderBookImbalance = this.calculateOrderBookImbalance(orderBook);
    const tradeVelocity = this.calculateTradeVelocity(trades);
    const buyPressure = this.analyzeBuyPressure(trades);

    // Multi-factor scoring system
    let pumpScore = 0;
    const signals = [];

    // Price momentum (0-30 points)
    if (shortTermPriceIncrease > CONFIG.MIN_PRICE_INCREASE) {
      pumpScore += Math.min(shortTermPriceIncrease * 5, 30);
      signals.push(`Price surge: +${shortTermPriceIncrease.toFixed(2)}%`);
    }

    // Volume spike (0-25 points)
    if (volumeIncreasePercent > CONFIG.MIN_VOLUME_INCREASE) {
      pumpScore += Math.min(volumeIncreasePercent / 10, 25);
      signals.push(`Volume spike: +${volumeIncreasePercent.toFixed(0)}%`);
    }

    // Order book imbalance (0-20 points)
    if (orderBookImbalance > CONFIG.ORDER_BOOK_IMBALANCE_THRESHOLD) {
      pumpScore += Math.min((orderBookImbalance - 1) * 10, 20);
      signals.push(`Order book: ${orderBookImbalance.toFixed(2)}x buy pressure`);
    }

    // Trade velocity (0-15 points)
    if (tradeVelocity > CONFIG.TRADE_VELOCITY_THRESHOLD) {
      pumpScore += Math.min((tradeVelocity - 1) * 7.5, 15);
      signals.push(`Trade velocity: ${tradeVelocity.toFixed(2)}x increase`);
    }

    // Buy pressure (0-10 points)
    if (buyPressure > 60) {
      pumpScore += Math.min((buyPressure - 50) / 5, 10);
      signals.push(`Buy pressure: ${buyPressure.toFixed(1)}%`);
    }

    // Pump detected if score > 50
    if (pumpScore > 50) {
      alertedCoins.set(symbol, Date.now());

      return {
        symbol,
        currentPrice,
        priceChangePercent,
        shortTermPriceIncrease,
        volumeIncreasePercent,
        orderBookImbalance,
        tradeVelocity,
        buyPressure,
        pumpScore: pumpScore.toFixed(1),
        signals,
        timestamp: new Date().toISOString()
      };
    }

    return null;
  }

  async sendTelegramAlert(pumpData) {
    if (!bot || !CONFIG.TELEGRAM_CHAT_ID) {
      console.log('Telegram not configured, skipping alert');
      return;
    }

    const message = `
🚀 *PUMP DETECTED - EARLY SIGNAL* 🚀

💎 *Coin:* ${pumpData.symbol}
💰 *Current Price:* $${pumpData.currentPrice}
📊 *24h Change:* ${pumpData.priceChangePercent}%

🔥 *Pump Score:* ${pumpData.pumpScore}/100

*Detection Signals:*
${pumpData.signals.map(s => `✓ ${s}`).join('\n')}

⏰ *Time:* ${new Date(pumpData.timestamp).toLocaleString()}

📈 *Binance Link:* https://www.binance.com/en/trade/${pumpData.symbol}

⚡ *Action:* This coin is showing early pump signals. Consider monitoring closely or entering a position based on your strategy.

⚠️ *Risk Warning:* Always DYOR and use proper risk management. This is not financial advice.
`;

    try {
      await bot.sendMessage(CONFIG.TELEGRAM_CHAT_ID, message, { parse_mode: 'Markdown' });
      console.log(`✅ Alert sent for ${pumpData.symbol}`);
    } catch (error) {
      console.error('Error sending Telegram message:', error.message);
    }
  }

  async scan() {
    const tickers = await this.getTickerData();

    console.log(`Scanning ${tickers.length} coins... [${new Date().toLocaleTimeString()}]`);

    const detectionPromises = tickers.map(ticker => this.detectPump(ticker));
    const results = await Promise.all(detectionPromises);

    const pumps = results.filter(r => r !== null);

    for (const pump of pumps) {
      console.log('\n🚨 PUMP DETECTED:', pump.symbol);
      console.log('   Score:', pump.pumpScore);
      console.log('   Signals:', pump.signals.join(', '));
      await this.sendTelegramAlert(pump);
    }

    if (pumps.length === 0) {
      console.log('   No pumps detected in this scan');
    }
  }

  async start() {
    if (this.isRunning) return;

    this.isRunning = true;
    console.log('🔍 Binance Pump Detector Started');
    console.log('⏱️  Scan interval:', CONFIG.CHECK_INTERVAL / 1000, 'seconds');

    await this.initialize();

    // Initial scan
    await this.scan();

    // Continuous scanning
    this.interval = setInterval(async () => {
      if (this.isRunning) {
        await this.scan();
      }
    }, CONFIG.CHECK_INTERVAL);
  }

  stop() {
    this.isRunning = false;
    if (this.interval) {
      clearInterval(this.interval);
    }
    console.log('🛑 Pump Detector Stopped');
  }
}

// Create detector instance
const detector = new PumpDetector();

// API Endpoints
app.get('/', (req, res) => {
  res.send(`
    <!DOCTYPE html>
    <html lang="en">
    <head>
      <meta charset="UTF-8">
      <meta name="viewport" content="width=device-width, initial-scale=1.0">
      <title>Binance Pump Detector</title>
      <style>
        * { margin: 0; padding: 0; box-sizing: border-box; }
        body {
          font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
          background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
          min-height: 100vh;
          display: flex;
          align-items: center;
          justify-content: center;
          padding: 20px;
        }
        .container {
          background: white;
          border-radius: 20px;
          padding: 40px;
          max-width: 800px;
          width: 100%;
          box-shadow: 0 20px 60px rgba(0,0,0,0.3);
        }
        h1 {
          color: #333;
          margin-bottom: 10px;
          font-size: 2.5em;
        }
        .subtitle {
          color: #666;
          margin-bottom: 30px;
          font-size: 1.1em;
        }
        .status {
          display: inline-block;
          padding: 10px 20px;
          border-radius: 50px;
          font-weight: bold;
          margin: 20px 0;
        }
        .status.active {
          background: #10b981;
          color: white;
        }
        .status.inactive {
          background: #ef4444;
          color: white;
        }
        .features {
          margin: 30px 0;
        }
        .feature {
          display: flex;
          align-items: center;
          margin: 15px 0;
          padding: 15px;
          background: #f9fafb;
          border-radius: 10px;
        }
        .feature-icon {
          font-size: 24px;
          margin-right: 15px;
        }
        .feature-text {
          color: #333;
        }
        .config-section {
          margin: 30px 0;
          padding: 20px;
          background: #f0f9ff;
          border-radius: 10px;
          border-left: 4px solid #3b82f6;
        }
        .config-title {
          font-weight: bold;
          color: #1e40af;
          margin-bottom: 10px;
        }
        .config-item {
          color: #334155;
          margin: 5px 0;
          font-family: 'Courier New', monospace;
          font-size: 0.9em;
        }
        .buttons {
          display: flex;
          gap: 15px;
          margin-top: 30px;
        }
        button {
          flex: 1;
          padding: 15px;
          font-size: 1.1em;
          font-weight: bold;
          border: none;
          border-radius: 10px;
          cursor: pointer;
          transition: transform 0.2s, box-shadow 0.2s;
        }
        button:hover {
          transform: translateY(-2px);
          box-shadow: 0 4px 12px rgba(0,0,0,0.2);
        }
        .btn-start {
          background: #10b981;
          color: white;
        }
        .btn-stop {
          background: #ef4444;
          color: white;
        }
        .btn-status {
          background: #3b82f6;
          color: white;
        }
        .alert {
          padding: 15px;
          margin-top: 20px;
          border-radius: 10px;
          display: none;
        }
        .alert.success {
          background: #d1fae5;
          color: #065f46;
          border: 1px solid #10b981;
        }
        .alert.error {
          background: #fee2e2;
          color: #991b1b;
          border: 1px solid #ef4444;
        }
      </style>
    </head>
    <body>
      <div class="container">
        <h1>🚀 Binance Pump Detector</h1>
        <p class="subtitle">Advanced early pump signal detection system</p>

        <div id="statusBadge" class="status inactive">⏸️ Stopped</div>

        <div class="features">
          <div class="feature">
            <span class="feature-icon">⚡</span>
            <span class="feature-text">Real-time monitoring of all USDT pairs on Binance</span>
          </div>
          <div class="feature">
            <span class="feature-icon">🧠</span>
            <span class="feature-text">Multi-factor analysis: Volume, Price, Order Book, Trade Velocity</span>
          </div>
          <div class="feature">
            <span class="feature-icon">📱</span>
            <span class="feature-text">Instant Telegram notifications for pump signals</span>
          </div>
          <div class="feature">
            <span class="feature-icon">🎯</span>
            <span class="feature-text">Detects pumps BEFORE they appear on Top Gainers</span>
          </div>
        </div>

        <div class="config-section">
          <div class="config-title">⚙️ Current Configuration</div>
          <div class="config-item">Scan Interval: ${CONFIG.CHECK_INTERVAL / 1000}s</div>
          <div class="config-item">Min Volume Increase: ${CONFIG.MIN_VOLUME_INCREASE}%</div>
          <div class="config-item">Min Price Increase: ${CONFIG.MIN_PRICE_INCREASE}%</div>
          <div class="config-item">Order Book Threshold: ${CONFIG.ORDER_BOOK_IMBALANCE_THRESHOLD}x</div>
          <div class="config-item">Telegram: ${CONFIG.TELEGRAM_BOT_TOKEN ? '✅ Configured' : '❌ Not Configured'}</div>
        </div>

        <div class="buttons">
          <button class="btn-start" onclick="startDetector()">▶️ Start Detector</button>
          <button class="btn-stop" onclick="stopDetector()">⏹️ Stop Detector</button>
          <button class="btn-status" onclick="checkStatus()">📊 Check Status</button>
        </div>

        <div id="alert" class="alert"></div>
      </div>

      <script>
        async function startDetector() {
          try {
            const response = await fetch('/api/start', { method: 'POST' });
            const data = await response.json();
            showAlert(data.message, 'success');
            updateStatus(true);
          } catch (error) {
            showAlert('Error starting detector: ' + error.message, 'error');
          }
        }

        async function stopDetector() {
          try {
            const response = await fetch('/api/stop', { method: 'POST' });
            const data = await response.json();
            showAlert(data.message, 'success');
            updateStatus(false);
          } catch (error) {
            showAlert('Error stopping detector: ' + error.message, 'error');
          }
        }

        async function checkStatus() {
          try {
            const response = await fetch('/api/status');
            const data = await response.json();
            showAlert('Status: ' + (data.isRunning ? 'Running' : 'Stopped') + ' | Monitoring: ' + data.symbolCount + ' pairs', 'success');
            updateStatus(data.isRunning);
          } catch (error) {
            showAlert('Error checking status: ' + error.message, 'error');
          }
        }

        function updateStatus(isRunning) {
          const badge = document.getElementById('statusBadge');
          if (isRunning) {
            badge.className = 'status active';
            badge.textContent = '✅ Running';
          } else {
            badge.className = 'status inactive';
            badge.textContent = '⏸️ Stopped';
          }
        }

        function showAlert(message, type) {
          const alert = document.getElementById('alert');
          alert.textContent = message;
          alert.className = 'alert ' + type;
          alert.style.display = 'block';
          setTimeout(() => {
            alert.style.display = 'none';
          }, 5000);
        }

        // Check status on load
        checkStatus();
      </script>
    </body>
    </html>
  `);
});

app.post('/api/start', async (req, res) => {
  if (detector.isRunning) {
    return res.json({ success: false, message: 'Detector is already running' });
  }

  await detector.start();
  res.json({ success: true, message: 'Pump detector started successfully' });
});

app.post('/api/stop', (req, res) => {
  detector.stop();
  res.json({ success: true, message: 'Pump detector stopped' });
});

app.get('/api/status', (req, res) => {
  res.json({
    isRunning: detector.isRunning,
    symbolCount: detector.symbols.length,
    alertedCoins: Array.from(alertedCoins.keys()),
    config: CONFIG
  });
});

// Health check for Vercel
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// Auto-start in production
if (process.env.NODE_ENV === 'production' && CONFIG.TELEGRAM_BOT_TOKEN) {
  detector.start().catch(console.error);
}

const PORT = process.env.PORT || 3000;

// For Vercel serverless
if (process.env.VERCEL) {
  module.exports = app;
} else {
  app.listen(PORT, () => {
    console.log(`🚀 Server running on port ${PORT}`);
  });
}
