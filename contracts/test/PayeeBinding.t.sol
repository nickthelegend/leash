// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;
import "./LeashPayment.t.sol";

// Payee binding. The victim's policy lists merchant M with payee RECIPIENT. A proof naming the
// attacker as payee can't be built under the victim's policy (nargo test
// test_allowlisted_merchant_attacker_payee_fails); the only such proof is one under a policy the
// attacker controls (fixtures/attacker: same merchant, payee 0x…dEaD). It never moves victim funds.
contract PayeeBindingTest is LeashTestBase {
    function test_attacker_payee_proof_rejected_against_victim_policy() public {
        payment.registerPolicy{value: 1000}(policyCommitment);
        Fixture memory a = _fixture("attacker");
        require(a.recipient == ATTACKER, "fixture pays the attacker");
        require(a.commitment != policyCommitment, "different policy");
        uint256 before = ATTACKER.balance;
        // Same merchant hash slot, victim's commitment, attacker payee: the verifier rejects.
        (bool ok, ) = address(payment).call(abi.encodeCall(
            LeashPayment.executePayment, (address(this), policyCommitment, a.amount, a.merchantHash, a.nonce, ATTACKER, a.spend, a.proof)
        ));
        require(!ok, "attacker-payee proof accepted");
        // And with the victim's own merchant hash.
        (ok, ) = address(payment).call(abi.encodeCall(
            LeashPayment.executePayment, (address(this), policyCommitment, a.amount, merchantHash, a.nonce, ATTACKER, a.spend, a.proof)
        ));
        require(!ok, "attacker-payee proof accepted (victim merchant hash)");
        require(ATTACKER.balance == before, "attacker paid");
        require(payment.policyBalance(_id(policyCommitment)) == 1000, "victim escrow intact");
    }

    function test_attacker_policy_not_registered_for_victim_owner() public {
        Fixture memory a = _fixture("attacker");
        (bool ok, bytes memory r) = address(payment).call(abi.encodeCall(
            LeashPayment.executePayment, (address(this), a.commitment, a.amount, a.merchantHash, a.nonce, a.recipient, a.spend, a.proof)
        ));
        require(!ok && r.length >= 68, "must revert with reason");
        assembly { r := add(r, 4) }
        require(keccak256(bytes(abi.decode(r, (string)))) == keccak256("Policy not registered"), "reason");
    }

    // Victim's real proof, payee swapped to the attacker: rejected, attacker gets nothing.
    function test_victim_proof_cannot_be_redirected_to_attacker() public {
        payment.registerPolicy{value: 1000}(policyCommitment);
        uint256 before = ATTACKER.balance;
        _expectRevert(0, amount, nonce, ATTACKER, _proof(), "");
        require(ATTACKER.balance == before, "attacker paid");
    }

    // The salted merchant hash differs across policies even for the same merchant name.
    function test_merchant_hash_is_salted_per_policy() public view {
        require(_fixture("attacker").merchantHash != merchantHash, "same merchant, different salt, different hash");
    }
}
