const { ethers } = require('ethers');
const { PaymentStatus } = require('../services/paymentService');

class EthereumAdapter {
    constructor(rpcUrl, mockProvider = null) {
        if (mockProvider) {
            this.provider = mockProvider;
        } else if (rpcUrl) {
            this.provider = new ethers.JsonRpcProvider(rpcUrl);
        } else {
            throw new Error("EthereumAdapter requires an rpcUrl or a mockProvider");
        }
    }

    async findTransactionsByAddress(address) {
        try {
            const axios = require('axios');
            const response = await axios.get(`https://api.etherscan.io/api?module=account&action=txlist&address=${address}&startblock=0&endblock=99999999&page=1&offset=10&sort=asc`);
            if (response.data && response.data.status === '1' && Array.isArray(response.data.result)) {
                return response.data.result.map(tx => tx.hash);
            }
            return [];
        } catch (error) {
            console.error(`Etherscan API error (find txs for ${address}):`, error.message);
            return [];
        }
    }

    /**
     * Verifies an Ethereum transaction against payment expectations.
     * @param {string} txid - The transaction hash.
     * @param {string} expectedAddress - The generated payment address for this order.
     * @param {string} expectedAmountWeiStr - The expected amount in wei (string).
     * @param {number} expectedNetworkChainId - Expected chain ID (e.g. 1 for mainnet).
     * @param {number} requiredConfirmations - Number of block confirmations required.
     * @returns {Promise<Object>} Verification result with status and amounts.
     */
    async verifyTransaction(txid, expectedAddress, expectedAmountWeiStr, expectedNetworkChainId, requiredConfirmations) {
        try {
            // 1. Check network
            const network = await this.provider.getNetwork();
            if (Number(network.chainId) !== expectedNetworkChainId) {
                return { status: PaymentStatus.WRONG_NETWORK, receivedAmountCrypto: '0', confirmations: 0 };
            }

            // 2. Fetch transaction
            const tx = await this.provider.getTransaction(txid);
            if (!tx) {
                // Transaction doesn't exist or isn't propagated yet
                return { status: PaymentStatus.WAITING_FOR_PAYMENT, receivedAmountCrypto: '0', confirmations: 0 };
            }

            // 3. Verify destination address
            if (!tx.to || tx.to.toLowerCase() !== expectedAddress.toLowerCase()) {
                return { status: PaymentStatus.WRONG_ADDRESS, receivedAmountCrypto: '0', confirmations: 0 };
            }

            // 4. Fetch receipt (to check if mined and success)
            const receipt = await this.provider.getTransactionReceipt(txid);
            if (!receipt) {
                // Transaction is pending in mempool
                return { status: PaymentStatus.TRANSACTION_DETECTED, receivedAmountCrypto: '0', confirmations: 0 };
            }

            // 5. Check if transaction failed
            if (receipt.status === 0) {
                return { status: PaymentStatus.FAILED, receivedAmountCrypto: '0', confirmations: 0 };
            }

            // 6. Check amounts
            const receivedAmountWei = tx.value;
            const expectedAmountWei = BigInt(expectedAmountWeiStr);

            let status = null;
            if (receivedAmountWei < expectedAmountWei) {
                status = PaymentStatus.UNDERPAID;
            } else {
                status = PaymentStatus.CONFIRMING;
            }

            // 7. Check confirmations
            const currentBlockNumber = await this.provider.getBlockNumber();
            const confirmations = currentBlockNumber - receipt.blockNumber + 1;

            if (confirmations >= requiredConfirmations && status !== PaymentStatus.UNDERPAID) {
                if (receivedAmountWei > expectedAmountWei) {
                    status = PaymentStatus.OVERPAID; // Application level can decide how to handle
                } else {
                    status = PaymentStatus.CONFIRMED;
                }
            }

            return {
                status,
                receivedAmountCrypto: receivedAmountWei.toString(),
                confirmations
            };

        } catch (error) {
            // If RPC fails (e.g. rate limit, connection drop), we throw to retry later,
            // rather than marking the payment as failed.
            throw new Error(`RPC Error verifying ETH transaction: ${error.message}`);
        }
    }
}

module.exports = {
    EthereumAdapter
};
