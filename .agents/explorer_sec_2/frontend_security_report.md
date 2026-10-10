# Exhaustive Frontend, Template, XSS & CSRF Security Audit Report

**Auditor**: Explorer 2 (Frontend, Template, XSS & CSRF Specialist)  
**Target Repository**: NeobyteCards-Tor  
**Audit Scope**: All EJS templates in `views/` and `views/partials/`, public assets, and client-server request handlers in `server.js`.  
**Date**: October 8, 2026  

---

## Executive Summary

An exhaustive security audit was conducted covering all 49 template files in `views/`, 7 partial templates in `views/partials/`, public scripts in `public/`, and associated routing handlers in `server.js`. 

The audit identified **11 distinct security vulnerabilities**, including:
- **1 Critical-severity** DOM XSS vulnerability in the admin treasury panel (`admin_treasury.ejs`).
- **4 High-severity** Stored XSS vulnerabilities across vendor profiles, product listings, messaging, and advert carousels.
- **1 High-severity** Path Traversal / Arbitrary File Overwrite in the admin asset upload pipeline that can be chained with XSS for Remote Code Execution (RCE).
- **1 High-severity** Negative Quantity / Cart Price Manipulation flaw due to missing server-side validation.
- **1 High-severity** Insecure CSRF token transmission pattern via URL query parameters on multipart routes.
- **2 Medium-severity** Open Redirect vulnerabilities in step-up authentication and Referer-based redirections.
- **1 Medium-severity** Insecure Direct Object Reference (IDOR) in the order tracking functionality.

---

## Vulnerability Matrix

| ID | Title | Component / Location | Severity | Category |
|---|---|---|---|---|
| SEC-01 | DOM-based XSS via `document.write` of Query Parameter | `views/admin_treasury.ejs:106` | **Critical** | Cross-Site Scripting |
| SEC-02 | Stored XSS via Unescaped Vendor Description | `views/vendor_profile.ejs:175`, `views/vendor.ejs:105`, `server.js:2252` | **High** | Cross-Site Scripting |
| SEC-03 | Stored XSS via Unescaped Product Description | `views/product_detail.ejs:139`, `server.js:2181, 2390` | **High** | Cross-Site Scripting |
| SEC-04 | Stored XSS via Inline Script String Interpolation | `views/messages.ejs:557, 630-637`, `server.js:1498` | **High** | Cross-Site Scripting |
| SEC-05 | Stored XSS via `javascript:` URI in Advert Carousel | `views/_advert_carousel.ejs:10`, `server.js:2224, 2604` | **High** | Cross-Site Scripting |
| SEC-06 | HTML Attribute Breakout & DOM XSS in Edit Modal | `views/vendor.ejs:221` | **High** | Cross-Site Scripting |
| SEC-07 | Arbitrary File Overwrite / RCE via Upload Fieldname Traversal | `server.js:15-26, 3249` | **High** | Path Traversal / RCE |
| SEC-08 | Negative Quantity & Order Price Manipulation | `server.js:908, 1059` | **High** | Input Validation |
| SEC-09 | CSRF Token Exposure via Query Strings (`req.query._csrf`) | `server.js:765`, various forms in `views/` | **High** | CSRF / Info Disclosure |
| SEC-10 | Open Redirect in Step-Up Authentication & Referer Handling | `server.js:2835, 901, 2334` | **Medium** | Open Redirect |
| SEC-11 | Vendor Cross-Account Order Tracking IDOR | `server.js:3296-3300` | **Medium** | Broken Access Control |

---

## Detailed Findings & Technical Analysis

### SEC-01 [CRITICAL]: DOM-based XSS via `document.write` in Admin Treasury Panel

#### Location
- File: `views/admin_treasury.ejs`, Lines 103–108

#### Code Snippet
```html
<div id="t-url-error" class="t-alert t-alert-error" style="display:none;">
    <script>
        (function(){
            var p = new URLSearchParams(window.location.search);
            if(p.get('error')) document.write(p.get('error'));
        })();
    </script>
</div>
```

