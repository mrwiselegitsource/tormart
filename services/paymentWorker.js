const { PaymentStatus, VerificationConfig } = require('./paymentService');

const ACTIVE_STATUSES = [
    PaymentStatus.PAYMENT_CREATED,
    PaymentStatus.WAITING_FOR_PAYMENT,
    PaymentStatus.TRANSACTION_DETECTED,
    PaymentStatus.CHECKING,
    PaymentStatus.CONFIRMING
];

class PaymentWorker {
    constructor(db, paymentService, adapters, config = {}) {
        this.db = db;
        this.paymentService = paymentService;
        this.adapters = adapters; // { BTC: btcAdapter, LTC: ..., BCH: ... }
        this.isRunning = false;
        this.intervalId = null;
        this.isProcessing = false;
        this.graceMs = config.graceMs ?? VerificationConfig.GRACE_MS;
        this.maxAttempts = config.maxAttempts ?? VerificationConfig.MAX_ATTEMPTS;
        // Confirming with no progress for this long -> manual review
        this.stallMs = config.stallMs ?? 6 * 60 * 60 * 1000;
        // Minimum spacing between counted verification attempts (6 x 5min = ~30min)
        this.attemptIntervalMs = config.attemptIntervalMs ?? parseInt(process.env.PAYMENT_ATTEMPT_INTERVAL_MS || String(5 * 60 * 1000), 10);
    }

