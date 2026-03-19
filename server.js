// server.js
const express = require("express");
const dotenv = require("dotenv");
const path = require("path");
const cors = require("cors");
const fs = require("fs");
const multer = require("multer");
const Stripe = require("stripe");
const { v2: cloudinary } = require("cloudinary");

dotenv.config();
console.log("SERVER VERSION = CLAIMAPIXEL-LIVE-001");
console.log("PUBLIC_BASE_URL =", process.env.PUBLIC_BASE_URL);
console.log("STRIPE KEY PREFIX =", (process.env.STRIPE_SECRET_KEY || "").slice(0, 7));

const { router, calcRectQuote, fulfillRectDirect } = require("./server_rect_routes.js");

const app = express();
const PORT = process.env.PORT || 4242;

// =========================
// 0) Cloudinary
// =========================
cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
});

// =========================
// 1) Stripe
// =========================
const stripeSecretKey = process.env.STRIPE_SECRET_KEY;

if (!stripeSecretKey) {
  console.error("❌ STRIPE_SECRET_KEY manquante dans l'environnement");
}

const stripe = new Stripe(stripeSecretKey || "");

// =========================
// 2) Webhook secret
// =========================
const webhookSecret =
  process.env.STRIPE_WEBHOOK_SECRET ||
  process.env.WHSEC ||
  process.env.STRIPE_WEBHOOK_SIGNING_SECRET;

// =========================
// 3) Base URL publique
// =========================
const PUBLIC_BASE_URL =
  process.env.PUBLIC_BASE_URL || `http://localhost:${PORT}`;

// =========================
// 4) Dossier uploads
// =========================
const uploadsDir = path.join(__dirname, "uploads");

if (!fs.existsSync(uploadsDir)) {
  fs.mkdirSync(uploadsDir, { recursive: true });
}

// =========================
// 5) Multer config
// =========================
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, uploadsDir);
  },

  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname || "").toLowerCase();
    const safeExt = [".png", ".jpg", ".jpeg", ".webp", ".gif"].includes(ext)
      ? ext
      : ".png";

    const uniqueName = `${Date.now()}-${Math.round(Math.random() * 1e9)}${safeExt}`;
    cb(null, uniqueName);
  },
});

const fileFilter = (req, file, cb) => {
  const allowed = ["image/png", "image/jpeg", "image/webp", "image/gif"];

  if (allowed.includes(file.mimetype)) {
    cb(null, true);
  } else {
    cb(new Error("Format non autorisé. Utilise PNG, JPG/JPEG, WEBP ou GIF."));
  }
};

const upload = multer({
  storage,
  fileFilter,
  limits: {
    fileSize: 8 * 1024 * 1024,
  },
});

// =========================
// 6) Webhook Stripe
// IMPORTANT: avant express.json()
// =========================
app.post("/webhook/stripe", express.raw({ type: "application/json" }), async (req, res) => {
  try {
    if (!webhookSecret) {
      console.error("❌ Webhook secret manquant");
      return res.status(500).send("Webhook secret manquant côté serveur");
    }

    const sig = req.headers["stripe-signature"];
    const event = stripe.webhooks.constructEvent(req.body, sig, webhookSecret);

    console.log("✅ Webhook Stripe reçu:", event.type);

    if (event.type === "checkout.session.completed") {
      const session = event.data.object;

      console.log("🧾 Session checkout complétée:", {
        id: session.id,
        payment_status: session.payment_status,
        livemode: session.livemode,
        metadata: session.metadata,
      });

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

        console.log("🔥 Achat reçu depuis Stripe webhook:", payload);

        const out = await fulfillRectDirect(payload);

        console.log("✅ FULFILL RESULT:", out);

        if (!out.ok) {
          console.error("❌ fulfill error:", out.error || out);
        }
      }
    }

    return res.json({ received: true });
  } catch (err) {
    console.error("❌ Webhook error:", err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }
});

