// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

import "./LeashVerifier.sol";

interface IERC20Min {
    function transfer(address to, uint256 amount) external returns (bool);
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
}

/// Mezo Borrow (MUSD protocol) read surface used by the trove guard.
interface IMezoTroveManager {
    function getCurrentICR(address borrower, uint256 price) external view returns (uint256);
    function getTroveStatus(address borrower) external view returns (uint8);
}

interface IMezoPriceFeed {
    function fetchPrice() external view returns (uint256);
}

/**
 * @title LeashMUSD
 * @notice LEASH on Mezo: an AI agent spends Bitcoin-backed MUSD only through zero-knowledge proofs of its
 * owner's hidden policy (payee allowlist, per-payment cap, rolling daily cap), and only while the owner's
 * Mezo Borrow trove stays healthy. The same Noir circuit and verifier as LeashPayment; escrow is MUSD.
 *
 * Amounts in proofs are cents (the circuit range-checks them to 64 bits); 1 cent = 1e16 MUSD wei.
 *
 * Trove guard: an owner can bind a policy to a minimum collateral ratio. Before every payment the contract
 * reads the owner's trove from Mezo's TroveManager at the live PriceFeed price. If the trove is not active,
 * or its ICR is below the policy's floor, the payment reverts: as BTC falls, the leash tightens on its own.
 */
