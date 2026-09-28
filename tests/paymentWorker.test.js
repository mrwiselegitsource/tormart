const assert = require('assert');
const sqlite3 = require('sqlite3').verbose();
const { PaymentService, PaymentStatus } = require('../services/paymentService');
const { PaymentWorker } = require('../services/paymentWorker');

async function setupTestDb() {
    return new Promise((resolve, reject) => {
        const db = new sqlite3.Database(':memory:');
        db.serialize(() => {
            db.run(`CREATE TABLE IF NOT EXISTS orders (id INTEGER PRIMARY KEY)`);
            db.run(`INSERT INTO orders (id) VALUES (1)`);
            db.run(`CREATE TABLE IF NOT EXISTS payment_intents (
                id TEXT PRIMARY KEY, order_id INTEGER, currency TEXT, network TEXT,
                expected_amount_crypto TEXT, payment_address TEXT, status TEXT,
                required_confirmations INTEGER, expires_at DATETIME,
                created_at DATETIME, updated_at DATETIME
            )`);
            db.run(`CREATE TABLE IF NOT EXISTS payment_transactions (
                id TEXT PRIMARY KEY, payment_intent_id TEXT, currency TEXT,
                txid TEXT, received_amount_crypto TEXT, confirmations INTEGER DEFAULT 0,
                status TEXT, detected_at DATETIME, confirmed_at DATETIME,
                failure_reason TEXT, metadata TEXT, UNIQUE(currency, txid)
            )`);
            db.run(`CREATE TABLE IF NOT EXISTS payment_events (
                id INTEGER PRIMARY KEY AUTOINCREMENT, payment_intent_id TEXT,
                event_type TEXT, old_status TEXT, new_status TEXT, metadata TEXT,
                created_at DATETIME
            )`);
            resolve(db);
        });
    });
}