#### Vulnerability Analysis
The template reads the `error` parameter directly from `window.location.search` on the client side and passes it unmodified to `document.write()`. Because `document.write()` parses the input as raw markup and executes scripts, an attacker can craft a link targeting an authenticated administrator:
`/admin/treasury?error=<img%20src=x%20onerror=alert(document.domain)>`

#### Impact
Execution of arbitrary JavaScript within the session of an administrator who holds `TREASURY_OPERATOR`, `ADMIN`, or `SUPER_ADMIN` privileges. This allows full compromise of the crypto treasury, authorization of pending withdrawals, extraction of admin secrets, or chaining with SEC-07 to overwrite server-side templates for Remote Code Execution.

#### Concrete Remediation
Replace `document.write` with safe DOM text assignment:
```html
<div id="t-url-error" class="t-alert t-alert-error" style="display:none;"></div>
<script>
    (function(){
        var p = new URLSearchParams(window.location.search);
        var err = p.get('error');
        if (err) {
            var el = document.getElementById('t-url-error');
            el.textContent = err;
            el.style.display = 'block';
        }
    })();
</script>
```

---

### SEC-02 [HIGH]: Stored XSS via Unescaped Vendor Description

#### Locations
- `views/vendor_profile.ejs:175`:
  ```html
  <div class="ql-editor" style="padding:0;"><%- (vendor.vendor_description || '') %></div>
  ```
- `views/vendor.ejs:105`:
  ```html
  <div id="vendor_description_editor" style="min-height: 300px;"><%- user.vendor_description || '' %></div>
  ```
- `server.js:2252, 2297`:
  ```javascript
  const { vendor_name, vendor_description, ... } = req.body;
  ...
  db.run(`UPDATE users SET ... vendor_description = ? ...`);
  ```

#### Vulnerability Analysis
When editing their profile (`/vendor/profile/edit`), vendors submit HTML generated by Quill WYSIWYG editor. The server stores `req.body.vendor_description` directly into the database without any HTML sanitization. In both the vendor's dashboard and the public vendor profile (`/:vendor_slug`), the content is output using `<%-`, which disables EJS HTML escaping.

#### Impact
Any vendor can upload HTML containing malicious `<script>`, `<iframe>`, or `onerror` handlers. When any buyer, visitor, or market administrator views the vendor profile, the script executes in their browser.

#### Concrete Remediation
1. Install and use `sanitize-html` on the server before persisting or rendering rich text:
```javascript
const sanitizeHtml = require('sanitize-html');
const cleanDescription = sanitizeHtml(vendor_description, {
    allowedTags: ['p', 'b', 'i', 'em', 'strong', 'a', 'ul', 'ol', 'li', 'h1', 'h2', 'h3', 'br', 'span'],
    allowedAttributes: {
        'a': ['href', 'target'],
        'span': ['style']
    },
    allowedSchemes: ['http', 'https']
});
```
2. Store only sanitized HTML in the database.

---

### SEC-03 [HIGH]: Stored XSS via Unescaped Product Description

#### Locations
- `views/product_detail.ejs:139`:
  ```html
  <%- product.description %>
  ```
- `server.js:2181, 2185` (`/vendor/products/add`)
- `server.js:2390, 2396` (`/vendor/products/edit/:id`)

#### Vulnerability Analysis
Similar to vendor descriptions, products created or edited by vendors store raw HTML in the `description` column. The product page template outputs `product.description` unescaped using `<%-`.

#### Impact
A rogue or compromised vendor can create listings containing JavaScript payloads. Anyone navigating to the product page (`/:vendor_slug/:product_slug`) will execute the payload.

#### Concrete Remediation
Apply strict server-side sanitization before insertion/update in `server.js`:
```javascript
const cleanDescription = sanitizeHtml(description || '', {
    allowedTags: ['p', 'b', 'i', 'strong', 'em', 'ul', 'ol', 'li', 'br'],
    allowedAttributes: {}
});
```

