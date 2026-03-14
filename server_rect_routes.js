// server_rect_routes.js
// Logique de la grille + règles des lots + calcul des prix

const pool = require("./db");
const express = require("express");
const fs = require("fs");
const path = require("path");

const router = express.Router();

// --- Constantes de la grille ---
const GRID_W = 100;
const GRID_H = 100;
const BASE_PRICE_CENTS = 100 * 100; // 100 € par case

const DATA_FILE = path.join(__dirname, "cells_state.json");

// --- État en mémoire : { cells: { "x:y": [ events... ] } } ---
let STATE = { cells: {} };

// Chargement / sauvegarde -------------------------------------------------
function loadState() {
  try {
    const raw = fs.readFileSync(DATA_FILE, "utf8");
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object") {
      STATE = parsed;
    }
  } catch {
    STATE = { cells: {} };
  }
}

function saveState() {
  try {
    fs.writeFileSync(DATA_FILE, JSON.stringify(STATE, null, 2), "utf8");
  } catch (e) {
    console.error("❌ Impossible de sauvegarder cells_state.json:", e.message);
  }
}

loadState();

// Helpers ------------------------------------------------------------------
function keyOf(x, y) {
  return `${x}:${y}`;
}

function inBounds(x, y) {
  return x >= 0 && y >= 0 && x < GRID_W && y < GRID_H;
}

// Renvoie les infos du dernier propriétaire d'une cellule (ou null)
function lastInfoForCell(x, y) {
  const k = keyOf(x, y);
  const hist = STATE.cells[k];
  if (!Array.isArray(hist) || hist.length === 0) return null;
  return hist[hist.length - 1];
}

// --- RÈGLE DES LOTS -------------------------------------------------------
function checkLotRuleAndCollect(rect) {
  const { x, y, w, h } = rect;
  const touchedLots = {};
  let newCells = 0;
  let overlappedCells = 0;

  for (let yy = y; yy < y + w && yy < GRID_H; yy++) {
    for (let xx = x; xx < x + h && xx < GRID_W; xx++) {
      if (!inBounds(xx, yy)) {
        return {
          ok: false,
          error: "out_of_bounds",
          lotRule: "Le rectangle dépasse la grille."
        };
      }

      const info = lastInfoForCell(xx, yy);
      if (!info) {
        newCells++;
        continue;
      }

      overlappedCells++;

      const lotKey = `${info.lotOriginX}:${info.lotOriginY}:${info.lotW}:${info.lotH}`;
      if (!touchedLots[lotKey]) {
        touchedLots[lotKey] = info;
      }
    }
  }

  for (const lotKey of Object.keys(touchedLots)) {
    const info = touchedLots[lotKey];
    const lx1 = info.lotOriginX;
    const ly1 = info.lotOriginY;
    const lx2 = lx1 + info.lotW - 1;
    const ly2 = ly1 + info.lotH - 1;

    const rx1 = x;
    const ry1 = y;
    const rx2 = x + w - 1;
    const ry2 = y + h - 1;

    const coversCompletely =
      rx1 <= lx1 && ry1 <= ly1 && rx2 >= lx2 && ry2 >= ly2;

    if (!coversCompletely) {
      return {
        ok: false,
        error: "partial_lot",
        lotRule:
          "Tu touches un bloc déjà vendu : tu dois acheter ce bloc en entier. " +
          "Impossible de n’en prendre qu’une partie."
      };
    }
  }

  return {
    ok: true,
    newCells,
    overlappedCells,
    touchedLots
  };
}

// --- CALCUL DU DEVIS ------------------------------------------------------
function calcRectQuote(body) {
  const x = Number(body.x);
  const y = Number(body.y);
  const w = Number(body.w);
  const h = Number(body.h);
  const buyerEmail = (body.buyerEmail || "").trim();

  if (!buyerEmail) {
    return { ok: false, error: "buyerEmail manquant" };
  }
  if (
    !Number.isInteger(x) ||
    !Number.isInteger(y) ||
    !Number.isInteger(w) ||
    !Number.isInteger(h) ||
    w <= 0 ||
    h <= 0
  ) {
    return { ok: false, error: "coordonnées invalides" };
  }
  if (!inBounds(x, y) || !inBounds(x + w - 1, y + h - 1)) {
    return { ok: false, error: "out_of_bounds" };
  }

  const lotCheck = checkLotRuleAndCollect({ x, y, w, h });
  if (!lotCheck.ok) {
    return lotCheck;
  }

  let totalCents = 0;

  for (let yy = y; yy < y + h; yy++) {
    for (let xx = x; xx < x + w; xx++) {
      const k = keyOf(xx, yy);
      const hist = STATE.cells[k];
      const prevSalesCount = Array.isArray(hist) ? hist.length : 0;
      const cellPrice = BASE_PRICE_CENTS * Math.pow(2, prevSalesCount);
      totalCents += cellPrice;
    }
  }

  return {
    ok: true,
    x,
    y,
    w,
    h,
    buyerEmail,
    newCells: lotCheck.newCells,
    overlappedCells: lotCheck.overlappedCells,
    totalCents,
    currency: "eur"
  };
}

