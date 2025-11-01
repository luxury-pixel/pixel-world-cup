// server_rect_routes.js
const fs = require('fs');
const path = require('path');

function attachRectRoutes(app, opts = {}) {
  const dbPath = opts.dbPath || path.join(__dirname, 'data', 'db.json');

  // valeurs par défaut
  const GRID_W = parseInt(process.env.GRID_W || '100', 10);
  const GRID_H = parseInt(process.env.GRID_H || '100', 10);
  // 💰 100 € = 10000 cents
  const BASE_CELL_CENTS = parseInt(process.env.BASE_CELL_CENTS || '10000', 10);
  const PRICE_MULTIPLIER = parseFloat(process.env.PRICE_MULTIPLIER || '2');
  const FUSION_FACTOR = parseFloat(process.env.FUSION_FACTOR || '1.3');
  const CURRENCY = process.env.CURRENCY || 'eur';
  const MAX_LAYERS_PER_CELL = parseInt(process.env.MAX_LAYERS_PER_CELL || '2', 10);

  // s'assurer que le dossier existe
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });

  function readDB() {
    try {
      const raw = fs.readFileSync(dbPath, 'utf8');
      return JSON.parse(raw);
    } catch (e) {
      return { cells: {} };
    }
  }

  function writeDB(db) {
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    fs.writeFileSync(dbPath, JSON.stringify(db, null, 2), 'utf8');
  }

  // prix d’UNE case en fonction de son historique
  function computeCellPriceCents(cellHistory) {
    if (!cellHistory || cellHistory.length === 0) {
      return BASE_CELL_CENTS;
    }
    const last = cellHistory[cellHistory.length - 1];
    return Math.round(last.priceCents * PRICE_MULTIPLIER);
  }

  // 🔵 on fabrique une fonction réutilisable (serveur ET route)
  function calcRectQuote({ x, y, w, h, buyerEmail }) {
    if (
      typeof x !== 'number' ||
      typeof y !== 'number' ||
      typeof w !== 'number' ||
      typeof h !== 'number'
    ) {
      return { ok: false, status: 400, error: 'coords_invalides' };
    }
    if (!buyerEmail) {
      return { ok: false, status: 400, error: 'buyerEmail_requis' };
    }
    if (x < 0 || y < 0 || x + w > GRID_W || y + h > GRID_H) {
      return { ok: false, status: 400, error: 'hors_grille' };
    }

    const db = readDB();

    let totalCents = 0;
    let newCells = 0;
    let overlappedCells = 0;

    // règle “le premier délimite le lot”
    let requiredLotW = null;
    let requiredLotH = null;

    for (let yy = y; yy < y + h; yy++) {
      for (let xx = x; xx < x + w; xx++) {
        const key = `${xx}:${yy}`;
        const history = db.cells[key];
        if (history && history.length > 0) {
          const first = history[0];
          if (first.lotW && first.lotH) {
            requiredLotW = first.lotW;
            requiredLotH = first.lotH;
          }
        }
      }
    }

    if (requiredLotW !== null && requiredLotH !== null) {
      if (w < requiredLotW || h < requiredLotH) {
        return {
          ok: false,
          status: 400,
          error: `lot_minimum_${requiredLotW}x${requiredLotH}`,
          requiredLotW,
          requiredLotH,
        };
      }
    }

    // calcul du prix case par case
    for (let yy = y; yy < y + h; yy++) {
      for (let xx = x; xx < x + w; xx++) {
        const key = `${xx}:${yy}`;
        const history = db.cells[key];
        const cellPrice = computeCellPriceCents(history);

        totalCents += cellPrice;

        if (!history || history.length === 0) newCells++;
        else overlappedCells++;
      }
    }

    return {
      ok: true,
      x,
      y,
      w,
      h,
      newCells,
      overlappedCells,
      totalCents,
      currency: CURRENCY,
      lotRule:
        requiredLotW && requiredLotH
          ? `Ce bloc appartient à un lot initial de ${requiredLotW}x${requiredLotH}`
          : null,
    };
  }

  // 👉 route HTTP qui utilise la fonction au-dessus
  app.post('/api/purchase-rect/quote', (req, res) => {
    try {
      const out = calcRectQuote(req.body || {});
      if (!out.ok) {
        return res.status(out.status || 400).json(out);
      }
      return res.json(out);
    } catch (err) {
      console.error(err);
      return res.status(500).json({ error: 'quote_error' });
    }
  });

  // fulfillment après paiement
  function fulfillRectDirect({ x, y, w, h, buyerEmail }) {
    try {
      const db = readDB();

      for (let yy = y; yy < y + h; yy++) {
        for (let xx = x; xx < x + w; xx++) {
          const key = `${xx}:${yy}`;
          const history = db.cells[key] || [];
          const nextPrice = computeCellPriceCents(history);

          // reversement
          let payoutToPrevious = 0;
          if (history.length > 0) {
            const last = history[history.length - 1];
            const wanted = Math.round(last.priceCents * FUSION_FACTOR);
            payoutToPrevious = Math.min(wanted, nextPrice);
          }

          history.push({
            ownerEmail: buyerEmail,
            priceCents: nextPrice,
            paidPreviousCents: payoutToPrevious,
            at: new Date().toISOString(),
            lotW: w,
            lotH: h,
          });

          // on garde max N couches
          if (history.length > MAX_LAYERS_PER_CELL) {
            history.splice(0, history.length - MAX_LAYERS_PER_CELL);
          }

          db.cells[key] = history;
        }
      }

      writeDB(db);
      return { ok: true };
    } catch (err) {
      console.error('fulfillRectDirect error:', err);
      return { ok: false, error: 'fulfill_error' };
    }
  }

  // on expose les 2 fonctions pour server.js
  app.locals.fulfillRectDirect = fulfillRectDirect;
  app.locals.calcRectQuote = calcRectQuote;
}

module.exports = { attachRectRoutes };