---

### SEC-04 [HIGH]: Stored XSS via Inline Script String Interpolation in Messages

#### Locations
- `views/messages.ejs:557`:
  ```javascript
  const pNameStr = "<%- (typeof pName !== 'undefined') ? pName : 'Partner' %>";
  ```
- `views/messages.ejs:630-637`:
  ```javascript
  msgRow.innerHTML = ... +
      '<div class="chat-bubble-name">' +
          (isMe ? '<%= user.username %>' : pNameStr) +
          ...
      '</div>' + ...
  ```
- `server.js:1498` (`app.post('/register')` lacks username format validation)

#### Vulnerability Analysis
1. In `views/messages.ejs`, `pName` is unescaped inside double quotes inside a `<script>` tag: `const pNameStr = "<%- ... %>";`.
2. When a user registers via `/register`, the server performs no character validation on `username`.
3. If a user registers with a username containing quotes or script tags (e.g. `test"; alert(1); //` or `</script><script>alert(1)</script>`), viewing messages with that partner breaks the JavaScript string context.
4. Furthermore, `pNameStr` is concatenated directly into `msgRow.innerHTML` on line 633, allowing secondary DOM XSS if HTML elements are present.

#### Impact
Stored XSS executed against any user or administrator who opens a chat conversation with the malicious username.

#### Concrete Remediation
1. Enforce strict username validation in `server.js`:
```javascript
if (!/^[a-zA-Z0-9_-]{3,20}$/.test(username)) {
    return res.render('login', { error: 'Username must be 3-20 alphanumeric characters.', hidePromo: true });
}
```
2. In `views/messages.ejs`, avoid embedding server variables in raw script strings. Use dataset or JSON encoding:
```javascript
const pNameStr = <%- JSON.stringify(typeof pName !== 'undefined' ? pName : 'Partner').replace(/</g, '\\u003c') %>;
```
3. Use `textContent` for inserting sender names into DOM elements rather than concatenating into `innerHTML`.

---

### SEC-05 [HIGH]: Stored XSS via `javascript:` URIs in Smart Advert Carousel Links

#### Locations
- `views/_advert_carousel.ejs:10`:
  ```html
  <a href="<%= ad.target_url %>" class="advert-item">
  ```
- `views/admin_adverts.ejs:78`:
  ```html
  <a href="<%= ad.target_url %>" target="_blank" style="color: #3b82f6;"><%= ad.target_url %></a>
  ```
- `server.js:2224` (`/vendor/adverts/add`) & `server.js:2604` (`/admin/adverts/add`)

#### Vulnerability Analysis
The application permits vendors and admins to create adverts with arbitrary `target_url` values. Standard EJS `<%=` escaping transforms `<` and `>`, but leaves `javascript:...` intact. When a user clicks the advert on the homepage, vendor profile, or product detail page, the browser evaluates the `javascript:` URI.

#### Impact
Stored XSS triggered when users or administrators interact with featured banners.

#### Concrete Remediation
Validate `target_url` in both `/vendor/adverts/add` and `/admin/adverts/add`:
```javascript
const isValidTarget = target_url.startsWith('/') || /^https?:\/\//i.test(target_url);
if (!isValidTarget || /^\s*javascript:/i.test(target_url)) {
    return res.redirect('/vendor?error=Invalid+target+URL');
}
```

---

### SEC-06 [HIGH]: HTML Attribute Breakout & DOM XSS in Edit Modal

#### Location
- `views/vendor.ejs:221`:
  ```html
  <button onclick='openEditModal(<%- JSON.stringify(product) %>)' ...>Edit</button>
  ```

#### Vulnerability Analysis
The `onclick` attribute is wrapped in single quotes (`onclick='...'`). `JSON.stringify()` outputs JSON formatted strings where quotes around keys and values are double quotes (`"`), but internal single quotes (`'`) within product titles or descriptions are NOT escaped. If a product title contains a single quote (e.g., `Digital Card's Manual`), the single quote terminates the `onclick` attribute and injects arbitrary HTML attributes into the button.

