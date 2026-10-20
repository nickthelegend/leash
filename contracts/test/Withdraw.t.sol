// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;
import "./LeashPayment.t.sol";

// Owner-only escrow withdraw, against the real HonkVerifier + committed proof fixture.
contract WithdrawTest is LeashPaymentTest {
    address payable constant SINK = payable(address(0xC0FFEE));

    function _expectWithdrawRevert(bytes32 p, uint256 a, address payable to, string memory expected) internal {
        try payment.withdraw(p, a, to) { revert("withdraw accepted"); }
        catch Error(string memory r) { require(keccak256(bytes(r)) == keccak256(bytes(expected)), r); }
    }

    function test_owner_withdraws() public {
        payment.registerPolicy(policyCommitment);
        payment.deposit{value: 1000}(policyCommitment);
        uint256 b = SINK.balance;
        payment.withdraw(policyCommitment, 400, SINK);
        require(SINK.balance == b + 400, "sink paid");
        require(payment.policyBalance(_id(policyCommitment)) == 600, "balance reduced");
        require(address(payment).balance == 600, "contract balance");
    }

    function test_non_owner_withdraw_reverts() public {
        payment.registerPolicy(policyCommitment);
        payment.deposit{value: 1000}(policyCommitment);
        vm.prank(ATTACKER);
        _expectWithdrawRevert(policyCommitment, 1, ATTACKER, "Not policy owner");
        require(payment.policyBalance(_id(policyCommitment)) == 1000, "untouched");
    }

    function test_unregistered_policy_withdraw_reverts() public {
        _expectWithdrawRevert(keccak256("nobody"), 0, SINK, "Not policy owner");
    }

    function test_over_balance_withdraw_reverts() public {
        payment.registerPolicy(policyCommitment);
        payment.deposit{value: 1000}(policyCommitment);
        _expectWithdrawRevert(policyCommitment, 1001, SINK, "Insufficient policy balance");
        require(payment.policyBalance(_id(policyCommitment)) == 1000, "untouched");
    }

    // Owner of policy A cannot pull escrow belonging to policy B, even when the contract holds it.
    function test_withdraw_cannot_touch_other_policy() public {
        bytes32 victim = keccak256("victim policy");
        vm.deal(ATTACKER, 1000);
        vm.prank(ATTACKER);
        payment.registerPolicy{value: 1000}(victim);
        payment.registerPolicy(policyCommitment);
        payment.deposit{value: 10}(policyCommitment);
        _expectWithdrawRevert(policyCommitment, 11, SINK, "Insufficient policy balance");
        _expectWithdrawRevert(victim, 1, SINK, "Not policy owner");
        require(payment.policyBalance(payment.policyIdOf(ATTACKER, victim)) == 1000, "victim escrow touched");
        require(address(payment).balance == 1010, "contract balance");
    }

    // After a partial withdraw, a real-proof payment must fail if the remainder is below amount,
    // and succeed (draining exactly amount) when enough remains.
    function test_payment_after_partial_withdraw_respects_balance() public {
        payment.registerPolicy(policyCommitment);
        payment.deposit{value: amount + 50}(policyCommitment);
        payment.withdraw(policyCommitment, 51, SINK);
        _expectRevert(0, amount, nonce, merchant, _proof(), "Insufficient policy balance");
        payment.deposit{value: 1}(policyCommitment);
        uint256 b = merchant.balance;
        _pay(0, amount, nonce, merchant, _proof());
        require(merchant.balance == b + amount, "paid");
        require(payment.policyBalance(_id(policyCommitment)) == 0, "drained exactly");
    }
}
