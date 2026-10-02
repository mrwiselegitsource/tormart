require('dotenv').config();
const express = require('express');
const session = require('express-session');
const svgCaptcha = require('svg-captcha');
const bodyParser = require('body-parser');
const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const multer = require('multer');
const bcrypt = require('bcryptjs');
const fs = require('fs');
const crypto = require('crypto');
const QRCode = require('qrcode');

// Configure multer for static asset uploads (admin panel)
const assetStorage = multer.diskStorage({
    destination: function (req, file, cb) {
        cb(null, path.join(__dirname, 'public/images'))
    },
    filename: function (req, file, cb) {
        // Use the fieldname as the filename (e.g. logo.png, top-banner-1.jpg)
        // We will expect the frontend to pass the exact filename in the field name
        const ext = path.extname(file.originalname) || '.png';
        const finalName = file.fieldname.includes('.') ? file.fieldname : file.fieldname + ext;
        cb(null, finalName);
    }
});
const assetUpload = multer({ storage: assetStorage });

// Configure multer for advert uploads (admin and vendor)
const advertStorage = multer.diskStorage({
    destination: (req, file, cb) => {
        cb(null, path.join(__dirname, 'public/uploads/advert'));
    },
    filename: (req, file, cb) => {
        const ext = path.extname(file.originalname);
        cb(null, Date.now() + ext);
    }
});
const advertUpload = multer({ 
    storage: advertStorage,
    limits: { fileSize: 2 * 1024 * 1024 }, // 2 MB
    fileFilter: (req, file, cb) => {
        if (file.mimetype === 'image/gif') {
            cb(null, true);
        } else {
            cb(new Error('Only GIF images are allowed for adverts.'));
        }
    }
});

const app = express();
const PORT = process.env.PORT || 3000;

// Setup directories
const isVercel = process.env.VERCEL;
const uploadsDir = isVercel ? '/tmp/uploads' : path.join(__dirname, 'public', 'uploads');
const imagesDir = isVercel ? '/tmp/images' : path.join(__dirname, 'public', 'images');
const messagesDir = isVercel ? '/tmp/messages' : path.join(__dirname, 'public', 'images', 'messages');
const advertDir = isVercel ? '/tmp/advert' : path.join(__dirname, 'public', 'uploads', 'advert');
if (!fs.existsSync(uploadsDir)) fs.mkdirSync(uploadsDir, { recursive: true });
if (!fs.existsSync(imagesDir)) fs.mkdirSync(imagesDir, { recursive: true });
if (!fs.existsSync(messagesDir)) fs.mkdirSync(messagesDir, { recursive: true });
if (!fs.existsSync(advertDir)) fs.mkdirSync(advertDir, { recursive: true });

// Setup View Engine
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
// Protect messaging attachments from unauthenticated access
app.use('/images/messages', (req, res, next) => {
    if (!req.session || !req.session.user) {
        return res.status(403).send('Access denied');
    }
    next();
});
app.use(express.static(path.join(__dirname, 'public')));
if (isVercel) {
    app.use('/uploads', express.static('/tmp/uploads'));
    app.use('/images', express.static('/tmp/images'));
}
app.use(express.urlencoded({ extended: true }));
app.use(express.json());

// Global template helpers
app.locals.slugify = (text) => text ? text.toString().toLowerCase().trim().replace(/[\s\W-]+/g, '-') : '';

if (!process.env.SESSION_SECRET) {
    console.error("FATAL ERROR: SESSION_SECRET environment variable is required.");
    process.exit(1);
}

// Session setup (HTTP-Only and Strict for Tor security)
app.use(session({
    secret: process.env.SESSION_SECRET,
    resave: false,
    saveUninitialized: false,
    cookie: {
        secure: process.env.NODE_ENV === 'production',
        httpOnly: true,
        sameSite: 'lax',
        maxAge: 24 * 60 * 60 * 1000
    }
}));

// Setup Multer for file uploads
const storage = multer.diskStorage({
    destination: function (req, file, cb) {
        cb(null, uploadsDir);
    },
    filename: function (req, file, cb) {
        cb(null, Date.now() + '-' + Math.round(Math.random() * 1E9) + path.extname(file.originalname));
    }
});
const upload = multer({ storage: storage });

const imageStorage = multer.diskStorage({
    destination: function (req, file, cb) {
        cb(null, imagesDir);
    },
    filename: function (req, file, cb) {
        cb(null, Date.now() + '-' + Math.round(Math.random() * 1E9) + path.extname(file.originalname));
    }
});
const imageUpload = multer({ storage: imageStorage });

const messageImageStorage = multer.diskStorage({
    destination: function (req, file, cb) {
        cb(null, messagesDir);
    },
    filename: function (req, file, cb) {
        cb(null, 'msg-' + Date.now() + '-' + Math.round(Math.random() * 1E9) + path.extname(file.originalname));
    }
});
const messageImageUpload = multer({ storage: messageImageStorage });

const proofsDir = isVercel ? '/tmp/proofs' : path.join(__dirname, 'public', 'images', 'proofs');
if (!fs.existsSync(proofsDir)) fs.mkdirSync(proofsDir, { recursive: true });
const proofsStorage = multer.diskStorage({
    destination: function (req, file, cb) {
        cb(null, proofsDir);
    },
    filename: function (req, file, cb) {
        cb(null, 'proof-' + Date.now() + '-' + Math.round(Math.random() * 1E9) + path.extname(file.originalname));
    }
});
const proofsUpload = multer({ storage: proofsStorage });

const reviewsDir = isVercel ? '/tmp/reviews' : path.join(__dirname, 'public', 'images', 'reviews');
if (!fs.existsSync(reviewsDir)) fs.mkdirSync(reviewsDir, { recursive: true });
const reviewsStorage = multer.diskStorage({
    destination: function (req, file, cb) {
        cb(null, reviewsDir);
    },
    filename: function (req, file, cb) {
        cb(null, 'review-' + Date.now() + '-' + Math.round(Math.random() * 1E9) + path.extname(file.originalname));
    }
});
const reviewsUpload = multer({ storage: reviewsStorage });

// Database Initialization
const dbPath = isVercel ? '/tmp/neobyte.db' : './neobyte.db';
if (isVercel && !fs.existsSync('/tmp/neobyte.db')) {
    try { fs.copyFileSync(path.join(__dirname, 'neobyte.db'), '/tmp/neobyte.db'); } catch (e) {}
}
const db = new sqlite3.Database(dbPath, (err) => {
    if (err) console.error('Database connection error:', err);
    else {
        console.log('Connected to SQLite database.');
        db.run('PRAGMA journal_mode = WAL;');
        db.run('PRAGMA busy_timeout = 5000;');
    }
});

// Initialize Payment System
const { PaymentService, PaymentStatus } = require('./services/paymentService');
const { PaymentWorker } = require('./services/paymentWorker');
const { BitcoinAdapter } = require('./blockchain/btc');
const { LitecoinAdapter } = require('./blockchain/ltc');
const { BitcoinCashAdapter } = require('./blockchain/bch');

const paymentService = new PaymentService(db);

const adapters = {
    'BTC': new BitcoinAdapter(),
    'LTC': new LitecoinAdapter(),
    'BCH': new BitcoinCashAdapter()
};

const paymentWorker = new PaymentWorker(db, paymentService, adapters);
paymentWorker.start(120000); // Poll every 2 minutes to avoid API spam

// ---- TREASURY SYSTEM INITIALIZATION ----
const { LoginRateLimiter, AuditLogger, StepUpAuth, RoleManager, ADMIN_ROLES, AUDIT_ACTIONS } = require('./services/adminAuth');
const { TreasuryService } = require('./services/treasuryService');
const { WalletManager } = require('./services/walletManager');

// Import wallet providers (signing boundary)
const BtcWalletProvider = require('./services/walletProviders/btcWalletProvider');
const LtcWalletProvider = require('./services/walletProviders/ltcWalletProvider');
const BchWalletProvider = require('./services/walletProviders/bchWalletProvider');

const loginRateLimiter = new LoginRateLimiter();

// Initialize wallet providers (signing boundary - credentials from env only)
const walletProviders = {};
try { walletProviders['BTC'] = new BtcWalletProvider(process.env.BTC_RPC || 'http://localhost:8332', 'user', 'pass'); } catch(e) { console.log('BTC wallet provider not configured:', e.message); }
try { walletProviders['LTC'] = new LtcWalletProvider(process.env.LTC_RPC || 'http://localhost:9332', 'user', 'pass'); } catch(e) { console.log('LTC wallet provider not configured:', e.message); }
try { walletProviders['BCH'] = new BchWalletProvider(process.env.BCH_RPC || 'http://localhost:8332', 'user', 'pass'); } catch(e) { console.log('BCH wallet provider not configured:', e.message); }
const walletManager = new WalletManager(db, walletProviders);
const treasuryService = new TreasuryService(db, walletManager, walletProviders);


