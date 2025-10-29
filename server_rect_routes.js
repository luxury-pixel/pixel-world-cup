// server_rect_routes.js
const fs = require('fs');
const path = require('path');

const BASE_CELL_CENTS = 10000; // 100 € / case
const CURRENCY = 'eur';
const PAYOUT_MULT = 1.3;       // 1,3× au précédent proprio (plafonné au prix de revente)
const RESALE_MULT = 2.0;       // prix revente = prix précédent ×2

function rect(x,y,w,h){ return {x:Number(x),y:Number(y),w:Number(w),h:Number(h)}; }
function area(R){ return Math.max(0, R.w) * Math.max(0, R.h); }
function intersect(a,b){
  const x1 = Math.max(a.x, b.x);
  const y1 = Math.max(a.y, b.y);
  const x2 = Math.min(a.x + a.w - 1, b.x + b.w - 1);
  const y2 = Math.min(a.y + a.h - 1, b.y + b.h - 1);
  if (x2 < x1 || y2 < y1) return null;
  return rect(x1, y1, x2 - x1 + 1, y2 - y1 + 1);
}
function unionRects(rects){
  if (!rects.length) return null;
  let minX=Infinity,minY=Infinity,maxX=-Infinity,maxY=-Infinity;
  for (const r of rects){
    minX = Math.min(minX, r.x);
    minY = Math.min(minY, r.y);
    maxX = Math.max(maxX, r.x + r.w - 1);
    maxY = Math.max(maxY, r.y + r.h - 1);
  }
  return rect(minX, minY, maxX-minX+1, maxY-minY+1);
}
function cellsIn(R){
  const out = [];
  for(let yy=R.y; yy<R.y+R.h; yy++){
    for(let xx=R.x; xx<R.x+R.w; xx++){
      out.push(`${xx}:${yy}`);
    }
  }
  return out;
}

function readDB(dbPath){
  try{
    const txt = fs.existsSync(dbPath) ? fs.readFileSync(dbPath,'utf8') : '';
    const db = txt ? JSON.parse(txt) : null;
    if (db) return db;
  }catch(e){}
  return { lots: [], ledger: [] };
}
function writeDB(dbPath, db){
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  fs.writeFileSync(dbPath, JSON.stringify(db,null,2));
}

