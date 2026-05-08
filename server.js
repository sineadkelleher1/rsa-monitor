/**
 * RSA Slot Monitor — Backend Server (Node.js)
 *
 * WHAT THIS DOES:
 *   - Runs a headless Puppeteer browser every ~25 seconds
 *   - Scrapes the RSA MyRoadSafety booking page for available slots
 *   - Pushes real-time updates to connected clients via Socket.io
 *   - Sends email alerts via Nodemailer when a new slot appears
 *
 * SETUP:
 *   1. npm install express socket.io puppeteer nodemailer cors
 *   2. Copy .env.example to .env and fill in your values
 *   3. node server.js
 *
 * DEPLOY TO RENDER (free tier):
 *   - Create a new Web Service, connect your GitHub repo
 *   - Set environment variables in Render dashboard
 *   - Start command: node server.js
 *   - Render auto-installs Chromium for Puppeteer ✓
 *
 * ENVIRONMENT VARIABLES (.env):
 *   PORT=3001
 *   ALLOWED_ORIGIN=https://claude.ai          # your frontend URL
 *   POLL_INTERVAL_MS=25000                    # how often to scrape (ms)
 *   ALERT_EMAIL_TO=your@email.com             # who gets slot alerts
 *   SMTP_HOST=smtp.gmail.com
 *   SMTP_PORT=587
 *   SMTP_USER=your@gmail.com
 *   SMTP_PASS=your-app-password               # Gmail app password (not account password)
 *   RSA_LOGIN_EMAIL=                          # optional: your MyRoadSafety login
 *   RSA_LOGIN_PASSWORD=                       # optional: your MyRoadSafety password
 */

require("dotenv").config();
const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const cors = require("cors");
const nodemailer = require("nodemailer");
const puppeteer = require("puppeteer");

// ─── Config ──────────────────────────────────────────────────────────────────

const PORT = process.env.PORT || 3001;
const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || "*";
const POLL_INTERVAL_MS = parseInt(process.env.POLL_INTERVAL_MS || "25000", 10);
const JITTER_MS = 8000; // randomise timing ±8s to avoid bot detection

const RSA_BOOKING_URL = "https://www.myrsa.ie/test/driving-test/booking/select-test-centre";

// ─── Express + Socket.io Setup ────────────────────────────────────────────────

const app = express();
app.use(cors({ origin: ALLOWED_ORIGIN }));
app.use(express.json());

const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: ALLOWED_ORIGIN, methods: ["GET", "POST"] }
});

// ─── Email Setup ──────────────────────────────────────────────────────────────

let mailer = null;
if (process.env.SMTP_HOST && process.env.SMTP_USER && process.env.SMTP_PASS) {
  mailer = nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: parseInt(process.env.SMTP_PORT || "587", 10),
    secure: false,
    auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS }
  });
  mailer.verify((err) => {
    if (err) console.warn("[email] SMTP config error:", err.message);
    else console.log("[email] SMTP ready ✓");
  });
}

async function sendSlotAlert(slots) {
  if (!mailer || !process.env.ALERT_EMAIL_TO) return;
  const lines = slots.map(s =>
    `• ${s.centre} — ${s.date} at ${s.time} — https://www.myrsa.ie/test/driving-test/booking`
  ).join("\n");

  try {
    await mailer.sendMail({
      from: `RSA Monitor <${process.env.SMTP_USER}>`,
      to: process.env.ALERT_EMAIL_TO,
      subject: `🚗 RSA Slot Available! ${slots[0].centre} — ${slots[0].date}`,
      text: `New RSA driving test slots found:\n\n${lines}\n\nBook now at https://www.myrsa.ie`,
      html: `
        <h2 style="color:#10b981">🚗 RSA Slot Available!</h2>
        <p>New driving test slots found:</p>
        <ul>${slots.map(s => `
          <li><strong>${s.centre}</strong> — ${s.date} at ${s.time}
            <br><a href="https://www.myrsa.ie/test/driving-test/booking">Book now →</a>
          </li>`).join("")}
        </ul>
        <p style="color:#6b7280;font-size:12px">RSA Slot Monitor • Unsubscribe by stopping the server</p>
      `
    });
    console.log(`[email] Alert sent for ${slots.length} slot(s)`);
  } catch (err) {
    console.error("[email] Send error:", err.message);
  }
}

// ─── Scraper ──────────────────────────────────────────────────────────────────

let browser = null;