function initializeSchema() {
    db.serialize(() => {
        db.run(`CREATE TABLE IF NOT EXISTS users (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            username TEXT UNIQUE,
            email TEXT UNIQUE,
            password TEXT,
            role TEXT DEFAULT 'client',
            is_vendor INTEGER DEFAULT 0,
            vendor_name TEXT,
            vendor_description TEXT,
            vendor_short_description TEXT,
            vendor_logo TEXT,
            vendor_banner TEXT,
            vendor_status TEXT DEFAULT 'pending',
            btc_wallet TEXT,
            vendor_video TEXT,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )`);

        // Add btc_wallet if missing
        db.run(`ALTER TABLE users ADD COLUMN btc_wallet TEXT`, (err) => {
            // Ignore error if column already exists
        });

        // Add vendor_video if missing
        db.run(`ALTER TABLE users ADD COLUMN vendor_video TEXT`, (err) => {
            // Ignore error if column already exists
        });

        // Add admin_chat_unlocked for Support messaging
        db.run(`ALTER TABLE users ADD COLUMN admin_chat_unlocked INTEGER DEFAULT 0`, (err) => {});

        // Add referred_by to track referrals
        db.run(`ALTER TABLE users ADD COLUMN referred_by TEXT`, (err) => {});
        
        // Add vendor_short_description if missing
        db.run(`ALTER TABLE users ADD COLUMN vendor_short_description TEXT`, (err) => {});

        // Add application fields for vendor partnership
        db.run(`ALTER TABLE users ADD COLUMN application_txid TEXT`, (err) => {});
        db.run(`ALTER TABLE users ADD COLUMN application_contact TEXT`, (err) => {});
        db.run(`ALTER TABLE users ADD COLUMN application_date DATETIME`, (err) => {});
        db.run(`ALTER TABLE users ADD COLUMN vendor_delivery_statement TEXT`, (err) => {});

        // Add bonus balance for profile dashboard
        db.run(`ALTER TABLE users ADD COLUMN bonus_balance_usd REAL DEFAULT 0.00`, (err) => {});

        db.run(`CREATE TABLE IF NOT EXISTS address_pool (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            currency TEXT,
            address TEXT,
            is_used INTEGER DEFAULT 0,
            assigned_order_id INTEGER,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            UNIQUE(currency, address)
        )`);

        db.run(`CREATE TABLE IF NOT EXISTS referral_links (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id INTEGER,
            link_name TEXT,
            link_code TEXT UNIQUE,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY(user_id) REFERENCES users(id)
        )`);

        db.run(`CREATE TABLE IF NOT EXISTS products (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            vendor_id INTEGER,
            name TEXT,
            description TEXT,
            price REAL,
            limit_amount REAL,
            image TEXT,
            tier TEXT,
            category TEXT DEFAULT 'Digital Goods',
            rating REAL DEFAULT 4.8,
            is_featured INTEGER DEFAULT 0,
            FOREIGN KEY(vendor_id) REFERENCES users(id)
        )`);

        db.run(`CREATE TABLE IF NOT EXISTS orders (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            invoice_id TEXT,
            user_id INTEGER,
            product_id INTEGER,
            status TEXT DEFAULT 'pending',
            payment_method TEXT,
            payment_proof TEXT,
            card_number TEXT,
            cvv TEXT,
            expiry TEXT,
            delivery_note TEXT,
            download_key TEXT,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY(user_id) REFERENCES users(id),
            FOREIGN KEY(product_id) REFERENCES products(id)
        )`);
        // Ensure columns exist if db was already created
        db.run(`ALTER TABLE orders ADD COLUMN invoice_id TEXT`, (err) => { /* ignore if exists */ });
        db.run(`ALTER TABLE orders ADD COLUMN download_key TEXT`, (err) => { /* ignore if exists */ });
        db.run(`ALTER TABLE orders ADD COLUMN tracking_id TEXT`, (err) => { /* ignore if exists */ });
        db.run(`ALTER TABLE orders ADD COLUMN tracking_status TEXT DEFAULT 'Preparing'`, (err) => { /* ignore if exists */ });
        db.run(`ALTER TABLE orders ADD COLUMN item_location TEXT`, (err) => { /* ignore if exists */ });
        db.run(`ALTER TABLE products ADD COLUMN delivery_type TEXT DEFAULT 'Digital'`, (err) => { /* ignore if exists */ });
        db.run(`CREATE TABLE IF NOT EXISTS messages (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            conversation_id TEXT,
            sender_id INTEGER,
            receiver_id INTEGER,
            subject TEXT,
            body TEXT,
            image_url TEXT,
            is_system INTEGER DEFAULT 0,
            is_read INTEGER DEFAULT 0,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )`);
        
        // Safely add new columns if upgrading from older version
        db.run("ALTER TABLE messages ADD COLUMN conversation_id TEXT", (err) => {});
        db.run("ALTER TABLE messages ADD COLUMN image_url TEXT", (err) => {});
        db.run("ALTER TABLE messages ADD COLUMN is_system INTEGER DEFAULT 0", (err) => {});

        db.run(`CREATE TABLE IF NOT EXISTS reviews (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            vendor_id INTEGER,
            buyer_id INTEGER,
            product_id INTEGER,
            rating INTEGER,
            comment TEXT,
            custom_buyer_name TEXT,
            custom_buyer_role TEXT,
            custom_date DATETIME,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY(vendor_id) REFERENCES users(id),
            FOREIGN KEY(buyer_id) REFERENCES users(id),
            FOREIGN KEY(product_id) REFERENCES products(id)
        )`);

        db.run("ALTER TABLE reviews ADD COLUMN custom_buyer_name TEXT", (err) => {});
        db.run("ALTER TABLE reviews ADD COLUMN custom_buyer_role TEXT", (err) => {});
        db.run("ALTER TABLE reviews ADD COLUMN custom_date DATETIME", (err) => {});

        db.run("ALTER TABLE reviews ADD COLUMN photo_url TEXT", (err) => {});
        db.run("ALTER TABLE reviews ADD COLUMN vendor_reply TEXT", (err) => {});

        db.run(`CREATE TABLE IF NOT EXISTS vendor_proofs (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            vendor_id INTEGER,
            file_url TEXT,
            type TEXT,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY(vendor_id) REFERENCES users(id)
        )`);

        // ---- FORUM TABLES ----
        db.run(`CREATE TABLE IF NOT EXISTS forum_posts (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id INTEGER,
            category TEXT DEFAULT 'General',
            title TEXT NOT NULL,
            body TEXT NOT NULL,
            upvotes INTEGER DEFAULT 0,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY(user_id) REFERENCES users(id)
        )`);

        db.run(`CREATE TABLE IF NOT EXISTS forum_comments (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            post_id INTEGER,
            user_id INTEGER,
            body TEXT NOT NULL,
            upvotes INTEGER DEFAULT 0,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY(post_id) REFERENCES forum_posts(id),
            FOREIGN KEY(user_id) REFERENCES users(id)
        )`);

        db.run(`CREATE TABLE IF NOT EXISTS forum_post_votes (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            post_id INTEGER,
            user_id INTEGER,
            vote INTEGER DEFAULT 1,
            UNIQUE(post_id, user_id)
        )`);

        db.run(`CREATE TABLE IF NOT EXISTS user_follows (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            follower_id INTEGER,
            following_id INTEGER,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            UNIQUE(follower_id, following_id)
        )`);

        db.run(`CREATE TABLE IF NOT EXISTS category_banners (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            category TEXT UNIQUE NOT NULL,
            banner_url TEXT,
            target_link TEXT,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )`);

        db.run(`CREATE TABLE IF NOT EXISTS promo_settings (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            setting_key TEXT UNIQUE,
            setting_value TEXT
        )`);

        db.run(`CREATE TABLE IF NOT EXISTS site_settings (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            setting_key TEXT UNIQUE,
            setting_value TEXT
        )`, (err) => {
            if (!err) {
                db.run(`INSERT OR IGNORE INTO site_settings (setting_key, setting_value) VALUES ('partnership_fee', '$150 in BTC')`);
                db.run(`INSERT OR IGNORE INTO site_settings (setting_key, setting_value) VALUES ('partnership_address', 'bc1qxy2kgdygjrsqtzq2n0yrf2493p83kkfjhx0wlh')`);
                db.run(`INSERT OR IGNORE INTO site_settings (setting_key, setting_value) VALUES ('bonus_percentage', '10')`);
            }
        });

        db.run(`CREATE TABLE IF NOT EXISTS adverts (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            vendor_id INTEGER NOT NULL,
            image_url TEXT NOT NULL,
            target_url TEXT NOT NULL,
            page_key TEXT NOT NULL DEFAULT 'home',
            is_active INTEGER DEFAULT 1,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY (vendor_id) REFERENCES users(id)
        )`, (err) => {
            if (!err) {
                // Add page_key column if it doesn't exist (SQLite doesn't support IF NOT EXISTS in ALTER TABLE add column natively in old versions, but we can catch the error)
                db.run(`ALTER TABLE adverts ADD COLUMN page_key TEXT NOT NULL DEFAULT 'home'`, (e) => {
                    // Ignore error if column already exists
                });
            }
        });

        db.run(`CREATE TABLE IF NOT EXISTS payment_intents (
            id TEXT PRIMARY KEY,
            order_id INTEGER,
            currency TEXT,
            network TEXT,
            expected_amount_crypto TEXT,
            payment_address TEXT,
            status TEXT DEFAULT 'PAYMENT_CREATED',
            required_confirmations INTEGER,
            expires_at DATETIME,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY(order_id) REFERENCES orders(id)
        )`);

        db.run(`CREATE TABLE IF NOT EXISTS payment_transactions (
            id TEXT PRIMARY KEY,
            payment_intent_id TEXT,
            currency TEXT,
            txid TEXT,
            received_amount_crypto TEXT,
            confirmations INTEGER DEFAULT 0,
            status TEXT,
            detected_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            confirmed_at DATETIME,
            failure_reason TEXT,
            metadata TEXT,
            FOREIGN KEY(payment_intent_id) REFERENCES payment_intents(id),
            UNIQUE(currency, txid)
        )`);

        db.run(`CREATE TABLE IF NOT EXISTS payment_events (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            payment_intent_id TEXT,
            event_type TEXT,
            old_status TEXT,
            new_status TEXT,
            metadata TEXT,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY(payment_intent_id) REFERENCES payment_intents(id)
        )`);

        // ---- TREASURY SYSTEM TABLES ----

        // Admin audit log — immutable trail of all privileged operations
        db.run(`CREATE TABLE IF NOT EXISTS admin_audit_log (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            admin_id INTEGER,
            action TEXT NOT NULL,
            resource_type TEXT,
            resource_id TEXT,
            ip_address TEXT,
            user_agent TEXT,
            result TEXT DEFAULT 'SUCCESS',
            failure_reason TEXT,
            metadata TEXT,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )`);

        // Treasury wallet registry
        db.run(`CREATE TABLE IF NOT EXISTS treasury_wallets (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            currency TEXT NOT NULL,
            network TEXT NOT NULL,
            name TEXT NOT NULL,
            type TEXT DEFAULT 'hot',
            status TEXT DEFAULT 'ACTIVE',
            provider TEXT NOT NULL,
            wallet_reference TEXT,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            UNIQUE(currency, network, name)
        )`);

        // Treasury address allocation and tracking
        db.run(`CREATE TABLE IF NOT EXISTS treasury_addresses (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            wallet_id INTEGER NOT NULL,
            currency TEXT NOT NULL,
            network TEXT NOT NULL,
            address TEXT NOT NULL,
            address_type TEXT DEFAULT 'receiving',
            payment_intent_id TEXT,
            order_id INTEGER,
            status TEXT DEFAULT 'AVAILABLE',
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            last_seen_at DATETIME,
            FOREIGN KEY(wallet_id) REFERENCES treasury_wallets(id),
            UNIQUE(currency, network, address)
        )`);

        // Treasury withdrawal lifecycle
        db.run(`CREATE TABLE IF NOT EXISTS treasury_withdrawals (
            id TEXT PRIMARY KEY,
            currency TEXT NOT NULL,
            network TEXT NOT NULL,
            wallet_id INTEGER NOT NULL,
            destination_address TEXT NOT NULL,
            amount_smallest_unit TEXT NOT NULL,
            estimated_fee_smallest_unit TEXT DEFAULT '0',
            actual_fee_smallest_unit TEXT,
            total_debit_smallest_unit TEXT,
            status TEXT DEFAULT 'DRAFT',
            requested_by INTEGER NOT NULL,
            approved_by INTEGER,
            approved_at DATETIME,
            txid TEXT,
            idempotency_key TEXT UNIQUE,
            failure_reason TEXT,
            metadata TEXT,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            broadcast_at DATETIME,
            completed_at DATETIME,
            FOREIGN KEY(wallet_id) REFERENCES treasury_wallets(id),
            FOREIGN KEY(requested_by) REFERENCES users(id),
            FOREIGN KEY(approved_by) REFERENCES users(id)
        )`);

        // Multi-admin approval support
        db.run(`CREATE TABLE IF NOT EXISTS withdrawal_approvals (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            withdrawal_id TEXT NOT NULL,
            admin_id INTEGER NOT NULL,
            action TEXT NOT NULL,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY(withdrawal_id) REFERENCES treasury_withdrawals(id),
            FOREIGN KEY(admin_id) REFERENCES users(id),
            UNIQUE(withdrawal_id, admin_id)
        )`);

        // Treasury operational configuration
        db.run(`CREATE TABLE IF NOT EXISTS treasury_config (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            config_key TEXT UNIQUE NOT NULL,
            config_value TEXT NOT NULL,
            updated_by INTEGER,
            updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )`, (err) => {
            if (!err) {
                db.run(`INSERT OR IGNORE INTO treasury_config (config_key, config_value) VALUES ('treasury_paused', 'false')`);
                db.run(`INSERT OR IGNORE INTO treasury_config (config_key, config_value) VALUES ('max_withdrawal_btc', '10')`);
                db.run(`INSERT OR IGNORE INTO treasury_config (config_key, config_value) VALUES ('max_withdrawal_ltc', '1000')`);
                db.run(`INSERT OR IGNORE INTO treasury_config (config_key, config_value) VALUES ('max_withdrawal_eth', '100')`);
                db.run(`INSERT OR IGNORE INTO treasury_config (config_key, config_value) VALUES ('max_withdrawal_bch', '100')`);
                db.run(`INSERT OR IGNORE INTO treasury_config (config_key, config_value) VALUES ('max_withdrawal_xmr', '500')`);
                db.run(`INSERT OR IGNORE INTO treasury_config (config_key, config_value) VALUES ('require_step_up', 'true')`);
                db.run(`INSERT OR IGNORE INTO treasury_config (config_key, config_value) VALUES ('min_approval_count', '1')`);
            }
        });

        // Add admin_role column to users for role-based access
        db.run("ALTER TABLE users ADD COLUMN admin_role TEXT DEFAULT NULL", (err) => {});

        // Add is_vip column to users if not exists
        db.run("ALTER TABLE users ADD COLUMN is_vip INTEGER DEFAULT 0", (err) => {});

        // Seed forum posts for simulation (if empty)
        db.get("SELECT COUNT(*) AS count FROM forum_posts", (err, row) => {
            if (!err && row && row.count === 0) {
                db.get("SELECT id FROM users WHERE role = 'admin'", (err2, adminUser) => {
                    const uid = adminUser ? adminUser.id : 1;
                    const seedPosts = [
                        ['General', 'Finally got my first card to work — full guide inside', 'Step by step process with screenshots. Tested on 3 different BINs. Ask me anything below.', 847, -2],
                        ['Tips & Tricks', 'Best BIN list for online shopping in 2026 (working)', 'Compiled from 6 months of testing. Sorted by success rate and region.', 1243, -4],
                        ['Vendor Reviews', 'Review: Northstar Labs — 10/10, instant delivery', 'Ordered twice. Both times delivered within 3 minutes of payment confirmation.', 512, -6],
                        ['Help & Support', 'Question: Escrow not releasing after 48 hours?', 'My order was marked complete but escrow still shows pending. Anyone else had this issue?', 93, -8],
                        ['General', 'New to the forum — introduction post', 'Been lurking for months, finally made a purchase and unlocked VIP. This community is gold.', 334, -12],
                        ['Tips & Tricks', 'Full OPSEC guide for staying anonymous on darknet markets', 'Tails OS + Tor Browser + Monero + VPN. Here is how I set it all up.', 2109, -24],
                        ['Vendor Reviews', 'Which vendors have the fastest delivery times? [2026 updated]', 'Ranked list based on community votes. Updated monthly. Comment your experience.', 678, -26],
                        ['General', 'Weekly discussion: Best methods this month?', 'Drop your techniques. Keep it vague for OPSEC but share the concept.', 1567, -48],
                        ['Help & Support', 'Common reasons why newly purchased items may fail and how to fix', 'List of debugging steps that helped me. Saved me a lot of money.', 445, -50],
                        ['Tips & Tricks', 'VPN vs Tor — which is safer for this marketplace?', 'Deep dive into the technical differences and my personal recommendation.', 889, -72],
                        ['General', 'Reached 100 successful orders — AMA', 'Happy to answer questions about my workflow, favourite vendors, and how I avoid issues.', 3021, -96],
                        ['Vendor Reviews', 'WARNING: Fake vendor impersonating a known seller — avoid', 'Screenshots included. Report to admin if you see this username. Stay safe.', 1872, -120],
                    ];
                    const stmt = db.prepare("INSERT INTO forum_posts (user_id, category, title, body, upvotes, created_at) VALUES (?, ?, ?, ?, ?, datetime('now', ? || ' hours'))");
                    seedPosts.forEach(([cat, title, body, upvotes, hoursAgo]) => {
                        stmt.run(uid, cat, title, body, upvotes, String(hoursAgo));
                    });
                    stmt.finalize();
                });
            }
        });


        db.get("SELECT COUNT(*) AS count FROM users WHERE role = 'admin'", (err, row) => {
            if (!err && row.count === 0) {
                if (!process.env.ADMIN_INITIAL_PASSWORD) {
                    console.error("FATAL ERROR: ADMIN_INITIAL_PASSWORD environment variable is required to seed the admin account.");
                    process.exit(1);
                }
                const hash = bcrypt.hashSync(process.env.ADMIN_INITIAL_PASSWORD, 10);
                db.run("INSERT INTO users (username, email, password, role) VALUES (?, ?, ?, ?)", ['admin', 'admin@globalmarket.onion', hash, 'admin']);
            }
        });

        db.get("SELECT id FROM users WHERE vendor_name = 'Northstar Labs'", (err, vendorRow) => {
            if (!vendorRow) {
                const hash = bcrypt.hashSync('vendor123', 10);
                db.run(
                    "INSERT INTO users (username, email, password, role, is_vendor, vendor_name, vendor_description, vendor_short_description, vendor_status) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
                    ['northstar', 'northstar@globalmarket.onion', hash, 'seller', 1, 'Northstar Labs', 'Trusted digital storefront for premium AI assets and automation kits.', 'Trusted digital storefront for premium AI assets and automation kits.', 'approved'],
                    function(err) {
                        const vendorId = this.lastID;
                        db.get("SELECT COUNT(*) AS count FROM products", (err, row) => {
                            if (!err && row.count === 0) {
                                const stmt = db.prepare("INSERT INTO products (vendor_id, name, description, price, limit_amount, image, tier, category, rating, is_featured) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)");
                                stmt.run(vendorId, 'AI Automation Pack', 'Instant delivery of prompt libraries, API templates, and deployment notes.', 48.00, 5000, '/images/ai-asset.svg', 'standard', 'AI Tools', 4.9, 1);
                                stmt.run(vendorId, 'Design Vault Pro', 'Curated UI kits and layered Photoshop assets for rapid product launches.', 89.00, 2500, '/images/design-kit.svg', 'premium', 'Design', 4.8, 1);
                                stmt.run(vendorId, 'Signal Audio Bundle', 'High-fidelity sound design loops and ambient textures for streaming.', 34.00, 1200, '/images/audio-bundle.svg', 'standard', 'Music', 4.7, 0);
                                stmt.finalize();
                            }
                        });
                    }
                );
            }
        });
    });
}

initializeSchema();

// Pass user session to all views
app.use((req, res, next) => {
    if (!req.session.csrfToken) {
        req.session.csrfToken = crypto.randomBytes(16).toString('hex');
    }
    res.locals.user = req.session.user || null;
    res.locals.cartCount = req.session.cart ? Object.keys(req.session.cart).length : 0;
    res.locals.csrfToken = req.session.csrfToken;
    res.locals.currentHost = (req.protocol || 'http') + '://' + req.get('host') + '/';
    
    // Fetch active adverts, site settings, and user purchase history
    db.all("SELECT * FROM adverts WHERE is_active = 1", (err, adverts) => {
        const advertsByPage = {};
        if (adverts) {
            adverts.forEach(ad => {
                advertsByPage[ad.page_key] = advertsByPage[ad.page_key] || [];
                advertsByPage[ad.page_key].push(ad);
            });
        }
        res.locals.smart_adverts = advertsByPage;

        db.all("SELECT * FROM site_settings", (err, sSettings) => {
            const siteSettings = {};
            if (sSettings) sSettings.forEach(s => siteSettings[s.setting_key] = s.setting_value);
            res.locals.siteSettings = siteSettings;
            
            if (req.session.user) {
                db.get("SELECT COUNT(*) AS count FROM orders WHERE user_id = ?", [req.session.user.id], (err, row) => {
                    res.locals.hasPurchased = row && row.count > 0;
                    next();
                });
            } else {
                res.locals.hasPurchased = false;
                next();
            }
        });
    });
});

// Middleware for authentication
const requireAuth = (req, res, next) => {
    if (!req.session.user) {
        // For API requests, return JSON error instead of redirect
        if (req.path.startsWith('/api/') || (req.headers.accept && req.headers.accept.includes('application/json'))) {
            return res.status(401).json({ error: 'Not authenticated. Please log in.' });
        }
        req.session.returnTo = req.originalUrl;
        return res.redirect('/login');
    }
    next();
};

const requireAdmin = (req, res, next) => {
    if (!req.session.user) {
        req.session.returnTo = req.originalUrl;
        return res.redirect('/login');
    }
    if (req.session.user.role !== 'admin') return res.redirect('/');
    next();
};

// Role-based admin middleware factory for treasury system
// Checks both the existing role === 'admin' AND the new admin_role hierarchy
const requireAdminRole = (minRole) => {
    return (req, res, next) => {
        if (!req.session.user) {
            req.session.returnTo = req.originalUrl;
            return res.redirect('/login');
        }
        if (req.session.user.role !== 'admin') {
            return res.status(403).send('Access denied');
        }
        const userAdminRole = req.session.user.admin_role || 'VIEWER';
        if (!RoleManager.hasMinRole(userAdminRole, minRole)) {
            return res.status(403).send('Insufficient treasury permissions');
        }
        next();
    };
};

// Step-up authentication check middleware
const requireStepUp = (req, res, next) => {
    if (!StepUpAuth.verifyStepUp(req.session)) {
        return res.status(403).json({ error: 'Step-up authentication required', requireStepUp: true });
    }
    next();
};

const requireCsrf = (req, res, next) => {
    if (['POST', 'PUT', 'DELETE'].includes(req.method)) {
        const token = (req.body && req.body._csrf) || req.headers['x-csrf-token'] || req.query._csrf;
        if (!token || typeof token !== 'string' || !req.session.csrfToken || token.length !== req.session.csrfToken.length) {
            return res.status(403).send('Invalid CSRF token');
        }
        if (!crypto.timingSafeEqual(Buffer.from(token), Buffer.from(req.session.csrfToken))) {
            return res.status(403).send('Invalid CSRF token');
        }
    }
    next();
};

// Security headers
app.use((req, res, next) => {
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('X-XSS-Protection', '1; mode=block');
    res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
    next();
});

app.use(requireCsrf);

// --- ROUTES ---

app.get('/', (req, res) => {
    db.all("SELECT products.*, users.vendor_name, users.username FROM products LEFT JOIN users ON products.vendor_id = users.id ORDER BY products.is_featured DESC, products.id DESC LIMIT 6", (err, products) => {
        db.all("SELECT * FROM users WHERE is_vendor = 1 AND vendor_status = 'approved' ORDER BY id DESC LIMIT 24", (vErr, vendors) => {
            const featuredCategories = [
                { name: 'AI Tools', emoji: '⚙️' },
                { name: 'Design', emoji: '🎨' },
                { name: 'Music', emoji: '🎵' },
                { name: 'Education', emoji: '📚' }
            ];
            const testimonials = [
                { name: 'Aster', quote: 'The delivery was instant and the seller was responsive.' },
                { name: 'K', quote: 'A calm, privacy-first marketplace that feels premium.' }
            ];
            res.render('index', { products: products || [], vendors: vendors || [], featuredCategories, testimonials });
        });
    });
});

app.get('/category/:name', (req, res) => {
    const categoryName = req.params.name;
    db.get("SELECT * FROM category_banners WHERE LOWER(category) = LOWER(?)", [categoryName], (err, banner) => {
        db.all(`
            SELECT DISTINCT users.* 
            FROM users 
            JOIN products ON users.id = products.vendor_id 
            WHERE LOWER(products.category) = LOWER(?) AND users.vendor_status = 'approved'
        `, [categoryName], (err, vendors) => {
            res.render('vendors', { vendors: vendors || [], categoryName, categoryBanner: banner || null });
        });
    });
});

// Removed /vendor-profile/:id route, using /:vendor_slug at the bottom

