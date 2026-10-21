// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;
import "./LeashPayment.t.sol";

// Registration front-run: policies are keyed by (owner, commitment), so copying a victim's
// commitment from the mempool only creates the copier's own empty policy.
// The test contract plays the victim; ATTACKER copies its commitment.
contract FrontRunTest is LeashTestBase {
    address payable constant SINK = payable(address(0xC0FFEE));

    function _reason(bytes memory r) internal pure returns (string memory) {
        if (r.length < 68) return "";
        assembly { r := add(r, 4) }
        return abi.decode(r, (string));
    }

    function _eq(string memory a, string memory b) internal pure returns (bool) {
        return keccak256(bytes(a)) == keccak256(bytes(b));
    }

    function test_mempool_copy_cannot_block_or_steal() public {
        // Attacker copies the victim's commitment and registers it first.
        vm.prank(ATTACKER);
        payment.registerPolicy(policyCommitment);
        bytes32 attackerId = payment.policyIdOf(ATTACKER, policyCommitment);
        require(attackerId != _id(policyCommitment), "ids must differ");

        // Victim still registers, funded in the same call.
        payment.registerPolicy{value: amount}(policyCommitment);
        require(payment.policyOwner(_id(policyCommitment)) == address(this), "victim owns its policy");
        require(payment.policyBalance(_id(policyCommitment)) == amount, "escrow funded at registration");
        require(payment.policyBalance(attackerId) == 0, "attacker policy empty");

        // Attacker cannot withdraw the victim's escrow: its withdraw resolves to its own empty policy.
        vm.prank(ATTACKER);
        (bool ok, bytes memory r) = address(payment).call(
            abi.encodeCall(LeashPayment.withdraw, (policyCommitment, 1, ATTACKER))
        );
        require(!ok && _eq(_reason(r), "Insufficient policy balance"), "attacker withdraw");

        // Attacker relaying the victim's proof against its own copy cannot spend victim escrow.
        vm.prank(ATTACKER);
        (ok, r) = address(payment).call(abi.encodeCall(
            LeashPayment.executePayment, (ATTACKER, policyCommitment, amount, merchantHash, nonce, merchant, spend, _proof())
        ));
        require(!ok && _eq(_reason(r), "Insufficient policy balance"), "attacker pay from own copy");
        require(!payment.usedNonces(_id(policyCommitment), nonce), "victim nonce untouched");

        // Victim pays from its escrow with the real proof.
        uint256 b = merchant.balance;
        _pay(0, amount, nonce, merchant, _proof());
        require(merchant.balance == b + amount, "merchant paid");
        require(payment.policyBalance(_id(policyCommitment)) == 0, "escrow spent");
    }

    function test_non_owner_deposit_reverts_no_funds_stranded() public {
        payment.registerPolicy(policyCommitment);
        vm.deal(ATTACKER, 1000);
        vm.prank(ATTACKER);
        (bool ok, bytes memory r) = address(payment).call{value: 1000}(
            abi.encodeCall(LeashPayment.deposit, (policyCommitment))
        );
        require(!ok && _eq(_reason(r), "Not policy owner"), "non-owner deposit");
        require(address(payment).balance == 0, "nothing stranded");
        require(ATTACKER.balance == 1000, "refunded");
    }

    function test_deposit_to_unregistered_reverts() public {
        (bool ok, bytes memory r) = address(payment).call{value: 1}(
            abi.encodeCall(LeashPayment.deposit, (policyCommitment))
        );
        require(!ok && _eq(_reason(r), "Not policy owner"), "unregistered deposit");
    }

    function test_owner_deposit_works() public {
        payment.registerPolicy(policyCommitment);
        payment.deposit{value: 500}(policyCommitment);
        payment.deposit{value: 7}(policyCommitment);
        require(payment.policyBalance(_id(policyCommitment)) == 507, "balance");
    }

    function test_register_with_value_funds_escrow_and_pays() public {
        bytes32 id = payment.registerPolicy{value: amount}(policyCommitment);
        require(id == _id(policyCommitment), "returned id");
        require(payment.policyBalance(id) == amount && address(payment).balance == amount, "funded");
        _pay(0, amount, nonce, merchant, _proof());
        require(payment.policyBalance(id) == 0, "spent");
    }

    function test_same_owner_cannot_reregister() public {
        payment.registerPolicy(policyCommitment);
        (bool ok, bytes memory r) = address(payment).call(abi.encodeCall(LeashPayment.registerPolicy, (policyCommitment)));
        require(!ok && _eq(_reason(r), "Policy already registered"), "rereg");
    }

    function test_attacker_cannot_withdraw_after_victim_deposits() public {
        vm.prank(ATTACKER);
        payment.registerPolicy(policyCommitment);
        payment.registerPolicy(policyCommitment);
        payment.deposit{value: 1000}(policyCommitment);
        vm.prank(ATTACKER);
        (bool ok, ) = address(payment).call(abi.encodeCall(LeashPayment.withdraw, (policyCommitment, 1000, ATTACKER)));
        require(!ok, "stolen");
        payment.withdraw(policyCommitment, 1000, SINK);
        require(SINK.balance == 1000, "owner withdraws");
    }
}

// Escrow-funded run: the owner funds at registration; an unrelated relayer submits the real proof
// with no msg.value and the payment comes out of the owner's policy escrow.
contract RelayerEscrowTest is LeashTestBase {
    address constant RELAYER = address(0xBEEF01);

    function test_relayer_pays_from_escrow_without_value() public {
        payment.registerPolicy{value: 1000}(policyCommitment);
        uint256 merchantBefore = merchant.balance;
        uint256 relayerBefore = RELAYER.balance;
        vm.prank(RELAYER);
        payment.executePayment(address(this), policyCommitment, amount, merchantHash, nonce, merchant, spend, _proof());
        require(merchant.balance == merchantBefore + amount, "merchant paid the proven amount");
        require(payment.policyBalance(_id(policyCommitment)) == 1000 - amount, "paid from escrow");
        require(RELAYER.balance == relayerBefore, "relayer spent no value");
    }

    function test_relayer_cannot_redirect_or_overdraw() public {
        payment.registerPolicy{value: 100}(policyCommitment); // less than the 300 proven
        vm.prank(RELAYER);
        (bool ok, ) = address(payment).call(abi.encodeCall(
            LeashPayment.executePayment, (address(this), policyCommitment, amount, merchantHash, nonce, merchant, spend, _proof())
        ));
        require(!ok, "overdraw accepted");
        vm.prank(RELAYER);
        (ok, ) = address(payment).call(abi.encodeCall(
            LeashPayment.executePayment, (address(this), policyCommitment, amount, merchantHash, nonce, payable(RELAYER), spend, _proof())
        ));
        require(!ok, "redirect to relayer accepted");
        require(payment.policyBalance(_id(policyCommitment)) == 100, "escrow intact");
    }
}
