const axios = require('axios');
const { PaymentStatus } = require('../services/paymentService');

class LitecoinAdapter {
    constructor(rpcUrl, rpcUser, rpcPass, mockClient = null) {
        this.apiBase = 'https://litecoinspace.org/api';
        this.timeout = 10000; // 10 second timeout
    }

    ltcToLitoshis(ltcValue) {
        return BigInt(Math.round(ltcValue * 100000000));
    }

    async findTransactionsByAddress(address) {
        try {
            const response = await axios.get(`${this.apiBase}/address/${address}/txs`, { timeout: this.timeout });
            if (Array.isArray(response.data)) {
                return response.data.map(tx => tx.txid);
            }
            return [];
        } catch (error) {
            console.error(`Litecoinspace API error (find txs for ${address}):`, error.message);
            return [];
        }
    }

    async verifyTransaction(txid, expectedAddress, expectedAmountLitoshisStr, expectedNetwork, requiredConfirmations) {
        try {
            // Fetch transaction
            const txRes = await axios.get(`${this.apiBase}/tx/${txid}`, { timeout: this.timeout });
            const tx = txRes.data;

            // Fetch current block height to calculate confirmations
            const heightRes = await axios.get(`${this.apiBase}/blocks/tip/height`, { timeout: this.timeout });
            const currentHeight = heightRes.data;

            let totalReceivedLitoshis = 0n;
            let sentToExpectedAddress = false;

            if (tx.vout && Array.isArray(tx.vout)) {
                for (const output of tx.vout) {
                    if (output.scriptpubkey_address && output.scriptpubkey_address.toLowerCase() === expectedAddress.toLowerCase()) {
                        sentToExpectedAddress = true;
                        totalReceivedLitoshis += BigInt(output.value); // API returns litoshis natively
                    }
                }
            }

            if (!sentToExpectedAddress) {
                return { status: PaymentStatus.WRONG_ADDRESS, receivedAmountCrypto: '0', confirmations: 0 };
            }

            const receivedAmountCryptoStr = totalReceivedLitoshis.toString();
            const expectedAmountLitoshis = BigInt(expectedAmountLitoshisStr);

            let status = null;
            if (totalReceivedLitoshis < expectedAmountLitoshis) {
                status = PaymentStatus.UNDERPAID;
            } else {
                status = PaymentStatus.CONFIRMING;
            }

            // Calculate confirmations
            let confirmations = 0;
            if (tx.status && tx.status.confirmed) {
                confirmations = (currentHeight - tx.status.block_height) + 1;
            }

            if (confirmations >= requiredConfirmations && status !== PaymentStatus.UNDERPAID) {
                if (totalReceivedLitoshis > expectedAmountLitoshis) {
                    status = PaymentStatus.OVERPAID;
                } else {
                    status = PaymentStatus.CONFIRMED;
                }
            } else if (confirmations === 0 && status !== PaymentStatus.UNDERPAID) {
                status = PaymentStatus.TRANSACTION_DETECTED;
            }

            return {
                status,
                receivedAmountCrypto: receivedAmountCryptoStr,
                confirmations
            };

        } catch (error) {
            throw new Error(`Litecoinspace API Error verifying LTC transaction: ${error.message}`);
        }
    }
}

module.exports = {
    LitecoinAdapter
};