app.get('/search', (req, res) => {
    const q = (req.query.q || '').trim();
    const category = req.query.category || '';
    const sql = [];
    const params = [];

    if (q) {
        sql.push('(LOWER(name) LIKE ? OR LOWER(description) LIKE ?)');
        const term = `%${q.toLowerCase()}%`;
        params.push(term, term);
    }

    if (category) {
        sql.push('LOWER(category) = ?');
        params.push(category.toLowerCase());
    }

    const whereClause = sql.length ? `WHERE ${sql.join(' AND ')}` : '';
    db.all(`SELECT products.*, users.vendor_name, users.username FROM products LEFT JOIN users ON products.vendor_id = users.id ${whereClause} ORDER BY products.is_featured DESC, products.id DESC`, params, (err, products) => {
        res.render('products', { products: products || [], query: q, category });
    });
});

// Removed /product/:id route, using /:vendor_slug/:product_slug at the bottom

app.get('/privacy', (req, res) => {
    res.render('privacy');
});

app.get('/faq', (req, res) => {
    res.render('faq');
});

app.get('/free-money', (req, res) => {
    db.all("SELECT * FROM promo_settings", (err, settings) => {
        const promoSettings = {};
        if (settings) {
            settings.forEach(s => promoSettings[s.setting_key] = s.setting_value);
        }
        res.render('free_money', { promoSettings });
    });
});

app.get('/bitcoin-guide', (req, res) => {
    res.render('bitcoin_guide');
});

app.get('/terms', (req, res) => {
    res.render('terms');
});

app.get('/escrow', (req, res) => {
    res.render('escrow');
});

app.get('/refunds', (req, res) => {
    res.render('refunds');
});

app.get('/wishlist', (req, res) => {
    const wishlistIds = req.session.wishlist || [];
    if (!wishlistIds.length) return res.render('wishlist', { wishlistItems: [] });
    const placeholders = wishlistIds.map(() => '?').join(',');
    db.all(`SELECT products.*, users.vendor_name, users.username FROM products LEFT JOIN users ON products.vendor_id = users.id WHERE products.id IN (${placeholders})`, wishlistIds, (err, wishlistItems) => {
        res.render('wishlist', { wishlistItems: wishlistItems || [] });
    });
});

app.post('/wishlist/toggle', (req, res) => {
    const { product_id } = req.body;
    const wishlist = req.session.wishlist || [];
    const exists = wishlist.includes(product_id);
    if (exists) {
        req.session.wishlist = wishlist.filter((id) => id !== product_id);
    } else {
        req.session.wishlist.push(product_id);
    }
    res.redirect(req.get('Referer') || '/');
});

// Cart Routes
app.post('/cart/add', (req, res) => {
    const { product_id, quantity } = req.body;
    const prodId = parseInt(product_id, 10);
    const qty = parseInt(quantity) || 1;
    if (isNaN(prodId)) return req.xhr || req.headers.accept.indexOf('json') > -1 ? res.json({ success: false, error: 'Invalid product' }) : res.redirect('/cart');
    
    if (!req.session.cart) req.session.cart = {};
    
    if (req.session.cart[prodId]) {
        req.session.cart[prodId] += qty;
    } else {
        req.session.cart[prodId] = qty;
    }

    if (req.xhr || req.headers.accept.indexOf('json') > -1) {
        const cartCount = Object.values(req.session.cart).reduce((a, b) => a + b, 0);
        const productIds = Object.keys(req.session.cart).map(id => parseInt(id, 10)).filter(id => !isNaN(id));
        if (productIds.length === 0) {
            return res.json({ success: true, cartCount: 0, cartItems: [], total: 0 });
        }
        const placeholders = productIds.map(() => '?').join(',');
        return db.all(`SELECT * FROM products WHERE id IN (${placeholders})`, productIds, (err, products) => {
            let total = 0;
            const cartItems = (products || []).map(p => {
                const q = req.session.cart[p.id];
                total += (p.price * q);
                return { id: p.id, name: p.name, image: p.image, price: p.price, quantity: q };
            });
            return res.json({ success: true, cartCount: cartCount, cartItems: cartItems, total: total });
        });
    }
    res.redirect('/cart');
});

app.post('/cart/update', (req, res) => {
    const { product_id, quantity } = req.body;
    const prodId = parseInt(product_id, 10);
    const qty = parseInt(quantity);
    if (!isNaN(prodId) && req.session.cart && req.session.cart[prodId]) {
        if (qty > 0) {
            req.session.cart[prodId] = qty;
        } else {
            delete req.session.cart[prodId];
        }
    }
    res.json({ success: true });
});

app.post('/cart/remove', (req, res) => {
    const { product_id } = req.body;
    const prodId = parseInt(product_id, 10);
    if (!isNaN(prodId) && req.session.cart && req.session.cart[prodId]) {
        delete req.session.cart[prodId];
    }
    res.redirect('/cart');
});

app.get('/cart', (req, res) => {
    const cartObj = req.session.cart || {};
    const productIds = Object.keys(cartObj).map(id => parseInt(id, 10)).filter(id => !isNaN(id));
    
    if (productIds.length === 0) {
        return res.render('cart', { cartItems: [], total: 0 });
    }
    
    const placeholders = productIds.map(() => '?').join(',');
    db.all(`SELECT products.*, users.vendor_name, users.username FROM products LEFT JOIN users ON products.vendor_id = users.id WHERE products.id IN (${placeholders})`, productIds, (err, products) => {
        let total = 0;
        const cartItems = (products || []).map(p => {
            const qty = cartObj[p.id];
            total += (p.price * qty);
            return { ...p, quantity: qty };
        });
        res.render('cart', { cartItems, total });
    });
});

app.post('/cart/clear', (req, res) => {
    req.session.cart = {};
    res.redirect('/cart');
});

// Checkout Routes
app.get('/checkout', requireAuth, (req, res) => {
    const cartObj = req.session.cart || {};
    const productIds = Object.keys(cartObj);
    if (productIds.length === 0) return res.redirect('/cart');

    const placeholders = productIds.map(() => '?').join(',');
    db.all(`SELECT * FROM products WHERE id IN (${placeholders})`, productIds, (err, products) => {
        let total = 0;
        const cartItems = (products || []).map(p => {
            const qty = cartObj[p.id];
            total += (p.price * qty);
            return { ...p, quantity: qty };
        });
        res.render('checkout', { cartItems, total });
    });
});

app.post('/checkout', requireAuth, (req, res) => {
    const { payment_method, comment } = req.body;
    const cartObj = req.session.cart || {};
    const productIds = Object.keys(cartObj);
    const userId = req.session.user.id;

    if (productIds.length === 0) {
        return res.redirect('/cart');
    }
    
    // Hardening Task 1: Order Creation Abuse Protection
    const maxActiveOrders = parseInt(process.env.MAX_ACTIVE_ORDERS || "5", 10);
    db.get(`
        SELECT COUNT(i.id) as active_count 
        FROM payment_intents i
        JOIN orders o ON i.order_id = o.id
        WHERE o.user_id = ? AND i.status IN ('PAYMENT_CREATED', 'WAITING_FOR_PAYMENT', 'TRANSACTION_DETECTED', 'CONFIRMING')
    `, [userId], (err, row) => {
        if (err) return res.status(500).send("Database error checking active limits");
        if (row && row.active_count >= maxActiveOrders) {
            return res.status(429).send("Too Many Requests: You have too many active unpaid orders. Please complete or wait for them to expire before placing new orders.");
        }

        // Generate a 6-digit order/invoice ID
        const invoiceId = Math.floor(100000 + Math.random() * 900000).toString();

    const rates = { bitcoin: 79549, litecoin: 54, bitcoincash: 254, dash: 66 };
    const currencyCodes = { bitcoin: 'BTC', litecoin: 'LTC', bitcoincash: 'BCH', dash: 'DASH' };
    
    db.serialize(() => {
        let firstOrderId = null;
        productIds.forEach((productId, index) => {
            const quantity = cartObj[productId];
            const downloadKey = crypto.randomBytes(8).toString('hex');
            
            db.run("INSERT INTO orders (invoice_id, user_id, product_id, payment_method, delivery_note, download_key, status) VALUES (?, ?, ?, ?, ?, ?, 'pending')", 
            [invoiceId, userId, productId, payment_method, comment || '', downloadKey], function(err) {
                if (index === 0) firstOrderId = this.lastID;
                
                db.get("SELECT vendor_id, name, price FROM products WHERE id = ?", [productId], async (err, product) => {
                    if (product) {
                        const vendorId = product.vendor_id;
                        const convId = userId < vendorId ? `${userId}_${vendorId}` : `${vendorId}_${userId}`;
                        const body = `System Message: New order placed for ${quantity}x "${product.name}" (Invoice #${invoiceId}). Awaiting payment confirmation.`;
                        db.run("INSERT INTO messages (conversation_id, sender_id, receiver_id, body, is_system) VALUES (?, ?, ?, ?, 1)", [convId, vendorId, userId, body]);
                        
                        // If it's the first order, create the payment intent
                        if (index === 0 && currencyCodes[payment_method] && currencyCodes[payment_method] !== 'DASH') {
                            const currency = currencyCodes[payment_method];
                            // Calculate total USD manually since we don't have it here yet, just assuming product.price for now (or doing it correctly)
                            // We need full total. Let's get total from products
                            const placeholders = productIds.map(() => '?').join(',');
                            db.all(`SELECT id, price FROM products WHERE id IN (${placeholders})`, productIds, async (err, prods) => {
                                let totalUsd = 0;
                                prods.forEach(p => totalUsd += (p.price * cartObj[p.id]));
                                
                                const cryptoValue = totalUsd / (rates[payment_method] || 1);
                                
                                let expectedAmountCrypto;
                                if (currency === 'BTC' || currency === 'BCH') {
                                    expectedAmountCrypto = adapters['BTC'].btcToSatoshis(cryptoValue).toString();
                                } else if (currency === 'LTC') {
                                    expectedAmountCrypto = adapters['LTC'].ltcToLitoshis(cryptoValue).toString();
                                }
                                
                                // Get wallet address from settings
                                db.all(`SELECT setting_key, setting_value FROM site_settings WHERE setting_key IN ('wallet_btc', 'wallet_ltc', 'wallet_bch')`, async (err, settingsRows) => {
                                    const customWallets = {};
                                    if (settingsRows) {
                                        settingsRows.forEach(r => customWallets[r.setting_key] = r.setting_value);
                                    }
                                    const wallets = {
                                        bitcoin: customWallets['wallet_btc'] || '17HBsuPs4Geoxw73r9NeZGqbGxiAsdNfEE',
                                        litecoin: customWallets['wallet_ltc'] || 'LdQ2WpEZ73CNmQviecrnyiWrnqRhWNLy',
                                        bitcoincash: customWallets['wallet_bch'] || 'qzs02v05l7qs5s24srqju498qu55dwxq08p'
                                    };
                                    
                                    // Support comma-separated lists for multiple addresses (picks one randomly)
                                    const addressList = wallets[payment_method].split(',').map(a => a.trim()).filter(a => a);
                                    const fallbackAddress = addressList[Math.floor(Math.random() * addressList.length)];

                                    db.get(`SELECT id, address FROM address_pool WHERE currency = ? AND is_used = 0 ORDER BY id ASC LIMIT 1`, [currency], async (err, poolRow) => {
                                        let address = fallbackAddress;
                                        if (poolRow) {
                                            address = poolRow.address;
                                            db.run(`UPDATE address_pool SET is_used = 1, assigned_order_id = ? WHERE id = ?`, [firstOrderId, poolRow.id]);
                                        } else {
                                            console.warn(`Address pool for ${currency} is empty! Using static fallback address.`);
                                        }
                                        
                                        await paymentService.createPaymentIntent({
                                            orderId: firstOrderId, // Linking to the first order ID
                                            currency: currency,
                                            network: 'mainnet',
                                            expectedAmountCrypto: expectedAmountCrypto,
                                            paymentAddress: address,
                                            requiredConfirmations: 2
                                        });
                                        
                                        req.session.cart = {};
                                        db.run("UPDATE users SET is_vip = 1 WHERE id = ?", [userId]);
                                        if (req.session.user) req.session.user.is_vip = 1;
                                        res.redirect(`/payment/${invoiceId}`);
                                    });
                                });
                            });
                        } else if (index === 0) {
                            // Fallback for non-crypto or DASH
                            req.session.cart = {};
                            db.run("UPDATE users SET is_vip = 1 WHERE id = ?", [userId]);
                            if (req.session.user) req.session.user.is_vip = 1;
                            res.redirect(`/payment/${invoiceId}`);
                        }
                    }
                });
            });
        });
    });
});
});

app.get('/payment/:invoice_id', requireAuth, (req, res) => {
    const invoiceId = req.params.invoice_id;
    const userId = req.session.user.id;
    
    db.all(`SELECT o.*, p.name, p.price, p.image 
            FROM orders o 
            JOIN products p ON o.product_id = p.id 
            WHERE o.invoice_id = ? AND o.user_id = ?`, [invoiceId, userId], (err, orders) => {
        if (err || !orders || orders.length === 0) {
            return res.redirect('/dashboard');
        }
        
        let totalUsd = 0;
        orders.forEach(o => { totalUsd += o.price; }); 
        
        const method = orders[0].payment_method || 'bitcoin';
        const currencyCodes = { bitcoin: 'BTC', litecoin: 'LTC', bitcoincash: 'BCH', dash: 'DASH' };
        const currency = currencyCodes[method];
        
        db.get(`SELECT * FROM payment_intents WHERE order_id = ?`, [orders[0].id], async (err, intent) => {
            let cryptoAmount = 0;
            let walletAddress = "N/A";
            
            if (intent) {
                walletAddress = intent.payment_address;
                if (currency === 'BTC' || currency === 'BCH' || currency === 'LTC') cryptoAmount = (Number(intent.expected_amount_crypto) / 1e8).toFixed(8);
            } else {
                // Fallback for Dash or unsupported
                const rates = { dash: 66 };
                cryptoAmount = (totalUsd / (rates[method] || 1)).toFixed(6);
            }

            const paymentUri = `${method}:${walletAddress}?amount=${cryptoAmount}`;
            let qrCodeBase64 = '';
            try {
                qrCodeBase64 = await QRCode.toDataURL(paymentUri);
            } catch (err) {
                console.error("QR Code Error:", err);
            }

            res.render('payment', { 
                invoiceId, 
                orders, 
                totalUsd, 
                method,
                walletAddress,
                cryptoAmount,
                currencySymbol: currency || method.toUpperCase(),
                intent: intent || null,
                qrCodeBase64
            });
        });
    });
});

app.post('/payment/:invoice_id/verify', requireAuth, async (req, res) => {
    const invoiceId = req.params.invoice_id;
    const { txid } = req.body;
    try {
        const order = await new Promise((resolve, reject) => {
            db.get(`SELECT id FROM orders WHERE invoice_id = ? AND user_id = ?`, [invoiceId, req.session.user.id], (err, row) => {
                if (err) reject(err); else resolve(row);
            });
        });
        if (!order) return res.redirect(`/payment/${invoiceId}?error=OrderNotFound`);
        
        const intent = await new Promise((resolve, reject) => {
            db.get(`SELECT * FROM payment_intents WHERE order_id = ?`, [order.id], (err, row) => {
                if (err) reject(err); else resolve(row);
            });
        });
        if (!intent) return res.redirect(`/payment/${invoiceId}?error=IntentNotFound`);
        
        await paymentWorker.manualVerifyTxid(intent.id, txid);
        
        if (req.headers.accept && req.headers.accept.includes('application/json')) {
            res.json({ success: true, message: 'Transaction submitted for verification. Checking...' });
        } else {
            res.redirect(`/payment/${invoiceId}?status=checking`);
        }
    } catch (err) {
        if (req.headers.accept && req.headers.accept.includes('application/json')) {
            res.status(500).json({ success: false, message: err.message });
        } else {
            res.redirect(`/payment/${invoiceId}?error=` + encodeURIComponent(err.message));
        }
    }
});

app.get('/payment/:invoice_id/status', requireAuth, (req, res) => {
    const invoiceId = req.params.invoice_id;
    db.get(`SELECT i.status, i.expires_at, i.expected_amount_crypto 
            FROM payment_intents i
            JOIN orders o ON i.order_id = o.id 
            WHERE o.invoice_id = ? AND o.user_id = ?`, [invoiceId, req.session.user.id], (err, intent) => {
        if (err || !intent) return res.json({ status: 'UNKNOWN' });
        res.json(intent);
    });
});


app.get('/download/:orderId', requireAuth, (req, res) => {
    db.get('SELECT orders.*, products.name FROM orders JOIN products ON orders.product_id = products.id WHERE orders.id = ? AND orders.user_id = ?', [req.params.orderId, req.session.user.id], (err, order) => {
        if (!order) return res.status(404).send('Download not found');
        const payload = `GlobalMarket instant delivery\nProduct: ${order.name}\nDownload key: ${order.download_key || 'n/a'}\nUse this link within 24 hours.`;
        res.setHeader('Content-Type', 'text/plain; charset=utf-8');
        res.setHeader('Content-Disposition', `attachment; filename="${order.name.toLowerCase().replace(/\s+/g, '-')}.txt"`);
        res.send(payload);
    });
});

// Auth Routes

