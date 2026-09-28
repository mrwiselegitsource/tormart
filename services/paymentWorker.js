const { PaymentStatus, SupportedCurrencies } = require('./paymentService');

class PaymentWorker {
    constructor(db, paymentService, adapters) {
        this.db = db;
        this.paymentService = paymentService;
        this.adapters = adapters; // { BTC: btcAdapter, ETH: ethAdapter, ... }
        this.isRunning = false;
        this.intervalId = null;
        this.isProcessing = false;
    }

    start(intervalMs = 60000) {
        if (this.isRunning) return;
        this.isRunning = true;
        this.intervalId = setInterval(() => this.processActivePayments(), intervalMs);
        console.log(`PaymentWorker started with interval ${intervalMs}ms`);
    }

    stop() {
        if (this.intervalId) {
            clearInterval(this.intervalId);
            this.intervalId = null;
        }
        this.isRunning = false;
        console.log("PaymentWorker stopped");
    }

    async getQuery(sql, params = []) {
        return new Promise((resolve, reject) => {
            this.db.get(sql, params, (err, row) => {
                if (err) reject(err);
                else resolve(row);
            });
        });
    }

    async allQuery(sql, params = []) {
        return new Promise((resolve, reject) => {
            this.db.all(sql, params, (err, rows) => {
                if (err) reject(err);
                else resolve(rows);
            });
        });
    }

    async runQuery(sql, params = []) {
        return new Promise((resolve, reject) => {
            this.db.run(sql, params, function(err) {
                if (err) reject(err);
                else resolve(this);
            });
        });
    }

    async processActivePayments() {
        if (this.isProcessing) {
            console.log("PaymentWorker skip: previous cycle still processing.");
            return;
        }
        this.isProcessing = true;
        try {
            const activeIntents = await this.allQuery(`
                SELECT * FROM payment_intents 
                WHERE status IN (?, ?, ?, ?)
            `, [
                PaymentStatus.PAYMENT_CREATED, 
                PaymentStatus.WAITING_FOR_PAYMENT, 
                PaymentStatus.TRANSACTION_DETECTED, 
                PaymentStatus.CONFIRMING
            ]);

            // Hardening Task 2 & 4: Scalability & RPC Efficiency (Bounded Concurrency)
            const CONCURRENCY_LIMIT = parseInt(process.env.WORKER_CONCURRENCY || "5", 10);
            for (let i = 0; i < activeIntents.length; i += CONCURRENCY_LIMIT) {
                const chunk = activeIntents.slice(i, i + CONCURRENCY_LIMIT);
                await Promise.allSettled(chunk.map(intent => this.processIntent(intent).catch(err => {
                    console.error(`Error processing intent ${intent.id}:`, err.message);
                })));
            }
        } catch (err) {
            console.error("Error in PaymentWorker loop:", err);
        } finally {
            this.isProcessing = false;
        }
    }

