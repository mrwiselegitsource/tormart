# Project: TorMart Security Audit, Remediation, & QA Review

## Architecture
- **Backend**: Node.js with Express 5 (`server.js`), EJS templating (`views/`), SQLite3 database (`neobyte.db` / `database.sqlite`).
- **Frontend**: EJS server-rendered templates, Bootstrap/custom CSS in `public/`.
- **Key Modules**:
  - Authentication & Session Management: `express-session`, bcryptjs, role-based access (buyer, vendor, admin, partner).
  - Marketplace Logic: Products, categories, cart, checkout, orders, escrow, tracking.
  - User Communication: Messaging (`messages.ejs`), Forum (`forum.ejs`, `forum_post.ejs`), Support tickets.
  - Vendor & Admin: Vendor applications, seller dashboard, admin moderation, treasury, address pool.
  - Payment & Blockchain: Bitcoin / crypto payment processing, address generation, webhooks.

## Milestones
| # | Name | Scope | Dependencies | Status |
|---|------|-------|-------------|--------|
| M1 | Security Audit & Codebase Discovery | Audit `server.js`, `views/`, DB queries for SQLi, XSS, CSRF, IDOR, Auth, File Upload; map all features & routes | None | DONE |
| M2 | Security Remediation | Apply high-confidence security patches to `server.js`, templates, and middleware; prevent regressions | M1 | IN_PROGRESS |
| M3 | Feature Identification & QA Plan | Generate comprehensive, structured, itemized manual testing checklist organized by role (Buyer, Vendor, Admin) and page | M1 | DONE |
| M4 | Visual & Functional Browser Inspection | Test running app at http://localhost:3000, verify pages render without crashes, fix broken layouts | M2 | PLANNED |
| M5 | Multi-Specialist Verification & Forensic Audit | Reviewers, Challengers, and Forensic Auditor verify security, functionality, and authentic implementation | M2, M3, M4 | PLANNED |
| M6 | Final Synthesis & Sentinel Reporting | Compile executive security report, QA deliverable, verify all acceptance criteria, report to Sentinel | M5 | PLANNED |

## Interface Contracts & Guidelines
- All database queries must use parameterized prepared statements (avoid SQL injection).
- User inputs rendered in EJS must use `<%= %>` escaping instead of `<%- %>` unless explicitly safe HTML with strict sanitization.
- Object-level access control (IDOR checks) must verify `req.session.user` ownership or role before returning/modifying records.
- Critical state-changing endpoints must validate session authenticity and authorization.
- Passwords must be hashed using bcrypt; sensitive parameters must not leak.
- File uploads must validate file types, size, and destination paths.
- All code fixes must preserve existing marketplace functionality and not break routes or views.

## Code Layout
- `server.js`: Main Express application, routes, database queries, and middleware.
- `views/`: EJS view templates.
- `public/`: Static assets (CSS, JS, images).
- `services/`: Supporting backend services.
- `blockchain/`: Crypto/blockchain payment handlers.
- `tests/` / `test/`: Automated test scripts.
- `.agents/`: Agent metadata and reports.