app.get('/partner/auth', (req, res) => {
    if (req.session.user) {
        return res.redirect('/partner/dashboard');
    }
    res.render('partner_auth', { error: null });
});

app.post('/partner/register', (req, res) => {
    const { email, password, btc_wallet, captcha } = req.body;
    if (!captcha || !req.session.captcha || captcha.replace(/\\s+/g, '').toLowerCase() !== req.session.captcha.toLowerCase()) {
        return res.render('partner_auth', { error: 'Invalid CAPTCHA code' });
    }
    const username = email.split('@')[0]; // Quick username generation
    const hash = bcrypt.hashSync(password, 10);
    db.run("INSERT INTO users (username, email, password, btc_wallet) VALUES (?, ?, ?, ?)", [username, email, hash, btc_wallet], function(err) {
        if (err) return res.render('partner_auth', { error: 'Email already exists.' });
        req.session.user = { id: this.lastID, username, role: 'client', is_vendor: 0, is_vip: 0 };
        res.redirect('/partner/dashboard');
    });
});

app.post('/partner/login', (req, res) => {
    const { email, password, captcha } = req.body;
    const rateLimitKey = email ? email.toLowerCase() : 'unknown';
    
    if (!captcha || !req.session.captcha || captcha.replace(/\\s+/g, '').toLowerCase() !== req.session.captcha.toLowerCase()) {
        return res.render('partner_auth', { error: 'Invalid CAPTCHA code' });
    }

    const rateCheck = loginRateLimiter.check(rateLimitKey);
    if (!rateCheck.allowed) {
        return res.render('partner_auth', { error: `Too many login attempts. Please try again in ${Math.ceil(rateCheck.retryAfter / 60)} minutes.` });
    }

    db.get("SELECT * FROM users WHERE email = ? OR username = ?", [email, email], (err, user) => {
        if (user && bcrypt.compareSync(password, user.password)) {
            loginRateLimiter.recordSuccess(rateLimitKey);
            req.session.regenerate((err) => {
                req.session.user = { id: user.id, username: user.username, role: user.role, is_vendor: user.is_vendor, is_vip: user.is_vip || 0 };
                return res.redirect('/partner/dashboard');
            });
        } else {
            loginRateLimiter.recordFailure(rateLimitKey);
            res.render('partner_auth', { error: 'Invalid credentials' });
        }
    });
});

app.get('/partner/dashboard', requireAuth, (req, res) => {
    db.get("SELECT btc_wallet FROM users WHERE id = ?", [req.session.user.id], (err, user) => {
        db.all("SELECT * FROM referral_links WHERE user_id = ?", [req.session.user.id], (err, links) => {
            if (!links) links = [];
            
            // Get referral registrations
            const linkCodes = links.map(l => l.link_code);
            let regsQuery = "SELECT username, created_at, referred_by as link_code FROM users WHERE referred_by IN (" + linkCodes.map(() => '?').join(',') + ") ORDER BY created_at DESC";
            
            if (linkCodes.length === 0) regsQuery = "SELECT 1 WHERE 0"; // Empty result if no links
            
            db.all(regsQuery, linkCodes, (err, registrations) => {
                if (!registrations) registrations = [];
                
                // Get orders conversion
                let ordersQuery = `
                    SELECT 
                        u.referred_by as link_code,
                        COUNT(DISTINCT u.id) as registrations,
                        SUM(CASE WHEN o.status = 'pending' THEN 1 ELSE 0 END) as unpaid_orders,
                        SUM(CASE WHEN o.status = 'completed' THEN 1 ELSE 0 END) as paid_orders
                    FROM users u
                    LEFT JOIN orders o ON u.id = o.user_id
                    WHERE u.referred_by IN (` + linkCodes.map(() => '?').join(',') + `)
                    GROUP BY u.referred_by
                `;
                if (linkCodes.length === 0) ordersQuery = "SELECT 1 WHERE 0";
                
                db.all(ordersQuery, linkCodes, (err, conversions) => {
                    if (!conversions) conversions = [];
                    
                    // Map conversion data to links
                    const conversionsMap = {};
                    conversions.forEach(c => { conversionsMap[c.link_code] = c; });
                    
                    res.render('partner_dashboard', { 
                        btc_wallet: user ? user.btc_wallet : 'N/A',
                        referral_links: links,
                        registrations: registrations,
                        conversionsMap: conversionsMap,
                        host: req.get('host')
                    });
                });
            });
        });
    });
});

app.post('/partner/links/add', requireAuth, (req, res) => {
    const linkName = req.body.link_name || 'NO NAME';
    const linkCode = crypto.randomBytes(3).toString('hex').toUpperCase(); // 6 chars
    db.run("INSERT INTO referral_links (user_id, link_name, link_code) VALUES (?, ?, ?)", [req.session.user.id, linkName, linkCode], (err) => {
        res.redirect('/partner/dashboard');
    });
});

// Partner Settings
app.get('/partner/settings', requireAuth, (req, res) => {
    db.get("SELECT email, btc_wallet FROM users WHERE id = ?", [req.session.user.id], (err, user) => {
        res.render('partner_settings', { 
            email: user ? user.email : '',
            btc_wallet: user ? user.btc_wallet : '',
            success: req.query.success || null,
            error: req.query.error || null
        });
    });
});

app.post('/partner/settings/password', requireAuth, (req, res) => {
    const { current_password, new_password } = req.body;
    db.get("SELECT password FROM users WHERE id = ?", [req.session.user.id], (err, user) => {
        if (user && bcrypt.compareSync(current_password, user.password)) {
            const hash = bcrypt.hashSync(new_password, 10);
            db.run("UPDATE users SET password = ? WHERE id = ?", [hash, req.session.user.id], (err) => {
                res.redirect('/partner/settings?success=Password+updated');
            });
        } else {
            res.redirect('/partner/settings?error=Invalid+current+password');
        }
    });
});

app.post('/partner/settings/email', requireAuth, (req, res) => {
    const { email } = req.body;
    db.run("UPDATE users SET email = ? WHERE id = ?", [email, req.session.user.id], (err) => {
        if (err) return res.redirect('/partner/settings?error=Email+already+in+use');
        res.redirect('/partner/settings?success=Email+updated');
    });
});

app.post('/partner/settings/btc', requireAuth, (req, res) => {
    const { btc_wallet } = req.body;
    db.run("UPDATE users SET btc_wallet = ? WHERE id = ?", [btc_wallet, req.session.user.id], (err) => {
        res.redirect('/partner/settings?success=BTC+Wallet+updated');
    });
});

app.get('/captcha', (req, res) => {
    const captcha = svgCaptcha.create({ size: 4, noise: 2, color: true, background: '#f0fdf4', width: 120, height: 40, ignoreChars: '0o1iIlL' });
    req.session.captcha = captcha.text;
    res.type('svg');
    res.status(200).send(captcha.data);
});

app.get('/login', (req, res) => {
    res.render('login', { error: null, hidePromo: true });
});

app.post('/login', (req, res) => {
    const { login_id, password, captcha } = req.body;
    const rateLimitKey = login_id ? login_id.toLowerCase() : 'unknown';

    if (!captcha || !req.session.captcha || captcha.replace(/\\s+/g, '').toLowerCase() !== req.session.captcha.toLowerCase()) {
        return res.render('login', { error: 'Invalid CAPTCHA code', hidePromo: true });
    }

    // Rate limiting check (Tor-aware by username)
    const rateCheck = loginRateLimiter.check(rateLimitKey);
    if (!rateCheck.allowed) {
        return res.render('login', { error: `Too many login attempts. Please try again in ${Math.ceil(rateCheck.retryAfter / 60)} minutes.`, hidePromo: true });
    }

    db.get("SELECT * FROM users WHERE email = ? OR username = ?", [login_id, login_id], (err, user) => {
        if (user && bcrypt.compareSync(password, user.password)) {
            // Clear rate limiter on success
            loginRateLimiter.recordSuccess(rateLimitKey);

            // Session rotation - regenerate session ID to prevent fixation
            const returnTo = req.session.returnTo;
            const cart = req.session.cart;
            req.session.regenerate((err) => {
                req.session.user = { 
                    id: user.id, 
                    username: user.username, 
                    role: user.role, 
                    is_vendor: user.is_vendor, 
                    is_vip: user.is_vip || 0,
                    admin_role: user.admin_role || (user.role === 'admin' ? 'SUPER_ADMIN' : null),
                    vendor_name: user.vendor_name,
                    vendor_description: user.vendor_description,
                    vendor_short_description: user.vendor_short_description,
                    vendor_logo: user.vendor_logo,
                    vendor_banner: user.vendor_banner,
                    vendor_video: user.vendor_video,
                    created_at: user.created_at,
                    btc_wallet: user.btc_wallet
                };
                req.session.cart = cart; // Preserve cart across session rotation
                req.session.csrfToken = crypto.randomBytes(16).toString('hex');

                // Audit log for admin logins
                if (user.role === 'admin') {
                    AuditLogger.log(db, {
                        adminId: user.id,
                        action: AUDIT_ACTIONS.ADMIN_LOGIN,
                        resourceType: 'session',
                        ipAddress: req.ip || '127.0.0.1',
                        userAgent: req.headers['user-agent']
                    });
                }

                const redirectUrl = returnTo || (user.role === 'admin' ? '/admin' : '/dashboard');
                return res.redirect(redirectUrl);
            });
        } else {
            // Record failed attempt
            loginRateLimiter.recordFailure(rateLimitKey);

            // Audit failed admin login attempts (don't reveal if user exists)
            if (user && user.role === 'admin') {
                AuditLogger.log(db, {
                    adminId: user.id,
                    action: AUDIT_ACTIONS.ADMIN_LOGIN_FAILED,
                    resourceType: 'session',
                    ipAddress: '127.0.0.1', // Hidden by Tor
                    userAgent: req.headers['user-agent'],
                    result: 'FAILURE',
                    failureReason: 'Invalid password'
                });
            }

            // Generic error message - don't reveal whether user exists
            res.render('login', { error: 'Invalid credentials', hidePromo: true });
        }
    });
});

app.get('/register', (req, res) => {
    res.redirect('/login');
});

app.get('/invite/:code', (req, res) => {
    req.session.referral_code = req.params.code;
    res.redirect('/login'); // Redirect to login/register page
});

app.post('/register', (req, res) => {
    const { username, password, captcha } = req.body;
    if (!captcha || !req.session.captcha || captcha.replace(/\\s+/g, '').toLowerCase() !== req.session.captcha.toLowerCase()) {
        return res.render('login', { error: 'Invalid CAPTCHA code', hidePromo: true });
    }
    // We will just generate a fake email for now or skip it if the form doesn't have it
    // Wait, the screenshot has only Username and Password for Register. Let's adapt.
    const email = req.body.email || `${username}@user.local`;
    const hash = bcrypt.hashSync(password, 10);
    const referredBy = req.session.referral_code || null;
    
    db.run("INSERT INTO users (username, email, password, referred_by) VALUES (?, ?, ?, ?)", [username, email, hash, referredBy], function(err) {
        if (err) return res.render('login', { error: 'Username already exists.', hidePromo: true });
        
        const newUserId = this.lastID;
        
        // Send automated welcome message from Admin
        db.get("SELECT id FROM users WHERE role = 'admin' LIMIT 1", (err, adminUser) => {
            if (adminUser) {
                const welcomeMessage = "Welcome to Tormart! You have a 10% discount on your first order.";
                const conversationId = adminUser.id < newUserId ? `${adminUser.id}-${newUserId}` : `${newUserId}-${adminUser.id}`;
                db.run("INSERT INTO messages (sender_id, receiver_id, body, conversation_id, is_read) VALUES (?, ?, ?, ?, 0)", [adminUser.id, newUserId, welcomeMessage, conversationId]);
            }
        });

        req.session.user = { id: newUserId, username, role: 'client', is_vendor: 0 };
        const redirectUrl = req.session.returnTo || '/dashboard';
        delete req.session.returnTo;
        res.redirect(redirectUrl);
    });
});

app.get('/logout', (req, res) => {
    req.session.destroy();
    res.redirect('/');
});

// Client Dashboard
// Client Dashboard
app.get('/profile', requireAuth, (req, res) => {
    const userId = req.session.user.id;
    
    // Fetch user details for bonus
    db.get("SELECT bonus_balance_usd FROM users WHERE id = ?", [userId], (err, userRow) => {
        const bonusUsd = userRow ? userRow.bonus_balance_usd : 0.00;
        const btcRate = 65000; // Mock rate
        const bonusBtc = (bonusUsd / btcRate).toFixed(6);

        // Fetch order counts
        db.all("SELECT status, COUNT(*) as count FROM orders WHERE user_id = ? GROUP BY status", [userId], (err, rows) => {
            const orderStats = { unpaid: 0, processing: 0, shipping: 0, waiting_review: 0, completed: 0 };
            let totalPurchases = 0;
            
            if (rows) {
                rows.forEach(r => {
                    if (r.status === 'pending') orderStats.unpaid += r.count;
                    else if (r.status === 'processing') orderStats.processing += r.count;
                    else if (r.status === 'shipping') orderStats.shipping += r.count;
                    else if (r.status === 'delivered') orderStats.waiting_review += r.count;
                    else if (r.status === 'completed') {
                        orderStats.completed += r.count;
                        totalPurchases += r.count;
                    }
                });
            }
            
            // Determine tier
            let tier = 'Regular';
            let avatar = '/images/regular-avatar.png';
            if (totalPurchases >= 7) {
                tier = 'Platinum';
                avatar = '/images/platinum.png';
            } else if (totalPurchases >= 4) {
                tier = 'Gold';
                avatar = '/images/crown.png';
            }
            
            res.render('profile', { bonusUsd, bonusBtc, orderStats, tier, avatar, username: req.session.user.username });
        });
    });
});

app.post('/profile/change-password', requireAuth, (req, res) => {
    const { old_password, new_password, confirm_password } = req.body;
    if (new_password !== confirm_password) {
        return res.redirect('/profile?error=Passwords do not match');
    }
    
    db.get("SELECT password FROM users WHERE id = ?", [req.session.user.id], (err, user) => {
        if (user && bcrypt.compareSync(old_password, user.password)) {
            const hash = bcrypt.hashSync(new_password, 10);
            db.run("UPDATE users SET password = ? WHERE id = ?", [hash, req.session.user.id], (err) => {
                res.redirect('/profile?success=Password changed successfully');
            });
        } else {
            res.redirect('/profile?error=Invalid old password');
        }
    });
});

app.get('/dashboard', requireAuth, (req, res) => {
    db.all(`
        SELECT orders.*, products.name, products.image, products.price 
        FROM orders 
        JOIN products ON orders.product_id = products.id 
        WHERE orders.user_id = ? ORDER BY orders.created_at DESC
    `, [req.session.user.id], (err, orders) => {
        const wishlistIds = req.session.wishlist || [];
        res.render('dashboard', { orders: orders || [], wishlistIds });
    });
});

app.post('/order/complete/:id', requireAuth, reviewsUpload.single('review_photo'), (req, res) => {
    const { rating, comment } = req.body;
    const orderId = req.params.id;
    const userId = req.session.user.id;
    const photo_url = req.file ? '/images/reviews/' + req.file.filename : null;
    
    // Get order details to find the vendor and price
    db.get(`
        SELECT orders.id, products.vendor_id, products.id as product_id, products.price
        FROM orders
        JOIN products ON orders.product_id = products.id
        WHERE orders.id = ? AND orders.user_id = ?
    `, [orderId, userId], (err, order) => {
        if (order) {
            db.run("UPDATE orders SET status = 'completed' WHERE id = ?", [orderId], (err) => {
                // Grant VIP status to user when they complete their first order
                db.run("UPDATE users SET is_vip = 1 WHERE id = ?", [userId]);
                if (req.session.user) req.session.user.is_vip = 1;
                
                // Add Bonus Logic
                db.get("SELECT setting_value FROM site_settings WHERE setting_key = 'bonus_percentage'", (err, setting) => {
                    const bonusPercentage = setting ? parseFloat(setting.setting_value) : 10;
                    const bonusAmount = order.price * (bonusPercentage / 100);
                    if (bonusAmount > 0) {
                        db.run("UPDATE users SET bonus_balance_usd = bonus_balance_usd + ? WHERE id = ?", [bonusAmount, userId]);
                    }
                });

                db.run(
                    "INSERT INTO reviews (vendor_id, buyer_id, product_id, rating, comment, photo_url) VALUES (?, ?, ?, ?, ?, ?)",
                    [order.vendor_id, userId, order.product_id, rating, comment, photo_url],
                    (err) => {
                        // Send system message
                        const convId = userId < order.vendor_id ? `${userId}_${order.vendor_id}` : `${order.vendor_id}_${userId}`;
                        const body = `System Message: The order for this product was marked as completed and a review was left.`;
                        db.run("INSERT INTO messages (conversation_id, sender_id, receiver_id, body, is_system) VALUES (?, ?, ?, ?, 1)", [convId, userId, order.vendor_id, body]);
                        
                        res.redirect('/dashboard');
                    }
                );
            });
        } else {
            res.redirect('/dashboard');
        }
    });
});

