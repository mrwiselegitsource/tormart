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

const app = express();
const PORT = process.env.PORT || 3000;

// Setup directories
const uploadsDir = path.join(__dirname, 'public', 'uploads');
const imagesDir = path.join(__dirname, 'public', 'images');
const messagesDir = path.join(__dirname, 'public', 'images', 'messages');
if (!fs.existsSync(uploadsDir)) fs.mkdirSync(uploadsDir, { recursive: true });
if (!fs.existsSync(imagesDir)) fs.mkdirSync(imagesDir, { recursive: true });
if (!fs.existsSync(messagesDir)) fs.mkdirSync(messagesDir, { recursive: true });

// Setup View Engine
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

// Middleware
app.use(express.static(path.join(__dirname, 'public')));
app.use(bodyParser.urlencoded({ extended: true }));
app.use(bodyParser.json());

// Session setup (HTTP-Only for Tor security)
app.use(session({
    secret: process.env.SESSION_SECRET || 'globalmarket-tor-secret',
    resave: false,
    saveUninitialized: true,
    cookie: {
        secure: false,
        httpOnly: true,
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

const proofsDir = path.join(__dirname, 'public', 'images', 'proofs');
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

const reviewsDir = path.join(__dirname, 'public', 'images', 'reviews');
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
const db = new sqlite3.Database('./neobyte.db', (err) => {
    if (err) console.error('Database connection error:', err);
    else console.log('Connected to SQLite database.');
});

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
            vendor_logo TEXT,
            vendor_banner TEXT,
            vendor_status TEXT DEFAULT 'pending',
            btc_wallet TEXT,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )`);

        // Add btc_wallet if missing
        db.run(`ALTER TABLE users ADD COLUMN btc_wallet TEXT`, (err) => {
            // Ignore error if column already exists
        });

        // Add referred_by to track referrals
        db.run(`ALTER TABLE users ADD COLUMN referred_by TEXT`, (err) => {});

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
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY(vendor_id) REFERENCES users(id),
            FOREIGN KEY(buyer_id) REFERENCES users(id),
            FOREIGN KEY(product_id) REFERENCES products(id)
        )`);

        db.run("ALTER TABLE reviews ADD COLUMN photo_url TEXT", (err) => {});

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
                const hash = bcrypt.hashSync('admin123', 10);
                db.run("INSERT INTO users (username, email, password, role) VALUES (?, ?, ?, ?)", ['admin', 'admin@globalmarket.onion', hash, 'admin']);
            }
        });

        db.get("SELECT id FROM users WHERE vendor_name = 'Northstar Labs'", (err, vendorRow) => {
            if (!vendorRow) {
                const hash = bcrypt.hashSync('vendor123', 10);
                db.run(
                    "INSERT INTO users (username, email, password, role, is_vendor, vendor_name, vendor_description, vendor_status) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
                    ['northstar', 'northstar@globalmarket.onion', hash, 'seller', 1, 'Northstar Labs', 'Trusted digital storefront for premium AI assets and automation kits.', 'approved'],
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
    res.locals.cartCount = req.session.cart ? req.session.cart.length : 0;
    res.locals.csrfToken = req.session.csrfToken;
    next();
});

// Middleware for authentication
const requireAuth = (req, res, next) => {
    if (!req.session.user) return res.redirect('/login');
    next();
};

const requireAdmin = (req, res, next) => {
    if (!req.session.user || req.session.user.role !== 'admin') return res.redirect('/');
    next();
};

const requireCsrf = (req, res, next) => {
    if (['POST', 'PUT', 'DELETE'].includes(req.method)) {
        if (req.headers['content-type'] && req.headers['content-type'].includes('multipart/form-data')) {
            return next(); // Multer handles body parsing later
        }
        const token = (req.body && req.body._csrf) || req.headers['x-csrf-token'];
        if (!token || token !== req.session.csrfToken) {
            return res.status(403).send('Invalid CSRF token');
        }
    }
    next();
};

app.use(requireCsrf);

// --- ROUTES ---

app.get('/', (req, res) => {
    db.all("SELECT * FROM products ORDER BY is_featured DESC, id DESC LIMIT 6", (err, products) => {
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
    db.all(`
        SELECT DISTINCT users.* 
        FROM users 
        JOIN products ON users.id = products.vendor_id 
        WHERE LOWER(products.category) = LOWER(?) AND users.vendor_status = 'approved'
    `, [categoryName], (err, vendors) => {
        res.render('vendors', { vendors: vendors || [], categoryName });
    });
});

app.get('/vendor-profile/:id', (req, res) => {
    db.get("SELECT * FROM users WHERE id = ? AND is_vendor = 1", [req.params.id], (err, vendor) => {
        if (!vendor) return res.redirect('/');
        db.all("SELECT * FROM products WHERE vendor_id = ? ORDER BY id DESC", [vendor.id], (err, products) => {
            db.all(`
                SELECT reviews.*, users.username as buyer_name 
                FROM reviews 
                JOIN users ON reviews.buyer_id = users.id 
                WHERE reviews.vendor_id = ? 
                ORDER BY reviews.created_at DESC
            `, [vendor.id], (err, reviews) => {
                db.all("SELECT * FROM vendor_proofs WHERE vendor_id = ? ORDER BY id ASC", [vendor.id], (err, proofs) => {
                    res.render('vendor_profile', { vendor, products: products || [], reviews: reviews || [], proofs: proofs || [] });
                });
            });
        });
    });
});

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
    db.all(`SELECT * FROM products ${whereClause} ORDER BY is_featured DESC, id DESC`, params, (err, products) => {
        res.render('products', { products: products || [], query: q, category });
    });
});

app.get('/product/:id', (req, res) => {
    db.get("SELECT * FROM products WHERE id = ?", [req.params.id], (err, product) => {
        if (!product) return res.redirect('/');
        db.get("SELECT * FROM users WHERE id = ?", [product.vendor_id], (err, vendor) => {
            db.all("SELECT * FROM products WHERE category = ? AND id != ? ORDER BY id DESC LIMIT 3", [product.category, product.id], (err, relatedProducts) => {
                res.render('product_detail', { product, vendor: vendor || { id: 0, username: 'Unknown' }, relatedProducts: relatedProducts || [] });
            });
        });
    });
});

app.get('/privacy', (req, res) => {
    res.render('privacy');
});

app.get('/faq', (req, res) => {
    res.render('faq');
});

app.get('/bitcoin-guide', (req, res) => {
    res.render('bitcoin_guide');
});

app.get('/terms', (req, res) => {
    res.render('terms');
});

app.get('/refunds', (req, res) => {
    res.render('refunds');
});

app.get('/wishlist', (req, res) => {
    const wishlistIds = req.session.wishlist || [];
    if (!wishlistIds.length) return res.render('wishlist', { wishlistItems: [] });
    const placeholders = wishlistIds.map(() => '?').join(',');
    db.all(`SELECT * FROM products WHERE id IN (${placeholders})`, wishlistIds, (err, wishlistItems) => {
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
    const { product_id } = req.body;
    if (!req.session.cart) req.session.cart = [];
    req.session.cart.push(product_id);
    res.redirect('/cart');
});

app.get('/cart', (req, res) => {
    const cartIds = req.session.cart || [];
    if (cartIds.length === 0) {
        return res.render('cart', { cartItems: [], total: 0 });
    }
    const placeholders = cartIds.map(() => '?').join(',');
    db.all(`SELECT * FROM products WHERE id IN (${placeholders})`, cartIds, (err, products) => {
        const total = (products || []).reduce((sum, p) => sum + Number(p.price || 0), 0);
        res.render('cart', { cartItems: products || [], total });
    });
});

app.post('/cart/clear', (req, res) => {
    req.session.cart = [];
    res.redirect('/cart');
});

// Checkout Routes
app.get('/checkout', requireAuth, (req, res) => {
    const cartIds = req.session.cart || [];
    if (cartIds.length === 0) return res.redirect('/cart');

    const placeholders = cartIds.map(() => '?').join(',');
    db.all(`SELECT * FROM products WHERE id IN (${placeholders})`, cartIds, (err, products) => {
        const total = (products || []).reduce((sum, p) => sum + Number(p.price || 0), 0);
        res.render('checkout', { cartItems: products || [], total });
    });
});

app.post('/checkout', requireAuth, upload.single('payment_proof'), (req, res) => {
    const { payment_method, comment } = req.body;
    const payment_proof = req.file ? '/uploads/' + req.file.filename : null;
    const cartIds = req.session.cart || [];
    const userId = req.session.user.id;

    if (!payment_proof) {
        return res.send('Error: Payment proof image is required.');
    }

    db.serialize(() => {
        cartIds.forEach((productId) => {
            const downloadKey = crypto.randomBytes(8).toString('hex');
            db.run("INSERT INTO orders (user_id, product_id, payment_method, payment_proof, delivery_note, download_key) VALUES (?, ?, ?, ?, ?, ?)", [userId, productId, payment_method, payment_proof, comment || '', downloadKey]);
            
            // Send system message for the order
            db.get("SELECT vendor_id, name FROM products WHERE id = ?", [productId], (err, product) => {
                if (product) {
                    const vendorId = product.vendor_id;
                    const convId = userId < vendorId ? `${userId}_${vendorId}` : `${vendorId}_${userId}`;
                    const body = `System Message: New order placed for "${product.name}". Awaiting vendor confirmation.`;
                    db.run("INSERT INTO messages (conversation_id, sender_id, receiver_id, body, is_system) VALUES (?, ?, ?, ?, 1)", [convId, vendorId, userId, body]);
                }
            });
        });
        req.session.cart = [];
        // Grant VIP on order placement
        db.run("UPDATE users SET is_vip = 1 WHERE id = ?", [userId]);
        if (req.session.user) req.session.user.is_vip = 1;
        res.redirect('/dashboard');
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
    if (!captcha || !req.session.captcha || captcha.toLowerCase() !== req.session.captcha.toLowerCase()) {
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
    if (!captcha || !req.session.captcha || captcha.toLowerCase() !== req.session.captcha.toLowerCase()) {
        return res.render('partner_auth', { error: 'Invalid CAPTCHA code' });
    }
    db.get("SELECT * FROM users WHERE email = ? OR username = ?", [email, email], (err, user) => {
        if (user && bcrypt.compareSync(password, user.password)) {
            req.session.user = { id: user.id, username: user.username, role: user.role, is_vendor: user.is_vendor, is_vip: user.is_vip || 0 };
            return res.redirect('/partner/dashboard');
        }
        res.render('partner_auth', { error: 'Invalid credentials' });
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
    const captcha = svgCaptcha.create({ size: 4, noise: 2, color: true, background: '#f0fdf4', width: 120, height: 40 });
    req.session.captcha = captcha.text;
    res.type('svg');
    res.status(200).send(captcha.data);
});

app.get('/login', (req, res) => {
    res.render('login', { error: null });
});

app.post('/login', (req, res) => {
    const { login_id, password, captcha } = req.body;
    if (!captcha || !req.session.captcha || captcha.toLowerCase() !== req.session.captcha.toLowerCase()) {
        return res.render('login', { error: 'Invalid CAPTCHA code' });
    }
    db.get("SELECT * FROM users WHERE email = ? OR username = ?", [login_id, login_id], (err, user) => {
        if (user && bcrypt.compareSync(password, user.password)) {
            req.session.user = { id: user.id, username: user.username, role: user.role, is_vendor: user.is_vendor, is_vip: user.is_vip || 0 };
            if (user.role === 'admin') return res.redirect('/admin');
            return res.redirect('/dashboard');
        }
        res.render('login', { error: 'Invalid credentials' });
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
    if (!captcha || !req.session.captcha || captcha.toLowerCase() !== req.session.captcha.toLowerCase()) {
        return res.render('login', { error: 'Invalid CAPTCHA code' });
    }
    // We will just generate a fake email for now or skip it if the form doesn't have it
    // Wait, the screenshot has only Username and Password for Register. Let's adapt.
    const email = req.body.email || `${username}@user.local`;
    const hash = bcrypt.hashSync(password, 10);
    const referredBy = req.session.referral_code || null;
    
    db.run("INSERT INTO users (username, email, password, referred_by) VALUES (?, ?, ?, ?)", [username, email, hash, referredBy], function(err) {
        if (err) return res.render('login', { error: 'Username already exists.' });
        req.session.user = { id: this.lastID, username, role: 'client', is_vendor: 0 };
        res.redirect('/dashboard');
    });
});

app.get('/logout', (req, res) => {
    req.session.destroy();
    res.redirect('/');
});

// Client Dashboard
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
    
    // Get order details to find the vendor
    db.get(`
        SELECT orders.id, products.vendor_id, products.id as product_id
        FROM orders
        JOIN products ON orders.product_id = products.id
        WHERE orders.id = ? AND orders.user_id = ?
    `, [orderId, userId], (err, order) => {
        if (order) {
            db.run("UPDATE orders SET status = 'completed' WHERE id = ?", [orderId], (err) => {
                // Grant VIP status to user when they complete their first order
                db.run("UPDATE users SET is_vip = 1 WHERE id = ?", [userId]);
                if (req.session.user) req.session.user.is_vip = 1;
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
        SELECT DISTINCT u.id, u.username, u.vendor_logo, u.is_vendor
        FROM users u
        JOIN messages m ON (m.sender_id = u.id OR m.receiver_id = u.id)
        WHERE (m.sender_id = ? OR m.receiver_id = ?) AND u.id != ?
    `, [userId, userId, userId], (err, conversations) => {
        db.get("SELECT id, username FROM users WHERE role = 'admin' LIMIT 1", (err, admin) => {
            const partnerId = req.query.chat || null;
            res.render('messages', { conversations: conversations || [], activePartnerId: partnerId, admin });
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

app.post('/api/messages/send', requireAuth, messageImageUpload.single('image'), (req, res) => {
    const senderId = req.session.user.id;
    const receiverId = req.body.receiver_id;
    const body = req.body.body || '';
    
    let imageUrl = null;
    if (req.file) {
        imageUrl = '/images/messages/' + req.file.filename;
    }
    
    if (!receiverId || (!body && !imageUrl)) {
        return res.status(400).json({ error: 'Missing required fields' });
    }
    
    const convId = senderId < receiverId ? `${senderId}_${receiverId}` : `${receiverId}_${senderId}`;

    db.run(`
        INSERT INTO messages (conversation_id, sender_id, receiver_id, body, image_url) 
        VALUES (?, ?, ?, ?, ?)
    `, [convId, senderId, receiverId, body, imageUrl], function(err) {
        if (err) return res.status(500).json({error: err.message});
        db.get("SELECT * FROM messages WHERE id = ?", [this.lastID], (err, msg) => {
            res.json(msg);
        });
    });
});

app.get('/support', requireAuth, (req, res) => {
    res.render('support');
});


// ============================================================
// FORUM ROUTES
// ============================================================

// Helper to check if user is VIP
function isVip(user) {
    if (!user) return false;
    if (user.role === 'admin') return true;
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

app.get('/job', (req, res) => {
    res.render('job');
});

app.post('/support/send', requireAuth, (req, res) => {
    const { subject, department, body } = req.body;
    const finalSubject = department ? `[${department}] ${subject}` : subject;

    db.get("SELECT id FROM users WHERE role = 'admin' LIMIT 1", (err, admin) => {
        if (admin) {
            db.run("INSERT INTO messages (sender_id, receiver_id, subject, body) VALUES (?, ?, ?, ?)",
                [req.session.user.id, admin.id, finalSubject, body],
                (err) => {
                    res.redirect('/messages');
                });
        } else {
            res.redirect('/messages');
        }
    });
});

function requireVendor(req, res, next) {
    if (req.session.user && req.session.user.is_vendor === 1) {
        next();
    } else {
        res.redirect('/');
    }
}

// Vendor Dashboard
app.get('/vendor', requireVendor, (req, res) => {
    db.all('SELECT * FROM products WHERE vendor_id = ? ORDER BY id DESC', [req.session.user.id], (err, products) => {
        db.all(`
            SELECT orders.*, products.name as product_name, users.username as customer_name 
            FROM orders 
            JOIN products ON orders.product_id = products.id 
            JOIN users ON orders.user_id = users.id
            WHERE products.vendor_id = ?
            ORDER BY orders.created_at DESC
        `, [req.session.user.id], (err, orders) => {
            db.all('SELECT * FROM vendor_proofs WHERE vendor_id = ? ORDER BY id DESC', [req.session.user.id], (err, proofs) => {
                res.render('vendor', { products: products || [], orders: orders || [], proofs: proofs || [] });
            });
        });
    });
});

app.post('/vendor/products/add', requireVendor, imageUpload.single('product_image'), (req, res) => {
    const { name, description, price, limit_amount, tier, category } = req.body;
    const image = req.file ? '/images/' + req.file.filename : '/images/ai-asset.svg';
    db.run(
        "INSERT INTO products (vendor_id, name, description, price, limit_amount, image, tier, category) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
        [req.session.user.id, name, description, price, limit_amount, image, tier, category],
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
app.post('/vendor/profile/edit', requireVendor, imageUpload.fields([{ name: 'vendor_logo', maxCount: 1 }, { name: 'vendor_banner', maxCount: 1 }]), (req, res) => {
    const { vendor_name, vendor_description } = req.body;
    
    let updates = ["vendor_name = ?", "vendor_description = ?"];
    let params = [vendor_name, vendor_description];
    
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
    }
    
    params.push(req.session.user.id);
    const query = `UPDATE users SET ${updates.join(', ')} WHERE id = ?`;
    
    db.run(query, params, () => {
        req.session.user.vendor_name = vendor_name;
        res.redirect('/vendor');
    });
});

app.post('/vendor/products/edit/:id', requireVendor, imageUpload.single('product_image'), (req, res) => {
    const { name, description, price, limit_amount, tier, category } = req.body;
    
    db.get("SELECT id, image FROM products WHERE id = ? AND vendor_id = ?", [req.params.id, req.session.user.id], (err, product) => {
        if (!product) return res.redirect('/vendor');
        
        const updateParams = [name, description, price, limit_amount, tier, category];
        let query = "UPDATE products SET name = ?, description = ?, price = ?, limit_amount = ?, tier = ?, category = ?";
        
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

// Admin Dashboard
app.get('/admin', requireAdmin, (req, res) => {
    db.all(`
        SELECT orders.*, users.username as customer_name, products.name as product_name 
        FROM orders 
        JOIN users ON orders.user_id = users.id 
        JOIN products ON orders.product_id = products.id 
        ORDER BY orders.created_at DESC LIMIT 50
    `, (err, orders) => {
        db.all("SELECT * FROM users WHERE is_vendor = 1 ORDER BY id DESC", (err, vendors) => {
            res.render('admin', { orders: orders || [], vendors: vendors || [] });
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
    const { username, password, vendor_name, vendor_description } = req.body;
    const email = `${username}@vendor.local`;
    const hash = bcrypt.hashSync(password, 10);
    
    db.run(
        "INSERT INTO users (username, email, password, role, is_vendor, vendor_name, vendor_description, vendor_status) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
        [username, email, hash, 'seller', 1, vendor_name, vendor_description, 'approved'],
        function(err) {
            res.redirect('/admin?vendorCreated=true');
        }
    );
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

    return app.listen(PORT, () => {
        console.log(`Server running on http://localhost:${PORT}`);
    });
}

if (require.main === module) {
    startServer();
}

module.exports = { app, startServer };
