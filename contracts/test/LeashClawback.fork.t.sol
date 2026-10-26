// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

import "../src/LeashClawback.sol";

interface Vm {
    function createSelectFork(string calldata url, uint256 blockNumber) external returns (uint256);
    function prank(address sender) external;
    function startPrank(address sender) external;
    function stopPrank() external;
    function warp(uint256 timestamp) external;
    function expectRevert(bytes calldata revertData) external;
    function expectRevert() external;
    function readFileBinary(string calldata path) external view returns (bytes memory);
    function envOr(string calldata name, string calldata defaultValue) external view returns (string memory);
}

interface IERC20T {
    function balanceOf(address) external view returns (uint256);
    function approve(address, uint256) external returns (bool);
    function transfer(address, uint256) external returns (bool);
}

/// The bond token in these fork tests. On Mezo, MEZO (0x7b7c…0001) is backed by a chain precompile that a local fork
/// cannot execute, so a plain ERC-20 stands in for it here; the live testnet run (packages/mezo/scripts/clawback-live.sh)
/// bonds and slashes real MEZO.
contract BondToken {
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    function mint(address to, uint256 amount) external {
        balanceOf[to] += amount;
    }

    function approve(address spender, uint256 amount) external returns (bool) {
        allowance[msg.sender][spender] = amount;
        return true;
    }

    function transfer(address to, uint256 amount) external returns (bool) {
        balanceOf[msg.sender] -= amount;
        balanceOf[to] += amount;
        return true;
    }

    function transferFrom(address from, address to, uint256 amount) external returns (bool) {
        allowance[from][msg.sender] -= amount;
        balanceOf[from] -= amount;
        balanceOf[to] += amount;
        return true;
    }
}