async function getBrowser() {
  if (browser && browser.isConnected()) return browser;
  console.log("[scraper] Launching Puppeteer browser…");
  browser = await puppeteer.launch({
    headless: "new",
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-dev-shm-usage",       // required on Linux/Docker
      "--disable-gpu",
      "--window-size=1280,800"
    ]
  });
  browser.on("disconnected", () => { browser = null; });
  return browser;
}

/**
 * scrapeSlots(centreIds)
 *
 * Navigates the RSA booking page and extracts slot availability.
 *
 * HOW TO ADAPT THIS:
 *   Open https://www.myrsa.ie/test/driving-test/booking in Chrome DevTools,
 *   go to Network tab, select a test centre, and watch for XHR/fetch calls.
 *   If you find a JSON API endpoint, replace the page.evaluate() block below
 *   with a simple fetch() call — much faster and more reliable than DOM scraping.
 *
 *   The selectors below are best guesses — update them to match the actual DOM
 *   once you inspect the live page.
 */
async function scrapeSlots(centreIds = []) {
  const b = await getBrowser();
  const page = await b.newPage();

  try {
    // Realistic browser headers
    await page.setUserAgent(
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
      "(KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36"
    );
    await page.setExtraHTTPHeaders({
      "Accept-Language": "en-IE,en;q=0.9",
      "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8"
    });

    // Optional: intercept API calls made by the booking page
    // This lets you capture JSON directly without scraping DOM
    const capturedApiData = [];
    await page.setRequestInterception(true);
    page.on("request", req => req.continue());
    page.on("response", async (res) => {
      const url = res.url();
      // Adjust this pattern to match RSA's actual API endpoint
      if (url.includes("/api/") && url.includes("availab")) {
        try {
          const json = await res.json();
          capturedApiData.push(json);
        } catch (_) {}
      }
    });

    console.log(`[scraper] Loading ${RSA_BOOKING_URL}`);
    await page.goto(RSA_BOOKING_URL, {
      waitUntil: "networkidle2",
      timeout: 30000
    });

    // Wait for content to render
    // ⚠️  Update this selector to match the actual booking page DOM
    await page.waitForSelector("body", { timeout: 10000 });

    // ── Option A: Use captured API data (preferred if available) ──
    if (capturedApiData.length > 0) {
      console.log("[scraper] Using intercepted API data");
      return parseApiData(capturedApiData, centreIds);
    }

    // ── Option B: DOM scraping fallback ──
    // ⚠️  Inspect the live booking page and update these selectors
    const slots = await page.evaluate((centres) => {
      const results = [];

      // Try to find slot rows — update selector to match real DOM
      const rows = document.querySelectorAll(
        ".test-centre-row, .slot-row, [data-centre], .availability-row, tr[data-slot]"
      );

      rows.forEach(row => {
        const centreEl = row.querySelector(".centre-name, .centre, [data-centre-name], td:first-child");
        const dateEl   = row.querySelector(".date, [data-date], td:nth-child(2)");
        const timeEl   = row.querySelector(".time, [data-time], td:nth-child(3)");
        const available = !row.classList.contains("booked") &&
                          !row.classList.contains("unavailable") &&
                          !row.querySelector(".booked, .unavailable, [data-status='booked']");

        if (centreEl) {
          const centre = centreEl.innerText?.trim();
          if (!centres.length || centres.some(c => centre?.toLowerCase().includes(c.replace("-", " ")))) {
            results.push({
              id: `${centre}-${dateEl?.innerText}-${timeEl?.innerText}`,
              centre: centre || "Unknown",
              date: dateEl?.innerText?.trim() || "TBC",
              time: timeEl?.innerText?.trim() || "TBC",
              available
            });
          }
        }
      });

      // If no rows found, return a diagnostic slot so we know the page loaded
      if (results.length === 0) {
        return [{
          id: "diagnostic",
          centre: "Page loaded — update selectors",
          date: new Date().toISOString().split("T")[0],
          time: "See server logs",
          available: false,
          _diagnostic: true
        }];
      }

      return results;
    }, centreIds);

    return slots;
  } catch (err) {
    console.error("[scraper] Error:", err.message);
    throw err;
  } finally {
    await page.close();
  }
}

/**
 * parseApiData(data, centreIds)
 *
 * Called when the RSA page makes its own API call that we intercept.
 * Update this to match the actual API response structure.
 */