contract LeashMUSD {
    uint256 public constant CENT = 1e16; // MUSD has 18 decimals
    uint8 internal constant TROVE_ACTIVE = 1; // MUSD TroveManager Status.active

    IVerifier public immutable verifier;
    IERC20Min public immutable musd;
    IMezoTroveManager public immutable troveManager;
    IMezoPriceFeed public immutable priceFeed;

    // policyId = keccak256(abi.encode(owner, commitment)), as in LeashPayment (front-run safe).
    mapping(bytes32 => address) public policyOwner;
    mapping(bytes32 => mapping(bytes32 => bool)) public usedNonces; // policyId => nonce => used
    mapping(bytes32 => uint256) public policyBalance; // policyId => MUSD wei
    mapping(bytes32 => bytes32) public spendCommit; // policyId => H(spent, epoch, spend_salt)
    mapping(bytes32 => uint64) public spendEpoch; // policyId => UTC day of spendCommit
    mapping(bytes32 => uint256) public minTroveICR; // policyId => floor (1e18 = 100%); 0 = guard off

    struct SpendUpdate {
        uint64 epoch; // block.timestamp / 1 days
        bytes32 prevCommit; // must equal spendCommit[policyId], or 0 for the first payment of an epoch
        bytes32 newCommit; // H(spent_before + amount, epoch, spend_salt), computed by the circuit
    }

    event PolicyRegistered(bytes32 indexed policyId, bytes32 indexed policyCommitment, address indexed owner, uint256 minTroveICR);
    event PolicyFunded(bytes32 indexed policyId, address indexed from, uint256 amount);
    event TroveGuardSet(bytes32 indexed policyId, uint256 minTroveICR);
    event PaymentReleased(
        bytes32 indexed policyId, uint256 amountCents, bytes32 indexed merchantIdHash, bytes32 indexed nonce, address recipient, uint256 troveICR
    );
    event SpendCommitted(bytes32 indexed policyId, uint64 indexed epoch, bytes32 commit);
    event PolicyWithdrawn(bytes32 indexed policyId, address indexed owner, address indexed to, uint256 amount);

    error TroveNotActive(address owner);
    error TroveBelowLeash(address owner, uint256 icr, uint256 minICR);

    constructor(address _verifier, address _musd, address _troveManager, address _priceFeed) {
        require(_verifier != address(0) && _musd != address(0), "Invalid address");
        require(_troveManager != address(0) && _priceFeed != address(0), "Invalid address");
        verifier = IVerifier(_verifier);
        musd = IERC20Min(_musd);
        troveManager = IMezoTroveManager(_troveManager);
        priceFeed = IMezoPriceFeed(_priceFeed);
    }

    function policyIdOf(address owner, bytes32 policyCommitment) public pure returns (bytes32) {
        return keccak256(abi.encode(owner, policyCommitment));
    }

    /// @notice Register msg.sender's policy, pull `depositWei` MUSD into its escrow (approve first), and set
    /// the trove guard (`minICR` 0 disables it; otherwise it must be at least Mezo's 110% MCR).
    function registerPolicy(bytes32 policyCommitment, uint256 depositWei, uint256 minICR) external returns (bytes32 policyId) {
        require(policyCommitment != bytes32(0), "Invalid policy commitment");
        require(minICR == 0 || minICR >= 1.1e18, "Guard below Mezo MCR");
        policyId = policyIdOf(msg.sender, policyCommitment);
        require(policyOwner[policyId] == address(0), "Policy already registered");
        policyOwner[policyId] = msg.sender;
        minTroveICR[policyId] = minICR;
        emit PolicyRegistered(policyId, policyCommitment, msg.sender, minICR);
        if (depositWei > 0) _pull(policyId, depositWei);
    }

    /// @notice Owner-only top-up of msg.sender's policy escrow (approve first).
    function deposit(bytes32 policyCommitment, uint256 amountWei) external {
        bytes32 policyId = policyIdOf(msg.sender, policyCommitment);
        require(policyOwner[policyId] == msg.sender, "Not policy owner");
        _pull(policyId, amountWei);
    }

    /// @notice Owner-only change of the trove guard floor.
    function setTroveGuard(bytes32 policyCommitment, uint256 minICR) external {
        bytes32 policyId = policyIdOf(msg.sender, policyCommitment);
        require(policyOwner[policyId] == msg.sender, "Not policy owner");
        require(minICR == 0 || minICR >= 1.1e18, "Guard below Mezo MCR");
        minTroveICR[policyId] = minICR;
        emit TroveGuardSet(policyId, minICR);
    }

    /// @notice The owner's trove as the guard sees it: status, ICR at the live price, and the price.
    function troveHealth(address owner) public view returns (uint8 status, uint256 icr, uint256 price) {
        price = priceFeed.fetchPrice();
        status = troveManager.getTroveStatus(owner);
        icr = status == TROVE_ACTIVE ? troveManager.getCurrentICR(owner, price) : 0;
    }

    /**
     * @notice Pays `amountCents` of MUSD from the owner's policy escrow to `recipient`, if the proof shows the
     * payment fits the committed policy and the owner's trove clears the guard. Anyone may relay.
     */
    function executePayment(
        address owner,
        bytes32 policyCommitment,
        uint256 amountCents,
        bytes32 merchantIdHash,
        bytes32 nonce,
        address recipient,
        SpendUpdate calldata spend,
        bytes calldata proof
    ) external {
        bytes32 policyId = policyIdOf(owner, policyCommitment);
        require(policyOwner[policyId] != address(0), "Policy not registered");
        require(!usedNonces[policyId][nonce], "Nonce already used");
        require(recipient != address(0), "Invalid recipient");
        _checkSpend(policyId, spend);
        uint256 icr = _checkTrove(policyId, owner);

        bytes32[] memory publicInputs = new bytes32[](8);
        publicInputs[0] = policyCommitment;
        publicInputs[1] = bytes32(amountCents);
        publicInputs[2] = merchantIdHash;
        publicInputs[3] = nonce;
        publicInputs[4] = bytes32(uint256(uint160(recipient)));
        publicInputs[5] = bytes32(uint256(spend.epoch));
        publicInputs[6] = spend.prevCommit;
        publicInputs[7] = spend.newCommit;
        require(verifier.verify(proof, publicInputs), "Invalid ZK proof");

        uint256 amountWei = amountCents * CENT;
        require(policyBalance[policyId] >= amountWei, "Insufficient policy balance");
        usedNonces[policyId][nonce] = true;
        spendCommit[policyId] = spend.newCommit;
        spendEpoch[policyId] = spend.epoch;
        policyBalance[policyId] -= amountWei;
        emit SpendCommitted(policyId, spend.epoch, spend.newCommit);

        require(musd.transfer(recipient, amountWei), "MUSD transfer failed");
        emit PaymentReleased(policyId, amountCents, merchantIdHash, nonce, recipient, icr);
    }

    /// @notice Owner-only withdrawal from msg.sender's policy escrow.
    function withdraw(bytes32 policyCommitment, uint256 amountWei, address to) external {
        bytes32 policyId = policyIdOf(msg.sender, policyCommitment);
        require(policyOwner[policyId] == msg.sender, "Not policy owner");
        require(to != address(0), "Invalid recipient");
        require(policyBalance[policyId] >= amountWei, "Insufficient policy balance");
        policyBalance[policyId] -= amountWei;
        require(musd.transfer(to, amountWei), "MUSD transfer failed");
        emit PolicyWithdrawn(policyId, msg.sender, to, amountWei);
    }

    function _pull(bytes32 policyId, uint256 amountWei) internal {
        require(amountWei > 0, "Zero deposit");
        policyBalance[policyId] += amountWei;
        require(musd.transferFrom(msg.sender, address(this), amountWei), "MUSD transferFrom failed");
        emit PolicyFunded(policyId, msg.sender, amountWei);
    }

    /// @dev Same rolling-cap rule as LeashPayment: proofs are for today and open the current commitment.
    function _checkSpend(bytes32 policyId, SpendUpdate calldata spend) internal view {
        require(spend.epoch == block.timestamp / 1 days, "Wrong epoch");
        if (spendEpoch[policyId] == spend.epoch && spendCommit[policyId] != bytes32(0)) {
            require(spend.prevCommit == spendCommit[policyId], "Stale spend commitment");
        } else {
            require(spend.prevCommit == bytes32(0), "New epoch must start from zero");
        }
    }

    /// @dev Returns the trove ICR used for the payment (0 when the guard is off).
    function _checkTrove(bytes32 policyId, address owner) internal view returns (uint256 icr) {
        uint256 floor = minTroveICR[policyId];
        if (floor == 0) return 0;
        uint8 status;
        (status, icr, ) = troveHealth(owner);
        if (status != TROVE_ACTIVE) revert TroveNotActive(owner);
        if (icr < floor) revert TroveBelowLeash(owner, icr, floor);
    }
}