async function runTests() {
    console.log("Starting PaymentWorker tests...");

    let db;
    try {
        db = await setupTestDb();
        const paymentService = new PaymentService(db);

        // Mock adapter
        const mockAdapter = {
            transactions: {}, // txid -> { status, receivedAmountCrypto, confirmations }
            addressTxids: {}, // address -> [txid]
            findTransactionsByAddress: async (address) => {
                if (address === 'fail_find') throw new Error("RPC error during find");
                return mockAdapter.addressTxids[address] || [];
            },
            verifyTransaction: async (txid, expectedAddress, expectedAmountCrypto, expectedNetwork, reqConfs) => {
                if (txid === 'fail_verify') throw new Error("RPC error during verify");
                if (mockAdapter.transactions[txid]) return mockAdapter.transactions[txid];
                return { status: PaymentStatus.WAITING_FOR_PAYMENT, receivedAmountCrypto: '0', confirmations: 0 };
            }
        };

        const adapters = { 'BTC': mockAdapter };
        const worker = new PaymentWorker(db, paymentService, adapters);

        // --- Test 1: Automatic Detection & Progression ---
        console.log("Test 1: Automatic Detection & Progression");
        const intentId1 = await paymentService.createPaymentIntent({
            orderId: 1, currency: 'BTC', network: 'mainnet', expectedAmountCrypto: '1000',
            paymentAddress: 'addr1', requiredConfirmations: 2
        });

        // Initially no tx
        await worker.processActivePayments();
        let i1 = await worker.getQuery(`SELECT status FROM payment_intents WHERE id=?`, [intentId1]);
        assert.strictEqual(i1.status, PaymentStatus.PAYMENT_CREATED);

        // Provide an unconfirmed tx
        mockAdapter.addressTxids['addr1'] = ['tx1'];
        mockAdapter.transactions['tx1'] = { status: PaymentStatus.TRANSACTION_DETECTED, receivedAmountCrypto: '1000', confirmations: 0 };
        
        await worker.processActivePayments();
        i1 = await worker.getQuery(`SELECT status FROM payment_intents WHERE id=?`, [intentId1]);
        assert.strictEqual(i1.status, PaymentStatus.TRANSACTION_DETECTED);

        // Progress to confirming
        mockAdapter.transactions['tx1'] = { status: PaymentStatus.CONFIRMING, receivedAmountCrypto: '1000', confirmations: 1 };
        await worker.processActivePayments();
        i1 = await worker.getQuery(`SELECT status FROM payment_intents WHERE id=?`, [intentId1]);
        assert.strictEqual(i1.status, PaymentStatus.CONFIRMING);

        // Progress to confirmed
        mockAdapter.transactions['tx1'] = { status: PaymentStatus.CONFIRMED, receivedAmountCrypto: '1000', confirmations: 2 };
        await worker.processActivePayments();
        i1 = await worker.getQuery(`SELECT status FROM payment_intents WHERE id=?`, [intentId1]);
        assert.strictEqual(i1.status, PaymentStatus.CONFIRMED);
        console.log("Test 1 Passed");

        // --- Test 2: Duplicate Detection ---
        console.log("Test 2: Duplicate Detection / Idempotency");
        // Re-running processActivePayments shouldn't change confirmed state or crash
        await worker.processActivePayments();
        i1 = await worker.getQuery(`SELECT status FROM payment_intents WHERE id=?`, [intentId1]);
        assert.strictEqual(i1.status, PaymentStatus.CONFIRMED);
        
        const txs = await worker.allQuery(`SELECT * FROM payment_transactions WHERE payment_intent_id=?`, [intentId1]);
        assert.strictEqual(txs.length, 1, "Should not duplicate transaction records");
        console.log("Test 2 Passed");

        // --- Test 3: RPC Failure Handling ---
        console.log("Test 3: RPC Failure Handling");
        const intentId3 = await paymentService.createPaymentIntent({
            orderId: 1, currency: 'BTC', network: 'mainnet', expectedAmountCrypto: '1000',
            paymentAddress: 'fail_find', requiredConfirmations: 2
        });
        // processActivePayments catches errors per intent and continues
        await worker.processActivePayments();
        let i3 = await worker.getQuery(`SELECT status FROM payment_intents WHERE id=?`, [intentId3]);
        assert.strictEqual(i3.status, PaymentStatus.PAYMENT_CREATED);
        console.log("Test 3 Passed");

        // --- Test 4: Underpayment ---
        console.log("Test 4: Underpayment");
        const intentId4 = await paymentService.createPaymentIntent({
            orderId: 1, currency: 'BTC', network: 'mainnet', expectedAmountCrypto: '1000',
            paymentAddress: 'addr_under', requiredConfirmations: 1
        });
        mockAdapter.addressTxids['addr_under'] = ['tx_under'];
        mockAdapter.transactions['tx_under'] = { status: PaymentStatus.UNDERPAID, receivedAmountCrypto: '500', confirmations: 1 };
        
        await worker.processActivePayments();
        let i4 = await worker.getQuery(`SELECT status FROM payment_intents WHERE id=?`, [intentId4]);
        assert.strictEqual(i4.status, PaymentStatus.UNDERPAID);
        console.log("Test 4 Passed");

        // --- Test 5: Expiration ---
        console.log("Test 5: Expiration");
        const intentId5 = await paymentService.createPaymentIntent({
            orderId: 1, currency: 'BTC', network: 'mainnet', expectedAmountCrypto: '1000',
            paymentAddress: 'addr_exp', requiredConfirmations: 1
        });
        // Force expire
        await worker.runQuery(`UPDATE payment_intents SET expires_at = ? WHERE id = ?`, [new Date(Date.now() - 10000).toISOString(), intentId5]);
        
        await worker.processActivePayments();
        let i5 = await worker.getQuery(`SELECT status FROM payment_intents WHERE id=?`, [intentId5]);
        assert.strictEqual(i5.status, PaymentStatus.EXPIRED);
        console.log("Test 5 Passed");

        // --- Test 6: Late Payment ---
        console.log("Test 6: Late Payment");
        // Now a payment arrives for the expired intent. 
        // Process doesn't auto-pick it up because status is EXPIRED (not in active states).
        // But what if we manually verify it? Or what if it arrived right as it expired?
        mockAdapter.addressTxids['addr_exp'] = ['tx_late'];
        mockAdapter.transactions['tx_late'] = { status: PaymentStatus.CONFIRMED, receivedAmountCrypto: '1000', confirmations: 1 };
        
        await worker.manualVerifyTxid(intentId5, 'tx_late');
        i5 = await worker.getQuery(`SELECT status FROM payment_intents WHERE id=?`, [intentId5]);
        // Manual verification forces a processIntent which updates it to CONFIRMED
        assert.strictEqual(i5.status, PaymentStatus.CONFIRMED);
        console.log("Test 6 Passed");

        console.log("All PaymentWorker tests passed successfully!");
    } catch (err) {
        console.error("Test failed:", err);
        process.exit(1);
    } finally {
        if (db) db.close();
    }
}

runTests();
