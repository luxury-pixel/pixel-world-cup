// server_rect_routes.js
const fs = require('fs');
const path = require('path');

function attachRectRoutes(app, opts = {}) {
  const dbPath = opts.dbPath || path.join(__dirname, 'data', 'db.json');

<<<<<<< HEAD
  // valeurs config (overridables par Render)
=======
  // config
>>>>>>> ee152e7 (fix: add real quote route)
  const GRID_W = parseInt(process.env.GRID_W || '100', 10);
  const GRID_H = parseInt(process.env.GRID_H || '100', 10);
  const BASE_CELL_CENTS = parseInt(process.env.BASE_CELL_CENTS || '10000', 10); // 100 € = 10000
  const PRICE_MULTIPLIER = parseFloat(process.env.PRICE_MULTIPLIER || '2');
  const FUSION_FACTOR = parseFloat(process.env.FUSION_FACTOR || '1.3');
  const CURRENCY = process.env.CURRENCY || 'eur';
  const MAX_LAYERS_PER_CELL = parseInt(process.env.MAX_LAYERS_PER_CELL || '2', 10);

<<<<<<< HEAD
  // être sûr que le dossier existe (Render peut démarrer vide)
=======
  // dossier data
>>>>>>> ee152e7 (fix: add real quote route)
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });

  function readDB() {
    try {
      const raw = fs.readFileSync(dbPath, 'utf8');
<<<<<<< HEAD
      const parsed = JSON.parse(raw);
      // fallback si jamais parsed.cells n’existe pas
      return {
        cells: parsed.cells || {}
      };
=======
      return JSON.parse(raw);
>>>>>>> ee152e7 (fix: add real quote route)
    } catch (e) {
      return { cells: {} };
    }
  }

  function writeDB(db) {
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    // on garantit qu’il y a bien un objet cells
    const toWrite = {
      cells: db.cells || {}
    };
    fs.writeFileSync(dbPath, JSON.stringify(toWrite, null, 2), 'utf8');
  }

<<<<<<< HEAD
  // prix d’une case selon historique
=======
  // prix d’UNE case
>>>>>>> ee152e7 (fix: add real quote route)
  function computeCellPriceCents(history) {
    if (!history || history.length === 0) {
      return BASE_CELL_CENTS;
    }
    const last = history[history.length - 1];
    return Math.round(last.priceCents * PRICE_MULTIPLIER);
  }

<<<<<<< HEAD
  // -------------------------------------------------------
  // 1) DEVIS
  // -------------------------------------------------------
=======
  // ------------------------------------------
  // 1) DEVIS
  // ------------------------------------------
>>>>>>> ee152e7 (fix: add real quote route)
  app.post('/api/purchase-rect/quote', (req, res) => {
    try {
      const { x, y, w, h, buyerEmail } = req.body || {};

      if (
        typeof x !== 'number' || typeof y !== 'number' ||
        typeof w !== 'number' || typeof h !== 'number'
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

      let totalCents = 0;
      let newCells = 0;
      let overlappedCells = 0;

<<<<<<< HEAD
      // règle “premier achat = taille du lot”
=======
      // règle “le tout premier achat impose la taille du lot”
>>>>>>> ee152e7 (fix: add real quote route)
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
          return res.status(400).json({
            error: `lot_minimum_${requiredLotW}x${requiredLotH}`,
            requiredLotW,
            requiredLotH
          });
        }
      }

<<<<<<< HEAD
      // calcul de prix
=======
      // calcul du prix
>>>>>>> ee152e7 (fix: add real quote route)
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

      return res.json({
        ok: true,
        x, y, w, h,
        newCells,
        overlappedCells,
        totalCents,
        currency: CURRENCY,
        lotRule: (requiredLotW && requiredLotH)
          ? `Ce bloc appartient à un lot initial de ${requiredLotW}x${requiredLotH}`
          : null
      });
    } catch (err) {
      console.error('quote_error:', err);
      return res.status(500).json({ error: 'quote_error' });
    }
  });

<<<<<<< HEAD
  // -------------------------------------------------------
  // 2) FULFILL après paiement
  // -------------------------------------------------------
=======
  // ------------------------------------------
  // 2) FULFILL (appelé par le webhook stripe OU direct)
  // ------------------------------------------
>>>>>>> ee152e7 (fix: add real quote route)
  function fulfillRectDirect({ x, y, w, h, buyerEmail }) {
    try {
      const db = readDB();

      for (let yy = y; yy < y + h; yy++) {
        for (let xx = x; xx < x + w; xx++) {
          const key = `${xx}:${yy}`;
          const history = db.cells[key] || [];
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
            lotH: h
          });

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

  // exposé pour server.js
  app.locals.fulfillRectDirect = fulfillRectDirect;
}

module.exports = { attachRectRoutes };
