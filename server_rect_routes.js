// server_rect_routes.js
// Logique de la grille + règles des lots + calcul des prix

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
// On regarde tous les lots touchés par le rectangle (x,y,w,h).
// Si un lot est touché PARTIELLEMENT => refus.
// Si un lot est contenu ENTIEREMENT dans le rectangle => OK.
// Les autres cellules neuves => OK.
function checkLotRuleAndCollect(rect) {
  const { x, y, w, h } = rect;
  const touchedLots = {}; // key "ox:oy:lw:lh" -> info
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

  // Vérifie pour chaque lot touché si le rectangle le couvre complètement
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

// --- CALCUL DU DEVIS (ne modifie PAS l'état !) ---------------------------
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
      const info = lastInfoForCell(xx, yy);
      const k = keyOf(xx, yy);
      const hist = STATE.cells[k];
      const prevSalesCount = Array.isArray(hist) ? hist.length : 0;

      // Niveau 0 : 100 €, niveau 1 : 200 €, niveau 2 : 400 €, etc.
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

// --- APPLICATION DE LA VENTE (après paiement réussi) ---------------------
function fulfillRectDirect(payload) {
  // Sécurité : on re-vérifie les règles et le montant (mais sans mutation)
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

        // Pour mémoire / analyse
        priceCents,
        saleIndex: prevSalesCount + 1
      };

      hist.push(event);
      STATE.cells[k] = hist;
    }
  }

  saveState();
  return { ok: true };
}

// --- ROUTES HTTP ----------------------------------------------------------

// État complet de la grille
router.get("/cells", (req, res) => {
  res.json({ ok: true, cells: STATE.cells });
});

// Devis pour un rectangle
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
