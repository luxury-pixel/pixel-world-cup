// server.js — backend Pixel World Cup
// Lance:  node server.js

const express = require('express');
const dotenv  = require('dotenv');
const path    = require('path');
const cors    = require('cors');
const { attachRectRoutes } = require('./server_rect_routes.js');

dotenv.config();

const app  = express();
const PORT = process.env.PORT || 4242;

/* -------------------- WEBHOOK STRIPE (RAW AVANT json) -------------------- */
app.post('/webhook/stripe', express.raw({ type: 'application/json' }), async (req, res) => {
  try {
    const Stripe = require('stripe');
    const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
    const sig = req.headers['stripe-signature'];
    const event = stripe.webhooks.constructEvent(req.body, sig, process.env.STRIPE_WEBHOOK_SECRET);

    if (event.type === 'checkout.session.completed') {
      const session = event.data.object;
      if (session.metadata?.kind === 'rect') {
        const payload = {
          x: Number(session.metadata.x),
          y: Number(session.metadata.y),
          w: Number(session.metadata.w),
          h: Number(session.metadata.h),
          buyerEmail: session.metadata.buyerEmail
        };
        const out = app.locals.fulfillRectDirect(payload);
        if (!out.ok) console.error('❌ Fulfill rect error:', out.error);
      }
    }
    res.json({ received: true });
  } catch (err) {
    console.error('❌ Webhook error:', err.message);
    res.status(400).send(`Webhook Error: ${err.message}`);
  }
});

/* -------------------- MIDDLEWARES -------------------- */
// CORS: autorise Live Server (5500) et le backend lui-même (4242)
app.use(cors({
  origin: [
    'http://127.0.0.1:5500',
    'http://localhost:5500',
    `http://localhost:${PORT}`
  ],
}));

// JSON (après webhook)
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Fichiers statiques (sert index.html, assets, etc.)
app.use(express.static(__dirname));

/* -------------------- PAGES -------------------- */
app.get('/',        (req,res)=>res.sendFile(path.join(__dirname,'index.html')));
app.get('/success', (req,res)=>res.sendFile(path.join(__dirname,'index.html')));
app.get('/cancel',  (req,res)=>res.sendFile(path.join(__dirname,'index.html')));

/* -------------------- API “RECTANGLE” (règles de lots) -------------------- */
attachRectRoutes(app, { dbPath: path.join(__dirname,'data','db.json') });

/* -------------------- CHECKOUT STRIPE (création session) -------------------- */
app.post('/api/purchase-rect/checkout', async (req, res) => {
  try {
    const { x, y, w, h, buyerEmail } = req.body || {};
    if (!buyerEmail) return res.status(400).json({ error: 'buyerEmail requis' });

    // 1) Devis côté serveur (applique les règles de LOT + revente)
    const qRes = await fetch(`http://localhost:${PORT}/api/purchase-rect/quote`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ x, y, w, h, buyerEmail })
    });
    if (!qRes.ok) {
      const e = await qRes.json().catch(()=>({error:'Devis refusé'}));
      return res.status(400).json(e);
    }
    const quote = await qRes.json();

    // 2) Créer la session Stripe
    const Stripe = require('stripe');
    const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
    const BASE   = process.env.PUBLIC_BASE_URL || `http://localhost:${PORT}`;

    const session = await stripe.checkout.sessions.create({
      mode: 'payment',
      success_url: `${BASE}/index.html?paid=1`,
      cancel_url:  `${BASE}/index.html?canceled=1`,
      customer_email: buyerEmail,
      line_items: [{
        price_data: {
          currency: quote.currency || 'eur',
          product_data: { name: `Achat rectangle ${w}×${h} à (${x},${y})` },
          unit_amount: quote.totalCents
        },
        quantity: 1
      }],
      metadata: { kind:'rect', x:String(x), y:String(y), w:String(w), h:String(h), buyerEmail }
    });

    return res.json({ ok:true, url: session.url });
  } catch (err) {
    console.error('❌ checkout_error:', err);
    res.status(500).json({ error: 'checkout_error' });
  }
});

/* -------------------- DIAG / HEALTH -------------------- */
app.get('/api/health', (req,res)=>res.json({ ok:true, port:PORT, ts:Date.now() }));

/* -------------------- START -------------------- */
app.listen(PORT, () => {
  console.log(`✅ Serveur prêt sur [http://localhost:${PORT}`);
  console.log('ℹ️  Ouvre: http://localhost:4242 (ou via Live Server 5500)');
});