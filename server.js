const express = require('express');
const session = require('express-session');
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
if (!fs.existsSync(uploadsDir)) fs.mkdirSync(uploadsDir, { recursive: true });
if (!fs.existsSync(imagesDir)) fs.mkdirSync(imagesDir, { recursive: true });

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
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP
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
            sender_id INTEGER,
            receiver_id INTEGER,
            subject TEXT,
            body TEXT,
            is_read INTEGER DEFAULT 0,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )`);

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
                res.render('vendor_profile', { vendor, products: products || [], reviews: reviews || [] });
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
        if (!product) return res.redirect('/cards');
        db.all("SELECT * FROM products WHERE category = ? AND id != ? ORDER BY id DESC LIMIT 3", [product.category, product.id], (err, relatedProducts) => {
            res.render('product_detail', { product, relatedProducts: relatedProducts || [] });
        });
    });
});

app.get('/privacy', (req, res) => {
    res.render('privacy');
});

app.get('/faq', (req, res) => {
    res.render('faq');
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
    res.redirect(req.get('Referer') || '/cards');
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
        const stmt = db.prepare("INSERT INTO orders (user_id, product_id, payment_method, payment_proof, delivery_note, download_key) VALUES (?, ?, ?, ?, ?, ?)");
        cartIds.forEach((productId) => {
            stmt.run(userId, productId, payment_method, payment_proof, comment || '', crypto.randomBytes(8).toString('hex'));
        });
        stmt.finalize();
        req.session.cart = [];
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
app.get('/login', (req, res) => {
    res.render('login', { error: null });
});

app.post('/login', (req, res) => {
    const { login_id, password } = req.body;
    db.get("SELECT * FROM users WHERE email = ? OR username = ?", [login_id, login_id], (err, user) => {
        if (user && bcrypt.compareSync(password, user.password)) {
            req.session.user = { id: user.id, username: user.username, role: user.role, is_vendor: user.is_vendor };
            if (user.role === 'admin') return res.redirect('/admin');
            return res.redirect('/dashboard');
        }
        res.render('login', { error: 'Invalid credentials' });
    });
});

app.get('/register', (req, res) => {
    res.redirect('/login');
});

app.post('/register', (req, res) => {
    const { username, password } = req.body;
    // We will just generate a fake email for now or skip it if the form doesn't have it
    // Wait, the screenshot has only Username and Password for Register. Let's adapt.
    const email = req.body.email || `${username}@user.local`;
    const hash = bcrypt.hashSync(password, 10);
    db.run("INSERT INTO users (username, email, password) VALUES (?, ?, ?)", [username, email, hash], function(err) {
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

app.post('/order/complete/:id', requireAuth, (req, res) => {
    const { rating, comment } = req.body;
    const orderId = req.params.id;
    const userId = req.session.user.id;
    
    // Get order details to find the vendor
    db.get(`
        SELECT orders.id, products.vendor_id, products.id as product_id
        FROM orders
        JOIN products ON orders.product_id = products.id
        WHERE orders.id = ? AND orders.user_id = ?
    `, [orderId, userId], (err, order) => {
        if (order) {
            db.run("UPDATE orders SET status = 'completed' WHERE id = ?", [orderId], (err) => {
                db.run(
                    "INSERT INTO reviews (vendor_id, buyer_id, product_id, rating, comment) VALUES (?, ?, ?, ?, ?)",
                    [order.vendor_id, userId, order.product_id, rating, comment],
                    (err) => {
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
    db.all(`
        SELECT messages.*, users.username as sender_name 
        FROM messages 
        JOIN users ON messages.sender_id = users.id 
        WHERE receiver_id = ? OR sender_id = ?
        ORDER BY created_at DESC
    `, [req.session.user.id, req.session.user.id], (err, messages) => {
        res.render('messages', { messages: messages || [] });
    });
});

app.get('/support', requireAuth, (req, res) => {
    res.render('support');
});

app.get('/cooperation', (req, res) => {
    res.render('cooperation');
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
            res.render('vendor', { products: products || [], orders: orders || [] });
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
    db.run(
        "UPDATE orders SET status = 'active', card_number = ?, cvv = ?, expiry = ?, delivery_note = ? WHERE id = ?",
        [card_number, cvv, expiry, delivery_note, orderId],
        (err) => {
            res.redirect('/admin');
        }
    );
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
    return app.listen(PORT, () => {
        console.log(`Server running on http://localhost:${PORT}`);
    });
}

if (require.main === module) {
    startServer();
}

module.exports = { app, startServer };
