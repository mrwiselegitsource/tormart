# Handoff Report: Frontend, Template, XSS & CSRF Security Audit

**Agent**: Explorer 2 (Frontend, Template, XSS & CSRF Specialist)  
**Target Path**: `/home/magic/Downloads/NeobyteCards-Tor`  
**Handoff Type**: Hard (Task Complete)  
**Date**: 2026-10-08T20:17:30Z  

---

## 1. Observation

Direct code observations across templates in `views/` and route handlers in `server.js`:

1. **DOM XSS via `document.write`**:
   - `views/admin_treasury.ejs:103-108`:
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
     `document.write` writes the raw query parameter `error` directly into the DOM in an administrative view.

2. **Unescaped Rich Text Rendering**:
   - `views/vendor_profile.ejs:175`: `<div class="ql-editor" style="padding:0;"><%- (vendor.vendor_description || '') %></div>`
   - `views/vendor.ejs:105`: `<div id="vendor_description_editor" style="min-height: 300px;"><%- user.vendor_description || '' %></div>`
   - `views/product_detail.ejs:139`: `<%- product.description %>`
   - In `server.js:2252, 2297, 2181, 2390`, `vendor_description` and `description` are saved to SQLite without HTML sanitization or tag filtering.

3. **Inline Script Interpolation & Unvalidated Usernames**:
   - `views/messages.ejs:557`: `const pNameStr = "<%- (typeof pName !== 'undefined') ? pName : 'Partner' %>";`
   - `views/messages.ejs:633`: `(isMe ? '<%= user.username %>' : pNameStr)` concatenated into `msgRow.innerHTML` (line 637).
   - `server.js:1497-1508`: `app.post('/register')` performs zero character or format validation on `username`.

4. **Attribute Breakout in Vendor Dashboard**:
   - `views/vendor.ejs:221`: `<button onclick='openEditModal(<%- JSON.stringify(product) %>)' ...>Edit</button>`
   - `JSON.stringify` does not escape single quotes (`'`), which are used as the HTML attribute delimiters.

5. **Arbitrary Protocol Links in Adverts**:
   - `views/_advert_carousel.ejs:10`: `<a href="<%= ad.target_url %>" class="advert-item">`
   - `views/admin_adverts.ejs:78`: `<a href="<%= ad.target_url %>" target="_blank" ...><%= ad.target_url %></a>`
   - `server.js:2224, 2604`: `target_url` is stored with no URI scheme validation (`javascript:` allowed).

6. **Path Traversal / Template Overwrite in Admin Asset Upload**:
   - `server.js:20-25`:
     ```javascript
     filename: function (req, file, cb) {
         const ext = path.extname(file.originalname) || '.png';
         const finalName = file.fieldname.includes('.') ? file.fieldname : file.fieldname + ext;
         cb(null, finalName);
     }
     ```
   - Destination is `path.join(__dirname, 'public/images')`. If `fieldname` contains `../../views/index.ejs`, it resolves outside `public/images`.

7. **Negative Cart Quantities**:
   - `server.js:908`: `const qty = parseInt(quantity) || 1;` lacks lower bound validation (`qty > 0`).
   - `server.js:1059`: `prods.forEach(p => totalUsd += (p.price * cartObj[p.id]));` enables reducing cart totals with negative values.

8. **CSRF Token in Query Parameters**:
   - `server.js:765`: `const token = (req.body && req.body._csrf) || req.headers['x-csrf-token'] || req.query._csrf;`
   - Multi-part forms pass `?_csrf=<%= csrfToken %>` in action URLs (e.g. `views/admin.ejs:257, 452, 508`, `views/vendor.ejs:51, 163, 194, 234`).

9. **Unvalidated Redirection**:
   - `server.js:2835`: `res.redirect(returnTo || '/admin/treasury');` in `/admin/treasury/step-up` accepts arbitrary `req.body.returnTo`.
   - `server.js:901, 2334`: Redirects to raw `req.get('Referer')` without domain validation.

10. **IDOR on Order Tracking**:
    - `server.js:3296-3300`: `const isAllowed = userId === order.user_id || (req.session.user && req.session.user.is_vendor);` grants any vendor read access to any order.

---

## 2. Logic Chain