    async processIntent(intent) {
        const adapter = this.adapters[intent.currency];
        if (!adapter) {
            console.warn(`No adapter configured for currency ${intent.currency}`);
            return;
        }

        const now = new Date();
        const expiresAt = new Date(intent.expires_at);

        // Handle Expiration
        if (now > expiresAt && 
            (intent.status === PaymentStatus.PAYMENT_CREATED || intent.status === PaymentStatus.WAITING_FOR_PAYMENT)) {
            await this.paymentService.updatePaymentStatus(intent.id, PaymentStatus.EXPIRED, { reason: "Time expired without detection" });
            return;
        }

        try {
            // Step 1: Detect new transactions if we don't have confirmed ones yet
            // To avoid rewriting adapters heavily, we expect adapters to expose findTransactionsByAddress
            let knownTxids = [];
            const txRecords = await this.allQuery(`SELECT txid FROM payment_transactions WHERE payment_intent_id = ?`, [intent.id]);
            knownTxids = txRecords.map(r => r.txid);

            let newTxids = [];
            if (adapter.findTransactionsByAddress) {
                const detected = await adapter.findTransactionsByAddress(intent.payment_address);
                newTxids = detected.filter(txid => !knownTxids.includes(txid));
            }

            // Step 2: Record any newly detected transactions safely
            for (const txid of newTxids) {
                try {
                    // We record it with 0 amount initially, verifyTransaction will update it.
                    // Or we just verify it immediately.
                    const result = await adapter.verifyTransaction(txid, intent.payment_address, intent.expected_amount_crypto, intent.network, intent.required_confirmations);
                    await this.paymentService.recordTransaction(intent.id, intent.currency, txid, result.receivedAmountCrypto || "0");
                    knownTxids.push(txid);
                } catch (err) {
                    if (err.message !== PaymentStatus.ALREADY_USED) {
                        console.error(`Error recording new txid ${txid}:`, err.message);
                    }
                }
            }

            // Step 3: Re-verify all known transactions to progress confirmations
            let highestStatus = intent.status;
            let totalConfirmedAmount = 0n;
            let highestConfirmations = 0;

            for (const txid of knownTxids) {
                const result = await adapter.verifyTransaction(txid, intent.payment_address, intent.expected_amount_crypto, intent.network, intent.required_confirmations);
                
                // Update transaction record
                await this.runQuery(`
                    UPDATE payment_transactions 
                    SET status = ?, confirmations = ?, received_amount_crypto = ? 
                    WHERE payment_intent_id = ? AND txid = ?
                `, [result.status, result.confirmations, result.receivedAmountCrypto, intent.id, txid]);

                if (result.confirmations > highestConfirmations) {
                    highestConfirmations = result.confirmations;
                }

                if (result.status === PaymentStatus.CONFIRMED || result.status === PaymentStatus.OVERPAID) {
                    totalConfirmedAmount += BigInt(result.receivedAmountCrypto);
                }

                // If any transaction hits these states, we want to update the intent appropriately
                if (result.status === PaymentStatus.CONFIRMING || 
                    result.status === PaymentStatus.CONFIRMED || 
                    result.status === PaymentStatus.OVERPAID || 
                    result.status === PaymentStatus.UNDERPAID) {
                    highestStatus = result.status;
                }
            }

            // Aggregate logic for multiple transactions (e.g. 2 underpaid transactions = 1 paid)
            if (totalConfirmedAmount >= BigInt(intent.expected_amount_crypto)) {
                highestStatus = totalConfirmedAmount > BigInt(intent.expected_amount_crypto) ? PaymentStatus.OVERPAID : PaymentStatus.CONFIRMED;
            } else if (knownTxids.length > 0 && highestStatus !== PaymentStatus.CONFIRMING) {
                // We have transactions but they don't add up to expected amount yet and aren't confirming
                // Determine if we should mark as underpaid
                const allUnderpaid = knownTxids.length > 0; // Simplified
                if (allUnderpaid && highestConfirmations >= intent.required_confirmations) {
                    highestStatus = PaymentStatus.UNDERPAID;
                }
            }

            if (highestStatus !== intent.status && knownTxids.length > 0) {
                await this.paymentService.updatePaymentStatus(intent.id, highestStatus, { totalConfirmedAmount: totalConfirmedAmount.toString() });
            } else if (knownTxids.length > 0 && intent.status === PaymentStatus.PAYMENT_CREATED) {
                // Move from created to detected
                await this.paymentService.updatePaymentStatus(intent.id, PaymentStatus.TRANSACTION_DETECTED);
            }

            // Late payment policy: if expired but we received funds, we might flag it as LATE_PAYMENT or just OVERPAID/CONFIRMED 
            // depending on business rules. We allow it to update to CONFIRMED.

        } catch (err) {
            console.error(`Error processing intent ${intent.id}:`, err.message);
        }
    }

    async manualVerifyTxid(intentId, txid) {
        const intent = await this.getQuery(`SELECT * FROM payment_intents WHERE id = ?`, [intentId]);
        if (!intent) throw new Error("Intent not found");

        // --- DEVELOPMENT TEST BYPASS ---
        // Allows testing the UI flow without having full blockchain nodes running locally.
        // SECURITY: This bypass is DISABLED in production.
        if (txid === 'test' && process.env.NODE_ENV !== 'production') {
            try {
                await this.paymentService.recordTransaction(intent.id, intent.currency, txid, intent.expected_amount_crypto);
            } catch (err) {
                if (err.message !== PaymentStatus.ALREADY_USED) throw err;
            }
            // Force status to PAID for testing
            await this.getQuery(`UPDATE payment_intents SET status = 'PAID' WHERE id = ?`, [intentId]);
            return await this.getQuery(`SELECT * FROM payment_intents WHERE id = ?`, [intentId]);
        } else if (txid === 'test') {
            throw new Error('Test bypass is disabled in production');
        }
        // -------------------------------

        const adapter = this.adapters[intent.currency];
        if (!adapter) throw new Error("Adapter not configured");

        const result = await adapter.verifyTransaction(txid, intent.payment_address, intent.expected_amount_crypto, intent.network, intent.required_confirmations);
        
        try {
            await this.paymentService.recordTransaction(intent.id, intent.currency, txid, result.receivedAmountCrypto || "0");
        } catch (err) {
            if (err.message !== PaymentStatus.ALREADY_USED) throw err;
        }

        // Trigger an immediate process to update the intent status
        await this.processIntent(intent);
        
        return await this.getQuery(`SELECT * FROM payment_intents WHERE id = ?`, [intentId]);
    }
}

module.exports = {
    PaymentWorker
};
