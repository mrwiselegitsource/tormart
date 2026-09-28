const assert = require('assert');
const { EthereumAdapter } = require('../blockchain/eth');
const { PaymentStatus } = require('../services/paymentService');

async function runTests() {
    console.log("Starting EthereumAdapter tests...");

    // Helper to create a mock provider
    const createMockProvider = (networkId, tx, receipt, currentBlock) => ({
        getNetwork: async () => ({ chainId: BigInt(networkId) }),
        getTransaction: async () => tx,
        getTransactionReceipt: async () => receipt,
        getBlockNumber: async () => currentBlock
    });

    const expectedAddress = "0x1234567890123456789012345678901234567890";
    const expectedAmountWei = "1000000000000000000"; // 1 ETH
    const expectedChainId = 1;
    const requiredConfirmations = 12;

    try {
        // Test 1: Wrong Network
        console.log("Test 1: Wrong Network");
        let adapter = new EthereumAdapter(null, createMockProvider(2, {}, {}, 100));
        let res = await adapter.verifyTransaction('0xtx', expectedAddress, expectedAmountWei, expectedChainId, requiredConfirmations);
        assert.strictEqual(res.status, PaymentStatus.WRONG_NETWORK);
        console.log("Test 1 Passed");

        // Test 2: Nonexistent TXID
        console.log("Test 2: Nonexistent TXID");
        adapter = new EthereumAdapter(null, createMockProvider(1, null, null, 100));
        res = await adapter.verifyTransaction('0xtx', expectedAddress, expectedAmountWei, expectedChainId, requiredConfirmations);
        assert.strictEqual(res.status, PaymentStatus.WAITING_FOR_PAYMENT);
        console.log("Test 2 Passed");

        // Test 3: Wrong Receiving Address
        console.log("Test 3: Wrong Receiving Address");
        adapter = new EthereumAdapter(null, createMockProvider(1, { to: "0xWRONGADDRESS" }, null, 100));
        res = await adapter.verifyTransaction('0xtx', expectedAddress, expectedAmountWei, expectedChainId, requiredConfirmations);
        assert.strictEqual(res.status, PaymentStatus.WRONG_ADDRESS);
        console.log("Test 3 Passed");

        // Test 4: Pending Transaction (no receipt)
        console.log("Test 4: Pending Transaction");
        adapter = new EthereumAdapter(null, createMockProvider(1, { to: expectedAddress }, null, 100));
        res = await adapter.verifyTransaction('0xtx', expectedAddress, expectedAmountWei, expectedChainId, requiredConfirmations);
        assert.strictEqual(res.status, PaymentStatus.TRANSACTION_DETECTED);
        console.log("Test 4 Passed");

        // Test 5: Failed Transaction
        console.log("Test 5: Failed Transaction");
        adapter = new EthereumAdapter(null, createMockProvider(1, { to: expectedAddress }, { status: 0 }, 100));
        res = await adapter.verifyTransaction('0xtx', expectedAddress, expectedAmountWei, expectedChainId, requiredConfirmations);
        assert.strictEqual(res.status, PaymentStatus.FAILED);
        console.log("Test 5 Passed");

        // Test 6: Underpayment
        console.log("Test 6: Underpayment");
        adapter = new EthereumAdapter(null, createMockProvider(1, 
            { to: expectedAddress, value: 500000000000000000n }, // 0.5 ETH
            { status: 1, blockNumber: 90 }, 100
        ));
        res = await adapter.verifyTransaction('0xtx', expectedAddress, expectedAmountWei, expectedChainId, requiredConfirmations);
        assert.strictEqual(res.status, PaymentStatus.UNDERPAID);
        assert.strictEqual(res.confirmations, 11);
        console.log("Test 6 Passed");

        // Test 7: Overpayment
        console.log("Test 7: Overpayment");
        adapter = new EthereumAdapter(null, createMockProvider(1, 
            { to: expectedAddress, value: 2000000000000000000n }, // 2 ETH
            { status: 1, blockNumber: 80 }, 100 // 21 confirmations
        ));
        res = await adapter.verifyTransaction('0xtx', expectedAddress, expectedAmountWei, expectedChainId, requiredConfirmations);
        assert.strictEqual(res.status, PaymentStatus.OVERPAID);
        assert.strictEqual(res.receivedAmountCrypto, "2000000000000000000");
        console.log("Test 7 Passed");

        // Test 8: Insufficient Confirmations
        console.log("Test 8: Insufficient Confirmations");
        adapter = new EthereumAdapter(null, createMockProvider(1, 
            { to: expectedAddress, value: 1000000000000000000n }, // 1 ETH
            { status: 1, blockNumber: 95 }, 100 // 6 confirmations
        ));
        res = await adapter.verifyTransaction('0xtx', expectedAddress, expectedAmountWei, expectedChainId, requiredConfirmations);
        assert.strictEqual(res.status, PaymentStatus.CONFIRMING);
        assert.strictEqual(res.confirmations, 6);
        console.log("Test 8 Passed");

        // Test 9: Confirmed Transaction (valid ETH transaction)
        console.log("Test 9: Confirmed Transaction");
        adapter = new EthereumAdapter(null, createMockProvider(1, 
            { to: expectedAddress, value: 1000000000000000000n }, // 1 ETH
            { status: 1, blockNumber: 80 }, 100 // 21 confirmations
        ));
        res = await adapter.verifyTransaction('0xtx', expectedAddress, expectedAmountWei, expectedChainId, requiredConfirmations);
        assert.strictEqual(res.status, PaymentStatus.CONFIRMED);
        assert.strictEqual(res.confirmations, 21);
        console.log("Test 9 Passed");

        console.log("All EthereumAdapter tests passed successfully!");
    } catch (err) {
        console.error("Test failed:", err);
        process.exit(1);
    }
}

runTests();
