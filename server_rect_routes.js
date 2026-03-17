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

async function loadStateFromSupabase() {
  try {
    console.log("LOADING STATE FROM SUPABASE");

const result = await pool.query(`
  SELECT cell_key, lot_origin_x, lot_origin_y, lot_w, lot_h,
         buyer_email, name, link, logo, color, msg, price_cents, created_at
  FROM pixel_purchases
  ORDER BY created_at ASC, id ASC
`);

console.log("SUPABASE ROWS:", result.rows.length);
console.log("FIRST ROW:", result.rows[0]);

    const cells = {};

    for (const row of result.rows) {
      const event = {
        ts: row.created_at,
        buyerEmail: row.buyer_email,
        name: row.name || "",
        link: row.link || "",
        logo: row.logo || "",
        color: row.color || "#1e90ff",
        msg: row.msg || "",
        lotOriginX: row.lot_origin_x,
        lotOriginY: row.lot_origin_y,
        lotW: row.lot_w,
        lotH: row.lot_h,
        priceCents: row.price_cents
      };

cells[row.cell_key] = {
  color: row.color || "#1e90ff",
  buyer_email: row.buyer_email,
  name: row.name,
  link: row.link,
  logo: row.logo,
  msg: row.msg,
  price_cents: row.price_cents
};
    }

    STATE.cells = cells;

    console.log("✅ Supabase state loaded");
  } catch (err) {
    console.error("❌ Supabase load error FULL:", err);
    console.error("❌ message:", err?.message);
    console.error("❌ code:", err?.code);
    console.error("❌ detail:", err?.detail);
    console.error("❌ hint:", err?.hint);
  }
}

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

// On charge Supabase au démarrage
loadStateFromSupabase();

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

// Clé stable d'un lot (sans ts)
function stableLotKey(sale) {
  return [
    (sale.buyerEmail || "").toLowerCase(),
    sale.lotOriginX ?? "",
    sale.lotOriginY ?? "",
    sale.lotW ?? "",
    sale.lotH ?? ""
  ].join("|");
}

// Reconstruit les lots uniques actuels à partir de STATE.cells
function buildCurrentLots() {
  const cells = STATE && STATE.cells ? STATE.cells : {};
  const lots = new Map();

  for (const cellKey of Object.keys(cells)) {
    const history = Array.isArray(cells[cellKey]) ? cells[cellKey] : [];
    if (!history.length) continue;

    const last = history[history.length - 1];
    const lotKey = stableLotKey(last);

    if (!lots.has(lotKey)) {
      lots.set(lotKey, {
        key: lotKey,
        name: last.name || "Anonymous",
        buyerEmail: last.buyerEmail || "",
        lotOriginX: Number(last.lotOriginX || 0),
        lotOriginY: Number(last.lotOriginY || 0),
        lotW: Number(last.lotW || 0),
        lotH: Number(last.lotH || 0),
        ts: last.ts || "",
        cells: Number(last.lotW || 0) * Number(last.lotH || 0),
        priceCents: 0
      });
    }
  }

  for (const lot of lots.values()) {
    let total = 0;

    for (let yy = lot.lotOriginY; yy < lot.lotOriginY + lot.lotH; yy++) {
      for (let xx = lot.lotOriginX; xx < lot.lotOriginX + lot.lotW; xx++) {
        const k = keyOf(xx, yy);
        const history = Array.isArray(cells[k]) ? cells[k] : [];
        if (!history.length) continue;

        const last = history[history.length - 1];

        const sameLot =
          stableLotKey(last) === lot.key &&
          Number(last.lotOriginX || 0) === lot.lotOriginX &&
          Number(last.lotOriginY || 0) === lot.lotOriginY &&
          Number(last.lotW || 0) === lot.lotW &&
          Number(last.lotH || 0) === lot.lotH;

        if (sameLot) {
          total += Number(last.priceCents || 0);
        }
      }
    }

    lot.priceCents = total;
  }

  return Array.from(lots.values());
}

// --- RÈGLE DES LOTS -------------------------------------------------------
function checkLotRuleAndCollect(rect) {
  const { x, y, w, h } = rect;
  const touchedLots = {};
  let newCells = 0;
  let overlappedCells = 0;

  for (let yy = y; yy < y + h && yy < GRID_H; yy++) {
    for (let xx = x; xx < x + w && xx < GRID_W; xx++) {
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

      console.log("INSERT SUPABASE START", {
        k,
        x,
        y,
        w,
        h,
        priceCents: event.priceCents
      });

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

      console.log("INSERT SUPABASE OK", k);
    }
  }

  saveState();
  return { ok: true };
}

// --- STATS VIRALES --------------------------------------------------------
router.get("/stats", (req, res) => {
  try {
    const lots = buildCurrentLots();

    let totalCents = 0;
    let highestCents = 0;

    for (const lot of lots) {
      totalCents += Number(lot.priceCents || 0);
      if (Number(lot.priceCents || 0) > highestCents) {
        highestCents = Number(lot.priceCents || 0);
      }
    }

    lots.sort((a, b) => {
      const ta = new Date(a.ts || 0).getTime();
      const tb = new Date(b.ts || 0).getTime();
      return tb - ta;
    });

    const lastSales = lots.slice(0, 5).map((lot) => ({
      ts: lot.ts || "",
      name: lot.name || "Anonymous",
      buyerEmail: lot.buyerEmail || "",
      lotOriginX: lot.lotOriginX ?? 0,
      lotOriginY: lot.lotOriginY ?? 0,
      lotW: lot.lotW ?? 0,
      lotH: lot.lotH ?? 0,
      priceCents: Number(lot.priceCents || 0)
    }));

    return res.json({
      ok: true,
      totalCents,
      highestCents,
      lastSales
    });
  } catch (e) {
    console.error("❌ stats error:", e);
    return res.status(500).json({ ok: false, error: "stats_error" });
  }
});

// --- LEADERBOARD ----------------------------------------------------------
router.get("/leaderboard", (req, res) => {
  try {
    const lots = buildCurrentLots();
    const owners = new Map();

    for (const lot of lots) {
      const ownerKey = (lot.buyerEmail || "").toLowerCase() || "anonymous";

      if (!owners.has(ownerKey)) {
        owners.set(ownerKey, {
          name: lot.name || "Anonymous",
          buyerEmail: lot.buyerEmail || "",
          blocks: 0,
          cells: 0,
          investedCents: 0
        });
      }

      const owner = owners.get(ownerKey);
      owner.blocks += 1;
      owner.cells += Number(lot.cells || 0);
      owner.investedCents += Number(lot.priceCents || 0);
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
    console.error("❌ leaderboard error:", e);
    return res.status(500).json({ ok: false, error: "leaderboard_error" });
  }
});

// --- ROUTES HTTP ----------------------------------------------------------
router.get("/cells", async (req, res) => {
  try {
    await loadStateFromSupabase();
    console.log("CELLS GENERATED:", Object.keys(STATE.cells).length);
    return res.json({ ok: true, cells: STATE.cells });
  } catch (err) {
    console.error("❌ API cells error:", err);
    return res.status(500).json({ ok: false, error: "cells_error" });
  }
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