1. **From Observation 1**: `admin_treasury.ejs:106` takes `p.get('error')` directly from `window.location.search` and passes it to `document.write`. Since `document.write` parses input as HTML markup, navigating an administrator to `/admin/treasury?error=<script>...` results in immediate DOM XSS execution within the admin context.
2. **From Observation 2**: User-supplied input from `req.body.vendor_description` and `req.body.description` is saved unvalidated into the database and rendered raw via `<%-` in `vendor_profile.ejs` and `product_detail.ejs`. This creates Stored XSS affecting all marketplace visitors browsing vendor profiles and products.
3. **From Observation 3**: `messages.ejs:557` interpolates `pName` (a username) using `<%-` inside an inline JavaScript string literal (`"..."`). Because `/register` accepts arbitrary usernames, a username containing quotes or script tags breaks out of the string literal, executing arbitrary JavaScript when opening a conversation.
4. **From Observation 4**: In `vendor.ejs:221`, `JSON.stringify(product)` is wrapped inside single quotes (`onclick='...'`). If `product.name` contains `'`, the single quote breaks out of the attribute and injects arbitrary attributes/event handlers.
5. **From Observation 5**: Smart advert carousel items render `ad.target_url` directly inside `<a href="...">`. Escaping HTML tags with `<%=` does not prevent `javascript:` pseudoprotocols. Clicking an advert triggers script execution.
6. **From Observation 6**: `assetStorage` uses `file.fieldname` directly in `cb(null, finalName)` with destination `public/images`. Supplying `../../views/<target>.ejs` allows directory traversal out of `public/images` to overwrite server template files. When chained with SEC-01 (Treasury DOM XSS), an attacker can automate an admin asset upload to achieve full Remote Code Execution (RCE).
7. **From Observation 7**: `/cart/add` does not ensure `qty > 0`. Submitting negative quantities creates negative quantities in `session.cart`, which decreases the computed order total at checkout, allowing price manipulation.
8. **From Observation 8**: Passing `?_csrf=...` in query parameters exposes anti-CSRF tokens in web server logs, proxy logs, and HTTP Referer headers.
9. **From Observation 9**: Step-up auth in `/admin/treasury/step-up` accepts `req.body.returnTo` and passes it directly to `res.redirect(returnTo)`, allowing external redirection to attacker-controlled phishing domains.
10. **From Observation 10**: Tracking authorization checks `req.session.user.is_vendor` without verifying if the order's `product.vendor_id` matches the session vendor's ID, exposing arbitrary order metadata to competitor vendors.

---

## 3. Caveats

- **No Active Exploitation**: All findings were identified via static source code analysis without sending network requests or modifying production databases.
- **Tor Network Protocol**: Tor onion sites typically run over HTTP locally behind a Tor onion service proxy. Cookie `secure` flags must take into account deployment configuration (`NODE_ENV === 'production'` behind TLS termination vs .onion service).
- **Backend Services**: Blockchain backend daemons (`services/paymentWorker.js`, `blockchain/*.js`) were not audited in this frontend-scoped review.

---

## 4. Conclusion

The application presents multiple high-impact frontend and template security vulnerabilities:
1. **Critical DOM XSS** in the admin treasury view (`admin_treasury.ejs:106`) that can be weaponized against administrators.
2. **Multiple Stored XSS vulnerabilities** in product descriptions, vendor descriptions, messages, and advert carousels that permit client-side session takeover.
3. **High-risk File Upload Traversal** in `assetStorage` (`server.js:23`) that allows arbitrary template overwrites and RCE.
4. **Financial Logic Flaw** in `/cart/add` permitting negative quantity inputs.
5. **Insecure CSRF token handling** via URL query parameters.

All vulnerabilities have localized, concrete remediation patches detailed in `frontend_security_report.md`.

---

## 5. Verification Method

To independently verify these findings:

1. **Verify SEC-01 (Treasury DOM XSS)**:
   - Inspect `views/admin_treasury.ejs` lines 103–108:
     ```bash
     sed -n '103,108p' views/admin_treasury.ejs
     ```
   - Invalidation condition: `document.write` replaced with `el.textContent = ...`.

2. **Verify SEC-02 & SEC-03 (Stored XSS in Descriptions)**:
   - Inspect `views/vendor_profile.ejs:175` and `views/product_detail.ejs:139`:
     ```bash
     grep -n 'product\.description' views/product_detail.ejs
     grep -n 'vendor\.vendor_description' views/vendor_profile.ejs
     ```
   - Invalidation condition: Raw `<%-` replaced with sanitized HTML helper output or `<%=`.

3. **Verify SEC-06 (Attribute Breakout in Vendor Dashboard)**:
   - Inspect `views/vendor.ejs:221`:
     ```bash
     sed -n '220,225p' views/vendor.ejs
     ```
   - Invalidation condition: Inline `onclick='...'` replaced with a standard `data-product` attribute or event listener.

4. **Verify SEC-07 (Asset Upload Path Traversal)**:
   - Inspect `server.js:15-26`:
     ```bash
     sed -n '15,26p' server.js
     ```
   - Invalidation condition: `file.fieldname` sanitized with `path.basename` and checked against an asset whitelist.

5. **Verify SEC-08 (Negative Cart Quantity)**:
   - Inspect `server.js:905-915`:
     ```bash
     sed -n '905,918p' server.js
     ```
   - Invalidation condition: Explicit check `if (isNaN(qty) || qty <= 0) return res.status(400)...` present in `/cart/add`.
