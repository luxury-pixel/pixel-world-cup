// server_rect_routes.js
const fs = require('fs');
const path = require('path');

function attachRectRoutes(app, opts = {}) {
  const dbPath = opts.dbPath || path.join(__dirname, 'data', 'db.json');

  // ⚙️ Config
  const GRID_W = parseInt(process.env.GRID_W || '100', 10);
  const GRID_H = parseInt(process.env.GRID_H || '100', 10);
  const BASE_CELL_CENTS = parseInt(process.env.BASE_CELL_CENTS || '10000', 10); // 100 € = 10000 cents
  const PRICE_MULTIPLIER = parseFloat(process.env.PRICE_MULTIPLIER || '2');     // ×2 à chaque revente
  const FUSION_FACTOR = parseFloat(process.env.FUSION_FACTOR || '1.3');         // 1,3× à reverser (plafonné)
  const CURRENCY = process.env.CURRENCY || 'eur';
  const MAX_LAYERS_PER_CELL = parseInt(process.env.MAX_LAYERS_PER_CELL || '2', 10);

  fs.mkdirSync(path.dirname(dbPath), { recursive: true });

  function readDB() {
    try {
      const raw = fs.readFileSync(dbPath, 'utf8');
      const parsed = JSON.parse(raw);
      return {
        cells: parsed.cells || {},
        placements: parsed.placements || []  // liste des “bannières” posées (un enregistrement par achat)
      };
    } catch {
      return { cells: {}, placements: [] };
    }
  }

  function writeDB(db) {
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    const out = {
      cells: db.cells || {},
      placements: db.placements || []
    };
    fs.writeFileSync(dbPath, JSON.stringify(out, null, 2), 'utf8');
  }

  function computeCellPriceCents(history) {
    if (!history || history.length === 0) return BASE_CELL_CENTS;
    const last = history[history.length - 1];
    return Math.round(last.priceCents * PRICE_MULTIPLIER);
  }

  // -------- DEVIS (quote) --------
  app.post('/api/purchase-rect/quote', (req, res) => {
    try {
      const { x, y, w, h, buyerEmail } = req.body || {};
      if ([x,y,w,h].some(v => typeof v !== 'number')) {
        return res.status(400).json({ error: 'coords_invalides' });
      }
      if (!buyerEmail) return res.status(400).json({ error: 'buyerEmail_requis' });
      if (x < 0 || y < 0 || x + w > GRID_W || y + h > GRID_H) {
        return res.status(400).json({ error: 'hors_grille' });
      }

      const db = readDB();

      // Règle “le premier délimite le lot”
      let requiredLotW = null, requiredLotH = null;
      for (let yy = y; yy < y + h; yy++) {
        for (let xx = x; xx < x + w; xx++) {
          const key = `${xx}:${yy}`;
          const hist = db.cells[key];
          if (hist && hist.length > 0) {
            const first = hist[0];
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
            error: 'lot_alignment_required',
            requiredLotW, requiredLotH,
            message: `Ce bloc appartient à un lot initial de ${requiredLotW}×${requiredLotH}. Sélectionne au moins cette taille.`
          });
        }
      }

      // Prix
      let totalCents = 0, newCells = 0, overlappedCells = 0;
      for (let yy = y; yy < y + h; yy++) {
        for (let xx = x; xx < x + w; xx++) {
          const key = `${xx}:${yy}`;
          const hist = db.cells[key];
          const p = computeCellPriceCents(hist);
          totalCents += p;
          if (!hist || hist.length === 0) newCells++; else overlappedCells++;
        }
      }

      return res.json({
        ok: true,
        x,y,w,h,
        newCells, overlappedCells,
        totalCents,
        currency: CURRENCY,
        lotRule: (requiredLotW && requiredLotH) ? { requiredLotW, requiredLotH } : null
      });
    } catch (err) {
      console.error('quote_error:', err);
      return res.status(500).json({ error: 'quote_error' });
    }
  });

  // -------- FULFILL (après paiement) --------
  function fulfillRectDirect({ x, y, w, h, buyerEmail, meta }) {
    try {
      const db = readDB();
      const purchaseId = `${Date.now()}_${Math.random().toString(36).slice(2)}`;
      for (let yy = y; yy < y + h; yy++) {
        for (let xx = x; xx < x + w; xx++) {
          const key = `${xx}:${yy}`;
          const hist = db.cells[key] || [];
          const nextPrice = computeCellPriceCents(hist);

          let payoutToPrevious = 0;
          if (hist.length > 0) {
            const last = hist[hist.length - 1];
            const wanted = Math.round(last.priceCents * FUSION_FACTOR);
            payoutToPrevious = Math.min(wanted, nextPrice);
          }

          hist.push({
            purchaseId,
            ownerEmail: buyerEmail,
            priceCents: nextPrice,
            paidPreviousCents: payoutToPrevious,
            at: new Date().toISOString(),
            lotW: w,
            lotH: h,
            // On ne répète pas tout le meta sur chaque case, mais on laisse une trace minimale
            hasBanner: !!meta
          });

          if (hist.length > MAX_LAYERS_PER_CELL) {
            hist.splice(0, hist.length - MAX_LAYERS_PER_CELL);
          }
          db.cells[key] = hist;
        }
      }

      // On enregistre UNE entrée “placement” (pour l’affichage des logos/bannières)
      if (meta && (meta.logo || meta.link || meta.name || meta.msg || meta.color)) {
        db.placements.push({
          purchaseId,
          x, y, w, h,
          meta: {
            name: (meta.name || '').slice(0, 80),
            link: (meta.link || '').slice(0, 300),
            logo: (meta.logo || '').slice(0, 600),
            color: (meta.color || '#1e90ff').slice(0, 20),
            msg: (meta.msg || '').slice(0, 280)
          },
          at: new Date().toISOString()
        });
      }

      writeDB(db);
      return { ok: true };
    } catch (err) {
      console.error('fulfillRectDirect error:', err);
      return { ok: false, error: 'fulfill_error' };
    }
  }

  // Exposé pour server.js
  app.locals.fulfillRectDirect = fulfillRectDirect;

  // -------- Lecture des placements (pour afficher les logos) --------
  app.get('/api/grid', (req, res) => {
    try {
      const db = readDB();
      return res.json({
        ok: true,
        width: GRID_W,
        height: GRID_H,
        placements: db.placements || []
      });
    } catch (err) {
      console.error('/api/grid error:', err);
      return res.status(500).json({ error: 'grid_error' });
    }
  });

  // ✅ petite fonction interne pour calculer un devis sans HTTP (utilisée par server.js)
  app.locals.calcRectQuote = ({ x, y, w, h, buyerEmail }) => {
    try {
      if ([x,y,w,h].some(v => typeof v !== 'number')) return { ok:false, error:'coords_invalides' };
      if (!buyerEmail) return { ok:false, error:'buyerEmail_requis' };
      if (x < 0 || y < 0 || x + w > GRID_W || y + h > GRID_H) return { ok:false, error:'hors_grille' };

      const db = readDB();

      let requiredLotW = null, requiredLotH = null;
      for (let yy = y; yy < y + h; yy++) {
        for (let xx = x; xx < x + w; xx++) {
          const key = `${xx}:${yy}`;
          const hist = db.cells[key];
          if (hist && hist.length > 0) {
            const first = hist[0];
            if (first.lotW && first.lotH) {
              requiredLotW = first.lotW;
              requiredLotH = first.lotH;
            }
          }
        }
      }
      if (requiredLotW !== null && requiredLotH !== null) {
        if (w < requiredLotW || h < requiredLotH) {
          return { ok:false, error:'lot_alignment_required', requiredLotW, requiredLotH };
        }
      }

      let totalCents = 0;
      for (let yy = y; yy < y + h; yy++) {
        for (let xx = x; xx < x + w; xx++) {
          const key = `${xx}:${yy}`;
          totalCents += computeCellPriceCents(db.cells[key]);
        }
      }
      return { ok:true, totalCents, currency:CURRENCY };
    } catch (e) {
      return { ok:false, error:'quote_error' };
    }
  };
}

module.exports = { attachRectRoutes };