// =========================
// 7) Middlewares JSON
// =========================
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Fichiers statiques
app.use(express.static(__dirname));
app.use("/uploads", express.static(uploadsDir));

// =========================
// 8) Pages
// =========================
app.get("/", (req, res) => res.sendFile(path.join(__dirname, "index.html")));
app.get("/success", (req, res) => res.sendFile(path.join(__dirname, "success.html")));
app.get("/cancel", (req, res) => res.sendFile(path.join(__dirname, "cancel.html")));
app.get("/about", (req, res) => res.sendFile(path.join(__dirname, "about.html")));

// =========================
// 9) API routes existantes
// =========================
app.use("/api", router);

// =========================
// 10) Upload image -> Cloudinary
// =========================
app.post("/api/upload-image", upload.single("image"), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({
        ok: false,
        error: "Aucune image reçue",
      });
    }

    if (
      !process.env.CLOUDINARY_CLOUD_NAME ||
      !process.env.CLOUDINARY_API_KEY ||
      !process.env.CLOUDINARY_API_SECRET
    ) {
      return res.status(500).json({
        ok: false,
        error: "Cloudinary non configuré côté serveur",
      });
    }

    const result = await cloudinary.uploader.upload(req.file.path, {
      folder: "pixel-territory",
      resource_type: "image",
    });

    try {
      fs.unlinkSync(req.file.path);
    } catch (cleanupErr) {
      console.warn("⚠️ Impossible de supprimer le fichier temporaire :", cleanupErr.message);
    }

    return res.json({
      ok: true,
      url: result.secure_url,
      public_id: result.public_id,
    });
  } catch (e) {
    console.error("❌ upload error:", e);
    return res.status(500).json({
      ok: false,
      error: "upload_error",
    });
  }
});

// Gestion erreurs multer
app.use((err, req, res, next) => {
  if (err instanceof multer.MulterError) {
    if (err.code === "LIMIT_FILE_SIZE") {
      return res.status(400).json({
        ok: false,
        error: "Image trop lourde (max 8 MB)",
      });
    }

    return res.status(400).json({
      ok: false,
      error: err.message,
    });
  }

  if (err && err.message) {
    return res.status(400).json({
      ok: false,
      error: err.message,
    });
  }

  next();
});

// =========================
// 11) Stripe checkout
// =========================
app.post("/api/purchase-rect/checkout", async (req, res) => {
  try {
    const body = req.body || {};

    if (!body.buyerEmail) {
      return res.status(400).json({
        ok: false,
        error: "buyerEmail requis",
      });
    }

    const q = calcRectQuote(body);

    if (!q.ok) {
      return res.status(400).json({
        ok: false,
        error: q.error,
        lotRule: q.lotRule,
      });
    }

    console.log("🛒 Création checkout Stripe avec base URL:", PUBLIC_BASE_URL);

    const session = await stripe.checkout.sessions.create({
      mode: "payment",
      success_url: `${PUBLIC_BASE_URL}/success?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${PUBLIC_BASE_URL}/cancel`,
      customer_email: body.buyerEmail,
      line_items: [
        {
          price_data: {
            currency: q.currency || "eur",
            product_data: {
              name: `Pixel Territory — Bloc ${q.w}x${q.h} (${q.x},${q.y})`,
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

    console.log("✅ Session Stripe créée:", {
      id: session.id,
      livemode: session.livemode,
      url: session.url,
    });

    return res.json({
      ok: true,
      url: session.url,
    });
  } catch (e) {
    console.error("❌ checkout_error:", e);
    return res.status(500).json({
      ok: false,
      error: "checkout_error",
    });
  }
});

// =========================
// 12) Lancement serveur
// =========================
app.listen(PORT, "0.0.0.0", () => {
  console.log(`✅ Serveur prêt - Port ${PORT}`);
  console.log(`➡️ Site public: ${PUBLIC_BASE_URL}`);
});