function parseApiData(apiResponses, centreIds) {
  const slots = [];
  apiResponses.forEach(data => {
    const items = data.slots || data.availability || data.results || data.data || [];
    items.forEach(item => {
      const centre = item.centreName || item.centre || item.name || "Unknown";
      if (!centreIds.length || centreIds.some(c => centre.toLowerCase().includes(c.replace("-", " ")))) {
        slots.push({
          id: item.id || `${centre}-${item.date}-${item.time}`,
          centre,
          date: item.date || item.testDate || "TBC",
          time: item.time || item.testTime || "TBC",
          available: item.available ?? item.status === "available" ?? true
        });
      }
    });
  });
  return slots;
}

// ─── Polling Loop ─────────────────────────────────────────────────────────────

const previousSlots = new Map(); // centre+date+time → available (bool)
let pollTimer = null;

async function poll(centreIds) {
  try {
    const slots = await scrapeSlots(centreIds);
    console.log(`[poll] ${slots.length} slot(s) found`);

    // Detect newly available slots
    const newlyAvailable = [];
    slots.forEach(slot => {
      const key = slot.id || `${slot.centre}-${slot.date}-${slot.time}`;
      const wasAvailable = previousSlots.get(key);
      if (slot.available && !wasAvailable) {
        newlyAvailable.push(slot);
      }
      previousSlots.set(key, slot.available);
    });

    if (newlyAvailable.length > 0) {
      console.log(`[poll] 🚨 ${newlyAvailable.length} new slot(s) found!`);
      await sendSlotAlert(newlyAvailable);
    }

    // Broadcast to all connected clients
    io.emit("slot-update", slots);
  } catch (err) {
    console.error("[poll] Failed:", err.message);
    io.emit("poll-error", { message: err.message });
  }
}

function startPolling(centreIds) {
  if (pollTimer) clearTimeout(pollTimer);

  const run = async () => {
    await poll(centreIds);
    // Randomise interval to avoid bot detection
    const jitter = Math.random() * JITTER_MS - JITTER_MS / 2;
    pollTimer = setTimeout(run, POLL_INTERVAL_MS + jitter);
  };

  run();
}

function stopPolling() {
  if (pollTimer) { clearTimeout(pollTimer); pollTimer = null; }
}

// ─── Socket.io Connection Handling ───────────────────────────────────────────

let activeCentres = [];
let connectedClients = 0;

io.on("connection", (socket) => {
  connectedClients++;
  const centres = (socket.handshake.query.centres || "")
    .split(",")
    .filter(Boolean);

  console.log(`[socket] Client connected (${connectedClients} total) — centres: ${centres.join(", ") || "all"}`);

  // Start/restart polling for the requested centres
  activeCentres = centres.length ? centres : [];
  startPolling(activeCentres);

  socket.on("set-centres", (newCentres) => {
    activeCentres = Array.isArray(newCentres) ? newCentres : [];
    console.log(`[socket] Centre filter updated: ${activeCentres.join(", ")}`);
    startPolling(activeCentres);
  });

  socket.on("disconnect", () => {
    connectedClients--;
    console.log(`[socket] Client disconnected (${connectedClients} remaining)`);
    if (connectedClients <= 0) {
      console.log("[socket] No clients — pausing polling");
      stopPolling();
    }
  });
});

// ─── REST API ─────────────────────────────────────────────────────────────────

// Health check — used by Render/Railway to confirm the server is alive
app.get("/health", (req, res) => {
  res.json({
    status: "ok",
    uptime: process.uptime(),
    clients: connectedClients,
    polling: pollTimer !== null,
    timestamp: new Date().toISOString()
  });
});

// Trigger a manual scan
app.post("/scan", async (req, res) => {
  try {
    const slots = await scrapeSlots(activeCentres);
    io.emit("slot-update", slots);
    res.json({ ok: true, count: slots.length, slots });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ─── Start Server ─────────────────────────────────────────────────────────────

server.listen(PORT, () => {
  console.log(`
╔═══════════════════════════════════════════╗
║     RSA Slot Monitor — Backend Server     ║
╠═══════════════════════════════════════════╣
║  Listening on  :${PORT}                      ║
║  Poll interval: ${POLL_INTERVAL_MS / 1000}s (±${JITTER_MS / 1000}s jitter)        ║
║  Email alerts: ${mailer ? "enabled ✓" : "disabled (no SMTP config)"}         ║
╚═══════════════════════════════════════════╝
  `);
});

// Graceful shutdown
process.on("SIGTERM", async () => {
  console.log("[server] SIGTERM received, shutting down…");
  stopPolling();
  if (browser) await browser.close();
  server.close(() => process.exit(0));
});