    start(intervalMs = 30000) {
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
            this.db.get(sql, params, (err, row) => (err ? reject(err) : resolve(row)));
        });
    }

    async allQuery(sql, params = []) {
        return new Promise((resolve, reject) => {
            this.db.all(sql, params, (err, rows) => (err ? reject(err) : resolve(rows)));
        });
    }

    async runQuery(sql, params = []) {
        return new Promise((resolve, reject) => {
            this.db.run(sql, params, function (err) { if (err) reject(err); else resolve(this); });
        });
    }

    async processActivePayments() {
        if (this.isProcessing) return;
        this.isProcessing = true;
        try {
            const placeholders = ACTIVE_STATUSES.map(() => '?').join(',');
            // CHECKING (buyer is waiting) first
            const activeIntents = await this.allQuery(`
                SELECT * FROM payment_intents
                WHERE status IN (${placeholders})
                ORDER BY CASE status WHEN 'CHECKING' THEN 0 WHEN 'CONFIRMING' THEN 1 ELSE 2 END, created_at ASC
            `, ACTIVE_STATUSES);

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

    /**
     * Has the buyer claimed payment or has any tx been seen?
     */
    _isClaimed(intent, knownTxCount) {
        return !!intent.claimed_paid_at || !!intent.buyer_txid || knownTxCount > 0 ||
            intent.status === PaymentStatus.CHECKING ||
            intent.status === PaymentStatus.TRANSACTION_DETECTED ||
            intent.status === PaymentStatus.CONFIRMING;
    }

    async _recordAttempt(intent) {
        const last = intent.last_checked_at ? new Date(intent.last_checked_at).getTime() : 0;
        if (last && Date.now() - last < this.attemptIntervalMs) {
            return intent.verify_attempts || 0; // too soon, don't count
        }
        await this.runQuery(
            `UPDATE payment_intents SET verify_attempts = COALESCE(verify_attempts, 0) + 1, last_checked_at = ? WHERE id = ?`,
            [new Date().toISOString(), intent.id]
        );
        const row = await this.getQuery(`SELECT verify_attempts FROM payment_intents WHERE id = ?`, [intent.id]);
        return row ? row.verify_attempts : 0;
    }

    async processIntent(intentArg, opts = {}) {
        // Always work on a fresh row (callers may pass stale objects)
        const intent = await this.getQuery(`SELECT * FROM payment_intents WHERE id = ?`, [intentArg.id]) || intentArg;
        // force=true lets admins re-check an intent in MANUAL_REVIEW/EXPIRED (escalation calls are no-ops there)
        const forcible = opts.force && ['MANUAL_REVIEW', 'EXPIRED', 'UNDERPAID'].includes(intent.status);
        if (!ACTIVE_STATUSES.includes(intent.status) && !forcible) return;

        const now = Date.now();
        const expiresAt = new Date(intent.expires_at).getTime();
        const isPastExpiry = !isNaN(expiresAt) && now > expiresAt;
        const isPastGrace = !isNaN(expiresAt) && now > expiresAt + this.graceMs;

        const txRecords = await this.allQuery(`SELECT txid FROM payment_transactions WHERE payment_intent_id = ?`, [intent.id]);
        const knownTxids = txRecords.map(r => r.txid);
        const claimed = this._isClaimed(intent, knownTxids.length);

        // 1) Unclaimed + expired -> EXPIRED (but still do one last address scan first)
        const adapter = this.adapters[intent.currency];
        if (!adapter) {
            console.warn(`No adapter configured for currency ${intent.currency}`);
            if (isPastExpiry) {
                if (claimed) await this.paymentService.sendToReview(intent.id, `No blockchain adapter for ${intent.currency}`);
                else await this.paymentService.expireIntent(intent.id);
            } else if (intent.status === PaymentStatus.CHECKING) {
                await this.paymentService.sendToReview(intent.id, `No blockchain adapter for ${intent.currency}`);
            }
            return;
        }

        let adapterError = null;
        let highestStatus = intent.status;
        let totalConfirmedAmount = 0n;
        let highestConfirmations = 0;

        try {
            // Detect new transactions on the address
            if (adapter.findTransactionsByAddress) {
                const detected = await adapter.findTransactionsByAddress(intent.payment_address);
                const newTxids = (detected || []).filter(txid => !knownTxids.includes(txid));
                for (const txid of newTxids) {
                    try {
                        const result = await adapter.verifyTransaction(txid, intent.payment_address, intent.expected_amount_crypto, intent.network, intent.required_confirmations);
                        await this.paymentService.recordTransaction(intent.id, intent.currency, txid, result.receivedAmountCrypto || "0");
                        knownTxids.push(txid);
                    } catch (err) {
                        if (err.message !== PaymentStatus.ALREADY_USED) console.error(`Error recording new txid ${txid}:`, err.message);
                    }
                }
            }

            // Re-verify known transactions to progress confirmations
            for (const txid of knownTxids) {
                const result = await adapter.verifyTransaction(txid, intent.payment_address, intent.expected_amount_crypto, intent.network, intent.required_confirmations);
                await this.runQuery(`
                    UPDATE payment_transactions SET status = ?, confirmations = ?, received_amount_crypto = ?
                    WHERE payment_intent_id = ? AND txid = ?
                `, [result.status, result.confirmations, result.receivedAmountCrypto, intent.id, txid]);

                if (result.confirmations > highestConfirmations) highestConfirmations = result.confirmations;
                if (result.status === PaymentStatus.CONFIRMED || result.status === PaymentStatus.OVERPAID) {
                    totalConfirmedAmount += BigInt(result.receivedAmountCrypto);
                }
                if ([PaymentStatus.CONFIRMING, PaymentStatus.CONFIRMED, PaymentStatus.OVERPAID, PaymentStatus.UNDERPAID].includes(result.status)) {
                    highestStatus = result.status;
                }
            }
        } catch (err) {
            adapterError = err;
            console.error(`Adapter error for intent ${intent.id}:`, err.message);
        }

        // 2) Fully paid -> PAID (single path, updates orders + notifies)
        if (knownTxids.length > 0 && totalConfirmedAmount >= BigInt(intent.expected_amount_crypto)) {
            await this.paymentService.markPaid(intent.id, 'auto');
            return;
        }

        // 3) Underpaid with enough confirmations -> manual review
        if (knownTxids.length > 0 && highestStatus === PaymentStatus.UNDERPAID && highestConfirmations >= intent.required_confirmations) {
            await this.paymentService.sendToReview(intent.id, 'Underpaid: received less than the expected amount');
            return;
        }

        // 4) Transaction seen and confirming -> CONFIRMING (progress)
        if (knownTxids.length > 0 && !adapterError) {
            if (highestStatus === PaymentStatus.CONFIRMING && intent.status !== PaymentStatus.CONFIRMING) {
                await this.paymentService.updatePaymentStatus(intent.id, PaymentStatus.CONFIRMING, { confirmations: highestConfirmations });
                return;
            }
            if (intent.status === PaymentStatus.PAYMENT_CREATED || intent.status === PaymentStatus.WAITING_FOR_PAYMENT) {
                await this.paymentService.updatePaymentStatus(intent.id, PaymentStatus.TRANSACTION_DETECTED);
                return;
            }
            // Stalled confirming -> review
            if (intent.status === PaymentStatus.CONFIRMING) {
                const since = new Date(intent.updated_at || intent.created_at).getTime();
                if (!isNaN(since) && now - since > this.stallMs) {
                    await this.paymentService.sendToReview(intent.id, 'Confirmations stalled for too long');
                }
                return;
            }
        }

        // 5) Nothing found (or adapter error)
        if (!claimed) {
            if (isPastExpiry) await this.paymentService.expireIntent(intent.id);
            return;
        }

        // Buyer claimed payment / verifying: count attempt, escalate when exhausted
        if (intent.status === PaymentStatus.CHECKING || intent.status === PaymentStatus.TRANSACTION_DETECTED || intent.claimed_paid_at) {
            const attempts = await this._recordAttempt(intent);
            if (attempts >= this.maxAttempts) {
                await this.paymentService.sendToReview(intent.id,
                    adapterError ? `Blockchain API unavailable after ${attempts} checks` : `No matching transaction after ${attempts} automatic checks`);
                return;
            }
        }
        if (isPastGrace) {
            await this.paymentService.sendToReview(intent.id, 'Verification window (incl. grace period) ended without confirmation');
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
                await this.paymentService.recordTransaction(intent.id, intent.currency, `test-${intent.id}`, intent.expected_amount_crypto);
            } catch (err) {
                if (err.message !== PaymentStatus.ALREADY_USED) throw err;
            }
            return await this.paymentService.markPaid(intentId, 'test');
        } else if (txid === 'test') {
            throw new Error('Test bypass is disabled in production');
        }
        // -------------------------------

        const adapter = this.adapters[intent.currency];
        if (!adapter) {
            await this.paymentService.sendToReview(intentId, `No blockchain adapter for ${intent.currency}`);
            return;
        }

        try {
            const result = await adapter.verifyTransaction(txid, intent.payment_address, intent.expected_amount_crypto, intent.network, intent.required_confirmations);
            try {
                await this.paymentService.recordTransaction(intent.id, intent.currency, txid, result.receivedAmountCrypto || "0");
            } catch (err) {
                if (err.message !== PaymentStatus.ALREADY_USED) throw err;
            }
        } catch (error) {
            // Do NOT drop back to WAITING: stay in verification and let the attempt counter / review handle it
            console.warn(`TXID ${txid} check failed for intent ${intentId}: ${error.message}`);
        }
        await this.processIntent(intent);
        return await this.getQuery(`SELECT * FROM payment_intents WHERE id = ?`, [intentId]);
    }
}

module.exports = {
    PaymentWorker,
    ACTIVE_STATUSES
};
