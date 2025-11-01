// server.js
const express = require('express');
const dotenv  = require('dotenv');
const path    = require('path');
const cors    = require('cors');
const { attachRectRoutes } = require('./server_rect_routes.js');

dotenv.config();

const app  = express();
const PORT = process.env.PORT || 4242;

// 1) webhook Stripe (RAW)
app.post(
  '/webhook/stripe',
  express.raw({ type: 'application/json' }),
  async (req, res) => {
    try {
      const Stripe = require('stripe');
      const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
      const sig    = req.headers['stripe-signature'];

      const event  = stripe.webhooks.constructEvent(
        req.body,
        sig,
        process.env.STRIPE_WEBHOOK_SECRET
      );

      if (event.type === 'checkout.session.completed') {
        const session = event.data.object;
        if (session.metadata && session.metadata.kind === 'rect') {
          const payload = {
            x: Number(session.metadata.x),
            y: Number(session.metadata.y),
            w: Number(session.metadata.w),
            h: Number(session.metadata.h),
            buyerEmail: session.metadata.buyerEmail
          };
          const out = app.locals.fulfillRectDirect(payload);
          if (!out.ok) {
            console.error('❌ Fulfill rect ERROR:', out.error);
          }
        }
      }

      res.json({ received: true });
    } catch (err) {
      console.error('Webhook error:', err.message);
      res.status(400).send(`Webhook Error: ${err.message}`);
    }
  }
);

// 2) middlewares normaux
app.use(
  cors({
    origin: [
      'http://127.0.0.1:5500',
      'http://localhost:5500',
      `http://localhost:${PORT}`,
      'https://pixel-world-cup.onrender.com'
    ],
  })
);
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// 3) statiques
app.use(express.static(__dirname));

// 4) pages
app.get('/',        (req, res) => res.sendFile(path.join(__dirname, 'index.html')));
app.get('/buy',     (req, res) => res.sendFile(path.join(__dirname, 'buy.html')));
app.get('/about',   (req, res) => res.sendFile(path.join(__dirname, 'about.html')));
app.get('/cancel',  (req, res) => res.sendFile(path.join(__dirname, 'cancel.html')));
app.get('/success', (req, res) => {
  try {
    res.sendFile(path.join(__dirname, 'success.html'));
  } catch {
    res.sendFile(path.join(__dirname, 'succes.html'));
  }
});

// 5) routes rectangles
attachRectRoutes(app, {
  dbPath: path.join(__dirname, 'data', 'db.json'),
});

// 6) checkout Stripe
app.post('/api/purchase-rect/checkout', async (req, res) => {
  try {
    const { x, y, w, h, buyerEmail } = req.body || {};
    if (!buyerEmail) {
      return res.status(400).json({ error: 'buyerEmail requis' });
    }

    const BASE = process.env.PUBLIC_BASE_URL || `http://localhost:${PORT}`;

    const qRes = await fetch(`${BASE}/api/purchase-rect/quote`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ x, y, w, h, buyerEmail })
    });

    if (!qRes.ok) {
      const e = await qRes.json().catch(() => ({ error: 'Devis refusé' }));
      return res.status(400).json(e);
    }
    const quote = await qRes.json();

    const Stripe = require('stripe');
    const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

    const session = await stripe.checkout.sessions.create({
      mode: 'payment',
      success_url: `${BASE}/success.html`,
      cancel_url:  `${BASE}/cancel.html`,
      customer_email: buyerEmail,
      line_items: [
        {
          price_data: {
            currency: quote.currency || 'eur',
            product_data: {
              name: `Achat bloc ${w}×${h} à (${x},${y})`
            },
            unit_amount: quote.totalCents
          },
          quantity: 1
        }
      ],
      metadata: {
        kind: 'rect',
        x: String(x),
        y: String(y),
        w: String(w),
        h: String(h),
        buyerEmail
      }
    });

    res.json({ ok: true, url: session.url });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'checkout_error' });
  }
});

// 7) start
app.listen(PORT, () => {
  console.log(`✅ Serveur prêt sur [http://localhost:${PORT}`);
});
