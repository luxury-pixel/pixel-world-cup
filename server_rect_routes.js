// server_rect_routes.js
const fs   = require('fs');
const path = require('path');

function attachRectRoutes(app, opts = {}) {
  const dbPath = opts.dbPath || path.join(__dirname, 'data', 'db.json');

  // garantir le dossier
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });

  // --- config ---
  const GRID_W = parseInt(process.env.GRID_W || '100', 10);
  const GRID_H = parseInt(process.env.GRID_H || '100', 10);
  const BASE_CELL_CENTS = parseInt(process.env.BASE_CELL_CENTS || '10000', 10); // 100 € = 10000
  const PRICE_MULTIPLIER = parseFloat(process.env.PRICE_MULTIPLIER || '2');
  const FUSION_FACTOR    = parseFloat(process.env.FUSION_FACTOR || '1.3');
  const CURRENCY         = process.env.CURRENCY || 'eur';
  const MAX_LAYERS_PER_CELL = parseInt(process.env.MAX_LAYERS_PER_CELL || '2', 10);

  function readDB() {
    try {
      const raw = fs.readFileSync(dbPath, 'utf8');
      const parsed = JSON.parse(raw);
      if (!parsed || typeof parsed !== 'object') {
        return { cells: {} };
      }
      if (!parsed.cells || typeof parsed.cells !== 'object') {
        return { cells: {} };
      }
      return { cells: parsed.cells };
    } catch (e) {
      return { cells: {} };
    }
  }

  function writeDB(db) {
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    const toWrite = {
      cells: db && typeof db === 'object' && typeof db.cells === 'object'
        ? db.cells
        : {}
    };
    fs.writeFileSync(dbPath, JSON.stringify(toWrite, null, 2), 'utf8');
  }

  function computeCellPriceCents(history) {
    if (!history || history.length === 0) {
      return BASE_CELL_CENTS;
    }
    const last = history[history.length - 1];
    return Math.round(last.priceCents * PRICE_MULTIPLIER);
  }

  // ----------- fonction réutilisable par server.js ------------
  function calcRectQuote({ x, y, w, h, buyerEmail }) {
    // sécurités
    x = Number(x); y = Number(y); w = Number(w); h = Number(h);

    if (
      Number.isNaN(x) || Number.isNaN(y) ||
      Number.isNaN(w) || Number.isNaN(h)
    ) {
      return { ok: false, error: 'coords_invalides' };
    }
    if (!buyerEmail) {
      return { ok: false, error: 'buyerEmail_requis' };
    }
    if (x < 0 || y < 0 || x + w > GRID_W || y + h > GRID_H) {
      return { ok: false, error: 'hors_grille' };
    }

    const db = readDB();
    const cells = db.cells || {};

    let totalCents = 0;
    let newCells = 0;
    let overlappedCells = 0;

    // chercher si un lot est déjà imposé
    let requiredLotW = null;
    let requiredLotH = null;

    for (let yy = y; yy < y + h; yy++) {
      for (let xx = x; xx < x + w; xx++) {
        const key = `${xx}:${yy}`;
        const history = cells[key];
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
          error: `lot_minimum_${requiredLotW}x${requiredLotH}`,
          requiredLotW,
          requiredLotH,
        };
      }
    }

    // calcul du prix
    for (let yy = y; yy < y + h; yy++) {
      for (let xx = x; xx < x + w; xx++) {
        const key = `${xx}:${yy}`;
        const history = cells[key];
        const cellPrice = computeCellPriceCents(history);

        totalCents += cellPrice;
        if (!history || history.length === 0) newCells++;
        else overlappedCells++;
      }
    }

    return {
      ok: true,
      x, y, w, h,
      newCells,
      overlappedCells,
      totalCents,
      currency: CURRENCY,
      lotRule: (requiredLotW && requiredLotH)
        ? `Ce bloc appartient à un lot initial de ${requiredLotW}x${requiredLotH}`
        : null
    };
  }

  // ----------- route HTTP qui appelle cette fonction -----------
  app.post('/api/purchase-rect/quote', (req, res) => {
    try {
      const out = calcRectQuote(req.body || {});
      if (!out.ok) {
        return res.status(400).json(out);
      }
      return res.json(out);
    } catch (err) {
      console.error('quote_error:', err);
      return res.status(500).json({ ok: false, error: 'quote_error' });
    }
  });

  // ----------- fulfill après paiement -----------
  function fulfillRectDirect({ x, y, w, h, buyerEmail }) {
    try {
      x = Number(x); y = Number(y); w = Number(w); h = Number(h);
      const db = readDB();
      const cells = db.cells || {};

      for (let yy = y; yy < y + h; yy++) {
        for (let xx = x; xx < x + w; xx++) {
          const key = `${xx}:${yy}`;
          const history = cells[key] || [];
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

          cells[key] = history;
        }
      }

      writeDB({ cells });
      return { ok: true };
    } catch (err) {
      console.error('fulfillRectDirect error:', err);
      return { ok: false, error: 'fulfill_error' };
    }
  }

  // exposer pour server.js
  app.locals.calcRectQuote   = calcRectQuote;
  app.locals.fulfillRectDirect = fulfillRectDirect;
}

module.exports = { attachRectRoutes };
