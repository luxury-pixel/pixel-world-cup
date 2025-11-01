// server_rect_routes.js
const fs = require('fs');
const path = require('path');

function attachRectRoutes(app, opts = {}) {
  const dbPath = opts.dbPath || path.join(__dirname, 'data', 'db.json');

  // valeurs par défaut
  const GRID_W = parseInt(process.env.GRID_W || '100', 10);
  const GRID_H = parseInt(process.env.GRID_H || '100', 10);
  const BASE_CELL_CENTS = parseInt(process.env.BASE_CELL_CENTS || '10000', 10); // 100 € = 10000 cents
  const PRICE_MULTIPLIER = parseFloat(process.env.PRICE_MULTIPLIER || '2');
  const FUSION_FACTOR = parseFloat(process.env.FUSION_FACTOR || '1.3');
  const CURRENCY = process.env.CURRENCY || 'eur';
  const MAX_LAYERS_PER_CELL = parseInt(process.env.MAX_LAYERS_PER_CELL || '2', 10);

  // on s'assure que le dossier existe
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });

  function readDB() {
    try {
      const raw = fs.readFileSync(dbPath, 'utf8');
      const parsed = JSON.parse(raw);

      // on blinde : si c'est pas un objet → on repart sur propre
      if (!parsed || typeof parsed !== 'object') {
        return { cells: {} };
      }
      // si pas de .cells → on l'ajoute
      if (!parsed.cells || typeof parsed.cells !== 'object') {
        parsed.cells = {};
      }
      return parsed;
    } catch (e) {
      // fichier absent ou pourri → on repart sur base
      return { cells: {} };
    }
  }

  function writeDB(db) {
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    fs.writeFileSync(dbPath, JSON.stringify(db, null, 2), 'utf8');
  }

  // calcule le prix d'une case selon son historique
  function computeCellPriceCents(cellHistory) {
    if (!cellHistory || cellHistory.length === 0) {
      return BASE_CELL_CENTS;
    }
    const last = cellHistory[cellHistory.length - 1];
    return Math.round(last.priceCents * PRICE_MULTIPLIER);
  }

  // =====================================================
  // POST /api/purchase-rect/quote
  // =====================================================
  app.post('/api/purchase-rect/quote', (req, res) => {
    try {
      const { x, y, w, h, buyerEmail } = req.body || {};

      if (
        typeof x !== 'number' ||
        typeof y !== 'number' ||
        typeof w !== 'number' ||
        typeof h !== 'number'
      ) {
        return res.status(400).json({ error: 'coords_invalides' });
      }
      if (!buyerEmail) {
        return res.status(400).json({ error: 'buyerEmail_requis' });
      }
      if (x < 0 || y < 0 || x + w > GRID_W || y + h > GRID_H) {
        return res.status(400).json({ error: 'hors_grille' });
      }

      const db = readDB();
      const cellsDB = db.cells || {}; // 👈 on re-blinde ici

      let totalCents = 0;
      let newCells = 0;
      let overlappedCells = 0;

      // règle “le premier délimite le lot”
      let requiredLotW = null;
      let requiredLotH = null;

      // on regarde dans le rectangle s'il existe déjà UNE case vendue
      for (let yy = y; yy < y + h; yy++) {
        for (let xx = x; xx < x + w; xx++) {
          const key = `${xx}:${yy}`;
          const history = cellsDB[key];

          if (history && history.length > 0) {
            const first = history[0];
            if (first.lotW && first.lotH) {
              requiredLotW = first.lotW;
              requiredLotH = first.lotH;
            }
          }
        }
      }

      // si un lot existe → l'acheteur doit au moins prendre ce lot
      if (requiredLotW !== null && requiredLotH !== null) {
        if (w < requiredLotW || h < requiredLotH) {
          return res.status(400).json({
            error: `lot_minimum_${requiredLotW}x${requiredLotH}`,
            requiredLotW,
            requiredLotH,
          });
        }
      }

      // on calcule le prix
      for (let yy = y; yy < y + h; yy++) {
        for (let xx = x; xx < x + w; xx++) {
          const key = `${xx}:${yy}`;
          const history = cellsDB[key];
          const cellPrice = computeCellPriceCents(history);
          totalCents += cellPrice;

          if (!history || history.length === 0) newCells++;
          else overlappedCells++;
        }
      }

      return res.json({
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
      });
    } catch (err) {
      console.error(err);
      return res.status(500).json({ error: 'quote_error' });
    }
  });

  // =====================================================
  // fulfilment après paiement
  // =====================================================
  function fulfillRectDirect({ x, y, w, h, buyerEmail }) {
    try {
      const db = readDB();
      const cellsDB = db.cells || {};

      for (let yy = y; yy < y + h; yy++) {
        for (let xx = x; xx < x + w; xx++) {
          const key = `${xx}:${yy}`;
          const history = cellsDB[key] || [];
          const nextPrice = computeCellPriceCents(history);

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

          if (history.length > MAX_LAYERS_PER_CELL) {
            history.splice(0, history.length - MAX_LAYERS_PER_CELL);
          }

          cellsDB[key] = history;
        }
      }

      db.cells = cellsDB;
      writeDB(db);
      return { ok: true };
    } catch (err) {
      console.error('fulfillRectDirect error:', err);
      return { ok: false, error: 'fulfill_error' };
    }
  }

  app.locals.fulfillRectDirect = fulfillRectDirect;
}

module.exports = { attachRectRoutes };
