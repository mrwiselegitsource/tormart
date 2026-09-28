const sqlite3 = require('sqlite3').verbose();
const { PaymentService, PaymentStatus } = require('../services/paymentService');
const assert = require('assert');

async function setupTestDb() {
    return new Promise((resolve, reject) => {
        const db = new sqlite3.Database(':memory:');
        db.serialize(() => {
            // Setup minimal schema for testing
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
                failure_reason TEXT, metadata TEXT,
                UNIQUE(currency, txid)
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
    console.log("Starting PaymentService tests...");
    let db;
    try {
        db = await setupTestDb();
        const service = new PaymentService(db);

        console.log("Test 1: createPaymentIntent");
        const intentId = await service.createPaymentIntent({
            orderId: 1,
            currency: 'BTC',
            network: 'mainnet',
            expectedAmountCrypto: '1000000', // 0.01 BTC in satoshis
            paymentAddress: 'bc1qtest123',
            requiredConfirmations: 3
        });
        assert.ok(intentId, "Intent ID should be generated");

        const intent = await service.getQuery('SELECT * FROM payment_intents WHERE id = ?', [intentId]);
        assert.strictEqual(intent.status, PaymentStatus.PAYMENT_CREATED);
        assert.strictEqual(intent.expected_amount_crypto, '1000000');
        console.log("Test 1 Passed");

        console.log("Test 2: updatePaymentStatus");
        await service.updatePaymentStatus(intentId, PaymentStatus.WAITING_FOR_PAYMENT, { note: "Customer viewed page" });
        const updated = await service.getQuery('SELECT * FROM payment_intents WHERE id = ?', [intentId]);
        assert.strictEqual(updated.status, PaymentStatus.WAITING_FOR_PAYMENT);

        const events = await new Promise((res, rej) => db.all("SELECT * FROM payment_events WHERE payment_intent_id = ?", [intentId], (err, rows) => err ? rej(err) : res(rows)));
        assert.strictEqual(events.length, 2); // CREATED and STATUS_UPDATE
        assert.strictEqual(events[1].new_status, PaymentStatus.WAITING_FOR_PAYMENT);
        console.log("Test 2 Passed");

        console.log("Test 3: recordTransaction");
        const txId = await service.recordTransaction(intentId, 'BTC', 'txid_abc123', '1000000');
        assert.ok(txId);
        console.log("Test 3 Passed");

        console.log("Test 4: recordTransaction duplicate protection");
        let duplicateCaught = false;
        try {
            await service.recordTransaction(intentId, 'BTC', 'txid_abc123', '1000000');
        } catch (err) {
            assert.strictEqual(err.message, PaymentStatus.ALREADY_USED);
            duplicateCaught = true;
        }
        assert.ok(duplicateCaught, "Should have thrown ALREADY_USED on duplicate TXID");
        console.log("Test 4 Passed");

        console.log("All tests passed successfully!");
    } catch (err) {
        console.error("Test failed:", err);
        process.exit(1);
    } finally {
        if (db) db.close();
    }
}

runTests();
