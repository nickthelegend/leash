// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;
import "./LeashPayment.t.sol";

// Rolling daily cap, against real proofs (cap 500/day, 500/payment):
//   base     300, prev 0         -> C1
//   second   200, prev C1 (300)  -> C2 (500 total)
//   parallel 300, prev 0         (built at the same time as base: 600 total if both landed)
//   nextday  300, epoch + 1, prev 0
contract DailyCapTest is LeashTestBase {
    function _payFixture(Fixture memory f) internal {
        payment.executePayment{value: f.amount}(address(this), f.commitment, f.amount, f.merchantHash, f.nonce, f.recipient, f.spend, f.proof);
    }

    function _revertReason(Fixture memory f) internal returns (string memory) {
        (bool ok, bytes memory r) = address(payment).call{value: f.amount}(
            abi.encodeCall(LeashPayment.executePayment, (address(this), f.commitment, f.amount, f.merchantHash, f.nonce, f.recipient, f.spend, f.proof))
        );
        require(!ok, "expected revert");
        if (r.length < 68) return "";
        assembly { r := add(r, 4) }
        return abi.decode(r, (string));
    }

    function _eq(string memory a, string memory b) internal pure returns (bool) {
        return keccak256(bytes(a)) == keccak256(bytes(b));
    }

    function test_first_payment_stores_spend_commitment() public {
        payment.registerPolicy(policyCommitment);
        Fixture memory b = _fixture("base");
        _payFixture(b);
        bytes32 id = _id(policyCommitment);
        require(payment.spendCommit(id) == b.spend.newCommit, "commit stored");
        require(payment.spendEpoch(id) == EPOCH, "epoch stored");
    }

    function test_sequential_payments_chain_up_to_cap() public {
        payment.registerPolicy(policyCommitment);
        uint256 before = merchant.balance;
        _payFixture(_fixture("base"));
        Fixture memory s2 = _fixture("second");
        _payFixture(s2);
        require(merchant.balance == before + 500, "300 + 200 paid");
        require(payment.spendCommit(_id(policyCommitment)) == s2.spend.newCommit, "chain advanced");
    }

    // Two proofs built on the same prev (a parallel double-spend that would total 600 > 500):
    // only the first lands; the second's prev is stale.
    function test_parallel_double_spend_stale_prev_reverts() public {
        payment.registerPolicy(policyCommitment);
        _payFixture(_fixture("base"));
        Fixture memory p = _fixture("parallel");
        uint256 before = merchant.balance;
        require(_eq(_revertReason(p), "Stale spend commitment"), "stale prev must revert");
        require(merchant.balance == before, "nothing paid");
        require(!payment.usedNonces(_id(policyCommitment), p.nonce), "nonce untouched");
    }

    // A forged newCommit (claiming less was spent) fails the proof: it is a public input.
    function test_forged_new_commitment_rejected() public {
        payment.registerPolicy(policyCommitment);
        Fixture memory b = _fixture("base");
        b.spend.newCommit = bytes32(uint256(b.spend.newCommit) ^ 1);
        _revertReason(b);
        require(payment.spendCommit(_id(policyCommitment)) == bytes32(0), "state untouched");
    }

    // Within an epoch, prev = 0 can't reset the running total.
    function test_zero_prev_cannot_reset_within_epoch() public {
        payment.registerPolicy(policyCommitment);
        _payFixture(_fixture("base"));
        require(_eq(_revertReason(_fixture("parallel")), "Stale spend commitment"), "reset blocked");
    }

    function test_wrong_epoch_reverts() public {
        payment.registerPolicy(policyCommitment);
        vm.warp((EPOCH + 1) * 1 days);
        require(_eq(_revertReason(_fixture("base")), "Wrong epoch"), "yesterday's proof");
        vm.warp(EPOCH * 1 days);
        require(_eq(_revertReason(_fixture("nextday")), "Wrong epoch"), "tomorrow's proof");
    }

    // Day E is spent to the cap; on day E+1 a fresh chain (prev 0) is accepted again.
    function test_epoch_rollover_resets() public {
        payment.registerPolicy(policyCommitment);
        _payFixture(_fixture("base"));
        _payFixture(_fixture("second"));
        vm.warp((EPOCH + 1) * 1 days + 60);
        Fixture memory n = _fixture("nextday");
        uint256 before = merchant.balance;
        _payFixture(n);
        require(merchant.balance == before + 300, "paid on the new day");
        require(payment.spendEpoch(_id(policyCommitment)) == EPOCH + 1, "epoch advanced");
        require(payment.spendCommit(_id(policyCommitment)) == n.spend.newCommit, "commit replaced");
    }

    // On a new day a stale non-zero prev (yesterday's chain) is refused.
    function test_new_epoch_requires_zero_prev() public {
        payment.registerPolicy(policyCommitment);
        _payFixture(_fixture("base"));
        vm.warp((EPOCH + 1) * 1 days + 60);
        Fixture memory n = _fixture("nextday");
        n.spend.prevCommit = _fixture("base").spend.newCommit;
        require(_eq(_revertReason(n), "New epoch must start from zero"), "carry-over blocked");
    }

    // Spend state is per policy: another owner's copy of the commitment has its own chain.
    function test_spend_chain_is_per_policy() public {
        vm.prank(ATTACKER);
        payment.registerPolicy(policyCommitment);
        payment.registerPolicy(policyCommitment);
        _payFixture(_fixture("base"));
        require(payment.spendCommit(payment.policyIdOf(ATTACKER, policyCommitment)) == bytes32(0), "copy untouched");
    }
}