app.post('/order/dispute/:id', requireAuth, (req, res) => {
    const orderId = req.params.id;
    const userId = req.session.user.id;
    
    db.run("UPDATE orders SET status = 'disputed' WHERE id = ? AND user_id = ?", [orderId, userId], (err) => {
        res.redirect('/dashboard');
    });
});

app.get('/seller-dashboard', requireAuth, (req, res) => {
    db.all('SELECT * FROM products WHERE vendor_id = ? ORDER BY id DESC', [req.session.user.id], (err, products) => {
        db.all('SELECT orders.*, users.username as customer_name, products.name as product_name FROM orders JOIN users ON orders.user_id = users.id JOIN products ON orders.product_id = products.id WHERE products.vendor_id = ? ORDER BY orders.created_at DESC LIMIT 8', [req.session.user.id], (orderErr, orders) => {
            res.render('seller_dashboard', { products: products || [], orders: orders || [] });
        });
    });
});

// Messaging & Support Routes
app.get('/messages', requireAuth, (req, res) => {
    const userId = req.session.user.id;
    db.all(`
        SELECT u.id, u.username, u.vendor_logo, u.is_vendor, u.role,
               (SELECT body FROM messages WHERE (sender_id = u.id AND receiver_id = ?) OR (sender_id = ? AND receiver_id = u.id) ORDER BY created_at DESC LIMIT 1) as last_message,
               (SELECT created_at FROM messages WHERE (sender_id = u.id AND receiver_id = ?) OR (sender_id = ? AND receiver_id = u.id) ORDER BY created_at DESC LIMIT 1) as last_message_time,
               (SELECT COUNT(*) FROM messages WHERE sender_id = u.id AND receiver_id = ? AND is_read = 0) as unread_count
        FROM users u
        JOIN messages m ON (m.sender_id = u.id OR m.receiver_id = u.id)
        WHERE (m.sender_id = ? OR m.receiver_id = ?) AND u.id != ?
        GROUP BY u.id
        ORDER BY last_message_time DESC
    `, [userId, userId, userId, userId, userId, userId, userId, userId], (err, conversations) => {
        db.get("SELECT id, username FROM users WHERE role = 'admin' LIMIT 1", (err, admin) => {
            db.get("SELECT admin_chat_unlocked FROM users WHERE id = ?", [userId], (err, currentUserRow) => {
                let partnerId = null;
                if (req.query.chat && !isNaN(parseInt(req.query.chat, 10))) {
                    partnerId = parseInt(req.query.chat, 10);
                }
                res.render('messages', { 
                    conversations: conversations || [], 
                    activePartnerId: partnerId, 
                    admin,
                    admin_chat_unlocked: currentUserRow ? currentUserRow.admin_chat_unlocked : 0
                });
            });
        });
    });
});

app.get('/api/messages/:partnerId', requireAuth, (req, res) => {
    const userId = req.session.user.id;
    const partnerId = req.params.partnerId;
    db.all(`
        SELECT * FROM messages 
        WHERE (sender_id = ? AND receiver_id = ?) OR (sender_id = ? AND receiver_id = ?)
        ORDER BY created_at ASC
    `, [userId, partnerId, partnerId, userId], (err, messages) => {
        if (err) return res.status(500).json({error: err.message});
        res.json(messages || []);
    });
});

app.get('/api/conversations', requireAuth, (req, res) => {
    const userId = req.session.user.id;
    db.all(`
        SELECT u.id, u.username, u.vendor_logo, u.is_vendor, u.role,
               (SELECT body FROM messages WHERE (sender_id = u.id AND receiver_id = ?) OR (sender_id = ? AND receiver_id = u.id) ORDER BY created_at DESC LIMIT 1) as last_message,
               (SELECT created_at FROM messages WHERE (sender_id = u.id AND receiver_id = ?) OR (sender_id = ? AND receiver_id = u.id) ORDER BY created_at DESC LIMIT 1) as last_message_time,
               (SELECT COUNT(*) FROM messages WHERE sender_id = u.id AND receiver_id = ? AND is_read = 0) as unread_count
        FROM users u
        JOIN messages m ON (m.sender_id = u.id OR m.receiver_id = u.id)
        WHERE (m.sender_id = ? OR m.receiver_id = ?) AND u.id != ?
        GROUP BY u.id
        ORDER BY last_message_time DESC
    `, [userId, userId, userId, userId, userId, userId, userId, userId], (err, conversations) => {
        if (err) return res.status(500).json({error: err.message});
        res.json(conversations || []);
    });
});

app.post('/api/messages/:partnerId/read', requireAuth, (req, res) => {
    const userId = req.session.user.id;
    const partnerId = req.params.partnerId;
    db.run(`UPDATE messages SET is_read = 1 WHERE sender_id = ? AND receiver_id = ? AND is_read = 0`, [partnerId, userId], function(err) {
        if (err) return res.status(500).json({error: err.message});
        res.json({ success: true, updated: this.changes });
    });
});


app.post('/api/messages/send', requireAuth, function (req, res, next) {
    messageImageUpload.single('image')(req, res, function (err) {
        if (err) {
            console.error("MULTER UPLOAD ERROR:", err);
            return res.status(500).json({ error: "File upload error: " + err.message });
        }
        next();
    });
}, (req, res) => {
    const senderId = req.session.user.id;
    let rawReceiverId = req.body.receiver_id;
    // Handle case where FormData sends an array (duplicate hidden fields)
    if (Array.isArray(rawReceiverId)) rawReceiverId = rawReceiverId[0];
    const receiverId = parseInt(rawReceiverId, 10);
    const body = (req.body.body || '').trim();
    
    let imageUrl = null;
    if (req.file) {
        imageUrl = '/images/messages/' + req.file.filename;
    }
    
    console.log("SEND MESSAGE ATTEMPT:", { senderId, receiverId, body: body.substring(0, 50), imageUrl, rawReceiverId: req.body.receiver_id });

    
    if (!receiverId || isNaN(receiverId) || (!body && !imageUrl)) {
        console.error("SEND MESSAGE REJECTED:", { receiverId, hasBody: !!body, hasImage: !!imageUrl });
        return res.status(400).json({ error: 'Missing required fields (receiver_id=' + receiverId + ')' });
    }
    
    const convId = senderId < receiverId ? senderId + '_' + receiverId : receiverId + '_' + senderId;

    const insertMessage = () => {
        db.run(`
            INSERT INTO messages (conversation_id, sender_id, receiver_id, body, image_url) 
            VALUES (?, ?, ?, ?, ?)
        `, [convId, senderId, receiverId, body, imageUrl], function(err) {
            if (err) {
                console.error("DB INSERT ERROR:", err.message);
                return res.status(500).json({error: err.message});
            }
            console.log("DB INSERT SUCCESS! ID:", this.lastID);
            db.get("SELECT * FROM messages WHERE id = ?", [this.lastID], (err, msg) => {
                res.json(msg);
            });
        });
    };

    // Check if trying to message admin
    db.get("SELECT role FROM users WHERE id = ?", [receiverId], (err, receiverUser) => {
        if (err || !receiverUser) return res.status(404).json({error: "Receiver not found"});
        
        if (receiverUser.role === 'admin' && req.session.user.role !== 'admin') {
            db.get("SELECT admin_chat_unlocked FROM users WHERE id = ?", [senderId], (err, senderUser) => {
                if (err || !senderUser || senderUser.admin_chat_unlocked !== 1) {
                    return res.status(403).json({error: "You cannot reply to this conversation unless the Admin allows it."});
                }
                insertMessage();
            });
        } else {
            insertMessage();
        }
    });
});
app.get('/how-to-buy/:coin', (req, res) => {
    const coinParam = req.params.coin.toLowerCase();
    
    const cryptoData = {
        'bitcoin': { id: 'bitcoin', image: 'bitcoin.png', name: 'Bitcoin', ticker: 'BTC', walletName: 'Bitcoin Core', walletLink: 'https://bitcoin.org/en/choose-your-wallet' },
        'litecoin': { id: 'litecoin', image: 'litecoin.png', name: 'Litecoin', ticker: 'LTC', walletName: 'Litecoin Core', walletLink: 'https://litecoin.org/' },
        'ethereum': { id: 'ethereum', image: 'eth.png', name: 'Ethereum', ticker: 'ETH', walletName: 'MetaMask', walletLink: 'https://metamask.io/' },
        'bitcoincash': { id: 'bitcoincash', image: 'bitcoincash.png', name: 'Bitcoin Cash', ticker: 'BCH', walletName: 'Electron Cash', walletLink: 'https://electroncash.org/' },
        'dash': { id: 'dash', image: 'dash.png', name: 'Dash', ticker: 'DASH', walletName: 'Dash Core', walletLink: 'https://www.dash.org/downloads/' },
        'monero': { id: 'monero', image: 'monero.png', name: 'Monero', ticker: 'XMR', walletName: 'Monero GUI Wallet', walletLink: 'https://www.getmonero.org/downloads/' }
    };
    
    const cryptoInfo = cryptoData[coinParam];
    
    if (!cryptoInfo) {
        return res.redirect('/');
    }
    
    res.render('how_to_buy', { crypto: cryptoInfo });
});

app.get('/support', requireAuth, (req, res) => {
    res.render('support');
});

// Vendor Application System
app.get('/apply-vendor', requireAuth, (req, res) => {
    // If they already applied and are pending, we can send them to a status page or profile
    if (req.session.user.vendor_status === 'pending') {
        return res.redirect('/profile');
    }
    res.render('vendor-apply-landing', { user: req.session.user });
});

app.get('/apply-vendor/step-1', requireAuth, (req, res) => {
    if (req.session.user.vendor_status === 'pending') return res.redirect('/profile');
    res.render('vendor-apply-step1', { user: req.session.user });
});

app.post('/apply-vendor/step-1', requireAuth, (req, res) => {
    const { vendor_name, vendor_short_description, vendor_delivery_statement, application_contact } = req.body;
    db.run(`
        UPDATE users 
        SET vendor_name = ?, vendor_short_description = ?, vendor_delivery_statement = ?, application_contact = ?, vendor_status = 'applying' 
        WHERE id = ?
    `, [vendor_name, vendor_short_description, vendor_delivery_statement, application_contact, req.session.user.id], (err) => {
        req.session.user.vendor_status = 'applying';
        req.session.user.vendor_name = vendor_name;
        res.redirect('/apply-vendor/step-2');
    });
});

app.get('/apply-vendor/step-2', requireAuth, (req, res) => {
    if (req.session.user.vendor_status === 'pending') return res.redirect('/profile');
    
    db.all("SELECT * FROM site_settings", (err, sSettings) => {
        const siteSettings = {};
        if (sSettings) sSettings.forEach(s => siteSettings[s.setting_key] = s.setting_value);
        if (!siteSettings.partnership_fee) siteSettings.partnership_fee = "$150 in BTC";
        if (!siteSettings.partnership_address) siteSettings.partnership_address = "bc1qxy2kgdygjrsqtzq2n0yrf2493p83kkfjhx0wlh";

        res.render('vendor-apply-step2', { user: req.session.user, siteSettings });
    });
});

app.post('/apply-vendor/step-2', requireAuth, (req, res) => {
    const { application_txid } = req.body;
    db.run(`
        UPDATE users 
        SET application_txid = ?, application_date = CURRENT_TIMESTAMP, vendor_status = 'pending' 
        WHERE id = ?
    `, [application_txid, req.session.user.id], (err) => {
        req.session.user.vendor_status = 'pending';
        res.redirect('/profile?success=Application%20submitted%20successfully!');
    });
});

app.get('/chat', requireAuth, (req, res) => {
    res.render('support');
});


// ============================================================
// FORUM ROUTES
// ============================================================

// Helper to check if user is VIP
function isVip(user) {
    if (!user) return false;
    if (user.role === 'admin') return true;
    if (user.is_vendor === 1) return true;
    return user.is_vip === 1;
}

// GET /forum — main forum page
app.get('/forum', (req, res) => {
    const user = req.session.user || null;
    const vip = isVip(user);
    const category = req.query.cat || null;
    const sort = req.query.sort || 'hot'; // hot | new | top

    let orderBy = 'p.upvotes DESC, p.created_at DESC';
    if (sort === 'new') orderBy = 'p.created_at DESC';
    else if (sort === 'top') orderBy = 'p.upvotes DESC';

    let query = `
        SELECT p.*, u.username, 
               (SELECT COUNT(*) FROM forum_comments WHERE post_id = p.id) AS comment_count
        FROM forum_posts p
        JOIN users u ON p.user_id = u.id
        ${category ? "WHERE p.category = ?" : ""}
        ORDER BY ${orderBy}
        LIMIT 30
    `;
    const params = category ? [category] : [];

    db.all(query, params, (err, posts) => {
        res.render('forum', { user, vip, posts: posts || [], category, sort });
    });
});

// GET /forum/post/:id — single post thread (VIP only)
app.get('/forum/post/:id', (req, res) => {
    const user = req.session.user || null;
    if (!isVip(user)) return res.redirect('/forum');
    db.get(`SELECT p.*, u.username FROM forum_posts p JOIN users u ON p.user_id = u.id WHERE p.id = ?`, [req.params.id], (err, post) => {
        if (!post) return res.redirect('/forum');
        db.all(`SELECT c.*, u.username FROM forum_comments c JOIN users u ON c.user_id = u.id WHERE c.post_id = ? ORDER BY c.created_at ASC`, [post.id], (err, comments) => {
            res.render('forum_post', { user, post, comments: comments || [] });
        });
    });
});

// POST /forum/post — create new post (VIP only)
app.post('/forum/post', requireAuth, (req, res) => {
    if (!isVip(req.session.user)) return res.redirect('/forum');
    const { title, body, category } = req.body;
    if (!title || !body) return res.redirect('/forum');
    db.run("INSERT INTO forum_posts (user_id, category, title, body) VALUES (?, ?, ?, ?)",
        [req.session.user.id, category || 'General', title.trim(), body.trim()],
        function(err) {
            if (err) return res.redirect('/forum');
            res.redirect('/forum/post/' + this.lastID);
        }
    );
});

// POST /forum/post/:id/comment — add comment (VIP only)
app.post('/forum/post/:id/comment', requireAuth, (req, res) => {
    if (!isVip(req.session.user)) return res.redirect('/forum');
    const { body } = req.body;
    if (!body) return res.redirect('/forum/post/' + req.params.id);
    db.run("INSERT INTO forum_comments (post_id, user_id, body) VALUES (?, ?, ?)",
        [req.params.id, req.session.user.id, body.trim()],
        (err) => res.redirect('/forum/post/' + req.params.id)
    );
});

// POST /forum/post/:id/vote — upvote a post (VIP only)
app.post('/forum/post/:id/vote', requireAuth, (req, res) => {
    if (!isVip(req.session.user)) return res.json({ error: 'VIP only' });
    const postId = req.params.id;
    const userId = req.session.user.id;
    db.get("SELECT id FROM forum_post_votes WHERE post_id = ? AND user_id = ?", [postId, userId], (err, existing) => {
        if (existing) {
            db.run("DELETE FROM forum_post_votes WHERE post_id = ? AND user_id = ?", [postId, userId]);
            db.run("UPDATE forum_posts SET upvotes = MAX(0, upvotes - 1) WHERE id = ?", [postId]);
            return res.json({ voted: false });
        }
        db.run("INSERT INTO forum_post_votes (post_id, user_id) VALUES (?, ?)", [postId, userId]);
        db.run("UPDATE forum_posts SET upvotes = upvotes + 1 WHERE id = ?", [postId]);
        res.json({ voted: true });
    });
});

// POST /forum/follow/:id — follow a user (VIP only)
app.post('/forum/follow/:id', requireAuth, (req, res) => {
    if (!isVip(req.session.user)) return res.redirect('/forum');
    const followerId = req.session.user.id;
    const followingId = req.params.id;
    if (followerId == followingId) return res.redirect('/forum');
    db.get("SELECT id FROM user_follows WHERE follower_id = ? AND following_id = ?", [followerId, followingId], (err, existing) => {
        if (existing) {
            db.run("DELETE FROM user_follows WHERE follower_id = ? AND following_id = ?", [followerId, followingId]);
        } else {
            db.run("INSERT OR IGNORE INTO user_follows (follower_id, following_id) VALUES (?, ?)", [followerId, followingId]);
        }
        res.redirect(req.get('Referer') || '/forum');
    });
});

app.get('/cooperation', (req, res) => {
    res.render('cooperation');
});

app.get('/about', (req, res) => {
    res.render('about');
});

