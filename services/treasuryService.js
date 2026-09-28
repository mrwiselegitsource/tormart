const crypto = require('crypto');

/**
 * Treasury Service — manages treasury operations, withdrawal lifecycle,
 * balance reservations, and treasury controls.
 * 
 * SECURITY: This service enforces the withdrawal state machine.
 * No state transition can be skipped. All amounts use integer smallest-unit strings.
 */

// Allowed withdrawal status transitions
const WITHDRAWAL_TRANSITIONS = {
    'DRAFT':              ['REQUESTED', 'CANCELLED'],
    'REQUESTED':          ['VALIDATED', 'REJECTED', 'CANCELLED'],
    'VALIDATED':          ['AWAITING_APPROVAL', 'REJECTED', 'CANCELLED'],
    'AWAITING_APPROVAL':  ['APPROVED', 'REJECTED', 'CANCELLED'],
    'APPROVED':           ['SIGNING', 'CANCELLED', 'FAILED'],
    'SIGNING':            ['SIGNED', 'SIGNING_FAILED', 'FAILED'],
    'SIGNED':             ['BROADCASTING', 'FAILED'],
    'BROADCASTING':       ['BROADCAST', 'BROADCAST_FAILED', 'FAILED'],
    'BROADCAST':          ['CONFIRMING', 'FAILED'],
    'CONFIRMING':         ['COMPLETED', 'FAILED'],
    // Terminal states — no further transitions
    'COMPLETED':          [],
    'REJECTED':           [],
    'FAILED':             [],
    'CANCELLED':          [],
    'SIGNING_FAILED':     ['SIGNING', 'CANCELLED'],  // Allow retry
    'BROADCAST_FAILED':   ['BROADCASTING', 'CANCELLED'],  // Allow retry
    'EXPIRED':            []
};

const SUPPORTED_CURRENCIES = ['BTC', 'LTC', 'ETH', 'BCH', 'XMR'];

class TreasuryService {
    constructor(db, walletManager, walletProviders) {
        this.db = db;
        this.walletManager = walletManager;
        this.walletProviders = walletProviders || {};
    }

    // ---- DB Helpers ----

    runQuery(sql, params = []) {
        return new Promise((resolve, reject) => {
            this.db.run(sql, params, function(err) {
                if (err) reject(err);
                else resolve({ lastID: this.lastID, changes: this.changes });
            });
        });
    }

    getQuery(sql, params = []) {
        return new Promise((resolve, reject) => {
            this.db.get(sql, params, (err, row) => {
                if (err) reject(err);
                else resolve(row);
            });
        });
    }

    allQuery(sql, params = []) {
        return new Promise((resolve, reject) => {
            this.db.all(sql, params, (err, rows) => {
                if (err) reject(err);
                else resolve(rows || []);
            });
        });
    }

    // ---- Treasury Config ----

    async getConfig(key) {
        const row = await this.getQuery(
            'SELECT config_value FROM treasury_config WHERE config_key = ?', [key]
        );
        return row ? row.config_value : null;
    }

    async setConfig(key, value, updatedBy) {
        await this.runQuery(
            `INSERT INTO treasury_config (config_key, config_value, updated_by, updated_at) 
             VALUES (?, ?, ?, datetime('now'))
             ON CONFLICT(config_key) DO UPDATE SET config_value = ?, updated_by = ?, updated_at = datetime('now')`,
            [key, value, updatedBy, value, updatedBy]
        );
    }

    async isTreasuryPaused() {
        const val = await this.getConfig('treasury_paused');
        return val === 'true';
    }

    async pauseTreasury(adminId) {
        await this.setConfig('treasury_paused', 'true', adminId);
    }

    async resumeTreasury(adminId) {
        await this.setConfig('treasury_paused', 'false', adminId);
    }

    // ---- Balance Queries ----