// --- APPLICATION DE LA VENTE ---------------------------------------------
async function fulfillRectDirect(payload) {
  const q = calcRectQuote(payload);
  if (!q.ok) {
    return q;
  }

  const { x, y, w, h } = q;
  const now = new Date().toISOString();

  for (let yy = y; yy < y + h; yy++) {
    for (let xx = x; xx < x + w; xx++) {
      const k = keyOf(xx, yy);
      const hist = STATE.cells[k] || [];
      const prevSalesCount = hist.length;

      const priceCents = BASE_PRICE_CENTS * Math.pow(2, prevSalesCount);

      const event = {
        ts: now,
        buyerEmail: q.buyerEmail,
        name: (payload.name || "").slice(0, 200),
        link: (payload.link || "").slice(0, 500),
        logo: (payload.logo || "").slice(0, 500),
        color: (payload.color || "").slice(0, 30),
        msg: (payload.msg || "").slice(0, 500),

        lotOriginX: x,
        lotOriginY: y,
        lotW: w,
        lotH: h,

        priceCents,
        saleIndex: prevSalesCount + 1
      };

      hist.push(event);
      STATE.cells[k] = hist;
      
      await pool.query(
  `INSERT INTO pixel_purchases
  (cell_key, lot_origin_x, lot_origin_y, lot_w, lot_h, buyer_email, name, link, logo, color, msg, price_cents)
  VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
  [
    k,
    x,
    y,
    w,
    h,
    q.buyerEmail,
    event.name,
    event.link,
    event.logo,
    event.color,
    event.msg,
    event.priceCents
  ]
);
    }
  }

  saveState();
  return { ok: true };
}

// --- STATS VIRALES --------------------------------------------------------
router.get("/stats", (req, res) => {
  try {
    const cells = STATE && STATE.cells ? STATE.cells : {};
    const groupedSales = new Map();

    for (const cellKey of Object.keys(cells)) {
      const history = Array.isArray(cells[cellKey]) ? cells[cellKey] : [];

      for (const sale of history) {
        const saleKey = [
          sale.ts || "",
          sale.buyerEmail || "",
          sale.lotOriginX ?? "",
          sale.lotOriginY ?? "",
          sale.lotW ?? "",
          sale.lotH ?? ""
        ].join("|");

        if (!groupedSales.has(saleKey)) {
          groupedSales.set(saleKey, {
            ts: sale.ts || "",
            name: sale.name || "Anonymous",
            buyerEmail: sale.buyerEmail || "",
            lotOriginX: sale.lotOriginX ?? 0,
            lotOriginY: sale.lotOriginY ?? 0,
            lotW: sale.lotW ?? 0,
            lotH: sale.lotH ?? 0,
            priceCents: 0
          });
        }

        const entry = groupedSales.get(saleKey);
        entry.priceCents += Number(sale.priceCents || 0);
      }
    }

    const sales = Array.from(groupedSales.values());

    let totalCents = 0;
    let highestCents = 0;

    for (const sale of sales) {
      totalCents += sale.priceCents;
      if (sale.priceCents > highestCents) highestCents = sale.priceCents;
    }

    sales.sort((a, b) => {
      const ta = new Date(a.ts || 0).getTime();
      const tb = new Date(b.ts || 0).getTime();
      return tb - ta;
    });

    return res.json({
      ok: true,
      totalCents,
      highestCents,
      lastSales: sales.slice(0, 5)
    });
  } catch (e) {
    console.error("❌ stats error:", e.message);
    return res.status(500).json({ ok: false, error: "stats_error" });
  }
});

// --- LEADERBOARD ----------------------------------------------------------
router.get("/leaderboard", (req, res) => {
  try {
    const cells = STATE && STATE.cells ? STATE.cells : {};
    const owners = new Map();
    const countedLots = new Set();

    for (const cellKey of Object.keys(cells)) {
      const history = Array.isArray(cells[cellKey]) ? cells[cellKey] : [];
      if (!history.length) continue;

      const last = history[history.length - 1];
      const lotKey = [
        last.buyerEmail || "",
        last.lotOriginX ?? "",
        last.lotOriginY ?? "",
        last.lotW ?? "",
        last.lotH ?? ""
      ].join("|");

      if (countedLots.has(lotKey)) continue;
      countedLots.add(lotKey);

      const ownerKey = (last.buyerEmail || "").toLowerCase() || "anonymous";
      if (!owners.has(ownerKey)) {
        owners.set(ownerKey, {
          name: last.name || "Anonymous",
          buyerEmail: last.buyerEmail || "",
          blocks: 0,
          cells: 0,
          investedCents: 0
        });
      }

      const owner = owners.get(ownerKey);
      owner.blocks += 1;
      owner.cells += Number(last.lotW || 0) * Number(last.lotH || 0);

      let latestBlockPrice = 0;
      for (const sale of history) {
        const sameLot =
          sale.lotOriginX === last.lotOriginX &&
          sale.lotOriginY === last.lotOriginY &&
          sale.lotW === last.lotW &&
          sale.lotH === last.lotH &&
          (sale.buyerEmail || "").toLowerCase() === ownerKey;

        if (sameLot) {
          latestBlockPrice += Number(sale.priceCents || 0);
        }
      }
      owner.investedCents += latestBlockPrice;
    }

    const leaderboard = Array.from(owners.values())
      .sort((a, b) => {
        if (b.cells !== a.cells) return b.cells - a.cells;
        return b.investedCents - a.investedCents;
      })
      .slice(0, 10);

    return res.json({
      ok: true,
      leaderboard
    });
  } catch (e) {
    console.error("❌ leaderboard error:", e.message);
    return res.status(500).json({ ok: false, error: "leaderboard_error" });
  }
});

// --- ROUTES HTTP ----------------------------------------------------------
router.get("/cells", (req, res) => {
  res.json({ ok: true, cells: STATE.cells });
});

router.post("/purchase-rect/quote", (req, res) => {
  const q = calcRectQuote(req.body || {});
  if (!q.ok) return res.status(400).json(q);
  return res.json(q);
});

module.exports = {
  router,
  calcRectQuote,
  fulfillRectDirect
};