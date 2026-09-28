const axios = require('axios');
const { PaymentStatus } = require('../services/paymentService');

class BitcoinAdapter {
    constructor(rpcUrl, rpcUser, rpcPass, mockClient = null) {
        this.apiBase = 'https://mempool.space/api';
    }

    btcToSatoshis(btcValue) {
        return BigInt(Math.round(btcValue * 100000000));
    }

    async findTransactionsByAddress(address) {
        try {
            const response = await axios.get(`${this.apiBase}/address/${address}/txs`);
            if (Array.isArray(response.data)) {
                return response.data.map(tx => tx.txid);
            }
            return [];
        } catch (error) {
            console.error(`Mempool API error (find txs for ${address}):`, error.message);
            return [];
        }
    }

    async verifyTransaction(txid, expectedAddress, expectedAmountSatsStr, expectedNetwork, requiredConfirmations) {
        try {
            // Fetch transaction
            const txRes = await axios.get(`${this.apiBase}/tx/${txid}`);
            const tx = txRes.data;

            // Fetch current block height to calculate confirmations
            const heightRes = await axios.get(`${this.apiBase}/blocks/tip/height`);
            const currentHeight = heightRes.data;

            let totalReceivedSats = 0n;
            let sentToExpectedAddress = false;

            if (tx.vout && Array.isArray(tx.vout)) {
                for (const output of tx.vout) {
                    if (output.scriptpubkey_address && output.scriptpubkey_address.toLowerCase() === expectedAddress.toLowerCase()) {
                        sentToExpectedAddress = true;
                        totalReceivedSats += BigInt(output.value); // Mempool API returns satoshis natively
                    }
                }
            }

            if (!sentToExpectedAddress) {
                return { status: PaymentStatus.WRONG_ADDRESS, receivedAmountCrypto: '0', confirmations: 0 };
            }

            const receivedAmountCryptoStr = totalReceivedSats.toString();
            const expectedAmountSats = BigInt(expectedAmountSatsStr);

            let status = null;
            if (totalReceivedSats < expectedAmountSats) {
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
                if (totalReceivedSats > expectedAmountSats) {
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
            throw new Error(`Mempool API Error verifying BTC transaction: ${error.message}`);
        }
    }
}

module.exports = {
    BitcoinAdapter
};