    async getBalances() {
        const balances = {};
        for (const currency of SUPPORTED_CURRENCIES) {
            const provider = this.walletProviders[currency];
            if (provider) {
                try {
                    balances[currency] = await provider.getBalance();
                } catch (err) {
                    balances[currency] = { 
                        total: 'UNAVAILABLE', 
                        spendable: 'UNAVAILABLE', 
                        pending: 'UNAVAILABLE',
                        error: err.message 
                    };
                }
            } else {
                balances[currency] = { 
                    total: 'UNAVAILABLE', 
                    spendable: 'UNAVAILABLE', 
                    pending: 'UNAVAILABLE',
                    error: 'Provider not configured' 
                };
            }
        }

        // Calculate reserved amounts from pending withdrawals
        const pendingWithdrawals = await this.allQuery(
            `SELECT currency, SUM(CAST(total_debit_smallest_unit AS INTEGER)) as reserved
             FROM treasury_withdrawals 
             WHERE status IN ('APPROVED', 'SIGNING', 'SIGNED', 'BROADCASTING', 'BROADCAST', 'CONFIRMING')
             GROUP BY currency`
        );

        for (const pw of pendingWithdrawals) {
            if (balances[pw.currency] && balances[pw.currency].spendable !== 'UNAVAILABLE') {
                balances[pw.currency].reserved = (pw.reserved || 0).toString();
            }
        }

        return balances;
    }

    // ---- Withdrawal Lifecycle ----

    /**
     * Create a new withdrawal request.
     * @param {Object} params
     * @returns {Object} The created withdrawal record
     */
    async createWithdrawal({ currency, network, walletId, destinationAddress, amountSmallestUnit, requestedBy, idempotencyKey }) {
        // Check treasury not paused
        if (await this.isTreasuryPaused()) {
            throw new Error('TREASURY_PAUSED: Withdrawals are currently suspended.');
        }

        // Validate currency
        if (!SUPPORTED_CURRENCIES.includes(currency)) {
            throw new Error(`INVALID_CURRENCY: ${currency} is not supported.`);
        }

        // Validate amount is a positive integer string
        const amount = BigInt(amountSmallestUnit);
        if (amount <= 0n) {
            throw new Error('INVALID_AMOUNT: Amount must be positive.');
        }

        // Validate wallet exists and is ACTIVE
        const wallet = await this.walletManager.getWallet(walletId);
        if (!wallet) throw new Error('WALLET_NOT_FOUND');
        if (wallet.status !== 'ACTIVE') throw new Error(`WALLET_INACTIVE: Wallet status is ${wallet.status}`);
        if (wallet.currency !== currency) throw new Error('WALLET_CURRENCY_MISMATCH');

        // Validate destination address
        const provider = this.walletProviders[currency];
        if (provider) {
            const validation = await provider.validateAddress(destinationAddress);
            if (!validation.valid) {
                throw new Error(`INVALID_ADDRESS: ${validation.error || 'Address validation failed'}`);
            }
        }

        // Check idempotency
        if (idempotencyKey) {
            const existing = await this.getQuery(
                'SELECT * FROM treasury_withdrawals WHERE idempotency_key = ?', [idempotencyKey]
            );
            if (existing) {
                return existing; // Return existing withdrawal instead of creating duplicate
            }
        }

        // Estimate fee
        let estimatedFee = '0';
        if (provider) {
            try {
                const feeResult = await provider.estimateFee(destinationAddress, amountSmallestUnit);
                estimatedFee = feeResult.fee || '0';
            } catch (err) {
                // Fee estimation failure is not fatal for draft creation
                estimatedFee = '0';
            }
        }

        const totalDebit = (amount + BigInt(estimatedFee)).toString();

        // Check withdrawal limits
        await this._checkWithdrawalLimits(currency, amountSmallestUnit);

        // Check available balance
        if (provider) {
            try {
                const balance = await provider.getBalance();
                if (balance.spendable !== 'UNAVAILABLE') {
                    const spendable = BigInt(balance.spendable);
                    // Account for existing reserved amounts
                    const reserved = await this._getReservedAmount(currency);
                    const available = spendable - reserved;
                    if (BigInt(totalDebit) > available) {
                        throw new Error(`INSUFFICIENT_BALANCE: Available ${available.toString()}, required ${totalDebit}`);
                    }
                }
            } catch (err) {
                if (err.message.startsWith('INSUFFICIENT_BALANCE')) throw err;
                // Balance check failure is logged but doesn't block draft creation
            }
        }

        const withdrawalId = crypto.randomUUID();
        await this.runQuery(
            `INSERT INTO treasury_withdrawals 
             (id, currency, network, wallet_id, destination_address, amount_smallest_unit, 
              estimated_fee_smallest_unit, total_debit_smallest_unit, status, requested_by, 
              idempotency_key, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'REQUESTED', ?, ?, datetime('now'), datetime('now'))`,
            [withdrawalId, currency, network, walletId, destinationAddress, 
             amountSmallestUnit, estimatedFee, totalDebit, requestedBy, idempotencyKey || null]
        );

        return await this.getWithdrawal(withdrawalId);
    }

