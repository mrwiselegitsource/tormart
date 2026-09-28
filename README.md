# Neobyte Cryptocurrency Payment System

This project is a Node.js-based cryptocurrency payment processor built seamlessly into the Neobyte platform. It fully handles exact payment matching, confirmations, underpayments, and overpayments autonomously without relying on third-party SaaS providers.

## Architecture

The system consists of:
1.  **Payment Domain (DB & `PaymentService`)**: Manages the lifecycle of payment intents (`PAYMENT_CREATED`, `WAITING_FOR_PAYMENT`, `TRANSACTION_DETECTED`, `CONFIRMING`, `CONFIRMED`, `PAID`). Backend is the ultimate source of truth.
2.  **Blockchain Adapters (`blockchain/*.js`)**: Unified abstractions connecting to native RPCs for BTC, LTC, BCH, ETH, and XMR.
3.  **Payment Worker (`PaymentWorker`)**: Background autonomous process that sweeps unpaid intents every 15 seconds to interact with adapters and confirm payments without blocking UI requests.
4.  **Checkout UI**: Handles safe client-side polling and secure server-rendered QR codes without revealing backend configuration.

## Supported Currencies
*   **Bitcoin (BTC)** (UTXO)
*   **Litecoin (LTC)** (UTXO)
*   **Bitcoin Cash (BCH)** (UTXO)
*   **Ethereum (ETH)** (Account-based)
*   **Monero (XMR)** (Subaddresses/Ring Signatures)

## Setup Requirements

1.  **Node.js**: Requires Node.js v14+ 
2.  **SQLite**: Uses a local `neobyte.db` (Schema auto-migrates via `initializeSchema()` in `server.js`).
3.  **Blockchain Infrastructure**: You MUST operate or have access to full nodes for any currency you want to automatically process.

### Environment Variables
Copy `.env.example` to `.env` and fill it out:

```bash
BTC_RPC="http://rpcuser:rpcpassword@127.0.0.1:8332"
LTC_RPC="http://rpcuser:rpcpassword@127.0.0.1:9332"
BCH_RPC="http://rpcuser:rpcpassword@127.0.0.1:8332"
ETH_RPC="http://127.0.0.1:8545"
XMR_RPC="http://rpcuser:rpcpassword@127.0.0.1:18082"
```

## Production Deployment Checklist (WARNING)

DO NOT use fake mock strings in production. Doing so will result in immediate financial loss.

1.  [ ] **Run Full Nodes**: You must have fully synced BTC, LTC, BCH, ETH, and XMR nodes.
2.  [ ] **Configure monero-wallet-rpc**: XMR specifically requires `monero-wallet-rpc` bound to the wallet that matches your master XMR address.
3.  [ ] **Secure the RPCs**: Ensure your RPCs are NOT exposed to the public internet (bind them to localhost/127.0.0.1 or put them behind a secure VPN/VPC).
4.  [ ] **HTTPS**: Deploy behind an NGINX reverse proxy with TLS/SSL.
5.  [ ] **Database Backups**: Schedule SQLite backups or migrate to PostgreSQL for massive scale.
6.  [ ] **Rate Limiting**: Add global rate-limiting to `POST /checkout` to prevent spamming the database with fake payment intents.

## Testing
Run the test suite using standard node execution (no external framework required):
```bash
for file in tests/*.test.js; do node "$file"; done
```
Tests simulate adapter interactions natively by intercepting the `fetch` calls.

## Payment States & Configuration
*   **Expiration**: Intents expire precisely 60 minutes after creation.
*   **Confirmations**: BTC/BCH/LTC default to 2. ETH defaults to 12. XMR defaults to 10. These can be adjusted via `createPaymentIntent()` arguments.
