# Worker Remediation Gen 3 Workspace
Replacement worker for failed worker_remediation_gen2.
Status:
- Templates already patched (admin_treasury.ejs DOM XSS fixed, vendor_profile.ejs sanitizeHtml added).
- server.js lines 15-35 already patched (assetStorage allowed filenames whitelist).
Remaining to patch in server.js:
1. Multer standard uploads (upload, imageUpload, etc.): extensions whitelist, MIME check, 5MB limit.
2. File cleanup routines: ensure paths stay inside public/uploads or public/images.
3. Cart add quantity: validate qty > 0 and integer.
4. Checkout: guard wallets[payment_method], remove premature UPDATE users SET is_vip = 1.
5. Download digital key: check orders.status IN ('completed', 'paid', 'delivered').
6. Complete order: check orders.status IN ('paid', 'shipped', 'delivered') before granting completed status, VIP, and bonus balance.
7. Track order IDOR: restrict vendor access to products they own.
8. Registration session fixation: req.session.regenerate().
9. CAPTCHA replay: clear req.session.captcha after validation.
10. Review simulation missing date: null/string guard on custom_date.
11. Template fixes in views/vendor.ejs, product_detail.ejs, messages.ejs, _advert_carousel.ejs.
12. Restart Node server on port 3000 and verify via curl.
