// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

// Minimal test framework without requiring external git submodules
contract LeashPaymentTest {
    // Events to listen to
    event PolicyRegistered(bytes32 indexed policyCommitment, address indexed owner);
    event PaymentReleased(
        bytes32 indexed policyCommitment,
        uint256 amount,
        bytes32 indexed merchantIdHash,
        bytes32 indexed nonce,
        address recipient
    );
}

import "../src/LeashPayment.sol";

contract MockHonkVerifier is IVerifier {
    bool public shouldPass = true;
    bytes32[] public lastPublicInputs;
    bytes public lastProof;

    function setShouldPass(bool _pass) external {
        shouldPass = _pass;
    }

    function verify(bytes calldata _proof, bytes32[] calldata _publicInputs) external view override returns (bool) {
        return shouldPass;
    }
}

contract TestRunner {
    LeashPayment public payment;
    MockHonkVerifier public verifier;
    address payable public merchant = payable(address(0x1234567890123456789012345678901234567890));

    bytes32 constant POLICY_COMMITMENT = 0x09133620fa909d1ae63144fe7b802a6746fe87be8b3ed165aed34d165383acff;
    bytes32 constant MERCHANT_HASH = 0x2251558a6d5a9c78d6af29ca25291e11cccb168a48b48c1daa9650055f9b06ec;
    bytes32 constant NONCE_1 = bytes32(uint256(1));
    bytes32 constant NONCE_2 = bytes32(uint256(2));
    uint256 constant AMOUNT = 300;

    function setUp() public {
        verifier = new MockHonkVerifier();
        payment = new LeashPayment(address(verifier));
    }

    function test_policy_registration() public {
        setUp();
        payment.registerPolicy(POLICY_COMMITMENT);
        require(payment.registeredPolicies(POLICY_COMMITMENT) == true, "Policy should be registered");
    }

    function test_unregistered_policy_fails() public {
        setUp();
        bytes memory fakeProof = hex"deadbeef";
        bytes32 fakeCommitment = 0x1111111111111111111111111111111111111111111111111111111111111111;

        try payment.executePayment(fakeCommitment, AMOUNT, MERCHANT_HASH, NONCE_1, merchant, fakeProof) {
            revert("Expected revert on unregistered policy");
        } catch Error(string memory reason) {
            require(
                keccak256(bytes(reason)) == keccak256(bytes("Policy not registered")),
                "Unexpected revert reason"
            );
        }
    }

    function test_valid_payment_execution() public {
        setUp();
        payment.registerPolicy(POLICY_COMMITMENT);
        bytes memory proof = hex"1234";

        uint256 before = merchant.balance;
        payment.executePayment{value: AMOUNT}(POLICY_COMMITMENT, AMOUNT, MERCHANT_HASH, NONCE_1, merchant, proof);
        require(payment.usedNonces(NONCE_1) == true, "Nonce should be marked used");
        require(merchant.balance == before + AMOUNT, "Merchant should receive exactly the proven amount");
    }

    function test_nonce_replay_rejected() public {
        setUp();
        payment.registerPolicy(POLICY_COMMITMENT);
        bytes memory proof = hex"1234";

        payment.executePayment{value: AMOUNT}(POLICY_COMMITMENT, AMOUNT, MERCHANT_HASH, NONCE_1, merchant, proof);

        // Try second payment with same nonce
        try payment.executePayment{value: AMOUNT}(POLICY_COMMITMENT, AMOUNT, MERCHANT_HASH, NONCE_1, merchant, proof) {
            revert("Expected revert on duplicate nonce");
        } catch Error(string memory reason) {
            require(
                keccak256(bytes(reason)) == keccak256(bytes("Nonce already used")),
                "Unexpected revert reason"
            );
        }
    }

    function test_invalid_proof_rejected() public {
        setUp();
        payment.registerPolicy(POLICY_COMMITMENT);
        verifier.setShouldPass(false);
        bytes memory badProof = hex"ffff";

        try payment.executePayment(POLICY_COMMITMENT, AMOUNT, MERCHANT_HASH, NONCE_2, merchant, badProof) {
            revert("Expected revert on invalid ZK proof");
        } catch Error(string memory reason) {
            require(
                keccak256(bytes(reason)) == keccak256(bytes("Invalid ZK proof")),
                "Unexpected revert reason"
            );
        }
    }

    function _expectRevert(bytes32 nonce, uint256 value, string memory expected) internal {
        try payment.executePayment{value: value}(POLICY_COMMITMENT, AMOUNT, MERCHANT_HASH, nonce, merchant, hex"1234") {
            revert("Expected revert");
        } catch Error(string memory reason) {
            require(keccak256(bytes(reason)) == keccak256(bytes(expected)), reason);
        }
        require(!payment.usedNonces(nonce), "Nonce must not be consumed on failure");
    }

    function test_unfunded_payment_reverts_instead_of_fake_success() public {
        setUp();
        payment.registerPolicy(POLICY_COMMITMENT);
        _expectRevert(bytes32(uint256(9)), 0, "Insufficient contract balance");
    }

    function test_value_mismatch_reverts() public {
        setUp();
        payment.registerPolicy(POLICY_COMMITMENT);
        _expectRevert(bytes32(uint256(10)), AMOUNT - 1, "msg.value must equal proven amount");
    }

    receive() external payable {}
}
