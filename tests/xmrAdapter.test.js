const assert = require('assert');
const { MoneroAdapter } = require('../blockchain/xmr');
const { PaymentStatus } = require('../services/paymentService');

async function runTests() {
    console.log("Starting MoneroAdapter tests...");

    const createMockClient = (rpcResponses) => {
        return {
            rpcCall: async (method, params) => {
                if (method in rpcResponses) {
                    if (typeof rpcResponses[method] === 'function') {
                        return rpcResponses[method](params);
                    }
                    return rpcResponses[method];
                }
                throw new Error(`Mock missing method ${method}`);
            }
        };
    };

    const expectedAddress = "888tNkZrPN6JsEgekjMnABU4TBzc2Dt29EPAvkRxbzBGB1yD6vj82xJ3qFh3rM2E9G9Xf7qJ9vGZJt4tMv9E9Xf7qJ9vGZJt4tMv9E9";
    const expectedAmountAtomic = "1000000000000"; // 1 XMR
    const requiredConfirmations = 10;

    try {
        // Test 1: Generate Address
        console.log("Test 1: Create Address");
        let adapter = new MoneroAdapter(null, null, null, createMockClient({
            create_address: { address: expectedAddress, address_index: 1 }
        }));
        let addr = await adapter.createPaymentAddress(0);
        assert.strictEqual(addr, expectedAddress);
        console.log("Test 1 Passed");

        // Test 2: Transaction Not Found (RPC throws not found)
        console.log("Test 2: Transaction Not Found");
        adapter = new MoneroAdapter(null, null, null, createMockClient({
            get_transfer_by_txid: (params) => {
                throw new Error("Transaction not found");
            }
        }));
        let res = await adapter.verifyTransaction('txid123', expectedAddress, expectedAmountAtomic, requiredConfirmations);
        assert.strictEqual(res.status, PaymentStatus.WAITING_FOR_PAYMENT);
        console.log("Test 2 Passed");

        // Test 3: Wrong Destination (Transfer address mismatch)
        console.log("Test 3: Wrong Destination");
        adapter = new MoneroAdapter(null, null, null, createMockClient({
            get_transfer_by_txid: {
                transfer: {
                    type: "in",
                    address: "888WRONGADDRESS",
                    amount: 1000000000000n,
                    confirmations: 1
                }
            }
        }));
        res = await adapter.verifyTransaction('txid123', expectedAddress, expectedAmountAtomic, requiredConfirmations);
        assert.strictEqual(res.status, PaymentStatus.WRONG_ADDRESS);
        console.log("Test 3 Passed");

        // Test 4: Underpayment
        console.log("Test 4: Underpayment");
        adapter = new MoneroAdapter(null, null, null, createMockClient({
            get_transfer_by_txid: {
                transfer: {
                    type: "in",
                    address: expectedAddress,
                    amount: 500000000000n, // 0.5 XMR
                    confirmations: 1
                }
            }
        }));
        res = await adapter.verifyTransaction('txid123', expectedAddress, expectedAmountAtomic, requiredConfirmations);
        assert.strictEqual(res.status, PaymentStatus.UNDERPAID);
        assert.strictEqual(res.receivedAmountCrypto, "500000000000");
        console.log("Test 4 Passed");

        // Test 5: Overpayment
        console.log("Test 5: Overpayment");
        adapter = new MoneroAdapter(null, null, null, createMockClient({
            get_transfer_by_txid: {
                transfer: {
                    type: "in",
                    address: expectedAddress,
                    amount: 1500000000000n, // 1.5 XMR
                    confirmations: 10
                }
            }
        }));
        res = await adapter.verifyTransaction('txid123', expectedAddress, expectedAmountAtomic, requiredConfirmations);
        assert.strictEqual(res.status, PaymentStatus.OVERPAID);
        assert.strictEqual(res.receivedAmountCrypto, "1500000000000");
        console.log("Test 5 Passed");

        // Test 6: Unconfirmed Transaction (Mempool)
        console.log("Test 6: Unconfirmed Transaction");
        adapter = new MoneroAdapter(null, null, null, createMockClient({
            get_transfer_by_txid: {
                transfer: {
                    type: "pool",
                    address: expectedAddress,
                    amount: 1000000000000n,
                    confirmations: 0
                }
            }
        }));
        res = await adapter.verifyTransaction('txid123', expectedAddress, expectedAmountAtomic, requiredConfirmations);
        assert.strictEqual(res.status, PaymentStatus.TRANSACTION_DETECTED); // 0 confs
        assert.strictEqual(res.confirmations, 0);
        console.log("Test 6 Passed");

        // Test 7: Confirming Transaction (unlocking)
        console.log("Test 7: Confirming Transaction");
        adapter = new MoneroAdapter(null, null, null, createMockClient({
            get_transfer_by_txid: {
                transfer: {
                    type: "in",
                    address: expectedAddress,
                    amount: 1000000000000n,
                    confirmations: 5
                }
            }
        }));
        res = await adapter.verifyTransaction('txid123', expectedAddress, expectedAmountAtomic, requiredConfirmations);
        assert.strictEqual(res.status, PaymentStatus.CONFIRMING);
        assert.strictEqual(res.confirmations, 5);
        console.log("Test 7 Passed");

        // Test 8: Confirmed Transaction (Unlocked)
        console.log("Test 8: Confirmed Transaction");
        adapter = new MoneroAdapter(null, null, null, createMockClient({
            get_transfer_by_txid: {
                transfer: {
                    type: "in",
                    address: expectedAddress,
                    amount: 1000000000000n,
                    confirmations: 10
                }
            }
        }));
        res = await adapter.verifyTransaction('txid123', expectedAddress, expectedAmountAtomic, requiredConfirmations);
        assert.strictEqual(res.status, PaymentStatus.CONFIRMED);
        assert.strictEqual(res.confirmations, 10);
        console.log("Test 8 Passed");

        // Test 9: Malformed TXID / RPC failure
        console.log("Test 9: Malformed TXID");
        adapter = new MoneroAdapter(null, null, null, createMockClient({
            get_transfer_by_txid: (params) => {
                if (params.txid === 'malformed') throw new Error("Invalid txid format");
                return null;
            }
        }));
        try {
            await adapter.verifyTransaction('malformed', expectedAddress, expectedAmountAtomic, requiredConfirmations);
            assert.fail("Should have thrown error");
        } catch (err) {
            assert.ok(err.message.includes("RPC Error verifying XMR transaction"));
        }
        console.log("Test 9 Passed");

        console.log("All MoneroAdapter tests passed successfully!");
    } catch (err) {
        console.error("Test failed:", err);
        process.exit(1);
    }
}

runTests();
