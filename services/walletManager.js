const crypto = require('crypto');

const SupportedCurrencies = ['BTC', 'BCH', 'LTC', 'ETH', 'XMR'];

class WalletManager {
    constructor(db, walletProviders) {
        this.db = db;
        this.walletProviders = walletProviders || {};
    }

    runQuery(sql, params = []) {
        return new Promise((resolve, reject) => {
            this.db.run(sql, params, function (err) {
                if (err) reject(err);
                else resolve(this); // 'this' contains lastID and changes
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
                else resolve(rows);
            });
        });
    }

    // --- Wallet Management Methods ---

    async listWallets() {
        const wallets = await this.allQuery(`SELECT * FROM treasury_wallets`);
        for (const wallet of wallets) {
            const provider = this.walletProviders[wallet.currency];
            if (provider && typeof provider.getBalance === 'function') {
                try {
                    wallet.balance = await provider.getBalance(wallet.wallet_reference);
                } catch (err) {
                    wallet.balance_error = err.message;
                }
            }
        }
        return wallets;
    }

    async getWallet(walletId) {
        const wallet = await this.getQuery(`SELECT * FROM treasury_wallets WHERE id = ?`, [walletId]);
        if (!wallet) return null;

        const countRow = await this.getQuery(`SELECT COUNT(*) as count FROM treasury_addresses WHERE wallet_id = ?`, [walletId]);
        wallet.address_count = countRow ? countRow.count : 0;

        const provider = this.walletProviders[wallet.currency];
        if (provider && typeof provider.getBalance === 'function') {
            try {
                wallet.balance = await provider.getBalance(wallet.wallet_reference);
            } catch (err) {
                wallet.balance_error = err.message;
            }
        }

        return wallet;
    }