function attachRectRoutes(app, opts = {}){
  const dbPath = opts.dbPath || path.join(__dirname, 'data', 'db.json');
  // init file if missing
  writeDB(dbPath, readDB(dbPath));

  /**
   * Devis + règles :
   * - si chevauche des LOTS => achat intégral de chaque LOT chevauché (pas de partiel)
   * - nouvelles cases hors lots = 100€/case
   * - total renvoyé + breakdown
   */
  app.post('/api/purchase-rect/quote', (req, res) => {
    try{
      const { x, y, w, h, buyerEmail } = req.body || {};
      if (!buyerEmail) return res.status(400).json({ error: 'buyerEmail requis' });

      const sel = rect(x,y,w,h);
      if (sel.w<=0 || sel.h<=0) return res.status(400).json({ error:'rectangle invalide' });

      const db = readDB(dbPath);

      // 1) LOTS touchés
      const touchedLots = [];
      for (const L of db.lots){
        const I = intersect(sel, L);
        if (I) touchedLots.push(L);
      }

      // 2) Union des lots touchés (pour info)
      let forcedLotsRect = touchedLots.length ? unionRects(touchedLots) : null;

      // 3) Nouvelles cases = sel - (tous lots existants)
      const newCells = new Set();
      for (const id of cellsIn(sel)){
        const [cx,cy] = id.split(':').map(Number);
        const cellR = rect(cx,cy,1,1);
        let covered=false;
        for (const L of db.lots){
          if (intersect(cellR,L)){ covered=true; break; }
        }
        if (!covered) newCells.add(id);
      }

      // 4) Pricing
      let totalCents = 0;
      const items = [];

      // lots touchés = revente obligatoire (×2)
      for (const L of touchedLots){
        const cellsCount = L.w * L.h;
        const resalePerCell = Math.round(L.pricePerCellCents * RESALE_MULT);
        const payoutPerCell = Math.min(Math.round(L.pricePerCellCents * PAYOUT_MULT), resalePerCell);
        const platformPerCell = resalePerCell - payoutPerCell;

        totalCents += resalePerCell * cellsCount;
        items.push({
          kind: 'lot-resale',
          lotId: L.id,
          owner: L.owner,
          cells: cellsCount,
          pricePerCellCents: resalePerCell,
          payoutPerCellCents: payoutPerCell,
          platformPerCellCents: platformPerCell,
          subtotalCents: resalePerCell * cellsCount
        });
      }

      // nouvelles cases (100€/case)
      if (newCells.size){
        totalCents += BASE_CELL_CENTS * newCells.size;
        items.push({
          kind: 'new-cells',
          cells: newCells.size,
          pricePerCellCents: BASE_CELL_CENTS,
          subtotalCents: BASE_CELL_CENTS * newCells.size
        });
      }

      return res.json({
        ok: true,
        currency: CURRENCY,
        totalCents,
        overlappedLots: touchedLots.map(L=>({ id:L.id, x:L.x,y:L.y,w:L.w,h:L.h, owner:L.owner })),
        forcedLotsRect,
        newCells: newCells.size,
        items
      });
    } catch(err){
      console.error(err);
      return res.status(500).json({ error:'quote_error' });
    }
  });

  /**
   * fulfillRectDirect() — appelée après succès Stripe
   * - Transfert des lots touchés au nouvel acheteur + maj prix de base (×2)
   * - Création d'un nouveau lot pour les éventuelles nouvelles cases
   */
  app.locals.fulfillRectDirect = function(payload){
    try{
      const { x,y,w,h, buyerEmail } = payload || {};
      const sel = rect(x,y,w,h);
      const db = readDB(dbPath);

      // lots touchés
      const touchedLots = [];
      for (const L of db.lots){
        if (intersect(sel, L)) touchedLots.push(L);
      }

      // transfert lots
      for (const L of touchedLots){
        const resalePerCell = Math.round(L.pricePerCellCents * RESALE_MULT);
        const payoutPerCell = Math.min(Math.round(L.pricePerCellCents * PAYOUT_MULT), resalePerCell);
        const cellsCount = L.w * L.h;

        // ledger payout
        db.ledger.push({
          type:'payout',
          lotId: L.id,
          from: buyerEmail,
          to: L.owner,
          perCellCents: payoutPerCell,
          cells: cellsCount,
          totalCents: payoutPerCell * cellsCount,
          ts: Date.now()
        });

        // transfert + nouveau prix de base (pour prochaine revente)
        L.owner = buyerEmail;
        L.pricePerCellCents = resalePerCell;
      }

      // détecter s'il y a des nouvelles cases dans la sélection
      let hasNew = false;
      OUTER:
      for (let yy=sel.y; yy<sel.y+sel.h; yy++){
        for (let xx=sel.x; xx<sel.x+sel.w; xx++){
          const cellRect = rect(xx,yy,1,1);
          let covered=false;
          for (const L of db.lots){ if (intersect(cellRect,L)){ covered=true; break; } }
          if (!covered){ hasNew=true; break OUTER; }
        }
      }
      if (hasNew){
        const newLot = {
          id: 'lot_'+Math.random().toString(36).slice(2,9),
          x: sel.x, y: sel.y, w: sel.w, h: sel.h,
          owner: buyerEmail,
          pricePerCellCents: BASE_CELL_CENTS
        };
        db.lots.push(newLot);
      }

      writeDB(dbPath, db);
      return { ok:true };
    }catch(e){
      console.error('fulfill error', e);
      return { ok:false, error:e.message };
    }
  };
}

module.exports = { attachRectRoutes };