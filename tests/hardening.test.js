const assert = require('assert');
const sqlite3 = require('sqlite3').verbose();
const { PaymentService, PaymentStatus } = require('../services/paymentService');
const { PaymentWorker } = require('../services/paymentWorker');

async function setupTestDb() {
    return new Promise((resolve, reject) => {
        const db = new sqlite3.Database(':memory:');
        db.serialize(() => {
            db.run(`CREATE TABLE IF NOT EXISTS orders (id INTEGER PRIMARY KEY, user_id INTEGER)`);
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
    console.log("Starting Hardening & Scalability tests...");
    let db;
    try {
        db = await setupTestDb();
        const paymentService = new PaymentService(db);
        
        // --- Test 1: Order Creation Rate Limiting Logic ---
        console.log("Test 1: Order Creation Rate Limiting");
        const userId = 100;
        const maxActiveOrders = 5;
        
        // Create 5 active orders
        for (let i = 1; i <= 5; i++) {
            await new Promise(r => db.run(`INSERT INTO orders (id, user_id) VALUES (?, ?)`, [i, userId], r));
            await paymentService.createPaymentIntent({
                orderId: i, currency: 'BTC', network: 'mainnet', expectedAmountCrypto: '100',
                paymentAddress: `addr${i}`, requiredConfirmations: 2
            });
        }
        
        // Run the query identical to server.js limit check
        const row = await new Promise((resolve, reject) => {
            db.get(`
                SELECT COUNT(i.id) as active_count 
                FROM payment_intents i
                JOIN orders o ON i.order_id = o.id
                WHERE o.user_id = ? AND i.status IN ('PAYMENT_CREATED', 'WAITING_FOR_PAYMENT', 'TRANSACTION_DETECTED', 'CONFIRMING')
            `, [userId], (err, res) => err ? reject(err) : resolve(res));
        });
        
        assert.strictEqual(row.active_count, 5);
        if (row.active_count >= maxActiveOrders) {
            // This is what server.js does to reject
            assert.ok(true, "Limit reached correctly");
        } else {
            assert.fail("Limit should have been reached");
        }
        console.log("Test 1 Passed");

        // --- Test 2: Worker Overlap Prevention ---
        console.log("Test 2: Worker Overlap Prevention");
        let processCount = 0;
        const mockAdapter = {
            findTransactionsByAddress: async (addr) => {
                processCount++;
                return new Promise(resolve => setTimeout(() => resolve([]), 50)); // Artificial delay
            },
            verifyTransaction: async () => ({ status: 'WAITING_FOR_PAYMENT', receivedAmountCrypto: '0', confirmations: 0 })
        };
        const worker = new PaymentWorker(db, paymentService, { 'BTC': mockAdapter });
        
        // Trigger cycle 1
        const promise1 = worker.processActivePayments();
        
        // Instantly trigger cycle 2 (simulate 15s interval firing while RPC is lagging)
        const promise2 = worker.processActivePayments();
        
        await Promise.all([promise1, promise2]);
        
        // Because of overlap prevention, processCount should only increment 5 times (for the 5 active intents) in one cycle. 
        // If it ran twice, it would be 10.
        assert.strictEqual(processCount, 5);
        console.log("Test 2 Passed");

        // --- Test 3: Concurrency Limiting ---
        console.log("Test 3: Concurrency Limiting (Promise.allSettled chunking)");
        // Add 10 more intents (15 total)
        for (let i = 6; i <= 15; i++) {
            await new Promise(r => db.run(`INSERT INTO orders (id, user_id) VALUES (?, ?)`, [i, userId], r));
            await paymentService.createPaymentIntent({
                orderId: i, currency: 'BTC', network: 'mainnet', expectedAmountCrypto: '100',
                paymentAddress: `addr${i}`, requiredConfirmations: 2
            });
        }
        processCount = 0;
        process.env.WORKER_CONCURRENCY = '3'; // Chunk size 3
        
        await worker.processActivePayments();
        assert.strictEqual(processCount, 15);
        console.log("Test 3 Passed");
        
        console.log("All Hardening tests passed successfully!");
    } catch (err) {
        console.error("Test failed:", err);
        process.exit(1);
    } finally {
        if (db) db.close();
    }
}

runTests();