#### Impact
Stored XSS execution in the vendor dashboard when rendering products containing single quotes.

#### Concrete Remediation
Use a data attribute with standard HTML escaping instead of inline handler interpolation:
```html
<button class="edit-product-btn" data-product="<%= JSON.stringify(product) %>">Edit</button>
```
And attach listeners unobtrusively:
```javascript
document.querySelectorAll('.edit-product-btn').forEach(btn => {
    btn.addEventListener('click', () => {
        const product = JSON.parse(btn.getAttribute('data-product'));
        openEditModal(product);
    });
});
```

---

### SEC-07 [HIGH]: Arbitrary File Overwrite / RCE via Upload Fieldname Traversal

#### Locations
- `server.js:15–26`:
  ```javascript
  const assetStorage = multer.diskStorage({
      destination: function (req, file, cb) {
          cb(null, path.join(__dirname, 'public/images'))
      },
      filename: function (req, file, cb) {
          const ext = path.extname(file.originalname) || '.png';
          const finalName = file.fieldname.includes('.') ? file.fieldname : file.fieldname + ext;
          cb(null, finalName);
      }
  });
  ```
- `server.js:3249`:
  ```javascript
  app.post('/admin/upload-asset', requireAdmin, assetUpload.any(), (req, res) => { ... });
  ```

#### Vulnerability Analysis
The static asset uploader uses `file.fieldname` directly as the output filename in `public/images`. If a request specifies a field name containing directory traversal sequences (such as `../../views/index.ejs`), `path.join` resolves to a path outside `public/images`. An attacker can overwrite any file writable by the Node process, including server templates or scripts.

#### Impact
Critical Remote Code Execution (RCE) by overwriting an EJS template file with malicious server-side JS tags (`<% require('child_process').execSync(...) %>`). When combined with SEC-01 (Treasury DOM XSS), this allows unauthenticated remote attackers to compromise the entire host.

#### Concrete Remediation
Sanitize the filename using `path.basename` and enforce a strict whitelist of permissible static asset filenames:
```javascript
const ALLOWED_ASSETS = ['logo.png', 'bitcoin-banner.jpg', 'bottom-banner-1.jpg', 'bottom-banner-2.jpg', 'carding-product.jpg'];
const cleanName = path.basename(file.fieldname);
if (!ALLOWED_ASSETS.includes(cleanName)) {
    return cb(new Error('Invalid asset fieldname'));
}
cb(null, cleanName);
```

---

### SEC-08 [HIGH]: Negative Quantity & Order Price Manipulation

#### Locations
- `server.js:908` (`/cart/add`):
  ```javascript
  const { product_id, quantity } = req.body;
  const prodId = parseInt(product_id, 10);
  const qty = parseInt(quantity) || 1;
  ```
- `server.js:1059` (`/checkout`):
  ```javascript
  let totalUsd = 0;
  prods.forEach(p => totalUsd += (p.price * cartObj[p.id]));
  const cryptoValue = totalUsd / (rates[payment_method] || 1);
  ```

#### Vulnerability Analysis
While `/cart/update` enforces `if (qty > 0)`, `/cart/add` does not check for negative values. An attacker can POST a negative `quantity` (e.g., `-5`), resulting in a negative item count in `req.session.cart`. At checkout, `p.price * cartObj[p.id]` subtracts value from the cart, allowing the buyer to artificially reduce the total price of orders to near zero.

#### Impact
Business logic compromise allowing buyers to obtain digital or physical goods without paying.

#### Concrete Remediation
Enforce bounds on quantity in `/cart/add`:
```javascript
const qty = parseInt(quantity, 10);
if (isNaN(qty) || qty <= 0 || qty > 100) {
    return res.status(400).json({ success: false, error: 'Invalid quantity' });
}
```