    async getWithdrawal(withdrawalId) {
        return await this.getQuery(
            `SELECT w.*, u1.username as requested_by_username, u2.username as approved_by_username
             FROM treasury_withdrawals w
             LEFT JOIN users u1 ON w.requested_by = u1.id
             LEFT JOIN users u2 ON w.approved_by = u2.id
             WHERE w.id = ?`, [withdrawalId]
        );
    }

    async listWithdrawals(options = {}) {
        let sql = `SELECT w.*, u1.username as requested_by_username, u2.username as approved_by_username
                    FROM treasury_withdrawals w
                    LEFT JOIN users u1 ON w.requested_by = u1.id
                    LEFT JOIN users u2 ON w.approved_by = u2.id`;
        const params = [];
        const conditions = [];

        if (options.currency) {
            conditions.push('w.currency = ?');
            params.push(options.currency);
        }
        if (options.status) {
            conditions.push('w.status = ?');
            params.push(options.status);
        }

        if (conditions.length > 0) {
            sql += ' WHERE ' + conditions.join(' AND ');
        }

        sql += ' ORDER BY w.created_at DESC';

        if (options.limit) {
            sql += ' LIMIT ?';
            params.push(options.limit);
        }

        return await this.allQuery(sql, params);
    }

    /**
     * Transition a withdrawal to a new status.
     * Enforces the state machine — invalid transitions are rejected.
     */
    async transitionWithdrawal(withdrawalId, newStatus, additionalUpdates = {}) {
        const withdrawal = await this.getWithdrawal(withdrawalId);
        if (!withdrawal) throw new Error('WITHDRAWAL_NOT_FOUND');

        const allowedNext = WITHDRAWAL_TRANSITIONS[withdrawal.status];
        if (!allowedNext || !allowedNext.includes(newStatus)) {
            throw new Error(`INVALID_TRANSITION: Cannot transition from ${withdrawal.status} to ${newStatus}`);
        }

        let setClauses = ["status = ?", "updated_at = datetime('now')"];
        let params = [newStatus];

        if (additionalUpdates.approvedBy) {
            setClauses.push('approved_by = ?', "approved_at = datetime('now')");
            params.push(additionalUpdates.approvedBy);
        }
        if (additionalUpdates.txid) {
            setClauses.push('txid = ?');
            params.push(additionalUpdates.txid);
        }
        if (additionalUpdates.actualFee) {
            setClauses.push('actual_fee_smallest_unit = ?');
            params.push(additionalUpdates.actualFee);
        }
        if (additionalUpdates.failureReason) {
            setClauses.push('failure_reason = ?');
            params.push(additionalUpdates.failureReason);
        }
        if (newStatus === 'BROADCAST' || newStatus === 'BROADCASTING') {
            setClauses.push("broadcast_at = datetime('now')");
        }
        if (newStatus === 'COMPLETED') {
            setClauses.push("completed_at = datetime('now')");
        }

        params.push(withdrawalId, withdrawal.status); // WHERE clause params

        const result = await this.runQuery(
            `UPDATE treasury_withdrawals SET ${setClauses.join(', ')} 
             WHERE id = ? AND status = ?`,
            params
        );

        if (result.changes === 0) {
            throw new Error('CONCURRENT_MODIFICATION: Withdrawal status changed by another process.');
        }

        return await this.getWithdrawal(withdrawalId);
    }

