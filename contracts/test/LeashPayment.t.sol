// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

import "../src/LeashPayment.sol";
import "../src/LeashVerifier.sol";

interface Vm {
    function readFileBinary(string calldata path) external view returns (bytes memory);
}

// Every test runs against the bb-generated HonkVerifier with a real proof from circuits/.
// Regenerate the fixture with scripts/gen-proof-fixture.sh (see test/fixtures/README.md).
contract LeashPaymentTest {
    Vm constant vm = Vm(address(uint160(uint256(keccak256("hevm cheat code")))));

    LeashPayment payment;
    address payable constant ATTACKER = payable(0x000000000000000000000000000000000000dEaD);

    // Public inputs, read from the fixture so the tests can't drift from the proof.
    bytes32 policyCommitment;
    uint256 amount;
    bytes32 merchantHash;
    bytes32 nonce;
    address payable merchant;

    function setUp() public {
        payment = new LeashPayment(address(new HonkVerifier()));
        uint256 recipient;
        (policyCommitment, amount, merchantHash, nonce, recipient) = abi.decode(
            vm.readFileBinary("test/fixtures/public_inputs"),
            (bytes32, uint256, bytes32, bytes32, uint256)
        );
        merchant = payable(address(uint160(recipient)));
    }

    function _proof() internal view returns (bytes memory) {
        return vm.readFileBinary("test/fixtures/proof");
    }

    function _pay(uint256 value, uint256 amt, bytes32 n, address payable to, bytes memory proof) internal {
        payment.executePayment{value: value}(policyCommitment, amt, merchantHash, n, to, proof);
    }

    // Asserts the call reverts (with `expected` when non-empty) and consumes no nonce.
    function _expectRevert(uint256 value, uint256 amt, bytes32 n, address payable to, bytes memory proof, string memory expected)
        internal
    {
        try payment.executePayment{value: value}(policyCommitment, amt, merchantHash, n, to, proof) {
            revert("expected revert");
        } catch Error(string memory reason) {
            if (bytes(expected).length != 0) {
                require(keccak256(bytes(reason)) == keccak256(bytes(expected)), reason);
            }
        } catch (bytes memory) {
            // HonkVerifier rejects bad proofs with custom errors.
            require(bytes(expected).length == 0, "expected a string revert");
        }
        require(!payment.usedNonces(policyCommitment, n), "nonce consumed on failure");
    }

    function test_policy_registration() public {
        payment.registerPolicy(policyCommitment);
        require(payment.registeredPolicies(policyCommitment), "policy not registered");
    }

    function test_unregistered_policy_fails() public {
        _expectRevert(amount, amount, nonce, merchant, _proof(), "Policy not registered");
    }

    function test_real_proof_pays_proven_recipient() public {
        payment.registerPolicy(policyCommitment);
        uint256 before = merchant.balance;
        _pay(amount, amount, nonce, merchant, _proof());
        require(merchant.balance == before + amount, "merchant not paid the proven amount");
        require(payment.usedNonces(policyCommitment, nonce), "nonce not consumed");
    }

    function test_real_proof_pays_from_contract_balance() public {
        payment.registerPolicy(policyCommitment);
        payment.deposit{value: amount}(policyCommitment);
        uint256 before = merchant.balance;
        _pay(0, amount, nonce, merchant, _proof());
        require(merchant.balance == before + amount, "merchant not paid");
        require(payment.policyBalance(policyCommitment) == 0, "policy balance not spent");
        require(address(payment).balance == 0, "contract balance not spent");
    }

    function test_replay_rejected() public {
        payment.registerPolicy(policyCommitment);
        bytes memory proof = _proof();
        _pay(amount, amount, nonce, merchant, proof);
        try payment.executePayment{value: amount}(policyCommitment, amount, merchantHash, nonce, merchant, proof) {
            revert("replay must fail");
        } catch Error(string memory reason) {
            require(keccak256(bytes(reason)) == keccak256("Nonce already used"), reason);
        }
    }

    function test_swapped_recipient_rejected() public {
        payment.registerPolicy(policyCommitment);
        uint256 before = ATTACKER.balance;
        _expectRevert(amount, amount, nonce, ATTACKER, _proof(), "");
        require(ATTACKER.balance == before, "attacker received funds");
    }

    function test_swapped_nonce_rejected() public {
        payment.registerPolicy(policyCommitment);
        _expectRevert(amount, amount, bytes32(uint256(nonce) + 1), merchant, _proof(), "");
    }

    function test_inflated_amount_rejected() public {
        payment.registerPolicy(policyCommitment);
        _expectRevert(amount + 1, amount + 1, nonce, merchant, _proof(), "");
    }

    function test_tampered_proof_rejected() public {
        payment.registerPolicy(policyCommitment);
        bytes memory proof = _proof();
        proof[proof.length / 2] ^= 0x01;
        _expectRevert(amount, amount, nonce, merchant, proof, "");
    }

    function test_unfunded_payment_reverts_instead_of_fake_success() public {
        payment.registerPolicy(policyCommitment);
        _expectRevert(0, amount, nonce, merchant, _proof(), "Insufficient policy balance");
    }

    function test_value_mismatch_reverts() public {
        payment.registerPolicy(policyCommitment);
        _expectRevert(amount - 1, amount, nonce, merchant, _proof(), "msg.value must equal proven amount");
    }

    receive() external payable {}

    // Funds deposited for another policy must not be spendable by a proof against ours.
    function test_cannot_spend_another_policys_deposit() public {
        bytes32 other = keccak256("victim policy");
        payment.registerPolicy(other);
        payment.deposit{value: amount}(other);
        payment.registerPolicy(policyCommitment);
        _expectRevert(0, amount, nonce, merchant, _proof(), "Insufficient policy balance");
        require(payment.policyBalance(other) == amount, "victim deposit touched");
    }

    function test_policy_cannot_be_reregistered() public {
        payment.registerPolicy(policyCommitment);
        try payment.registerPolicy(policyCommitment) {
            revert("re-registration accepted");
        } catch Error(string memory r) {
            require(keccak256(bytes(r)) == keccak256("Policy already registered"), r);
        }
        require(payment.policyOwner(policyCommitment) == address(this), "owner");
    }

    function test_plain_eth_transfer_rejected() public {
        (bool ok, ) = address(payment).call{value: 1}("");
        require(!ok, "unaccounted ETH accepted");
    }

    // Another policy owner consuming the same nonce value must not block this policy's payment.
    function test_foreign_policy_cannot_burn_our_nonce() public {
        bytes32 other = keccak256("attacker policy");
        payment.registerPolicy(other);
        payment.registerPolicy(policyCommitment);
        require(!payment.usedNonces(other, nonce) && !payment.usedNonces(policyCommitment, nonce), "fresh");
        _pay(amount, amount, nonce, merchant, _proof());
        require(payment.usedNonces(policyCommitment, nonce), "ours consumed");
        require(!payment.usedNonces(other, nonce), "nonce must be scoped per policy");
    }
}
