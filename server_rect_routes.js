// server_rect_routes.js
const fs = require('fs');
const path = require('path');

function attachRectRoutes(app, opts = {}) {
  const dbPath = opts.dbPath || path.join(__dirname, 'data', 'db.json');

  const GRID_W = parseInt(process.env.GRID_W || '100', 10);
  const GRID_H = parseInt(process.env.GRID_H || '100', 10);
  const BASE_CELL_CENTS = parseInt(process.env.BASE_CELL_CENTS || '10000', 10); // 100 € / case
  const PRICE_MULTIPLIER = parseFloat(process.env.PRICE_MULTIPLIER || '2');     // ×2 à la revente
  const FUSION_FACTOR = parseFloat(process.env.FUSION_FACTOR || '1.3');         // 1,3× reversé à l’ancien (plafonné)
  const CURRENCY = process.env.CURRENCY || 'eur';
  const MAX_LAYERS_PER_CELL = parseInt(process.env.MAX_LAYERS_PER_CELL || '2', 10);

  fs.mkdirSync(path.dirname(dbPath), { recursive: true });

  function readDB() {
    try {
      const raw = fs.readFileSync(dbPath, 'utf8');
      const parsed = JSON.parse(raw);
      return { cells: parsed.cells || {}, meta: parsed.meta || {} };
    } catch {
      return { cells: {}, meta: {} };
    }
  }

  function writeDB(db) {
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    fs.writeFileSync(dbPath, JSON.stringify({
      cells: db.cells || {},
      meta:  db.meta  || {}
    }, null, 2), 'utf8');
  }

  function computeCellPriceCents(history) {
    if (!history || history.length === 0) return BASE_CELL_CENTS;
    const last = history[history.length - 1];
    return Math.round(last.priceCents * PRICE_MULTIPLIER);
  }

  // ============== Devis (exposé aussi en fonction locale) ==============
  function calcRectQuote({ x, y, w, h, buyerEmail }) {
    if (![x,y,w,h].every(n => typeof n === 'number')) {
      return { ok:false, error:'coords_invalides' };
    }
    if (!buyerEmail) return { ok:false, error:'buyerEmail_requis' };
    if (x < 0 || y < 0 || x + w > GRID_W || y + h > GRID_H) {
      return { ok:false, error:'hors_grille' };
    }

    const db = readDB();

    // Règle de lot global (le 1er achat fixe lotW×lotH et origine)
    if (db.meta.lotW && db.meta.lotH) {
      const Lw = db.meta.lotW, Lh = db.meta.lotH;
      const Ox = db.meta.lotX0 ?? 0, Oy = db.meta.lotY0 ?? 0;
      const alignedX = ((x - Ox) % Lw) === 0;
      const alignedY = ((y - Oy) % Lh) === 0;
      const isMultiple = (w % Lw === 0) && (h % Lh === 0);
      if (!alignedX || !alignedY || !isMultiple) {
        return {
          ok:false,
          error:'lot_alignment_required',
          message:`Le site est organisé en lots de ${Lw}×${Lh}. Sélectionnez un bloc aligné.`
        };
      }
    }

    let totalCents = 0;
    for (let yy = y; yy < y + h; yy++) {
      for (let xx = x; xx < x + w; xx++) {
        const key = `${xx}:${yy}`;
        const history = (readDB().cells[key]); // re-read not needed but safe
        const price = computeCellPriceCents(history);
        totalCents += price;
      }
    }
    return { ok:true, totalCents, currency:CURRENCY };
  }

  // Route POST /quote (utilise la même logique)
  app.post('/api/purchase-rect/quote', (req, res) => {
    try {
      const out = calcRectQuote(req.body || {});
      if (!out.ok) return res.status(400).json(out);
      res.json(out);
    } catch (err) {
      console.error('quote_error:', err);
      res.status(500).json({ error: 'quote_error' });
    }
  });

  // ============== Fulfill après paiement ==============
  function fulfillRectDirect({ x, y, w, h, buyerEmail, logo, link, color, msg }) {
    try {
      const db = readDB();

      // Premier achat → fixe le lot global
      if (!db.meta.lotW || !db.meta.lotH) {
        db.meta.lotW = w;
        db.meta.lotH = h;
        db.meta.lotX0 = x;
        db.meta.lotY0 = y;
      }

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
            lotX0: x, lotY0: y, lotW: w, lotH: h,
            logo: logo || '', link: link || '', color: color || '', msg: msg || ''
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
      return { ok:false, error:'fulfill_error' };
    }
  }

  // Exposer pour server.js
  app.locals.fulfillRectDirect = fulfillRectDirect;
  app.locals.calcRectQuote     = calcRectQuote;

  // ============== Exposition lecture cellules ==============
  app.get('/api/cells', (req, res) => {
    try {
      const db = readDB();
      res.json({ ok:true, cells: db.cells });
    } catch {
      res.status(500).json({ ok:false, error:'cells_error' });
    }
  });
}

module.exports = { attachRectRoutes };

