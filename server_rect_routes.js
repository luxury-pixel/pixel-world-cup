// server_rect_routes.js
const fs   = require('fs');
const path = require('path');

function attachRectRoutes(app, opts = {}) {
  const dbPath = opts.dbPath || path.join(__dirname, 'data', 'db.json');

  // Config (surchargée par .env si présent)
  const GRID_W = parseInt(process.env.GRID_W || '100', 10);
  const GRID_H = parseInt(process.env.GRID_H || '100', 10);
  const BASE_CELL_CENTS  = parseInt(process.env.BASE_CELL_CENTS || '10000', 10); // 100€ = 10000
  const PRICE_MULTIPLIER = parseFloat(process.env.PRICE_MULTIPLIER || '2');      // ×2 à chaque revente
  const FUSION_FACTOR    = parseFloat(process.env.FUSION_FACTOR    || '1.3');    // 1,3× reversé (plafonné)
  const CURRENCY         = process.env.CURRENCY || 'eur';
  const MAX_LAYERS_PER_CELL = parseInt(process.env.MAX_LAYERS_PER_CELL || '2', 10);

  fs.mkdirSync(path.dirname(dbPath), { recursive: true });

  function readDB() {
    try {
      const raw = fs.readFileSync(dbPath, 'utf8');
      const parsed = JSON.parse(raw);
      return { cells: parsed.cells || {} };
    } catch {
      return { cells: {} };
    }
  }

  function writeDB(db) {
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    const toWrite = { cells: db.cells || {} };
    fs.writeFileSync(dbPath, JSON.stringify(toWrite, null, 2), 'utf8');
  }

  function computeCellPriceCents(history) {
    if (!history || history.length === 0) return BASE_CELL_CENTS;
    const last = history[history.length - 1];
    return Math.round(last.priceCents * PRICE_MULTIPLIER);
  }

  // ------- Calcul du devis (réutilisable) -------
  function calcRectQuote({ x, y, w, h, buyerEmail }) {
    try {
      if (
        typeof x !== 'number' || typeof y !== 'number' ||
        typeof w !== 'number' || typeof h !== 'number'
      ) return { ok:false, error:'coords_invalides' };
      if (!buyerEmail) return { ok:false, error:'buyerEmail_requis' };
      if (x < 0 || y < 0 || x + w > GRID_W || y + h > GRID_H) {
        return { ok:false, error:'hors_grille' };
      }

      const db = readDB();

      // Règle : le tout premier acheteur fixe le lot minimum
      let requiredLotW = null, requiredLotH = null;

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
            ok:false,
            error:`lot_minimum_${requiredLotW}x${requiredLotH}`,
            requiredLotW, requiredLotH
          };
        }
      }

      let totalCents = 0;
      let newCells = 0;
      let overlappedCells = 0;

      for (let yy = y; yy < y + h; yy++) {
        for (let xx = x; xx < x + w; xx++) {
          const key = `${xx}:${yy}`;
          const history = db.cells[key];
          const price = computeCellPriceCents(history);
          totalCents += price;
          if (!history || history.length === 0) newCells++;
          else overlappedCells++;
        }
      }

      return {
        ok:true,
        x, y, w, h,
        newCells, overlappedCells,
        totalCents,
        currency: CURRENCY,
        lotRule: (requiredLotW && requiredLotH)
          ? `Ce bloc appartient à un lot initial de ${requiredLotW}x${requiredLotH}`
          : null
      };
    } catch (err) {
      console.error('calcRectQuote error:', err);
      return { ok:false, error:'quote_error' };
    }
  }

  // --------- Route devis ----------
  app.post('/api/purchase-rect/quote', (req, res) => {
    const out = calcRectQuote(req.body || {});
    if (!out.ok) return res.status(400).json(out);
    return res.json(out);
  });

  // --------- Fulfill après paiement ----------
  function fulfillRectDirect({ x, y, w, h, buyerEmail, name='', link='', logo='', color='#1e90ff', msg='' }) {
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
            lotH: h,
            lotOriginX: x,
            lotOriginY: y,
            name, link, logo, color, msg
          });

          if (history.length > MAX_LAYERS_PER_CELL) {
            history.splice(0, history.length - MAX_LAYERS_PER_CELL);
          }

          db.cells[key] = history;
        }
      }

      writeDB(db);
      return { ok:true };
    } catch (err) {
      console.error('fulfillRectDirect error:', err);
      return { ok:false, error:'fulfill_error' };
    }
  }

  // --------- Lecture de l’état pour le front ----------
  app.get('/api/cells', (req,res) => {
    try {
      const db = readDB();
      const latest = {};
      for (const key of Object.keys(db.cells || {})) {
        const hist = db.cells[key];
        if (hist && hist.length) latest[key] = hist[hist.length - 1];
      }
      res.json({ ok:true, width: GRID_W, height: GRID_H, cells: latest });
    } catch (e) {
      console.error(e);
      res.status(500).json({ ok:false, error:'read_cells_error' });
    }
  });

  // Expose pour server.js
  app.locals.calcRectQuote = calcRectQuote;
  app.locals.fulfillRectDirect = fulfillRectDirect;
}

