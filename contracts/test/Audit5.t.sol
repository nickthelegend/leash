// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;
import "./LeashPayment.t.sol";
// Round-5 verifier attacks against the committed HonkVerifier + committed fixture.
contract Audit5Test is LeashPaymentTest {
    function test_audit_fixture_amount_is_300() public view { require(amount == 300, "amount"); }
    function test_audit_amount_5000_rejected() public {
        payment.registerPolicy(policyCommitment);
        _expectRevert(5000, 5000, nonce, merchant, _proof(), "");
    }
    function test_audit_amount_wraps_2pow64_rejected() public {
        payment.registerPolicy(policyCommitment);
        uint256 a = amount + (uint256(1) << 64);
        _expectRevert(a, a, nonce, merchant, _proof(), "");
    }
    function test_audit_other_recipient_rejected() public {
        payment.registerPolicy(policyCommitment);
        _expectRevert(amount, amount, nonce, payable(address(0xBEEF)), _proof(), "");
    }
    function test_audit_pays_once_then_nonce_reuse_reverts() public {
        payment.registerPolicy(policyCommitment);
        uint256 b = merchant.balance;
        _pay(amount, amount, nonce, merchant, _proof());
        require(merchant.balance == b + amount, "paid");
        require(payment.usedNonces(_id(policyCommitment), nonce), "nonce");
        try payment.executePayment{value: amount}(address(this), policyCommitment, amount, merchantHash, nonce, merchant, _proof()) {
            revert("replay accepted");
        } catch Error(string memory r) { require(keccak256(bytes(r)) == keccak256("Nonce already used"), r); }
    }
}