app.get('/job', (req, res) => {
    // Generate dynamic consistent top partners using seeded PRNG
    function mulberry32(a) {
        return function() {
          var t = a += 0x6D2B79F5;
          t = Math.imul(t ^ t >>> 15, t | 1);
          t ^= t + Math.imul(t ^ t >>> 7, t | 61);
          return ((t ^ t >>> 14) >>> 0) / 4294967296;
        }
    }
    
    function generateTopPartners(seedStr, count, minUsd, maxUsd) {
        let seed = 0;
        for(let i = 0; i < seedStr.length; i++) seed += (seedStr.charCodeAt(i) * (i + 1));
        const prng = mulberry32(seed);
        
        const prefixes = ["Slis", "Wayz", "Blak", "Thr0", "Grab", "Trgo", "Mork", "Rash", "Hall", "Conn", "Vect", "Zork", "Nixx", "Flex", "Bane", "Kilo", "Jaxx"];
        
        let availablePrefixes = [...prefixes];
        // Fisher-Yates shuffle with PRNG
        for (let i = availablePrefixes.length - 1; i > 0; i--) {
            const j = Math.floor(prng() * (i + 1));
            [availablePrefixes[i], availablePrefixes[j]] = [availablePrefixes[j], availablePrefixes[i]];
        }
        
        let partners = [];
        let currentUsd = maxUsd;
        for (let i = 0; i < count; i++) {
            let drop = Math.floor(prng() * ((maxUsd - minUsd) / (count - 1)) * 1.5);
            if (i === 0) drop = 0; 
            currentUsd -= drop;
            if (currentUsd < minUsd) currentUsd = minUsd;
            
            partners.push({
                name: availablePrefixes[i] + "*****",
                usd: Math.round(currentUsd)
            });
        }
        return partners;
    }

    const today = new Date().toISOString().split('T')[0];
    
    // Get ISO week string for weekly seed
    const d = new Date();
    d.setUTCDate(d.getUTCDate() + 4 - (d.getUTCDay()||7));
    const yearStart = new Date(Date.UTC(d.getUTCFullYear(),0,1));
    const weekNo = Math.ceil(( ( (d - yearStart) / 86400000) + 1)/7);
    const weekStr = d.getUTCFullYear() + "-W" + weekNo;

    const topDailyPartners = generateTopPartners("daily" + today, 10, 40, 280);
    const topWeeklyPartners = generateTopPartners("weekly" + weekStr, 10, 400, 2500);

    res.render('job', { topDailyPartners, topWeeklyPartners });
});

app.post('/support/send', requireAuth, (req, res) => {
    const { subject, department, body } = req.body;
    const finalSubject = department ? `[${department}] ${subject}` : subject;

    db.get("SELECT id FROM users WHERE role = 'admin' LIMIT 1", (err, admin) => {
        if (admin) {
            const senderId = req.session.user.id;
            const receiverId = admin.id;
            const convId = senderId < receiverId ? `${senderId}_${receiverId}` : `${receiverId}_${senderId}`;
            db.run("INSERT INTO messages (conversation_id, sender_id, receiver_id, subject, body) VALUES (?, ?, ?, ?, ?)",
                [convId, senderId, receiverId, finalSubject, body],
                (err) => {
                    if (err) {
                        console.error("SUPPORT SEND DB INSERT ERROR:", err.message);
                    } else {
                        console.log("SUPPORT SEND DB INSERT SUCCESS!");
                    }
                    res.redirect('/messages?chat=' + admin.id);
                });
        } else {
            res.redirect('/messages');
        }
    });
});

function requireVendor(req, res, next) {
    if (!req.session.user) {
        req.session.returnTo = req.originalUrl;
        return res.redirect('/login');
    }
    if (req.session.user.is_vendor === 1) {
        next();
    } else {
        if (req.session.user.vendor_status === 'pending') {
            res.redirect('/apply-vendor');
        } else {
            res.redirect('/seller-dashboard');
        }
    }
}

// Vendor Dashboard
app.get('/vendor', requireVendor, (req, res) => {
    db.all('SELECT * FROM products WHERE vendor_id = ? ORDER BY id DESC', [req.session.user.id], (err, products) => {
        db.all(`
            SELECT orders.*, products.name as product_name, products.delivery_type, users.username as customer_name 
            FROM orders 
            JOIN products ON orders.product_id = products.id 
            JOIN users ON orders.user_id = users.id
            WHERE products.vendor_id = ?
            ORDER BY orders.created_at DESC
        `, [req.session.user.id], (err, orders) => {
            db.all('SELECT * FROM vendor_proofs WHERE vendor_id = ? ORDER BY id DESC', [req.session.user.id], (err, proofs) => {
                db.all('SELECT * FROM adverts WHERE vendor_id = ? ORDER BY id DESC', [req.session.user.id], (err, adverts) => {
                    res.render('vendor', { products: products || [], orders: orders || [], proofs: proofs || [], adverts: adverts || [] });
                });
            });
        });
    });
});

app.post('/vendor/products/add', requireVendor, imageUpload.single('product_image'), (req, res) => {
    const { name, description, price, limit_amount, tier, category, delivery_type } = req.body;
    const image = req.file ? '/images/' + req.file.filename : '/images/ai-asset.svg';
    db.run(
        "INSERT INTO products (vendor_id, name, description, price, limit_amount, image, tier, category, delivery_type) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
        [req.session.user.id, name, description, price, limit_amount, image, tier, category, delivery_type || 'Digital'],
        (err) => {
            res.redirect('/vendor');
        }
    );
});

app.post('/vendor/proofs/add', requireVendor, proofsUpload.single('proof_file'), (req, res) => {
    if (!req.file) return res.redirect('/vendor');
    
    const type = req.file.mimetype.startsWith('video/') ? 'video' : 'image';
    const file_url = '/images/proofs/' + req.file.filename;

    db.run(
        "INSERT INTO vendor_proofs (vendor_id, file_url, type) VALUES (?, ?, ?)",
        [req.session.user.id, file_url, type],
        (err) => {
            res.redirect('/vendor');
        }
    );
});

app.post('/vendor/proofs/delete/:id', requireVendor, (req, res) => {
    db.get("SELECT file_url FROM vendor_proofs WHERE id = ? AND vendor_id = ?", [req.params.id, req.session.user.id], (err, proof) => {
        if (proof) {
            const filePath = path.join(__dirname, 'public', proof.file_url);
            fs.unlink(filePath, () => {});
            db.run("DELETE FROM vendor_proofs WHERE id = ?", [req.params.id], () => {
                res.redirect('/vendor');
            });
        } else {
            res.redirect('/vendor');
        }
    });
});

app.post('/vendor/adverts/add', requireVendor, requireCsrf, advertUpload.single('advert_image'), (req, res) => {
    if (!req.file) return res.redirect('/vendor?error=No+file+uploaded');
    
    const target_url = req.body.target_url || '#';
    const image_url = '/uploads/advert/' + req.file.filename;
    const page_key = 'vendor_profile';

    db.run(
        "INSERT INTO adverts (vendor_id, image_url, target_url, page_key) VALUES (?, ?, ?, ?)",
        [req.session.user.id, image_url, target_url, page_key],
        (err) => {
            if (err) console.error("Error adding vendor advert:", err);
            res.redirect('/vendor?success=true');
        }
    );
});

app.post('/vendor/adverts/delete/:id', requireVendor, requireCsrf, (req, res) => {
    db.get("SELECT image_url FROM adverts WHERE id = ? AND vendor_id = ?", [req.params.id, req.session.user.id], (err, advert) => {
        if (advert) {
            const filePath = path.join(__dirname, 'public', advert.image_url);
            if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
            db.run("DELETE FROM adverts WHERE id = ?", [req.params.id], () => {
                res.redirect('/vendor?deleted=true');
            });
        } else {
            res.redirect('/vendor');
        }
    });
});
app.post('/vendor/profile/edit', requireVendor, imageUpload.fields([{ name: 'vendor_logo', maxCount: 1 }, { name: 'vendor_banner', maxCount: 1 }, { name: 'vendor_video', maxCount: 1 }]), (req, res) => {
    const { vendor_name, vendor_description, vendor_short_description, created_at, btc_wallet } = req.body;
    
    let updates = ["vendor_name = ?", "vendor_description = ?", "vendor_short_description = ?"];
    let params = [vendor_name, vendor_description, vendor_short_description];
    
    if (btc_wallet !== undefined) {
        updates.push("btc_wallet = ?");
        params.push(btc_wallet);
    }
    
    if (created_at) {
        // created_at comes as 'YYYY-MM-DD' from the date picker
        // Let's add an arbitrary time if we just get a date
        const dateStr = created_at.includes('T') ? created_at : created_at + ' 12:00:00';
        updates.push("created_at = ?");
        params.push(dateStr);
    }
    
    if (req.files) {
        if (req.files['vendor_logo']) {
            const logo_url = '/images/' + req.files['vendor_logo'][0].filename;
            updates.push("vendor_logo = ?");
            params.push(logo_url);
            req.session.user.vendor_logo = logo_url;
        }
        if (req.files['vendor_banner']) {
            const banner_url = '/images/' + req.files['vendor_banner'][0].filename;
            updates.push("vendor_banner = ?");
            params.push(banner_url);
            req.session.user.vendor_banner = banner_url;
        }
        if (req.files['vendor_video']) {
            const video_url = '/images/' + req.files['vendor_video'][0].filename;
            updates.push("vendor_video = ?");
            params.push(video_url);
            req.session.user.vendor_video = video_url;
        }
    }
    
    params.push(req.session.user.id);
    const query = `UPDATE users SET ${updates.join(', ')} WHERE id = ?`;
    
    db.run(query, params, function(err) {
        if (!err) {
            req.session.user.vendor_name = vendor_name;
            req.session.user.vendor_description = vendor_description;
            req.session.user.vendor_short_description = vendor_short_description;
            if (created_at) req.session.user.created_at = req.body.created_at;
            if (btc_wallet !== undefined) req.session.user.btc_wallet = btc_wallet;
        }
        res.redirect('/vendor');
    });
});

app.post('/vendor/simulate-review', requireVendor, upload.single('review_media'), (req, res) => {
    const { custom_buyer_name, custom_buyer_role, rating, product_id, custom_date, comment } = req.body;
    
    // We parse custom_date and add arbitrary time for DATETIME column
    const dateStr = custom_date.includes('T') ? custom_date : custom_date + ' 12:00:00';
    const prodId = product_id ? parseInt(product_id) : null;
    const photoUrl = req.file ? `/uploads/${req.file.filename}` : null;
    
    db.run(
        "INSERT INTO reviews (vendor_id, product_id, rating, comment, custom_buyer_name, custom_buyer_role, custom_date, photo_url) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
        [req.session.user.id, prodId, rating, comment, custom_buyer_name, custom_buyer_role, dateStr, photoUrl],
        () => {
            res.redirect('/vendor');
        }
    );
});

app.post('/vendor/review/reply/:id', requireVendor, (req, res) => {
    const reviewId = req.params.id;
    const { vendor_reply } = req.body;
    
    // First, ensure the review belongs to this vendor
    db.get("SELECT vendor_id FROM reviews WHERE id = ?", [reviewId], (err, review) => {
        if (err || !review) return res.redirect('/vendor');
        if (review.vendor_id !== req.session.user.id) return res.redirect('/vendor');
        
        db.run("UPDATE reviews SET vendor_reply = ? WHERE id = ?", [vendor_reply, reviewId], () => {
            // Redirect back to profile page so vendor can see their reply
            res.redirect(req.get('referer') || '/dashboard');
        });
    });
});

app.post('/vendor/order/:id/fulfill', requireVendor, (req, res) => {
    const { download_key } = req.body;
    const orderId = req.params.id;
    
    // Verify order belongs to a product owned by this vendor
    db.get(`
        SELECT orders.id FROM orders 
        JOIN products ON orders.product_id = products.id 
        WHERE orders.id = ? AND products.vendor_id = ?
    `, [orderId, req.session.user.id], (err, order) => {
        if (order) {
            db.run(
                "UPDATE orders SET status = 'shipped', download_key = ? WHERE id = ?",
                [download_key, orderId],
                (err) => {
                    res.redirect('/vendor');
                }
            );
        } else {
            res.redirect('/vendor');
        }
    });
});

// Vendor: Update Physical Order Tracking
app.post('/vendor/order/:id/tracking', requireVendor, (req, res) => {
    const { tracking_id, tracking_status, item_location } = req.body;
    const orderId = req.params.id;
    const crypto = require('crypto');
    const finalTrackingId = tracking_id || ('TRK-' + crypto.randomBytes(4).toString('hex').toUpperCase());
    
    db.get(`
        SELECT orders.id FROM orders 
        JOIN products ON orders.product_id = products.id 
        WHERE orders.id = ? AND products.vendor_id = ?
    `, [orderId, req.session.user.id], (err, order) => {
        if (order) {
            db.run(
                "UPDATE orders SET tracking_id = ?, tracking_status = ?, item_location = ?, status = 'shipped' WHERE id = ?",
                [finalTrackingId, tracking_status || 'In Transit', item_location || '', orderId],
                (err) => {
                    res.redirect('/vendor');
                }
            );
        } else {
            res.redirect('/vendor');
        }
    });
});

app.post('/vendor/products/edit/:id', requireVendor, imageUpload.single('product_image'), (req, res) => {
    const { name, description, price, limit_amount, tier, category, delivery_type } = req.body;
    
    db.get("SELECT id, image FROM products WHERE id = ? AND vendor_id = ?", [req.params.id, req.session.user.id], (err, product) => {
        if (!product) return res.redirect('/vendor');
        
        const updateParams = [name, description, price, limit_amount, tier, category, delivery_type || 'Digital'];
        let query = "UPDATE products SET name = ?, description = ?, price = ?, limit_amount = ?, tier = ?, category = ?, delivery_type = ?";
        
        if (req.file) {
            query += ", image = ?";
            updateParams.push('/images/' + req.file.filename);
            
            if (product.image && !product.image.includes('ai-asset') && !product.image.includes('default')) {
                const oldPath = path.join(__dirname, 'public', product.image);
                fs.unlink(oldPath, () => {});
            }
        }
        
        query += " WHERE id = ? AND vendor_id = ?";
        updateParams.push(req.params.id, req.session.user.id);
        
        db.run(query, updateParams, () => {
            res.redirect('/vendor');
        });
    });
});

app.post('/vendor/products/delete/:id', requireVendor, (req, res) => {
    db.get("SELECT id, image FROM products WHERE id = ? AND vendor_id = ?", [req.params.id, req.session.user.id], (err, product) => {
        if (product) {
            if (product.image && !product.image.includes('ai-asset') && !product.image.includes('default')) {
                const oldPath = path.join(__dirname, 'public', product.image);
                fs.unlink(oldPath, () => {});
            }
            db.run("DELETE FROM products WHERE id = ?", [req.params.id], () => {
                res.redirect('/vendor');
            });
        } else {
            res.redirect('/vendor');
        }
    });
});

app.post('/admin/support/toggle-lock', requireAdmin, (req, res) => {
    const userId = req.body.user_id;
    const unlockStatus = req.body.unlocked === '1' ? 1 : 0;
    
    if (!userId) return res.status(400).json({error: "Missing user_id"});

    db.run("UPDATE users SET admin_chat_unlocked = ? WHERE id = ?", [unlockStatus, userId], function(err) {
        if (err) return res.status(500).json({error: err.message});
        res.json({success: true, unlocked: unlockStatus});
    });
});

// Admin Dashboard
app.get('/admin', requireAdmin, (req, res) => {
    db.all(`
        SELECT orders.*, users.username as customer_name, products.name as product_name, vendors.username as vendor_name, vendors.btc_wallet
        FROM orders 
        JOIN users ON orders.user_id = users.id 
        JOIN products ON orders.product_id = products.id 
        JOIN users as vendors ON products.vendor_id = vendors.id
        ORDER BY orders.created_at DESC LIMIT 100
    `, (err, orders) => {
        db.all("SELECT * FROM users WHERE is_vendor = 1 ORDER BY id DESC", (err, vendors) => {
            db.all("SELECT * FROM promo_settings", (err, settings) => {
                const promoSettings = {};
                if (settings) {
                    settings.forEach(s => promoSettings[s.setting_key] = s.setting_value);
                }
                
                db.all("SELECT * FROM site_settings", (err, sSettings) => {
                    const siteSettings = {};
                    if (sSettings) sSettings.forEach(s => siteSettings[s.setting_key] = s.setting_value);
                    
                    db.all("SELECT * FROM users WHERE vendor_status = 'pending' AND application_txid IS NOT NULL ORDER BY id DESC", (err, vendorApplications) => {
                        db.all(`
                            SELECT u.id, u.username, u.admin_chat_unlocked, 
                                   MAX(m.created_at) as last_contact,
                                   (SELECT body FROM messages WHERE sender_id = u.id AND receiver_id = ? ORDER BY created_at DESC LIMIT 1) as last_message
                            FROM users u
                            JOIN messages m ON (m.sender_id = u.id AND m.receiver_id = ?)
                            GROUP BY u.id
                            ORDER BY last_contact DESC
                        `, [req.session.user.id, req.session.user.id], (err, supportUsers) => {
                            db.all(`
                                SELECT pi.*, o.invoice_id, u.username
                                FROM payment_intents pi
                                JOIN orders o ON pi.order_id = o.id
                                JOIN users u ON o.user_id = u.id
                                ORDER BY pi.created_at DESC LIMIT 100
                            `, (err, paymentIntents) => {
                                res.render('admin', { 
                                    orders: orders || [], 
                                    vendors: vendors || [], 
                                    promoSettings, 
                                    siteSettings, 
                                    vendorApplications: vendorApplications || [], 
                                    supportUsers: supportUsers || [],
                                    paymentIntents: paymentIntents || []
                                });
                            });
                        });
                    });
                });
            });
        });
    });
});

app.post('/admin/order/:id/resolve', requireAdmin, (req, res) => {
    const { resolution } = req.body;
    const newStatus = resolution === 'refund' ? 'refunded' : 'completed';
    db.run("UPDATE orders SET status = ? WHERE id = ?", [newStatus, req.params.id], (err) => {
        res.redirect('/admin');
    });
});