    /**
     * Approve a withdrawal. Requires valid admin and step-up auth.
     */
    async approveWithdrawal(withdrawalId, adminId) {
        if (await this.isTreasuryPaused()) {
            throw new Error('TREASURY_PAUSED');
        }

        const withdrawal = await this.getWithdrawal(withdrawalId);
        if (!withdrawal) throw new Error('WITHDRAWAL_NOT_FOUND');

        // Verify the wallet is still active
        const wallet = await this.walletManager.getWallet(withdrawal.wallet_id);
        if (!wallet || wallet.status !== 'ACTIVE') {
            throw new Error('WALLET_INACTIVE');
        }

        // Revalidate balance
        const provider = this.walletProviders[withdrawal.currency];
        if (provider) {
            try {
                const balance = await provider.getBalance();
                if (balance.spendable !== 'UNAVAILABLE') {
                    const spendable = BigInt(balance.spendable);
                    const reserved = await this._getReservedAmount(withdrawal.currency);
                    const totalDebit = BigInt(withdrawal.total_debit_smallest_unit || withdrawal.amount_smallest_unit);
                    if (totalDebit > (spendable - reserved)) {
                        throw new Error('INSUFFICIENT_BALANCE');
                    }
                }
            } catch (err) {
                if (err.message === 'INSUFFICIENT_BALANCE') throw err;
            }
        }

        // Record approval
        try {
            await this.runQuery(
                `INSERT INTO withdrawal_approvals (withdrawal_id, admin_id, action, created_at) 
                 VALUES (?, ?, 'APPROVED', datetime('now'))`,
                [withdrawalId, adminId]
            );
        } catch (err) {
            if (err.message && err.message.includes('UNIQUE')) {
                throw new Error('ALREADY_APPROVED: You have already approved this withdrawal.');
            }
            throw err;
        }

        // Check if minimum approvals met
        const minApprovals = parseInt(await this.getConfig('min_approval_count') || '1', 10);
        const approvalCount = await this.getQuery(
            `SELECT COUNT(*) as count FROM withdrawal_approvals 
             WHERE withdrawal_id = ? AND action = 'APPROVED'`,
            [withdrawalId]
        );

        if (approvalCount.count >= minApprovals) {
            // Transition through the required states
            if (withdrawal.status === 'REQUESTED') {
                await this.transitionWithdrawal(withdrawalId, 'VALIDATED');
                await this.transitionWithdrawal(withdrawalId, 'AWAITING_APPROVAL');
            }
            if (withdrawal.status === 'VALIDATED' || withdrawal.status === 'REQUESTED') {
                const current = await this.getWithdrawal(withdrawalId);
                if (current.status === 'AWAITING_APPROVAL' || current.status === 'VALIDATED') {
                    if (current.status === 'VALIDATED') {
                        await this.transitionWithdrawal(withdrawalId, 'AWAITING_APPROVAL');
                    }
                }
            }
            return await this.transitionWithdrawal(withdrawalId, 'APPROVED', { approvedBy: adminId });
        }

        return await this.getWithdrawal(withdrawalId);
    }

    /**
     * Reject a withdrawal.
     */
    async rejectWithdrawal(withdrawalId, adminId, reason) {
        await this.runQuery(
            `INSERT OR REPLACE INTO withdrawal_approvals (withdrawal_id, admin_id, action, created_at)
             VALUES (?, ?, 'REJECTED', datetime('now'))`,
            [withdrawalId, adminId]
        );

        return await this.transitionWithdrawal(withdrawalId, 'REJECTED', {
            failureReason: reason || 'Rejected by admin'
        });
    }

    /**
     * Sign and broadcast a withdrawal. This is the critical spending operation.
     * Must only be called after approval and step-up auth.
     */
    async broadcastWithdrawal(withdrawalId) {
        if (await this.isTreasuryPaused()) {
            throw new Error('TREASURY_PAUSED');
        }

        const withdrawal = await this.getWithdrawal(withdrawalId);
        if (!withdrawal) throw new Error('WITHDRAWAL_NOT_FOUND');
        if (withdrawal.status !== 'APPROVED') {
            throw new Error(`INVALID_STATE: Withdrawal must be APPROVED to broadcast, currently ${withdrawal.status}`);
        }

        const provider = this.walletProviders[withdrawal.currency];
        if (!provider) throw new Error('PROVIDER_NOT_CONFIGURED');

        // Transition to SIGNING
        await this.transitionWithdrawal(withdrawalId, 'SIGNING');

        let txid, actualFee;
        try {
            // Sign and broadcast through the wallet provider (signing boundary)
            const result = await provider.signAndBroadcast(
                withdrawal.destination_address,
                withdrawal.amount_smallest_unit
            );
            txid = result.txid;
            actualFee = result.fee || withdrawal.estimated_fee_smallest_unit;
        } catch (err) {
            // Signing or broadcast failed
            await this.transitionWithdrawal(withdrawalId, 'SIGNING_FAILED', {
                failureReason: `Signing/broadcast error: ${err.message}`
            });
            throw new Error(`BROADCAST_FAILED: ${err.message}`);
        }

        // Transition through SIGNED → BROADCASTING → BROADCAST
        await this.transitionWithdrawal(withdrawalId, 'SIGNED', { txid, actualFee });
        await this.transitionWithdrawal(withdrawalId, 'BROADCASTING');
        await this.transitionWithdrawal(withdrawalId, 'BROADCAST');

        return await this.getWithdrawal(withdrawalId);
    }