    async createWallet({ currency, network, name, type, provider, walletReference }) {
        if (!SupportedCurrencies.includes(currency)) {
            throw new Error(`Unsupported currency: ${currency}`);
        }

        const id = crypto.randomUUID();
        const now = new Date().toISOString();

        await this.runQuery(
            `INSERT INTO treasury_wallets (id, currency, network, name, type, provider, wallet_reference, status, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [id, currency, network, name, type, provider, walletReference, 'ACTIVE', now, now]
        );

        return await this.getWallet(id);
    }

    async updateWalletStatus(walletId, newStatus) {
        const validStatuses = ['ACTIVE', 'DISABLED', 'MAINTENANCE', 'COMPROMISED', 'ARCHIVED'];
        if (!validStatuses.includes(newStatus)) {
            throw new Error(`Invalid status: ${newStatus}`);
        }

        const now = new Date().toISOString();
        await this.runQuery(
            `UPDATE treasury_wallets SET status = ?, updated_at = ? WHERE id = ?`,
            [newStatus, now, walletId]
        );
    }

    // --- Address Management Methods ---

    async allocateAddress(walletId, paymentIntentId, orderId) {
        return new Promise((resolve, reject) => {
            this.db.serialize(async () => {
                try {
                    const wallet = await this.getQuery(`SELECT * FROM treasury_wallets WHERE id = ?`, [walletId]);
                    if (!wallet) {
                        return reject(new Error('Wallet not found'));
                    }

                    // Check for an AVAILABLE address in the wallet
                    const availableAddr = await this.getQuery(
                        `SELECT * FROM treasury_addresses WHERE wallet_id = ? AND status = 'AVAILABLE' LIMIT 1`,
                        [walletId]
                    );

                    let addressStr;
                    let addressId;
                    const now = new Date().toISOString();

                    if (availableAddr) {
                        addressStr = availableAddr.address;
                        addressId = availableAddr.id;
                    } else {
                        // Need to generate new address
                        const provider = this.walletProviders[wallet.currency];
                        if (!provider) {
                            return reject(new Error(`No provider for currency ${wallet.currency}`));
                        }

                        if (['BTC', 'LTC', 'BCH'].includes(wallet.currency)) {
                            addressStr = await provider.getNewAddress(wallet.wallet_reference);
                        } else if (wallet.currency === 'ETH') {
                            addressStr = wallet.wallet_reference;
                        } else if (wallet.currency === 'XMR') {
                            addressStr = await provider.getNewSubaddress(wallet.wallet_reference);
                        } else {
                            return reject(new Error(`Unsupported currency for address generation: ${wallet.currency}`));
                        }

                        addressId = crypto.randomUUID();
                        await this.runQuery(
                            `INSERT INTO treasury_addresses (id, wallet_id, address, status, created_at, updated_at)
                             VALUES (?, ?, ?, ?, ?, ?)`,
                            [addressId, walletId, addressStr, 'AVAILABLE', now, now]
                        );
                    }

                    await this.runQuery(
                        `UPDATE treasury_addresses SET status = 'ASSIGNED', payment_intent_id = ?, order_id = ?, updated_at = ?
                         WHERE id = ?`,
                        [paymentIntentId, orderId, now, addressId]
                    );

                    const allocatedAddr = await this.getQuery(`SELECT * FROM treasury_addresses WHERE id = ?`, [addressId]);
                    resolve(allocatedAddr);

                } catch (err) {
                    reject(err);
                }
            });
        });
    }

    async listAddresses(walletId, options = {}) {
        let sql = `SELECT * FROM treasury_addresses WHERE wallet_id = ?`;
        const params = [walletId];

        if (options.status) {
            sql += ` AND status = ?`;
            params.push(options.status);
        }
        
        return await this.allQuery(sql, params);
    }

    async getAddressStatus(address, currency) {
        return await this.getQuery(
            `SELECT ta.* FROM treasury_addresses ta
             JOIN treasury_wallets tw ON ta.wallet_id = tw.id
             WHERE ta.address = ? AND tw.currency = ?`,
            [address, currency]
        );
    }

    async markAddressUsed(addressId) {
        const now = new Date().toISOString();
        await this.runQuery(
            `UPDATE treasury_addresses SET status = 'USED', updated_at = ? WHERE id = ?`,
            [now, addressId]
        );
    }

    async releaseAddress(addressId) {
        const addr = await this.getQuery(`SELECT status FROM treasury_addresses WHERE id = ?`, [addressId]);
        if (!addr) throw new Error('Address not found');
        if (addr.status !== 'ASSIGNED') {
            throw new Error(`Cannot release address with status ${addr.status}`);
        }

        const now = new Date().toISOString();
        await this.runQuery(
            `UPDATE treasury_addresses SET status = 'AVAILABLE', payment_intent_id = NULL, order_id = NULL, updated_at = ? WHERE id = ?`,
            [now, addressId]
        );
    }

    // --- Health Check Methods ---

    async getWalletHealth(walletId) {
        const wallet = await this.getQuery(`SELECT * FROM treasury_wallets WHERE id = ?`, [walletId]);
        if (!wallet) throw new Error('Wallet not found');

        const provider = this.walletProviders[wallet.currency];
        if (!provider || typeof provider.getHealth !== 'function') {
            return { wallet, health: { status: 'UNKNOWN_PROVIDER' } };
        }

        try {
            const health = await provider.getHealth();
            return { wallet, health };
        } catch (err) {
            return { wallet, health: { status: 'ERROR', error: err.message } };
        }
    }

    async getAllHealth() {
        const wallets = await this.allQuery(`SELECT * FROM treasury_wallets WHERE status = 'ACTIVE'`);
        const results = {};
        
        for (const wallet of wallets) {
            const provider = this.walletProviders[wallet.currency];
            if (provider && typeof provider.getHealth === 'function') {
                try {
                    results[wallet.id] = await provider.getHealth();
                } catch (err) {
                    results[wallet.id] = { status: 'ERROR', error: err.message };
                }
            } else {
                results[wallet.id] = { status: 'UNKNOWN_PROVIDER' };
            }
        }
        
        return results;
    }
}

module.exports = { WalletManager };