app.post('/admin/order/:id/mark_paid', requireAdmin, (req, res) => {
    db.run("UPDATE orders SET status = 'paid_out' WHERE id = ?", [req.params.id], (err) => {
        res.redirect('/admin');
    });
});

app.post('/admin/site-settings', requireAdmin, (req, res) => {
    const { partnership_fee, partnership_address, bonus_percentage } = req.body;
    db.serialize(() => {
        const stmt = db.prepare(`
            INSERT INTO site_settings (setting_key, setting_value) 
            VALUES (?, ?) 
            ON CONFLICT(setting_key) DO UPDATE SET setting_value = excluded.setting_value
        `);
        stmt.run('partnership_fee', partnership_fee);
        if (bonus_percentage) stmt.run('bonus_percentage', bonus_percentage);
        stmt.run('partnership_address', partnership_address, (err) => {
            res.redirect('/admin');
        });
        stmt.finalize();
    });
});

app.post('/admin/crypto-settings', requireAdmin, (req, res) => {
    const { wallet_btc, wallet_ltc, wallet_eth, wallet_bch, wallet_xmr } = req.body;
    db.serialize(() => {
        const stmt = db.prepare(`
            INSERT INTO site_settings (setting_key, setting_value) 
            VALUES (?, ?) 
            ON CONFLICT(setting_key) DO UPDATE SET setting_value = excluded.setting_value
        `);
        if (wallet_btc !== undefined) stmt.run("wallet_btc", wallet_btc);
        if (wallet_ltc !== undefined) stmt.run("wallet_ltc", wallet_ltc);
        if (wallet_eth !== undefined) stmt.run("wallet_eth", wallet_eth);
        if (wallet_bch !== undefined) stmt.run("wallet_bch", wallet_bch);
        if (wallet_xmr !== undefined) stmt.run("wallet_xmr", wallet_xmr);
        
        stmt.finalize(() => {
            res.redirect('/admin?cryptoSaved=true');
        });
    });
});

// ---- ADDRESS POOL ROUTES ----
app.get('/admin/address-pool', requireAdmin, (req, res) => {
    db.all(`SELECT currency, COUNT(*) as total, SUM(CASE WHEN is_used = 0 THEN 1 ELSE 0 END) as unused FROM address_pool GROUP BY currency`, (err, rows) => {
        const stats = {};
        ['BTC', 'LTC', 'ETH', 'BCH', 'XMR'].forEach(c => stats[c] = { total: 0, unused: 0 });
        if (rows) {
            rows.forEach(r => {
                stats[r.currency] = {
                    total: r.total,
                    unused: r.unused || 0
                };
            });
        }
        res.render('admin_address_pool', { user: req.session.user, stats, query: req.query });
    });
});

app.post('/admin/address-pool', requireAdmin, (req, res) => {
    const { currency, addresses } = req.body;
    if (!currency || !addresses) {
        return res.redirect('/admin/address-pool?error=Missing+currency+or+addresses');
    }
    
    const list = addresses.split(/[\n,]+/).map(a => a.trim()).filter(a => a);
    if (list.length === 0) return res.redirect('/admin/address-pool?error=No+valid+addresses+found');
    
    const stmt = db.prepare(`INSERT OR IGNORE INTO address_pool (currency, address) VALUES (?, ?)`);
    db.serialize(() => {
        list.forEach(address => {
            stmt.run(currency, address);
        });
        stmt.finalize(() => {
            res.redirect(`/admin/address-pool?success=true&count=${list.length}`);
        });
    });
});

// ---- ADMIN ADVERTS MANAGER ----
app.get('/admin/adverts', requireAdmin, (req, res) => {
    db.all(`SELECT a.*, u.username as vendor_name FROM adverts a LEFT JOIN users u ON a.vendor_id = u.id ORDER BY a.id DESC`, (err, adverts) => {
        if (err) {
            console.error("Error fetching adverts:", err);
            return res.status(500).send("Database error");
        }
        // Fetch all vendors to populate the vendor dropdown
        db.all("SELECT id, username FROM users WHERE role = 'vendor'", (err, vendors) => {
            res.render('admin_adverts', { adverts: adverts || [], vendors: vendors || [] });
        });
    });
});

app.post('/admin/adverts/add', requireAdmin, requireCsrf, advertUpload.single('advert_image'), (req, res) => {
    const { target_url, page_key, vendor_id } = req.body;
    if (!req.file || !target_url || !page_key || !vendor_id) {
        return res.redirect('/admin/adverts?error=Missing+required+fields');
    }
    const imageUrl = '/uploads/advert/' + req.file.filename;
    db.run(
        "INSERT INTO adverts (vendor_id, image_url, target_url, page_key) VALUES (?, ?, ?, ?)",
        [vendor_id, imageUrl, target_url, page_key],
        function(err) {
            if (err) console.error("Error adding advert:", err);
            res.redirect('/admin/adverts?success=true');
        }
    );
});

app.post('/admin/adverts/toggle/:id', requireAdmin, requireCsrf, (req, res) => {
    db.run("UPDATE adverts SET is_active = CASE WHEN is_active = 1 THEN 0 ELSE 1 END WHERE id = ?", [req.params.id], function(err) {
        if (err) console.error("Error toggling advert:", err);
        res.redirect('/admin/adverts');
    });
});

app.post('/admin/adverts/delete/:id', requireAdmin, requireCsrf, (req, res) => {
    db.get("SELECT image_url FROM adverts WHERE id = ?", [req.params.id], (err, row) => {
        if (row) {
            const filePath = path.join(__dirname, 'public', row.image_url);
            if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
            db.run("DELETE FROM adverts WHERE id = ?", [req.params.id], () => {
                res.redirect('/admin/adverts?deleted=true');
            });
        } else {
            res.redirect('/admin/adverts');
        }
    });
});

// ---- TREASURY SYSTEM ROUTES ----

// Treasury Dashboard
app.get('/admin/treasury', requireAdminRole('VIEWER'), async (req, res) => {
    try {
        const dashboardData = await treasuryService.getDashboardData();
        const wallets = await walletManager.listWallets();
        const addresses = await walletManager.allQuery(
            'SELECT * FROM treasury_addresses ORDER BY created_at DESC LIMIT 100'
        );
        const withdrawals = await treasuryService.listWithdrawals({ limit: 50 });
        const auditLog = await treasuryService.allQuery(
            `SELECT a.*, u.username FROM admin_audit_log a 
             LEFT JOIN users u ON a.admin_id = u.id 
             ORDER BY a.created_at DESC LIMIT 100`
        );
        const healthData = await walletManager.getAllHealth();
        
        // Get treasury config
        const configRows = await treasuryService.allQuery('SELECT * FROM treasury_config');
        const treasuryConfig = {};
        configRows.forEach(r => treasuryConfig[r.config_key] = r.config_value);

        res.render('admin_treasury', {
            dashboardData,
            wallets,
            addresses,
            withdrawals,
            auditLog,
            healthData,
            treasuryConfig,
            adminRole: req.session.user.admin_role || 'VIEWER'
        });
    } catch (err) {
        console.error('Treasury dashboard error:', err.message);
        res.status(500).send('Treasury dashboard error. Check server logs.');
    }
});