---

### SEC-09 [HIGH]: CSRF Token Exposure via Query Strings (`req.query._csrf`)

#### Locations
- `server.js:765`:
  ```javascript
  const token = (req.body && req.body._csrf) || req.headers['x-csrf-token'] || req.query._csrf;
  ```
- Various forms across `views/`:
  - `views/admin.ejs:257, 452, 508`
  - `views/vendor.ejs:51, 163, 194, 234, 389`
  - `views/dashboard.ejs:473`
  - All specify `action="/route?_csrf=<%= csrfToken %>"`

#### Vulnerability Analysis
Because Express's body parsers do not parse multipart form data prior to Multer, the application developers passed the CSRF token in the query string `?_csrf=...` as a workaround. Passing anti-CSRF tokens in URLs violates security standards (OWASP CSRF Prevention Cheat Sheet):
1. URLs are logged in web server access logs, reverse proxies, and Tor logs.
2. Tokens appear in browser history.
3. If any outgoing link is followed, the token is leaked via the HTTP `Referer` header.

#### Impact
Token leakage enables attackers to intercept valid CSRF tokens and execute state-changing requests against the victim.

#### Concrete Remediation
1. Remove `req.query._csrf` from `requireCsrf`.
2. Place Multer middleware on specific routes before validating CSRF from `req.body._csrf`, or utilize the `X-CSRF-Token` request header for AJAX/Fetch multipart uploads.

---

### SEC-10 [MEDIUM]: Open Redirect in Step-Up Auth & Referer Redirection

#### Locations
- `server.js:2835` (`/admin/treasury/step-up`):
  ```javascript
  const { password, returnTo } = req.body;
  ...
  res.redirect(returnTo || '/admin/treasury');
  ```
- `server.js:901`:
  ```javascript
  res.redirect(req.get('Referer') || '/');
  ```
- `server.js:2334`:
  ```javascript
  res.redirect(req.get('referer') || '/dashboard');
  ```

#### Vulnerability Analysis
1. In `/admin/treasury/step-up`, `returnTo` is accepted from POST body without validation and directly redirected to via `res.redirect(returnTo)`. An attacker can supply `https://phishing-site.com` or `//phishing-site.com`.
2. In `/wishlist/toggle` and `/vendor/review/reply/:id`, `Referer` header is trusted directly without verifying whether it belongs to the same domain.

#### Impact
Phishing attacks targeting users or administrators after sensitive authentication steps.

#### Concrete Remediation
Enforce local relative path validation for redirects:
```javascript
function safeRedirectUrl(url, fallback = '/') {
    if (!url || typeof url !== 'string') return fallback;
    const trimmed = url.trim();
    if (trimmed.startsWith('/') && !trimmed.startsWith('//') && !trimmed.startsWith('/\\')) {
        return trimmed;
    }
    return fallback;
}
```

---

### SEC-11 [MEDIUM]: Insecure Direct Object Reference (IDOR) on Order Tracking

#### Locations
- `server.js:3296-3300`:
  ```javascript
  const userId = req.session.user ? req.session.user.id : null;
  const isAllowed = userId === order.user_id || (req.session.user && req.session.user.is_vendor);
  if (!isAllowed) {
      return res.render('track_order', { order: null, error: 'Order not found...' });
  }
  ```

#### Vulnerability Analysis
The authorization check allows *any* user with `is_vendor: 1` to track *any* order in the database, even if the order was placed with another vendor entirely.

#### Impact
Any approved vendor can view the tracking ID, product name, delivery status, and buyer username of orders belonging to competitor vendors.

#### Concrete Remediation
Enforce that only the buyer who placed the order or the specific vendor who sells the product can view tracking:
```javascript
const isAllowed = userId === order.user_id || (req.session.user && req.session.user.id === order.vendor_id);
```

---

## Template-by-Template Audit Summary