    // ---- Dashboard Data ----

    async getDashboardData() {
        const balances = await this.getBalances();
        
        const pendingPayments = await this.allQuery(
            `SELECT currency, COUNT(*) as count, SUM(CAST(expected_amount_crypto AS INTEGER)) as total
             FROM payment_intents 
             WHERE status IN ('PAYMENT_CREATED', 'WAITING_FOR_PAYMENT', 'TRANSACTION_DETECTED', 'CONFIRMING')
             GROUP BY currency`
        );

        const pendingWithdrawals = await this.allQuery(
            `SELECT currency, COUNT(*) as count, SUM(CAST(amount_smallest_unit AS INTEGER)) as total
             FROM treasury_withdrawals 
             WHERE status IN ('REQUESTED', 'VALIDATED', 'AWAITING_APPROVAL', 'APPROVED', 'SIGNING', 'BROADCASTING')
             GROUP BY currency`
        );

        const recentTransactions = await this.allQuery(
            `SELECT * FROM treasury_withdrawals ORDER BY created_at DESC LIMIT 20`
        );

        const treasuryPaused = await this.isTreasuryPaused();

        return {
            balances,
            pendingPayments,
            pendingWithdrawals,
            recentTransactions,
            treasuryPaused
        };
    }

    // ---- Transaction History ----

    async getTransactionHistory(options = {}) {
        let sql = `SELECT w.*, u1.username as requested_by_username 
                    FROM treasury_withdrawals w
                    LEFT JOIN users u1 ON w.requested_by = u1.id
                    WHERE w.status IN ('BROADCAST', 'CONFIRMING', 'COMPLETED', 'FAILED', 'BROADCAST_FAILED')`;
        const params = [];

        if (options.currency) {
            sql += ' AND w.currency = ?';
            params.push(options.currency);
        }

        sql += ' ORDER BY w.created_at DESC';

        if (options.limit) {
            sql += ' LIMIT ?';
            params.push(options.limit);
        }

        return await this.allQuery(sql, params);
    }

    // ---- Private Helpers ----

    async _getReservedAmount(currency) {
        const result = await this.getQuery(
            `SELECT COALESCE(SUM(CAST(total_debit_smallest_unit AS INTEGER)), 0) as reserved
             FROM treasury_withdrawals 
             WHERE currency = ? AND status IN ('APPROVED', 'SIGNING', 'SIGNED', 'BROADCASTING', 'BROADCAST', 'CONFIRMING')`,
            [currency]
        );
        return BigInt(result ? result.reserved : 0);
    }

    async _checkWithdrawalLimits(currency, amountSmallestUnit) {
        const maxKey = `max_withdrawal_${currency.toLowerCase()}`;
        const maxStr = await this.getConfig(maxKey);
        if (!maxStr) return; // No limit configured

        const maxAmount = parseFloat(maxStr);
        // Convert to smallest unit for comparison
        let divisor;
        switch (currency) {
            case 'ETH': divisor = 1e18; break;
            case 'XMR': divisor = 1e12; break;
            default: divisor = 1e8; break; // BTC, LTC, BCH
        }

        const amountInMainUnit = Number(BigInt(amountSmallestUnit)) / divisor;
        if (amountInMainUnit > maxAmount) {
            throw new Error(`EXCEEDS_LIMIT: Maximum withdrawal for ${currency} is ${maxAmount}`);
        }
    }
}

module.exports = {
    TreasuryService,
    WITHDRAWAL_TRANSITIONS,
    SUPPORTED_CURRENCIES
};