module.exports = { attachRectRoutes };
// server_rect_routes.js
const fs   = require('fs');
const path = require('path');

function attachRectRoutes(app, opts = {}) {
  const dbPath = opts.dbPath || path.join(__dirname, 'data', 'db.json');

  // Config (surchargée par .env si présent)
  const GRID_W = parseInt(process.env.GRID_W || '100', 10);
  const GRID_H = parseInt(process.env.GRID_H || '100', 10);
  const BASE_CELL_CENTS  = parseInt(process.env.BASE_CELL_CENTS || '10000', 10); // 100€ = 10000
  const PRICE_MULTIPLIER = parseFloat(process.env.PRICE_MULTIPLIER || '2');      // ×2 à chaque revente
  const FUSION_FACTOR    = parseFloat(process.env.FUSION_FACTOR    || '1.3');    // 1,3× reversé (plafonné)
  const CURRENCY         = process.env.CURRENCY || 'eur';
  const MAX_LAYERS_PER_CELL = parseInt(process.env.MAX_LAYERS_PER_CELL || '2', 10);

  fs.mkdirSync(path.dirname(dbPath), { recursive: true });

  function readDB() {
    try {
      const raw = fs.readFileSync(dbPath, 'utf8');
      const parsed = JSON.parse(raw);
      return { cells: parsed.cells || {} };
    } catch {
      return { cells: {} };
    }
  }

  function writeDB(db) {
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    const toWrite = { cells: db.cells || {} };
    fs.writeFileSync(dbPath, JSON.stringify(toWrite, null, 2), 'utf8');
  }

  function computeCellPriceCents(history) {
    if (!history || history.length === 0) return BASE_CELL_CENTS;
    const last = history[history.length - 1];
    return Math.round(last.priceCents * PRICE_MULTIPLIER);
  }

  // ------- Calcul du devis (réutilisable) -------
  function calcRectQuote({ x, y, w, h, buyerEmail }) {
    try {
      if (
        typeof x !== 'number' || typeof y !== 'number' ||
        typeof w !== 'number' || typeof h !== 'number'
      ) return { ok:false, error:'coords_invalides' };
      if (!buyerEmail) return { ok:false, error:'buyerEmail_requis' };
      if (x < 0 || y < 0 || x + w > GRID_W || y + h > GRID_H) {
        return { ok:false, error:'hors_grille' };
      }

      const db = readDB();

      // Règle : le tout premier acheteur fixe le lot minimum
      let requiredLotW = null, requiredLotH = null;

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
            ok:false,
            error:`lot_minimum_${requiredLotW}x${requiredLotH}`,
            requiredLotW, requiredLotH
          };
        }
      }

      let totalCents = 0;
      let newCells = 0;
      let overlappedCells = 0;

      for (let yy = y; yy < y + h; yy++) {
        for (let xx = x; xx < x + w; xx++) {
          const key = `${xx}:${yy}`;
          const history = db.cells[key];
          const price = computeCellPriceCents(history);
          totalCents += price;
          if (!history || history.length === 0) newCells++;
          else overlappedCells++;
        }
      }

      return {
        ok:true,
        x, y, w, h,
        newCells, overlappedCells,
        totalCents,
        currency: CURRENCY,
        lotRule: (requiredLotW && requiredLotH)
          ? `Ce bloc appartient à un lot initial de ${requiredLotW}x${requiredLotH}`
          : null
      };
    } catch (err) {
      console.error('calcRectQuote error:', err);
      return { ok:false, error:'quote_error' };
    }
  }

  // --------- Route devis ----------
  app.post('/api/purchase-rect/quote', (req, res) => {
    const out = calcRectQuote(req.body || {});
    if (!out.ok) return res.status(400).json(out);
    return res.json(out);
  });

  // --------- Fulfill après paiement ----------
  function fulfillRectDirect({ x, y, w, h, buyerEmail, name='', link='', logo='', color='#1e90ff', msg='' }) {
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
            lotH: h,
            lotOriginX: x,
            lotOriginY: y,
            name, link, logo, color, msg
          });

          if (history.length > MAX_LAYERS_PER_CELL) {
            history.splice(0, history.length - MAX_LAYERS_PER_CELL);
          }

          db.cells[key] = history;
        }
      }

      writeDB(db);
      return { ok:true };
    } catch (err) {
      console.error('fulfillRectDirect error:', err);
      return { ok:false, error:'fulfill_error' };
    }
  }

  // --------- Lecture de l’état pour le front ----------
  app.get('/api/cells', (req,res) => {
    try {
      const db = readDB();
      const latest = {};
      for (const key of Object.keys(db.cells || {})) {
        const hist = db.cells[key];
        if (hist && hist.length) latest[key] = hist[hist.length - 1];
      }
      res.json({ ok:true, width: GRID_W, height: GRID_H, cells: latest });
    } catch (e) {
      console.error(e);
      res.status(500).json({ ok:false, error:'read_cells_error' });
    }
  });

  // Expose pour server.js
  app.locals.calcRectQuote = calcRectQuote;
  app.locals.fulfillRectDirect = fulfillRectDirect;
}

module.exports = { attachRectRoutes };