| Template File | Non-include `<%-` | Script Tags | XSS Risk | CSRF Form Status |
|---|---|---|---|---|
| `views/admin_treasury.ejs` | Yes (`statusBadge`) | 4 tags | **CRITICAL** (DOM XSS in line 106) | Forms include `_csrf` |
| `views/vendor_profile.ejs` | Yes (`vendor.vendor_description`) | 0 tags | **HIGH** (Stored XSS in line 175) | Forms include `_csrf` |
| `views/product_detail.ejs` | Yes (`product.description`) | 1 tag | **HIGH** (Stored XSS in line 139) | Forms include `_csrf` |
| `views/messages.ejs` | Yes (`pNameStr`, `pAvatar`) | 2 tags | **HIGH** (Stored XSS in line 557) | AJAX sends `X-CSRF-Token` |
| `views/vendor.ejs` | Yes (`vendor_description`, `JSON.stringify`) | 2 tags | **HIGH** (Attribute XSS line 221) | Forms include `_csrf` |
| `views/_advert_carousel.ejs` | No | 0 tags | **HIGH** (`javascript:` URI line 10) | N/A (links only) |
| `views/admin_adverts.ejs` | No | 0 tags | **HIGH** (`javascript:` URI line 78) | Forms include `_csrf` |
| `views/admin.ejs` | No | 1 tag | Safe (clean fetch) | Forms include `_csrf` |
| `views/index.ejs` | No | 1 tag | Safe | Forms include `_csrf` |
| `views/forum.ejs` | No | 1 tag | Safe (simData static) | Forms include `_csrf` |
| `views/forum_post.ejs` | No | 1 tag | Safe (numeric ID) | Forms include `_csrf` |
| `views/payment.ejs` | No | 1 tag | Safe (innerText) | AJAX sends `_csrf` |
| `views/cart.ejs` | No | 1 tag | Safe | AJAX sends `_csrf` |
| `views/checkout.ejs` | No | 1 tag | Safe | Forms include `_csrf` |
| `views/dashboard.ejs` | No | 1 tag | Safe | Forms include `_csrf` |
| `views/login.ejs` | No | 1 tag | Safe | Forms include `_csrf` |
| `views/register.ejs` | No | 0 tags | Safe | Forms include `_csrf` |
| `views/profile.ejs` | No | 1 tag | Safe | Forms include `_csrf` |
| `views/reviews.ejs` | No | 0 tags | Safe (escaped via `<%=`) | Forms include `_csrf` |
| `views/track_order.ejs` | No | 0 tags | Safe (escaped) | Forms include `_csrf` |
| `views/support.ejs` | No | 1 tag | Safe | Forms include `_csrf` |
| `views/partner_auth.ejs` | No | 1 tag | Safe | Forms include `_csrf` |
| `views/partner_dashboard.ejs`| No | 1 tag | Safe | Forms include `_csrf` |
| `views/partner_settings.ejs` | No | 0 tags | Safe | Forms include `_csrf` |
| `views/footer.ejs` | No | 4 tags | Safe | AJAX includes `_csrf` |
| `views/header.ejs` | No | 1 tag | Safe | N/A |

---

## Action Plan & Verification Methods

1. **Immediate Patch Priorities**:
   - Eliminate `document.write(p.get('error'))` in `views/admin_treasury.ejs:106`.
   - Prevent Path Traversal in `server.js:23` by sanitizing `file.fieldname` with `path.basename` and whitelisting.
   - Enforce server-side sanitization of rich text descriptions (`vendor_description` and `product.description`).
   - Validate and sanitize URLs (`target_url` in adverts, `returnTo` in step-up authentication).
   - Validate `username` on registration and remove `<%-` interpolation inside JS scripts.
   - Enforce positive `quantity > 0` validation in `/cart/add`.

2. **Automated Verification**:
   - Run integration tests simulating requests containing malicious XSS payloads in query strings and form fields.
   - Run CSRF test harness verifying rejection of requests lacking headers or proper bodies.
   - Verify that all templates render escaped content without breaking syntax.