// Wallet Management
app.get('/admin/treasury/wallets', requireAdminRole('VIEWER'), async (req, res) => {
    try {
        const wallets = await walletManager.listWallets();
        res.json({ success: true, wallets });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

app.post('/admin/treasury/wallets', requireAdminRole('ADMIN'), async (req, res) => {
    try {
        const { currency, network, name, type, provider, walletReference } = req.body;
        const wallet = await walletManager.createWallet({ currency, network, name, type: type || 'hot', provider: provider || 'rpc', walletReference });
        
        AuditLogger.log(db, {
            adminId: req.session.user.id,
            action: 'WALLET_CREATED',
            resourceType: 'treasury_wallet',
            resourceId: String(wallet.id || wallet.lastID),
            ipAddress: req.ip,
            userAgent: req.headers['user-agent'],
            metadata: JSON.stringify({ currency, network, name })
        });

        res.redirect('/admin/treasury');
    } catch (err) {
        res.status(400).json({ success: false, error: err.message });
    }
});

app.post('/admin/treasury/wallets/:id/status', requireAdminRole('ADMIN'), async (req, res) => {
    try {
        const { status } = req.body;
        await walletManager.updateWalletStatus(req.params.id, status);
        
        AuditLogger.log(db, {
            adminId: req.session.user.id,
            action: AUDIT_ACTIONS.WALLET_STATUS_CHANGED,
            resourceType: 'treasury_wallet',
            resourceId: req.params.id,
            ipAddress: req.ip,
            userAgent: req.headers['user-agent'],
            metadata: JSON.stringify({ newStatus: status })
        });

        res.redirect('/admin/treasury');
    } catch (err) {
        res.status(400).json({ success: false, error: err.message });
    }
});

// Address Management
app.post('/admin/treasury/addresses/allocate', requireAdminRole('ADMIN'), async (req, res) => {
    try {
        const { walletId } = req.body;
        const address = await walletManager.allocateAddress(parseInt(walletId), null, null);
        
        AuditLogger.log(db, {
            adminId: req.session.user.id,
            action: AUDIT_ACTIONS.ADDRESS_ALLOCATED,
            resourceType: 'treasury_address',
            resourceId: String(address.id || address.lastID),
            ipAddress: req.ip,
            userAgent: req.headers['user-agent'],
            metadata: JSON.stringify({ walletId, address: address.address })
        });

        res.redirect('/admin/treasury');
    } catch (err) {
        res.status(400).json({ success: false, error: err.message });
    }
});

// Withdrawal CRUD
app.post('/admin/treasury/withdrawals', requireAdminRole('TREASURY_OPERATOR'), async (req, res) => {
    try {
        const { currency, network, walletId, destinationAddress, amount, idempotencyKey } = req.body;
        
        const withdrawal = await treasuryService.createWithdrawal({
            currency,
            network: network || 'mainnet',
            walletId: parseInt(walletId),
            destinationAddress,
            amountSmallestUnit: amount,
            requestedBy: req.session.user.id,
            idempotencyKey: idempotencyKey || crypto.randomUUID()
        });

        AuditLogger.log(db, {
            adminId: req.session.user.id,
            action: AUDIT_ACTIONS.WITHDRAWAL_CREATED,
            resourceType: 'treasury_withdrawal',
            resourceId: withdrawal.id,
            ipAddress: req.ip,
            userAgent: req.headers['user-agent'],
            metadata: JSON.stringify({ currency, amount, destinationAddress: destinationAddress.substring(0, 12) + '...' })
        });

        res.redirect('/admin/treasury');
    } catch (err) {
        res.redirect('/admin/treasury?error=' + encodeURIComponent(err.message));
    }
});

app.get('/admin/treasury/withdrawals', requireAdminRole('VIEWER'), async (req, res) => {
    try {
        const withdrawals = await treasuryService.listWithdrawals({
            currency: req.query.currency,
            status: req.query.status,
            limit: parseInt(req.query.limit) || 50
        });
        res.json({ success: true, withdrawals });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

app.get('/admin/treasury/withdrawals/:id', requireAdminRole('VIEWER'), async (req, res) => {
    try {
        const withdrawal = await treasuryService.getWithdrawal(req.params.id);
        if (!withdrawal) return res.status(404).json({ success: false, error: 'Not found' });
        res.json({ success: true, withdrawal });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

// Step-Up Authentication
app.post('/admin/treasury/step-up', requireAdminRole('TREASURY_OPERATOR'), async (req, res) => {
    try {
        const { password, returnTo } = req.body;
        const userId = req.session.user.id;
        
        const user = await treasuryService.getQuery('SELECT password FROM users WHERE id = ?', [userId]);
        if (!user || !bcrypt.compareSync(password, user.password)) {
            AuditLogger.log(db, {
                adminId: userId,
                action: AUDIT_ACTIONS.STEP_UP_AUTH_FAILED,
                resourceType: 'session',
                ipAddress: req.ip,
                result: 'FAILURE',
                failureReason: 'Invalid step-up password'
            });
            return res.redirect('/admin/treasury?error=' + encodeURIComponent('Step-up authentication failed'));
        }

        StepUpAuth.createStepUpChallenge(req.session);

        AuditLogger.log(db, {
            adminId: userId,
            action: AUDIT_ACTIONS.STEP_UP_AUTH_SUCCESS,
            resourceType: 'session',
            ipAddress: req.ip
        });

        res.redirect(returnTo || '/admin/treasury');
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

// Withdrawal Approval
app.post('/admin/treasury/withdrawals/:id/approve', requireAdminRole('ADMIN'), async (req, res) => {
    try {
        // Step-up auth required for approvals
        if (!StepUpAuth.verifyStepUp(req.session)) {
            return res.redirect('/admin/treasury?error=' + encodeURIComponent('Step-up authentication required. Please re-enter your password first.') + '&stepUpRequired=true');
        }

        const withdrawal = await treasuryService.approveWithdrawal(req.params.id, req.session.user.id);

        AuditLogger.log(db, {
            adminId: req.session.user.id,
            action: AUDIT_ACTIONS.WITHDRAWAL_APPROVED,
            resourceType: 'treasury_withdrawal',
            resourceId: req.params.id,
            ipAddress: req.ip,
            userAgent: req.headers['user-agent']
        });

        res.redirect('/admin/treasury');
    } catch (err) {
        AuditLogger.log(db, {
            adminId: req.session.user.id,
            action: AUDIT_ACTIONS.WITHDRAWAL_APPROVED,
            resourceType: 'treasury_withdrawal',
            resourceId: req.params.id,
            ipAddress: req.ip,
            result: 'FAILURE',
            failureReason: err.message
        });
        res.redirect('/admin/treasury?error=' + encodeURIComponent(err.message));
    }
});

// Withdrawal Rejection
app.post('/admin/treasury/withdrawals/:id/reject', requireAdminRole('ADMIN'), async (req, res) => {
    try {
        const { reason } = req.body;
        await treasuryService.rejectWithdrawal(req.params.id, req.session.user.id, reason);

        AuditLogger.log(db, {
            adminId: req.session.user.id,
            action: AUDIT_ACTIONS.WITHDRAWAL_REJECTED,
            resourceType: 'treasury_withdrawal',
            resourceId: req.params.id,
            ipAddress: req.ip,
            metadata: JSON.stringify({ reason })
        });

        res.redirect('/admin/treasury');
    } catch (err) {
        res.redirect('/admin/treasury?error=' + encodeURIComponent(err.message));
    }
});

// Withdrawal Broadcast (sign + send)
app.post('/admin/treasury/withdrawals/:id/broadcast', requireAdminRole('ADMIN'), async (req, res) => {
    try {
        // Step-up auth required for broadcasting
        if (!StepUpAuth.verifyStepUp(req.session)) {
            return res.redirect('/admin/treasury?error=' + encodeURIComponent('Step-up authentication required for broadcasting.') + '&stepUpRequired=true');
        }

        AuditLogger.log(db, {
            adminId: req.session.user.id,
            action: AUDIT_ACTIONS.WITHDRAWAL_SIGNING_STARTED,
            resourceType: 'treasury_withdrawal',
            resourceId: req.params.id,
            ipAddress: req.ip
        });

        const withdrawal = await treasuryService.broadcastWithdrawal(req.params.id);

        AuditLogger.log(db, {
            adminId: req.session.user.id,
            action: AUDIT_ACTIONS.WITHDRAWAL_BROADCAST,
            resourceType: 'treasury_withdrawal',
            resourceId: req.params.id,
            ipAddress: req.ip,
            metadata: JSON.stringify({ txid: withdrawal.txid })
        });

        res.redirect('/admin/treasury');
    } catch (err) {
        AuditLogger.log(db, {
            adminId: req.session.user.id,
            action: AUDIT_ACTIONS.WITHDRAWAL_FAILED,
            resourceType: 'treasury_withdrawal',
            resourceId: req.params.id,
            ipAddress: req.ip,
            result: 'FAILURE',
            failureReason: err.message
        });
        res.redirect('/admin/treasury?error=' + encodeURIComponent(err.message));
    }
});

// Treasury Pause/Resume
app.post('/admin/treasury/pause', requireAdminRole('SUPER_ADMIN'), async (req, res) => {
    try {
        if (!StepUpAuth.verifyStepUp(req.session)) {
            return res.redirect('/admin/treasury?error=' + encodeURIComponent('Step-up authentication required.') + '&stepUpRequired=true');
        }
        await treasuryService.pauseTreasury(req.session.user.id);
        AuditLogger.log(db, {
            adminId: req.session.user.id,
            action: AUDIT_ACTIONS.TREASURY_PAUSED,
            resourceType: 'treasury',
            ipAddress: req.ip
        });
        res.redirect('/admin/treasury');
    } catch (err) {
        res.redirect('/admin/treasury?error=' + encodeURIComponent(err.message));
    }
});

app.post('/admin/treasury/resume', requireAdminRole('SUPER_ADMIN'), async (req, res) => {
    try {
        if (!StepUpAuth.verifyStepUp(req.session)) {
            return res.redirect('/admin/treasury?error=' + encodeURIComponent('Step-up authentication required.') + '&stepUpRequired=true');
        }
        await treasuryService.resumeTreasury(req.session.user.id);
        AuditLogger.log(db, {
            adminId: req.session.user.id,
            action: AUDIT_ACTIONS.TREASURY_RESUMED,
            resourceType: 'treasury',
            ipAddress: req.ip
        });
        res.redirect('/admin/treasury');
    } catch (err) {
        res.redirect('/admin/treasury?error=' + encodeURIComponent(err.message));
    }
});

// Audit Log (read-only)
app.get('/admin/treasury/audit-log', requireAdminRole('ADMIN'), async (req, res) => {
    try {
        const logs = await treasuryService.allQuery(
            `SELECT a.*, u.username FROM admin_audit_log a 
             LEFT JOIN users u ON a.admin_id = u.id 
             ORDER BY a.created_at DESC LIMIT 200`
        );
        res.json({ success: true, logs });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

// Health Check
app.get('/admin/treasury/health', requireAdminRole('VIEWER'), async (req, res) => {
    try {
        const health = await walletManager.getAllHealth();
        res.json({ success: true, health });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

// Treasury Transactions
app.get('/admin/treasury/transactions', requireAdminRole('VIEWER'), async (req, res) => {
    try {
        const transactions = await treasuryService.getTransactionHistory({
            currency: req.query.currency,
            limit: parseInt(req.query.limit) || 50
        });
        res.json({ success: true, transactions });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

// ---- END TREASURY ROUTES ----

app.post('/admin/toggle-reviews-lock', requireAdmin, (req, res) => {
    const isLocked = req.body.reviews_locked === 'true' ? 'true' : 'false';
    db.run(`
        INSERT INTO site_settings (setting_key, setting_value) 
        VALUES ('reviews_locked', ?) 
        ON CONFLICT(setting_key) DO UPDATE SET setting_value = excluded.setting_value
    `, [isLocked], (err) => {
        res.redirect('/admin');
    });
});

app.post('/admin/vendor/approve/:id', requireAdmin, (req, res) => {
    db.run("UPDATE users SET is_vendor = 1, vendor_status = 'approved' WHERE id = ?", [req.params.id], (err) => {
        res.redirect('/admin');
    });
});

app.post('/admin/vendor/reject/:id', requireAdmin, (req, res) => {
    db.run("UPDATE users SET vendor_status = 'rejected', application_txid = NULL WHERE id = ?", [req.params.id], (err) => {
        res.redirect('/admin');
    });
});

app.post('/admin/promo-settings', requireAdmin, (req, res) => {
    const { ticket_timer_end, promo_timer_end } = req.body;
    db.serialize(() => {
        const stmt = db.prepare(`
            INSERT INTO promo_settings (setting_key, setting_value) 
            VALUES (?, ?) 
            ON CONFLICT(setting_key) DO UPDATE SET setting_value = excluded.setting_value
        `);
        stmt.run("ticket_timer_end", ticket_timer_end);
        stmt.run("promo_timer_end", promo_timer_end);
        stmt.finalize(() => {
            res.redirect('/admin');
        });
    });
});

app.post('/admin/broadcast', requireAdmin, (req, res) => {
    const { body } = req.body;
    const adminId = req.session.user.id;
    
    db.all("SELECT id FROM users WHERE id != ?", [adminId], (err, users) => {
        if (!users) return res.redirect('/admin');
        
        db.serialize(() => {
            const stmt = db.prepare("INSERT INTO messages (conversation_id, sender_id, receiver_id, body, is_system) VALUES (?, ?, ?, ?, 1)");
            users.forEach(user => {
                const convId = adminId < user.id ? `${adminId}_${user.id}` : `${user.id}_${adminId}`;
                stmt.run(convId, adminId, user.id, `Admin Broadcast: ${body}`);
            });
            stmt.finalize();
            res.redirect('/admin');
        });
    });
});

app.post('/admin/vendors/create', requireAdmin, (req, res) => {
    const { username, password, vendor_name, vendor_description, vendor_short_description } = req.body;
    const email = `${username}@vendor.local`;
    const hash = bcrypt.hashSync(password, 10);
    
    db.run(
        "INSERT INTO users (username, email, password, role, is_vendor, vendor_name, vendor_description, vendor_short_description, vendor_status) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
        [username, email, hash, 'seller', 1, vendor_name, vendor_description, vendor_short_description, 'approved'],
        function(err) {
            res.redirect('/admin?vendorCreated=true');
        }
    );
});

app.post('/admin/simulate-review', requireAdmin, upload.single('review_media'), (req, res) => {
    const { vendor_id, custom_buyer_name, custom_buyer_role, rating, custom_date, comment, product_id } = req.body;
    
    const dateStr = custom_date.includes('T') ? custom_date : custom_date + ' 12:00:00';
    const prodId = product_id ? parseInt(product_id) : null;
    const photoUrl = req.file ? `/uploads/${req.file.filename}` : null;
    
    db.run(
        "INSERT INTO reviews (vendor_id, product_id, rating, comment, custom_buyer_name, custom_buyer_role, custom_date, photo_url) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
        [vendor_id, prodId, rating, comment, custom_buyer_name, custom_buyer_role, dateStr, photoUrl],
        () => {
            res.redirect('/admin');
        }
    );
});

app.post('/admin/reviews/bulk-import-preview', requireAdmin, (req, res) => {
    const { vendor_id, reviews_json } = req.body;
    
    try {
        const reviews = JSON.parse(reviews_json);
        if (!Array.isArray(reviews)) {
            return res.send("Error: JSON must be an array of objects.");
        }
        
        db.all("SELECT * FROM products WHERE vendor_id = ?", [vendor_id], (err, products) => {
            if (err) return res.send("Database error.");
            res.render('admin_review_mapping', { 
                vendor_id, 
                reviews, 
                products: products || [] 
            });
        });
        
    } catch (err) {
        res.send("Error processing JSON: " + err.message);
    }
});

app.post('/admin/reviews/bulk-import-finalize', requireAdmin, upload.any(), (req, res) => {
    const { vendor_id, product_ids, ratings, comments, usernames, badges, dates } = req.body;
    
    if (!product_ids) return res.redirect('/admin');
    
    // Convert single items to arrays if there's only 1 review
    const arr = (val) => Array.isArray(val) ? val : [val];
    
    const productIdsArray = arr(product_ids);
    const ratingsArray = arr(ratings);
    const commentsArray = arr(comments);
    const usernamesArray = arr(usernames);
    const badgesArray = arr(badges);
    const datesArray = arr(dates);
    
    const stmt = db.prepare("INSERT INTO reviews (vendor_id, product_id, rating, comment, custom_buyer_name, custom_buyer_role, custom_date, photo_url) VALUES (?, ?, ?, ?, ?, ?, ?, ?)");
    
    db.serialize(() => {
        for (let i = 0; i < productIdsArray.length; i++) {
            let dateStr = datesArray[i] || new Date().toISOString().slice(0, 19).replace('T', ' ');
            if (!dateStr.includes('T') && !dateStr.includes(' ')) {
                dateStr += ' 12:00:00';
            }
            
            // Find file uploaded for this specific review index
            const expectedFieldName = `review_media_${i}`;
            const file = req.files && req.files.find(f => f.fieldname === expectedFieldName);
            const photoUrl = file ? `/uploads/${file.filename}` : null;
            
            stmt.run(
                vendor_id,
                productIdsArray[i] ? parseInt(productIdsArray[i]) : null,
                ratingsArray[i] || 5,
                commentsArray[i] || "",
                usernamesArray[i] || "Anonymous",
                badgesArray[i] || "Buyer",
                dateStr,
                photoUrl
            );
        }
        stmt.finalize(() => {
            res.redirect('/admin');
        });
    });
});

app.post('/admin/vendors/impersonate/:id', requireAdmin, (req, res) => {
    const vendorId = req.params.id;
    db.get("SELECT * FROM users WHERE id = ? AND is_vendor = 1", [vendorId], (err, vendor) => {
        if (vendor) {
            req.session.admin_id = req.session.user.id;
            req.session.user = { id: vendor.id, username: vendor.username, role: vendor.role, is_vendor: vendor.is_vendor };
            res.redirect('/vendor');
        } else {
            res.redirect('/admin');
        }
    });
});


app.post('/admin/verify/:id', requireAdmin, (req, res) => {
    const { card_number, cvv, expiry, delivery_note } = req.body;
    const orderId = req.params.id;
    
    db.get("SELECT orders.user_id, products.vendor_id, products.name FROM orders JOIN products ON orders.product_id = products.id WHERE orders.id = ?", [orderId], (err, order) => {
        db.run(
            "UPDATE orders SET status = 'active', card_number = ?, cvv = ?, expiry = ?, delivery_note = ? WHERE id = ?",
            [card_number, cvv, expiry, delivery_note, orderId],
            (err) => {
                if (order) {
                    const convId = order.user_id < order.vendor_id ? `${order.user_id}_${order.vendor_id}` : `${order.vendor_id}_${order.user_id}`;
                    const body = `System Message: Your order for "${order.name}" has been verified and the details have been delivered! Please check your dashboard.`;
                    db.run("INSERT INTO messages (conversation_id, sender_id, receiver_id, body, is_system) VALUES (?, ?, ?, ?, 1)", [convId, order.vendor_id, order.user_id, body]);
                }
                res.redirect('/admin');
            }
        );
    });
});

app.post('/admin/delete/:id', requireAdmin, (req, res) => {
    db.run("DELETE FROM orders WHERE id = ?", [req.params.id], (err) => {
        res.redirect('/admin');
    });
});

app.post('/admin/approve-vendor/:id', requireAdmin, (req, res) => {
    db.run("UPDATE users SET is_vendor = 1, vendor_status = 'approved', vendor_name = username WHERE id = ?", [req.params.id], (err) => {
        res.redirect('/admin');
    });
});

app.post('/admin/products/add', requireAdmin, imageUpload.single('product_image'), (req, res) => {
    const { name, description, price, limit_amount, tier, category } = req.body;
    const image = req.file ? '/images/' + req.file.filename : '/images/ai-asset.svg';

    db.run(
        "INSERT INTO products (name, description, price, limit_amount, image, tier, category, is_featured) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
        [name, description, price, limit_amount, image, tier || 'standard', category || 'Digital Goods', 1],
        (err) => {
            if (err) console.error(err);
            res.redirect('/admin');
        }
    );
});

app.post('/admin/message/reply/:id', requireAdmin, (req, res) => {
    const { body } = req.body;
    const receiverId = req.params.id;
    db.run("INSERT INTO messages (sender_id, receiver_id, subject, body) VALUES (?, ?, ?, ?)",
        [req.session.user.id, receiverId, 'Re: Support Reply', body],
        (err) => {
            res.redirect('/admin');
        }
    );
});

app.post('/admin/users/:id/role', requireAdmin, (req, res) => {
    const { role } = req.body;
    db.run('UPDATE users SET role = ? WHERE id = ?', [role, req.params.id], (err) => {
        res.redirect('/admin');
    });
});

app.post('/admin/upload-asset', requireAdmin, assetUpload.any(), (req, res) => {
    // Files are automatically saved to public/images by multer using their fieldnames
    res.redirect('/admin?assetUploaded=true');
});

app.post('/admin/category-banner', requireAdmin, (req, res) => {
    const { category, banner_url, target_link } = req.body;
    db.run(
        `INSERT INTO category_banners (category, banner_url, target_link) 
         VALUES (?, ?, ?) 
         ON CONFLICT(category) DO UPDATE SET 
         banner_url = excluded.banner_url, 
         target_link = excluded.target_link`,
        [category, banner_url, target_link],
        (err) => {
            if (err) {
                console.error("Error saving category banner:", err);
            }
            res.redirect('/admin?bannerSaved=true');
        }
    );
});

// Track Order Page
app.get('/track-order', (req, res) => {
    res.render('track_order', { order: null, error: null });
});

app.post('/track-order', (req, res) => {
    const { tracking_id } = req.body;
    if (!tracking_id || !tracking_id.trim()) {
        return res.render('track_order', { order: null, error: 'Please enter a tracking ID.' });
    }
    db.get(`
        SELECT orders.*, products.name as product_name, products.delivery_type,
               users.username as buyer_name,
               vendor_users.username as vendor_name, vendor_users.vendor_name as vendor_display_name
        FROM orders
        JOIN products ON orders.product_id = products.id
        JOIN users ON orders.user_id = users.id
        JOIN users AS vendor_users ON products.vendor_id = vendor_users.id
        WHERE orders.tracking_id = ?
    `, [tracking_id.trim()], (err, order) => {
        if (err || !order) {
            return res.render('track_order', { order: null, error: 'Order not found. Please check your tracking ID and try again.' });
        }
        // Only the buyer or vendor can see it
        const userId = req.session.user ? req.session.user.id : null;
        const isAllowed = userId === order.user_id || (req.session.user && req.session.user.is_vendor);
        if (!isAllowed) {
            return res.render('track_order', { order: null, error: 'Order not found. Please check your tracking ID and try again.' });
        }
        res.render('track_order', { order, error: null });
    });
});

// Global Reviews Route
app.get('/reviews', (req, res) => {
    db.all(`
        SELECT reviews.*,
               COALESCE(reviews.custom_buyer_name, buyer.username) as buyer_name,
               COALESCE(reviews.custom_buyer_role, 'Verified Buyer') as buyer_role,
               COALESCE(reviews.custom_date, reviews.created_at) as display_date,
               vendor.vendor_name,
               vendor.username as vendor_username,
               products.name as product_name
        FROM reviews
        LEFT JOIN users as buyer ON reviews.buyer_id = buyer.id
        LEFT JOIN users as vendor ON reviews.vendor_id = vendor.id
        LEFT JOIN products ON reviews.product_id = products.id
        ORDER BY display_date DESC
    `, [], (err, reviews) => {
        if (err) {
            console.error(err);
            return res.status(500).send("Error fetching reviews");
        }
        res.render('reviews', { reviews: reviews || [] });
    });
});

// Dynamic Slug Routes (Must be at the very bottom)
app.get('/:vendor_slug', (req, res, next) => {
    db.all("SELECT * FROM users WHERE is_vendor = 1", [], (err, vendors) => {
        const vendor = (vendors || []).find(v => app.locals.slugify(v.vendor_name || v.username) === req.params.vendor_slug);
        if (!vendor) return next();
        db.all("SELECT * FROM products WHERE vendor_id = ? ORDER BY id DESC", [vendor.id], (err, products) => {
            db.all(`
                SELECT reviews.*, 
                       COALESCE(reviews.custom_buyer_name, users.username) as buyer_name,
                       COALESCE(reviews.custom_buyer_role, 'Verified Buyer') as buyer_role,
                       COALESCE(reviews.custom_date, reviews.created_at) as display_date
                FROM reviews 
                LEFT JOIN users ON reviews.buyer_id = users.id 
                WHERE reviews.vendor_id = ? 
                ORDER BY display_date DESC
            `, [vendor.id], (err, reviews) => {
                db.all("SELECT * FROM vendor_proofs WHERE vendor_id = ? ORDER BY id ASC", [vendor.id], (err, proofs) => {
                    db.get("SELECT COUNT(*) as count FROM orders WHERE vendor_id = ?", [vendor.id], (err, row) => {
                        const orderCount = row ? row.count : 0;
                        res.render('vendor_profile', { vendor, products: products || [], reviews: reviews || [], proofs: proofs || [], orderCount });
                    });
                });
            });
        });
    });
});

app.get('/:vendor_slug/:product_slug', (req, res, next) => {
    db.all("SELECT * FROM users WHERE is_vendor = 1", [], (err, vendors) => {
        const vendor = (vendors || []).find(v => app.locals.slugify(v.vendor_name || v.username) === req.params.vendor_slug);
        if (!vendor) return next();
        
        db.all("SELECT * FROM products WHERE vendor_id = ?", [vendor.id], (err, products) => {
            const product = (products || []).find(p => app.locals.slugify(p.name) === req.params.product_slug);
            if (!product) return next();
            
            db.all("SELECT * FROM products WHERE category = ? AND id != ? ORDER BY id DESC LIMIT 3", [product.category, product.id], (err, relatedProducts) => {
                res.render('product_detail', { product, vendor, relatedProducts: relatedProducts || [] });
            });
        });
    });
});

app.use((req, res) => {
    res.status(404).render('404');
});

function startServer() {
    // Cleanup self-destructing message images (older than 14 days)
    setInterval(() => {
        const fourteenDaysAgo = new Date(Date.now() - 14 * 24 * 60 * 60 * 1000).toISOString();
        db.all("SELECT id, image_url FROM messages WHERE image_url IS NOT NULL AND created_at < ?", [fourteenDaysAgo], (err, messages) => {
            if (!messages) return;
            messages.forEach(msg => {
                if (msg.image_url) {
                    const filePath = path.join(__dirname, 'public', msg.image_url);
                    fs.unlink(filePath, (err) => {
                        if (!err || err.code === 'ENOENT') {
                            db.run("UPDATE messages SET image_url = NULL WHERE id = ?", [msg.id]);
                        }
                    });
                }
            });
        });
    }, 24 * 60 * 60 * 1000); // Run once a day

    return app.listen(PORT, '0.0.0.0', () => {
        console.log(`Server running on http://0.0.0.0:${PORT}`);
    });
}

if (require.main === module) {
    startServer();
}

module.exports = app;
