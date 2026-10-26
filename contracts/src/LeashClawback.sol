// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

import "./LeashVerifier.sol";

interface IERC20C {
    function transfer(address to, uint256 amount) external returns (bool);
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
}

/**
 * @title LeashClawback
 * @notice Pay-on-delivery for AI agents on Mezo. An agent pays a provider in MUSD only through a LEASH zero-knowledge
 * proof of its owner's hidden policy (payee allowlist, per-payment cap, rolling daily cap). The payment does not go to
 * the provider yet: it becomes a job held in escrow.
 *
 *  - The provider delivers before the deadline (a hash of the result, plus where to fetch it).
 *  - The owner accepts, or lets the dispute window pass, and the provider is paid.
 *  - If the provider never delivers, anyone can claw the job back after the deadline: the MUSD returns to the owner's
 *    policy escrow and part of the provider's MEZO bond goes to the owner.
 *  - If the owner disputes a delivery, the policy's arbiter decides: release, or claw back with the same slash.
 *
 * Providers must keep a MEZO bond to be paid through LEASH; it can't be withdrawn while they hold open jobs.
 * Amounts in proofs are cents (the circuit range-checks them to 64 bits); 1 cent = 1e16 MUSD wei.
 */
contract LeashClawback {
    uint256 public constant CENT = 1e16;
    uint64 public constant MAX_DELIVERY_WINDOW = 7 days;

    IVerifier public immutable verifier;
    IERC20C public immutable musd;
    IERC20C public immutable mezo;
    uint64 public immutable disputeWindow;
    uint256 public immutable minBond; // MEZO wei a provider must hold to take jobs
    uint256 public immutable slashAmount; // MEZO wei moved from the provider to the owner per clawed-back job

    // ---- policies (as in LeashPayment / LeashMUSD: policyId = keccak(owner, commitment), front-run safe) ----
    mapping(bytes32 => address) public policyOwner;
    mapping(bytes32 => address) public policyArbiter;
    mapping(bytes32 => mapping(bytes32 => bool)) public usedNonces;
    mapping(bytes32 => uint256) public policyBalance; // MUSD wei
    mapping(bytes32 => bytes32) public spendCommit;
    mapping(bytes32 => uint64) public spendEpoch;

    // ---- providers ----
    mapping(address => uint256) public bondOf; // MEZO wei
    mapping(address => uint256) public openJobs;

    // ---- jobs ----
    enum Status { None, Pending, Delivered, Disputed, Released, ClawedBack }

    struct Job {
        bytes32 policyId;
        address owner;
        address provider;
        uint96 amountCents;
        uint64 deadline; // delivery must land before this
        uint64 deliveredAt;
        Status status;
        bytes32 taskHash; // what was asked (the agent's request, hashed)
        bytes32 resultHash; // what was delivered
    }

    mapping(uint256 => Job) public jobs;
    uint256 public jobCount;

    struct SpendUpdate {
        uint64 epoch;
        bytes32 prevCommit;
        bytes32 newCommit;
    }

    event PolicyRegistered(bytes32 indexed policyId, bytes32 indexed policyCommitment, address indexed owner, address arbiter);
    event PolicyFunded(bytes32 indexed policyId, address indexed from, uint256 amount);
    event PolicyWithdrawn(bytes32 indexed policyId, address indexed owner, address indexed to, uint256 amount);
    event SpendCommitted(bytes32 indexed policyId, uint64 indexed epoch, bytes32 commit);
    event BondChanged(address indexed provider, uint256 bond);
    event JobOpened(uint256 indexed jobId, bytes32 indexed policyId, address indexed provider, uint256 amountCents, uint64 deadline, bytes32 taskHash);
    event JobDelivered(uint256 indexed jobId, bytes32 resultHash, string uri);
    event JobDisputed(uint256 indexed jobId, bytes32 reasonHash);
    event JobReleased(uint256 indexed jobId, address indexed provider, uint256 amountWei);
    event JobClawedBack(uint256 indexed jobId, address indexed owner, uint256 amountWei, uint256 slashedMezo);

    constructor(address _verifier, address _musd, address _mezo, uint64 _disputeWindow, uint256 _minBond, uint256 _slashAmount) {
        require(_verifier != address(0) && _musd != address(0) && _mezo != address(0), "Invalid address");
        require(_slashAmount <= _minBond, "Slash above bond");
        verifier = IVerifier(_verifier);
        musd = IERC20C(_musd);
        mezo = IERC20C(_mezo);
        disputeWindow = _disputeWindow;
        minBond = _minBond;
        slashAmount = _slashAmount;
    }

    function policyIdOf(address owner, bytes32 policyCommitment) public pure returns (bytes32) {
        return keccak256(abi.encode(owner, policyCommitment));
    }

    // ---------------------------------------------------------------- policies

    /// @notice Register msg.sender's policy with an arbiter for disputes, and pull `depositWei` MUSD (approve first).
    function registerPolicy(bytes32 policyCommitment, address arbiter, uint256 depositWei) external returns (bytes32 policyId) {
        require(policyCommitment != bytes32(0), "Invalid policy commitment");
        require(arbiter != address(0) && arbiter != msg.sender, "Arbiter must be a third party");
        policyId = policyIdOf(msg.sender, policyCommitment);
        require(policyOwner[policyId] == address(0), "Policy already registered");
        policyOwner[policyId] = msg.sender;
        policyArbiter[policyId] = arbiter;
        emit PolicyRegistered(policyId, policyCommitment, msg.sender, arbiter);
        if (depositWei > 0) _pullMusd(policyId, depositWei);
    }

    function deposit(bytes32 policyCommitment, uint256 amountWei) external {
        bytes32 policyId = policyIdOf(msg.sender, policyCommitment);
        require(policyOwner[policyId] == msg.sender, "Not policy owner");
        _pullMusd(policyId, amountWei);
    }

    function withdraw(bytes32 policyCommitment, uint256 amountWei, address to) external {
        bytes32 policyId = policyIdOf(msg.sender, policyCommitment);
        require(policyOwner[policyId] == msg.sender, "Not policy owner");
        require(to != address(0), "Invalid recipient");
        require(policyBalance[policyId] >= amountWei, "Insufficient policy balance");
        policyBalance[policyId] -= amountWei;
        require(musd.transfer(to, amountWei), "MUSD transfer failed");
        emit PolicyWithdrawn(policyId, msg.sender, to, amountWei);
    }

    // ---------------------------------------------------------------- providers

    function bond(uint256 amountWei) external {
        require(amountWei > 0, "Zero bond");
        bondOf[msg.sender] += amountWei;
        require(mezo.transferFrom(msg.sender, address(this), amountWei), "MEZO transferFrom failed");
        emit BondChanged(msg.sender, bondOf[msg.sender]);
    }

    function unbond(uint256 amountWei) external {
        require(openJobs[msg.sender] == 0, "Open jobs");
        require(bondOf[msg.sender] >= amountWei, "Insufficient bond");
        bondOf[msg.sender] -= amountWei;
        require(mezo.transfer(msg.sender, amountWei), "MEZO transfer failed");
        emit BondChanged(msg.sender, bondOf[msg.sender]);
    }

    // ---------------------------------------------------------------- jobs

    /// @notice What the agent asks for: the policy, the proven payment, the provider, and the task.
    struct JobRequest {
        address owner;
        bytes32 policyCommitment;
        uint256 amountCents;
        bytes32 merchantIdHash;
        bytes32 nonce;
        address provider; // the proof's recipient: the owner's allowlisted payee
        bytes32 taskHash; // the agent's request, hashed
        uint64 deliveryWindow; // seconds the provider has to deliver
    }

    /**
     * @notice The agent (or any relayer) opens a job: the proof shows the payment fits the owner's hidden policy and
     * names `r.provider` as the allowlisted payee. The MUSD leaves the policy escrow into the job, not to the provider.
     */
    function openJob(JobRequest calldata r, SpendUpdate calldata spend, bytes calldata proof) external returns (uint256 jobId) {
        bytes32 policyId = policyIdOf(r.owner, r.policyCommitment);
        require(policyOwner[policyId] != address(0), "Policy not registered");
        require(!usedNonces[policyId][r.nonce], "Nonce already used");
        require(r.provider != address(0), "Invalid provider");
        require(r.deliveryWindow > 0 && r.deliveryWindow <= MAX_DELIVERY_WINDOW, "Bad delivery window");
        require(bondOf[r.provider] >= minBond, "Provider not bonded");
        require(r.amountCents <= type(uint96).max, "Amount too large");
        _checkSpend(policyId, spend);
        _verify(r, spend, proof);

        uint256 amountWei = r.amountCents * CENT;
        require(policyBalance[policyId] >= amountWei, "Insufficient policy balance");
        usedNonces[policyId][r.nonce] = true;
        spendCommit[policyId] = spend.newCommit;
        spendEpoch[policyId] = spend.epoch;
        policyBalance[policyId] -= amountWei;
        emit SpendCommitted(policyId, spend.epoch, spend.newCommit);

        jobId = ++jobCount;
        uint64 deadline = uint64(block.timestamp) + r.deliveryWindow;
        jobs[jobId] = Job(policyId, r.owner, r.provider, uint96(r.amountCents), deadline, 0, Status.Pending, r.taskHash, bytes32(0));
        openJobs[r.provider] += 1;
        emit JobOpened(jobId, policyId, r.provider, r.amountCents, deadline, r.taskHash);
    }

    /// @notice The provider delivers before the deadline: a hash of the result and where the owner's agent can fetch it.
    function deliver(uint256 jobId, bytes32 resultHash, string calldata uri) external {
        Job storage j = jobs[jobId];
        require(j.status == Status.Pending, "Not pending");
        require(msg.sender == j.provider, "Not the provider");
        require(block.timestamp <= j.deadline, "Deadline passed");
        require(resultHash != bytes32(0), "Empty result");
        j.status = Status.Delivered;
        j.deliveredAt = uint64(block.timestamp);
        j.resultHash = resultHash;
        emit JobDelivered(jobId, resultHash, uri);
    }

    /// @notice The owner accepts a delivery early, paying the provider at once.
    function accept(uint256 jobId) external {
        Job storage j = jobs[jobId];
        require(j.status == Status.Delivered, "Not delivered");
        require(msg.sender == j.owner, "Not the owner");
        _release(jobId, j);
    }

    /// @notice Anyone releases a delivery nobody disputed within the window.
    function release(uint256 jobId) external {
        Job storage j = jobs[jobId];
        require(j.status == Status.Delivered, "Not delivered");
        require(block.timestamp > j.deliveredAt + disputeWindow, "Dispute window open");
        _release(jobId, j);
    }

    /// @notice Anyone claws back a job the provider never delivered: MUSD back to the owner's escrow, bond slashed.
    function clawback(uint256 jobId) external {
        Job storage j = jobs[jobId];
        require(j.status == Status.Pending, "Not pending");
        require(block.timestamp > j.deadline, "Deadline not passed");
        _clawback(jobId, j);
    }

    /// @notice The owner disputes a delivery within the window; the policy's arbiter will decide.
    function dispute(uint256 jobId, bytes32 reasonHash) external {
        Job storage j = jobs[jobId];
        require(j.status == Status.Delivered, "Not delivered");
        require(msg.sender == j.owner, "Not the owner");
        require(block.timestamp <= j.deliveredAt + disputeWindow, "Dispute window closed");
        j.status = Status.Disputed;
        emit JobDisputed(jobId, reasonHash);
    }

    /// @notice The policy's arbiter resolves a dispute: claw back (refund + slash) or release to the provider.
    function resolve(uint256 jobId, bool refundOwner) external {
        Job storage j = jobs[jobId];
        require(j.status == Status.Disputed, "Not disputed");
        require(msg.sender == policyArbiter[j.policyId], "Not the arbiter");
        if (refundOwner) _clawback(jobId, j);
        else _release(jobId, j);
    }

    // ---------------------------------------------------------------- internal

    function _release(uint256 jobId, Job storage j) internal {
        j.status = Status.Released;
        openJobs[j.provider] -= 1;
        uint256 amountWei = uint256(j.amountCents) * CENT;
        require(musd.transfer(j.provider, amountWei), "MUSD transfer failed");
        emit JobReleased(jobId, j.provider, amountWei);
    }

    function _clawback(uint256 jobId, Job storage j) internal {
        j.status = Status.ClawedBack;
        openJobs[j.provider] -= 1;
        uint256 amountWei = uint256(j.amountCents) * CENT;
        policyBalance[j.policyId] += amountWei; // the MUSD goes back to the owner's policy escrow
        uint256 slash = bondOf[j.provider] < slashAmount ? bondOf[j.provider] : slashAmount;
        bondOf[j.provider] -= slash;
        if (slash > 0) require(mezo.transfer(j.owner, slash), "MEZO transfer failed");
        emit BondChanged(j.provider, bondOf[j.provider]);
        emit JobClawedBack(jobId, j.owner, amountWei, slash);
    }

    function _pullMusd(bytes32 policyId, uint256 amountWei) internal {
        require(amountWei > 0, "Zero deposit");
        policyBalance[policyId] += amountWei;
        require(musd.transferFrom(msg.sender, address(this), amountWei), "MUSD transferFrom failed");
        emit PolicyFunded(policyId, msg.sender, amountWei);
    }

    function _checkSpend(bytes32 policyId, SpendUpdate calldata spend) internal view {
        require(spend.epoch == block.timestamp / 1 days, "Wrong epoch");
        if (spendEpoch[policyId] == spend.epoch && spendCommit[policyId] != bytes32(0)) {
            require(spend.prevCommit == spendCommit[policyId], "Stale spend commitment");
        } else {
            require(spend.prevCommit == bytes32(0), "New epoch must start from zero");
        }
    }

    function _verify(JobRequest calldata r, SpendUpdate calldata spend, bytes calldata proof) internal {
        bytes32[] memory publicInputs = new bytes32[](8);
        publicInputs[0] = r.policyCommitment;
        publicInputs[1] = bytes32(r.amountCents);
        publicInputs[2] = r.merchantIdHash;
        publicInputs[3] = r.nonce;
        publicInputs[4] = bytes32(uint256(uint160(r.provider)));
        publicInputs[5] = bytes32(uint256(spend.epoch));
        publicInputs[6] = spend.prevCommit;
        publicInputs[7] = spend.newCommit;
        require(verifier.verify(proof, publicInputs), "Invalid ZK proof");
    }
}
