# Proof fixture (tests only)

`proof` and `public_inputs` are a real UltraHonk (EVM target) proof for the current circuit, generated
by `nargo` and `bb` from `circuits/Prover.toml`. `test/LeashPayment.t.sol` runs every test against the
bb-generated `HonkVerifier` with this proof and reads its public inputs from `public_inputs`.

Public inputs: the policy commitment for (merkle_root of merchant 42 with siblings 101/202/303/404,
max_per_tx 500, salt 987654321), amount 300, the merchant hash of 42, nonce 1, and recipient
0x1234567890123456789012345678901234567890.

Regenerate after any circuit change (it also rewrites `src/LeashVerifier.sol` and verifies the proof
natively with bb before copying it here):

    ./scripts/gen-proof-fixture.sh    # from the repo root, or: pnpm gen:fixture
