// server.js
const express = require("express");
const dotenv = require("dotenv");
const path = require("path");
const cors = require("cors");
const fs = require("fs");
const multer = require("multer");
const Stripe = require("stripe");

dotenv.config();

const { router, calcRectQuote, fulfillRectDirect } = require("./server_rect_routes.js");

const app = express();
const PORT = process.env.PORT || 4242;

// =========================
// 1) Stripe
// =========================
const stripeSecretKey = process.env.STRIPE_SECRET_KEY;
if (!stripeSecretKey) {
  console.error("❌ STRIPE_SECRET_KEY manquante dans .env");
}
const stripe = Stripe(stripeSecretKey || "");

// =========================
// 2) Webhook secret
// =========================
const webhookSecret =
  process.env.STRIPE_WEBHOOK_SECRET ||
  process.env.WHSEC ||
  process.env.STRIPE_WEBHOOK_SIGNING_SECRET;

// =========================
// 3) Dossier uploads
// =========================
const uploadsDir = path.join(__dirname, "uploads");
if (!fs.existsSync(uploadsDir)) {
  fs.mkdirSync(uploadsDir, { recursive: true });
}

// =========================
// 4) Multer config
// =========================
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, uploadsDir);
  },
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname || "").toLowerCase();
    const safeExt = [".png", ".jpg", ".jpeg", ".webp"].includes(ext) ? ext : ".png";
    const uniqueName = `${Date.now()}-${Math.round(Math.random() * 1e9)}${safeExt}`;
    cb(null, uniqueName);
  },
});

const fileFilter = (req, file, cb) => {
  const allowed = ["image/png", "image/jpeg", "image/webp"];
  if (allowed.includes(file.mimetype)) {
    cb(null, true);
  } else {
    cb(new Error("Format non autorisé. Utilise PNG, JPG/JPEG ou WEBP."));
  }
};

const upload = multer({
  storage,
  fileFilter,
  limits: {
    fileSize: 8 * 1024 * 1024, // 8 MB
  },
});

// =========================
// 5) Webhook Stripe (RAW AVANT express.json)
// =========================
app.post("/webhook/stripe", express.raw({ type: "application/json" }), (req, res) => {
  try {
    if (!webhookSecret) {
      console.error("❌ Webhook secret manquant (.env): STRIPE_WEBHOOK_SECRET ou WHSEC");
      return res.status(500).send("Webhook secret manquant côté serveur");
    }

    const sig = req.headers["stripe-signature"];
    const event = stripe.webhooks.constructEvent(req.body, sig, webhookSecret);

    if (event.type === "checkout.session.completed") {
      const session = event.data.object;

      // Sécurité : ne finalise que si payé
      if (session.payment_status !== "paid") {
        return res.json({ received: true });
      }

      if (session.metadata && session.metadata.kind === "rect") {
        const payload = {
          x: Number(session.metadata.x),
          y: Number(session.metadata.y),
          w: Number(session.metadata.w),
          h: Number(session.metadata.h),
          buyerEmail: session.metadata.buyerEmail,
          name: session.metadata.name || "",
          link: session.metadata.link || "",
          logo: session.metadata.logo || "",
          color: session.metadata.color || "#1e90ff",
          msg: session.metadata.msg || "",
        };

        const out = fulfillRectDirect(payload);
        if (!out.ok) console.error("❌ fulfill error:", out.error);
      }
    }

    return res.json({ received: true });
  } catch (err) {
    console.error("Webhook error:", err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }
});

// =========================
// 6) Middlewares JSON APRÈS webhook
// =========================
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Fichiers statiques
app.use(express.static(__dirname));
app.use("/uploads", express.static(uploadsDir));

// =========================
// 7) Pages
// =========================
app.get("/", (req, res) => res.sendFile(path.join(__dirname, "index.html")));
app.get("/success", (req, res) => res.sendFile(path.join(__dirname, "success.html")));
app.get("/cancel", (req, res) => res.sendFile(path.join(__dirname, "cancel.html")));
app.get("/about", (req, res) => res.sendFile(path.join(__dirname, "about.html")));

// =========================
// 8) API routes existantes
// =========================
app.use("/api", router);

// =========================
// 9) Upload image
// =========================
app.post("/api/upload-image", upload.single("image"), (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ ok: false, error: "Aucune image reçue" });
    }

    const BASE = process.env.PUBLIC_BASE_URL || `http://localhost:${PORT}`;
    const fileUrl = `${BASE}/uploads/${req.file.filename}`;

    return res.json({
      ok: true,
      url: fileUrl,
      filename: req.file.filename,
    });
  } catch (e) {
    console.error("upload error:", e);
    return res.status(500).json({ ok: false, error: "upload_error" });
  }
});

// Gestion propre des erreurs multer
app.use((err, req, res, next) => {
  if (err instanceof multer.MulterError) {
    if (err.code === "LIMIT_FILE_SIZE") {
      return res.status(400).json({ ok: false, error: "Image trop lourde (max 8 MB)" });
    }
    return res.status(400).json({ ok: false, error: err.message });
  }

  if (err && err.message) {
    return res.status(400).json({ ok: false, error: err.message });
  }

  next();
});

// =========================
// 10) Stripe checkout
// =========================
app.post("/api/purchase-rect/checkout", async (req, res) => {
  try {
    const body = req.body || {};
    if (!body.buyerEmail) {
      return res.status(400).json({ ok: false, error: "buyerEmail requis" });
    }

    const q = calcRectQuote(body);
    if (!q.ok) {
      return res.status(400).json({ ok: false, error: q.error, lotRule: q.lotRule });
    }

    const BASE = process.env.PUBLIC_BASE_URL || `http://localhost:${PORT}`;

    const session = await stripe.checkout.sessions.create({
      mode: "payment",
      success_url: `${BASE}/success?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${BASE}/cancel`,
      customer_email: body.buyerEmail,
      line_items: [
        {
          price_data: {
            currency: q.currency || "eur",
            product_data: {
              name: `Pixel World Cup — Bloc ${q.w}×${q.h} (${q.x},${q.y})`,
            },
            unit_amount: q.totalCents,
          },
          quantity: 1,
        },
      ],
      metadata: {
        kind: "rect",
        x: String(q.x),
        y: String(q.y),
        w: String(q.w),
        h: String(q.h),
        buyerEmail: body.buyerEmail,
        name: (body.name || "").slice(0, 200),
        link: (body.link || "").slice(0, 500),
        logo: (body.logo || "").slice(0, 500),
        color: (body.color || "").slice(0, 30),
        msg: (body.msg || "").slice(0, 500),
      },
    });

    return res.json({ ok: true, url: session.url });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ ok: false, error: "checkout_error" });
  }
});

// =========================
// 11) Lancement serveur
// =========================
app.listen(PORT, "0.0.0.0", () => {
  console.log(`✅ Serveur prêt - Port ${PORT}`);
  console.log(`➡️ Site: [http://localhost:${PORT}/`)
});