/// Fork of Mezo testnet (pinned to the fixtures' UTC day) with the real MUSD token and real UltraHonk proofs
/// (test/fixtures/mezo-pay1 and mezo-pay2: 300 and 400 cents to the fixture payee, chained on one policy).
contract LeashClawbackForkTest {
    Vm constant vm = Vm(address(uint160(uint256(keccak256("hevm cheat code")))));

    address constant MUSD = 0x118917a40FAF1CD7a13dB0Ef56C86De7973Ac503;
    address constant STABILITY_POOL = 0x1CCA7E410eE41739792eA0A24e00349Dd247680e;
    uint256 constant FORK_BLOCK = 16375480;
    uint64 constant WINDOW = 1 days;
    uint64 constant DISPUTE = 1 hours;

    LeashClawback cb;
    BondToken bondToken;
    address owner = address(0xB0B);
    address arbiter = address(0xA4B);
    address relayer = address(0xA11CE);
    address provider; // the fixture's allowlisted payee

    struct Pay {
        bytes32 commitment;
        uint256 cents;
        bytes32 merchantHash;
        bytes32 nonce;
        address recipient;
        LeashClawback.SpendUpdate spend;
        bytes proof;
    }

    function _pay(string memory name) internal view returns (Pay memory p) {
        string memory dir = string.concat("test/fixtures/", name, "/");
        (bytes32 c, uint256 a, bytes32 m, bytes32 n, uint256 r, uint256 e, bytes32 prev, bytes32 next) = abi.decode(
            vm.readFileBinary(string.concat(dir, "public_inputs")),
            (bytes32, uint256, bytes32, bytes32, uint256, uint256, bytes32, bytes32)
        );
        p = Pay(c, a, m, n, address(uint160(r)), LeashClawback.SpendUpdate(uint64(e), prev, next), vm.readFileBinary(string.concat(dir, "proof")));
    }

    function setUp() public {
        vm.createSelectFork(vm.envOr("MEZO_RPC_URL", string("https://rpc.test.mezo.org")), FORK_BLOCK);
        bondToken = new BondToken();
        cb = new LeashClawback(address(new HonkVerifier()), MUSD, address(bondToken), DISPUTE, 10e18, 5e18);
        Pay memory p = _pay("mezo-pay1");
        provider = p.recipient;
        // owner: 10 MUSD from the real StabilityPool's balance, a registered policy with an arbiter
        vm.prank(STABILITY_POOL);
        require(IERC20T(MUSD).transfer(owner, 10e18), "seed");
        vm.startPrank(owner);
        IERC20T(MUSD).approve(address(cb), 10e18);
        cb.registerPolicy(p.commitment, arbiter, 10e18);
        vm.stopPrank();
        // provider: 20 bond tokens, bonded
        bondToken.mint(provider, 20e18);
        vm.startPrank(provider);
        bondToken.approve(address(cb), 20e18);
        cb.bond(20e18);
        vm.stopPrank();
    }

    function _open(Pay memory p) internal returns (uint256 id) {
        vm.prank(relayer);
        id = cb.openJob(_req(p, p.recipient, p.cents), p.spend, p.proof);
    }

    function _req(Pay memory p, address prov, uint256 cents) internal view returns (LeashClawback.JobRequest memory) {
        return LeashClawback.JobRequest(owner, p.commitment, cents, p.merchantHash, p.nonce, prov, keccak256("summarise the Mezo docs"), WINDOW);
    }

    function _pid() internal view returns (bytes32) {
        return cb.policyIdOf(owner, _pay("mezo-pay1").commitment);
    }

    function test_delivered_and_accepted_pays_the_provider() public {
        uint256 id = _open(_pay("mezo-pay1"));
        require(cb.policyBalance(_pid()) == 7e18, "escrow not moved into the job");
        uint256 before = IERC20T(MUSD).balanceOf(provider);
        vm.prank(provider);
        cb.deliver(id, keccak256("the summary"), "ipfs://summary");
        vm.prank(owner);
        cb.accept(id);
        require(IERC20T(MUSD).balanceOf(provider) - before == 3e18, "provider not paid 3 MUSD");
        require(cb.openJobs(provider) == 0, "job still open");
    }

    function test_undisputed_delivery_releases_after_the_window() public {
        uint256 id = _open(_pay("mezo-pay1"));
        vm.prank(provider);
        cb.deliver(id, keccak256("r"), "");
        vm.expectRevert(bytes("Dispute window open"));
        cb.release(id);
        vm.warp(block.timestamp + DISPUTE + 1);
        uint256 before = IERC20T(MUSD).balanceOf(provider);
        cb.release(id); // anyone
        require(IERC20T(MUSD).balanceOf(provider) - before == 3e18, "not released");
    }

    function test_ghosted_job_is_clawed_back_and_bond_slashed() public {
        uint256 id = _open(_pay("mezo-pay1"));
        vm.expectRevert(bytes("Deadline not passed"));
        cb.clawback(id);
        vm.warp(block.timestamp + WINDOW + 1);
        vm.prank(provider);
        vm.expectRevert(bytes("Deadline passed"));
        cb.deliver(id, keccak256("too late"), "");
        cb.clawback(id); // anyone
        require(cb.policyBalance(_pid()) == 10e18, "MUSD not back in the owner's escrow");
        require(bondToken.balanceOf(owner) == 5e18, "owner did not get the slashed bond");
        require(cb.bondOf(provider) == 15e18, "bond not slashed");
        vm.expectRevert(bytes("Not pending"));
        cb.clawback(id);
    }

    function test_dispute_resolved_for_the_owner_claws_back() public {
        uint256 id = _open(_pay("mezo-pay1"));
        vm.prank(provider);
        cb.deliver(id, keccak256("wrong answer"), "");
        vm.prank(owner);
        cb.dispute(id, keccak256("output does not match the task"));
        vm.prank(address(0xBAD));
        vm.expectRevert(bytes("Not the arbiter"));
        cb.resolve(id, true);
        vm.prank(arbiter);
        cb.resolve(id, true);
        require(cb.policyBalance(_pid()) == 10e18, "not refunded");
        require(bondToken.balanceOf(owner) == 5e18, "not slashed");
    }

    function test_dispute_resolved_for_the_provider_releases() public {
        uint256 id = _open(_pay("mezo-pay1"));
        vm.prank(provider);
        cb.deliver(id, keccak256("good answer"), "");
        vm.prank(owner);
        cb.dispute(id, keccak256("buyer's remorse"));
        uint256 before = IERC20T(MUSD).balanceOf(provider);
        vm.prank(arbiter);
        cb.resolve(id, false);
        require(IERC20T(MUSD).balanceOf(provider) - before == 3e18, "not released");
        require(cb.bondOf(provider) == 20e18, "honest provider slashed");
    }

    function test_dispute_after_the_window_is_refused() public {
        uint256 id = _open(_pay("mezo-pay1"));
        vm.prank(provider);
        cb.deliver(id, keccak256("r"), "");
        vm.warp(block.timestamp + DISPUTE + 1);
        vm.prank(owner);
        vm.expectRevert(bytes("Dispute window closed"));
        cb.dispute(id, bytes32(0));
    }

    function test_provider_cannot_unbond_with_open_jobs() public {
        uint256 id = _open(_pay("mezo-pay1"));
        vm.prank(provider);
        vm.expectRevert(bytes("Open jobs"));
        cb.unbond(1e18);
        vm.prank(provider);
        cb.deliver(id, keccak256("r"), "");
        vm.prank(owner);
        cb.accept(id);
        vm.prank(provider);
        cb.unbond(20e18);
        require(bondToken.balanceOf(provider) == 20e18, "unbond failed");
    }

    function test_unbonded_provider_cannot_take_jobs() public {
        vm.prank(provider);
        cb.unbond(20e18);
        Pay memory p = _pay("mezo-pay1");
        vm.prank(relayer);
        vm.expectRevert(bytes("Provider not bonded"));
        cb.openJob(_req(p, p.recipient, p.cents), p.spend, p.proof);
    }

    function test_only_the_provider_delivers_and_only_the_owner_accepts_or_disputes() public {
        uint256 id = _open(_pay("mezo-pay1"));
        vm.prank(address(0xBAD));
        vm.expectRevert(bytes("Not the provider"));
        cb.deliver(id, keccak256("r"), "");
        vm.prank(provider);
        cb.deliver(id, keccak256("r"), "");
        vm.prank(address(0xBAD));
        vm.expectRevert(bytes("Not the owner"));
        cb.accept(id);
        vm.prank(address(0xBAD));
        vm.expectRevert(bytes("Not the owner"));
        cb.dispute(id, bytes32(0));
    }

    function test_proof_binds_the_provider_amount_and_nonce() public {
        Pay memory p = _pay("mezo-pay1");
        // a second bonded address, so the revert comes from the proof, not the bond check
        bondToken.mint(address(0xdead), 20e18);
        vm.startPrank(address(0xdead));
        bondToken.approve(address(cb), 20e18);
        cb.bond(20e18);
        vm.stopPrank();
        vm.prank(relayer);
        vm.expectRevert(); // a different provider is a different public input
        cb.openJob(_req(p, address(0xdead), p.cents), p.spend, p.proof);
        vm.prank(relayer);
        vm.expectRevert(); // an inflated amount fails verification
        cb.openJob(_req(p, p.recipient, p.cents * 10), p.spend, p.proof);
        _open(p);
        vm.prank(relayer);
        vm.expectRevert(bytes("Nonce already used"));
        cb.openJob(_req(p, p.recipient, p.cents), p.spend, p.proof);
    }

    function test_chained_jobs_follow_the_rolling_cap() public {
        _open(_pay("mezo-pay1"));
        _open(_pay("mezo-pay2")); // opens pay1's spend commitment
        require(cb.policyBalance(_pid()) == 3e18, "two jobs should hold 7 MUSD");
        require(cb.jobCount() == 2, "two jobs");
    }

    function test_arbiter_must_be_a_third_party() public {
        Pay memory p = _pay("mezo-pay2");
        vm.prank(address(0xC0C));
        vm.expectRevert(bytes("Arbiter must be a third party"));
        cb.registerPolicy(p.commitment, address(0xC0C), 0);
    }
}
