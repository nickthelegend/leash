// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

import "../src/LeashMUSD.sol";

interface Vm {
    function createSelectFork(string calldata url, uint256 blockNumber) external returns (uint256);
    function prank(address sender) external;
    function startPrank(address sender) external;
    function stopPrank() external;
    function expectRevert(bytes calldata revertData) external;
    function expectRevert() external;
    function readFileBinary(string calldata path) external view returns (bytes memory);
    function envOr(string calldata name, string calldata defaultValue) external view returns (string memory);
}

interface IERC20Full {
    function balanceOf(address) external view returns (uint256);
    function approve(address, uint256) external returns (bool);
}

/// Runs on a fork of Mezo testnet (chain 31611) pinned to a block on the fixtures' UTC day, against the real
/// MUSD, BorrowerOperations, TroveManager and PriceFeed contracts from mezo-org/musd's matsnet deployment.
/// The policy owner is a real borrower with an active testnet trove (impersonated); MUSD is seeded from the real
/// StabilityPool's balance (a local fork cannot run Mezo's BTC precompile, so openTrove itself is exercised on
/// the live testnet by packages/mezo/scripts/live.mjs, not here). The agent pays with real UltraHonk proofs (test/fixtures/mezo-pay1, mezo-pay2: node packages/mezo/scripts/gen-fixtures.mjs).
contract LeashMUSDForkTest {
    Vm constant vm = Vm(address(uint160(uint256(keccak256("hevm cheat code")))));

    // mezo-org/musd solidity/artifacts/deployments/matsnet
    address constant MUSD = 0x118917a40FAF1CD7a13dB0Ef56C86De7973Ac503;
    address constant TROVE_MANAGER = 0xE47c80e8c23f6B4A1aE41c34837a0599D5D16bb0;
    address constant PRICE_FEED = 0x86bCF0841622a5dAC14A313a15f96A95421b9366;
    address constant STABILITY_POOL = 0x1CCA7E410eE41739792eA0A24e00349Dd247680e;
    uint256 constant FORK_BLOCK = 16375480; // 2026-10-26 UTC, epoch 20752 = the fixtures' day

    LeashMUSD leash;
    address owner = 0x4F5723979a70eACd03155a3cD0596f40Fe2fed46; // active trove at FORK_BLOCK (~743% ICR)
    address relayer = address(0xA11CE);

    struct Pay {
        bytes32 commitment;
        uint256 cents;
        bytes32 merchantHash;
        bytes32 nonce;
        address recipient;
        LeashMUSD.SpendUpdate spend;
        bytes proof;
    }

    function _pay(string memory name) internal view returns (Pay memory p) {
        string memory dir = string.concat("test/fixtures/", name, "/");
        (bytes32 c, uint256 a, bytes32 m, bytes32 n, uint256 r, uint256 e, bytes32 prev, bytes32 next) = abi.decode(
            vm.readFileBinary(string.concat(dir, "public_inputs")),
            (bytes32, uint256, bytes32, bytes32, uint256, uint256, bytes32, bytes32)
        );
        p = Pay(c, a, m, n, address(uint160(r)), LeashMUSD.SpendUpdate(uint64(e), prev, next), vm.readFileBinary(string.concat(dir, "proof")));
    }

    function setUp() public {
        vm.createSelectFork(vm.envOr("MEZO_RPC_URL", string("https://rpc.test.mezo.org")), FORK_BLOCK);
        leash = new LeashMUSD(address(new HonkVerifier()), MUSD, TROVE_MANAGER, PRICE_FEED);
    }

    /// Seeds `who` with MUSD from the real StabilityPool's balance.
    function _seed(address who, uint256 amountWei) internal {
        vm.prank(STABILITY_POOL);
        (bool ok, bytes memory ret) = MUSD.call(abi.encodeWithSignature("transfer(address,uint256)", who, amountWei));
        require(ok && (ret.length == 0 || abi.decode(ret, (bool))), "seed transfer failed");
    }

    function _register(bytes32 commitment, uint256 depositWei, uint256 minICR) internal {
        vm.startPrank(owner);
        IERC20Full(MUSD).approve(address(leash), depositWei);
        leash.registerPolicy(commitment, depositWei, minICR);
        vm.stopPrank();
    }

    function _execute(Pay memory p) internal {
        vm.prank(relayer);
        leash.executePayment(owner, p.commitment, p.cents, p.merchantHash, p.nonce, p.recipient, p.spend, p.proof);
    }

    /// The trove guard (TroveManager.getCurrentICR at PriceFeed.fetchPrice) needs Mezo's oracle precompile,
    /// which a local fork cannot execute, so guarded payments are verified on the live testnet by
    /// packages/mezo/scripts/live.mjs. Here the guard is off (minICR 0) and everything else is real.
    function test_musd_escrow_pays_through_chained_proofs() public {
        _seed(owner, 10e18);
        Pay memory p1 = _pay("mezo-pay1");
        _register(p1.commitment, 10e18, 0);
        uint256 before = IERC20Full(MUSD).balanceOf(p1.recipient);
        _execute(p1);
        require(IERC20Full(MUSD).balanceOf(p1.recipient) - before == 3e18, "payee did not get 3 MUSD");
        Pay memory p2 = _pay("mezo-pay2");
        _execute(p2); // chains on pay1's spend commitment
        require(IERC20Full(MUSD).balanceOf(p1.recipient) - before == 7e18, "payee did not get 7 MUSD");
        require(leash.policyBalance(leash.policyIdOf(owner, p1.commitment)) == 3e18, "escrow not debited");
    }

    function test_proof_cannot_be_redirected_or_replayed() public {
        _seed(owner, 10e18);
        Pay memory p1 = _pay("mezo-pay1");
        _register(p1.commitment, 10e18, 0);
        vm.prank(relayer);
        vm.expectRevert(); // recipient is a public input: a swapped payee fails verification
        leash.executePayment(owner, p1.commitment, p1.cents, p1.merchantHash, p1.nonce, address(0xdead), p1.spend, p1.proof);
        vm.prank(relayer);
        vm.expectRevert(); // an inflated amount fails verification
        leash.executePayment(owner, p1.commitment, p1.cents * 10, p1.merchantHash, p1.nonce, p1.recipient, p1.spend, p1.proof);
        _execute(p1);
        vm.expectRevert(bytes("Nonce already used"));
        _execute(p1);
    }

    function test_front_runner_cannot_spend_the_owners_escrow() public {
        _seed(owner, 10e18);
        Pay memory p1 = _pay("mezo-pay1");
        _register(p1.commitment, 10e18, 0);
        // an attacker registers the same public commitment under its own key: a separate, empty policy
        address attacker = address(0xBAD);
        vm.prank(attacker);
        leash.registerPolicy(p1.commitment, 0, 0);
        vm.prank(attacker);
        vm.expectRevert(bytes("Insufficient policy balance"));
        leash.executePayment(attacker, p1.commitment, p1.cents, p1.merchantHash, p1.nonce, p1.recipient, p1.spend, p1.proof);
        vm.prank(attacker); // withdraw reaches only the attacker's own empty policy
        vm.expectRevert(bytes("Insufficient policy balance"));
        leash.withdraw(p1.commitment, 1e18, attacker);
        _execute(p1); // the owner's policy still pays
    }

    function test_guard_floor_below_mezo_mcr_is_refused() public {
        Pay memory p1 = _pay("mezo-pay1");
        vm.prank(owner);
        vm.expectRevert(bytes("Guard below Mezo MCR"));
        leash.registerPolicy(p1.commitment, 0, 1.05e18);
    }

    function test_only_owner_sets_the_guard() public {
        _seed(owner, 10e18);
        Pay memory p1 = _pay("mezo-pay1");
        _register(p1.commitment, 10e18, 0);
        vm.prank(address(0xBAD));
        vm.expectRevert(bytes("Not policy owner"));
        leash.setTroveGuard(p1.commitment, 2e18);
    }

    function test_owner_withdraws_unspent_musd() public {
        _seed(owner, 10e18);
        Pay memory p1 = _pay("mezo-pay1");
        _register(p1.commitment, 10e18, 0);
        uint256 before = IERC20Full(MUSD).balanceOf(owner);
        vm.prank(owner);
        leash.withdraw(p1.commitment, 10e18, owner);
        require(IERC20Full(MUSD).balanceOf(owner) - before == 10e18, "withdraw failed");
    }
}
