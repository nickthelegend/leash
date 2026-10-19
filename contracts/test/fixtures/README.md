# Proof fixture (tests only)

`proof` and `public_inputs` are a real UltraHonk (EVM target) proof for the current circuit. Only
`test/LeashPaymentRealProof.t.sol` uses them. Public inputs: the policy commitment for (merkle_root of
merchant 42 with siblings 101/202/303/404, max_per_tx 500, salt 987654321), amount 300, the merchant
hash of 42, nonce 1, and recipient 0x1234567890123456789012345678901234567890.

Regenerate after any circuit change: run `nargo compile`, then `nargo execute` with those inputs in
Prover.toml, then `bb prove -b target/leash_circuit.json -w target/<witness>.gz -k target/vk_evm/vk -t evm -o out`.
Copy `out/proof` and `out/public_inputs` here. Also regenerate `src/LeashVerifier.sol` with
`bb write_solidity_verifier -k target/vk_evm/vk -t evm`.
