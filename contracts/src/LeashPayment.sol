// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

import "./LeashVerifier.sol";

/**
 * @title LeashPayment
 * @notice On-chain verifier & payment executor for LEASH stateless ZK spending policies.
 * Ensures an AI agent or delegator cannot move funds unless a valid ZK proof
 * demonstrates the payment complies with the committed spending rules (merchant allowlist with each
 * merchant's bound payee, max_per_tx, and a rolling daily cap), without ever exposing the merchant
 * list or the caps on-chain.
 */
contract LeashPayment {
    IVerifier public immutable verifier;

    // Policies are keyed by policyId = keccak256(abi.encode(owner, commitment)), not by the bare
    // commitment. A commitment is public once broadcast, so keying by commitment let anyone copy a
    // victim's commitment from the mempool, register it first, become its owner and withdraw what the
    // victim later deposited. Now a copier only creates their own separate, empty policy.
    mapping(bytes32 => bool) public registeredPolicies; // policyId => registered
    // Nonces are scoped per policy so another policy cannot burn ours.
    mapping(bytes32 => mapping(bytes32 => bool)) public usedNonces; // policyId => nonce => used
    // Escrow is per policy: a policy can only spend what was deposited for that policy.
    mapping(bytes32 => uint256) public policyBalance; // policyId => wei
    mapping(bytes32 => address) public policyOwner; // policyId => owner
    // Rolling daily cap: the latest hiding commitment to today's spent total, per policy. A proof must
    // open exactly this commitment (prev), so two proofs built on the same prev can't both land.
    mapping(bytes32 => bytes32) public spendCommit; // policyId => H(spent, epoch, spend_salt)
    mapping(bytes32 => uint64) public spendEpoch; // policyId => UTC day of spendCommit

    /// @notice Rolling-cap update carried by a payment: today's epoch, the commitment it opens, the new one.
    struct SpendUpdate {
        uint64 epoch; // block.timestamp / 1 days
        bytes32 prevCommit; // must equal spendCommit[policyId], or 0 for the first payment of an epoch
        bytes32 newCommit; // H(spent_before + amount, epoch, spend_salt), computed by the circuit
    }

    event PolicyRegistered(bytes32 indexed policyId, bytes32 indexed policyCommitment, address indexed owner);
    event PolicyFunded(bytes32 indexed policyId, address indexed from, uint256 amount);
    event PaymentReleased(
        bytes32 indexed policyId,
        uint256 amount,
        bytes32 indexed merchantIdHash,
        bytes32 indexed nonce,
        address recipient
    );
    event SpendCommitted(bytes32 indexed policyId, uint64 indexed epoch, bytes32 commit);
    event PolicyWithdrawn(bytes32 indexed policyId, address indexed owner, address indexed to, uint256 amount);

    constructor(address _verifier) {
        require(_verifier != address(0), "Invalid verifier address");
        verifier = IVerifier(_verifier);
    }

    function policyIdOf(address owner, bytes32 policyCommitment) public pure returns (bytes32) {
        return keccak256(abi.encode(owner, policyCommitment));
    }

    /**
     * @notice Register a policy commitment for msg.sender, optionally funding its escrow in the same call.
     * @param policyCommitment Pedersen commitment of (merkle_root, max_per_tx, policy_salt)
     */
    function registerPolicy(bytes32 policyCommitment) external payable returns (bytes32 policyId) {
        require(policyCommitment != bytes32(0), "Invalid policy commitment");
        policyId = policyIdOf(msg.sender, policyCommitment);
        require(!registeredPolicies[policyId], "Policy already registered");
        registeredPolicies[policyId] = true;
        policyOwner[policyId] = msg.sender;
        emit PolicyRegistered(policyId, policyCommitment, msg.sender);
        if (msg.value > 0) {
            policyBalance[policyId] += msg.value;
            emit PolicyFunded(policyId, msg.sender, msg.value);
        }
    }

    /// @notice Owner-only deposit into msg.sender's policy for `policyCommitment`.
    function deposit(bytes32 policyCommitment) external payable {
        bytes32 policyId = policyIdOf(msg.sender, policyCommitment);
        require(policyOwner[policyId] == msg.sender, "Not policy owner");
        policyBalance[policyId] += msg.value;
        emit PolicyFunded(policyId, msg.sender, msg.value);
    }

    /**
     * @notice Releases payment to a merchant recipient upon verifying a valid ZK proof.
     * @param owner Owner of the policy (anyone may relay; funds come from owner's policy escrow)
     * @param policyCommitment Commitment to the policy governing this payment
     * @param amount Amount in smallest units (e.g. cents or wei)
     * @param merchantIdHash Pedersen hash of merchant ID
     * @param nonce Unique payment nonce to prevent replay attacks
     * @param recipient Merchant destination address; must equal the payee bound in the proof (and,
     *        through the allowlist leaf, the payee the owner listed for that merchant)
     * @param spend Rolling daily cap update (epoch, previous and new spend commitments)
     * @param proof UltraHonk ZK proof generated by Noir / bb
     */
    function executePayment(
        address owner,
        bytes32 policyCommitment,
        uint256 amount,
        bytes32 merchantIdHash,
        bytes32 nonce,
        address payable recipient,
        SpendUpdate calldata spend,
        bytes calldata proof
    ) external payable {
        bytes32 policyId = policyIdOf(owner, policyCommitment);
        require(registeredPolicies[policyId], "Policy not registered");
        require(!usedNonces[policyId][nonce], "Nonce already used");
        require(recipient != address(0), "Invalid recipient");
        _checkSpend(policyId, spend);

        // Public inputs in the circuit's order. The payee address fills the proven recipient slot,
        // so the proof only verifies if recipient == proven recipient.
        bytes32[] memory publicInputs = new bytes32[](8);
        publicInputs[0] = policyCommitment;
        publicInputs[1] = bytes32(amount);
        publicInputs[2] = merchantIdHash;
        publicInputs[3] = nonce;
        publicInputs[4] = bytes32(uint256(uint160(address(recipient))));
        publicInputs[5] = bytes32(uint256(spend.epoch));
        publicInputs[6] = spend.prevCommit;
        publicInputs[7] = spend.newCommit;

        bool verified = verifier.verify(proof, publicInputs);
        require(verified, "Invalid ZK proof");

        usedNonces[policyId][nonce] = true;
        spendCommit[policyId] = spend.newCommit;
        spendEpoch[policyId] = spend.epoch;
        emit SpendCommitted(policyId, spend.epoch, spend.newCommit);

        // Release exactly the proven amount. Never emit PaymentReleased without moving funds.
        if (msg.value > 0) {
            require(msg.value == amount, "msg.value must equal proven amount");
        } else {
            require(policyBalance[policyId] >= amount, "Insufficient policy balance");
            policyBalance[policyId] -= amount;
        }
        (bool success, ) = recipient.call{value: amount}("");
        require(success, "Payment transfer failed");

        emit PaymentReleased(policyId, amount, merchantIdHash, nonce, recipient);
    }

    /// @dev The proof must be for today and must open the policy's current spend commitment.
    function _checkSpend(bytes32 policyId, SpendUpdate calldata spend) internal view {
        require(spend.epoch == block.timestamp / 1 days, "Wrong epoch");
        if (spendEpoch[policyId] == spend.epoch && spendCommit[policyId] != bytes32(0)) {
            require(spend.prevCommit == spendCommit[policyId], "Stale spend commitment");
        } else {
            // First payment of this epoch for the policy: the running total starts at zero.
            require(spend.prevCommit == bytes32(0), "New epoch must start from zero");
        }
    }

    /**
     * @notice Lets the policy owner reclaim escrow deposited for their policy (msg.sender's policy
     * for `policyCommitment`). Other policies' escrow, including copies of the same commitment
     * registered by other accounts, is untouched.
     */
    function withdraw(bytes32 policyCommitment, uint256 amount, address payable to) external {
        bytes32 policyId = policyIdOf(msg.sender, policyCommitment);
        require(policyOwner[policyId] == msg.sender, "Not policy owner");
        require(to != address(0), "Invalid recipient");
        require(policyBalance[policyId] >= amount, "Insufficient policy balance");
        policyBalance[policyId] -= amount; // effects before interaction
        (bool success, ) = to.call{value: amount}("");
        require(success, "Withdraw transfer failed");
        emit PolicyWithdrawn(policyId, msg.sender, to, amount);
    }
}
