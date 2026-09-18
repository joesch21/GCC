const hre = require("hardhat");
const fs = require("fs");
const path = require("path");

const RECORD_PATH = path.resolve(
  __dirname,
  "../deployments/GCC-GENESIS-001-bsc-mainnet.json"
);

function fail(message) {
  const error = new Error(message);
  error.code = "GENESIS_MAINNET_LOCAL_VERIFICATION_FAILED";
  throw error;
}

function maskImmutableBytes(hexCode, immutableReferences) {
  const raw = hexCode.startsWith("0x") ? hexCode.slice(2) : hexCode;
  const bytes = Buffer.from(raw, "hex");

  for (const refs of Object.values(immutableReferences || {})) {
    for (const ref of refs) {
      bytes.fill(0, ref.start, ref.start + ref.length);
    }
  }

  return bytes.toString("hex");
}

async function verifyRuntimeBytecode(fqn, address) {
  const buildInfo = await hre.artifacts.getBuildInfo(fqn);
  if (!buildInfo) fail(`No Hardhat build info found for ${fqn}`);

  const [sourceName, contractName] = fqn.split(":");
  const deployed = buildInfo.output.contracts[sourceName][contractName].evm.deployedBytecode;
  const compiled = deployed.object;
  const onchain = await hre.ethers.provider.getCode(address);

  if (onchain === "0x") fail(`No contract code at ${address}`);

  const compiledRaw = compiled.startsWith("0x") ? compiled.slice(2) : compiled;
  const onchainRaw = onchain.slice(2);

  if (compiledRaw.length !== onchainRaw.length) {
    fail(
      `${contractName} runtime bytecode length mismatch: compiled=${compiledRaw.length / 2}, onchain=${onchainRaw.length / 2}`
    );
  }

  const compiledMasked = maskImmutableBytes(
    compiledRaw,
    deployed.immutableReferences
  );
  const onchainMasked = maskImmutableBytes(
    onchainRaw,
    deployed.immutableReferences
  );

  if (compiledMasked !== onchainMasked) {
    fail(`${contractName} runtime bytecode does not match local compiled source`);
  }

  return {
    contract: contractName,
    address,
    codeBytes: onchainRaw.length / 2,
    immutableRanges: Object.values(deployed.immutableReferences || {}).flat().length,
    runtimeBytecodeMatch: true,
  };
}

function sameAddress(a, b) {
  return a.toLowerCase() === b.toLowerCase();
}

async function main() {
  const record = JSON.parse(fs.readFileSync(RECORD_PATH, "utf8"));
  const network = await hre.ethers.provider.getNetwork();
  if (network.chainId !== 56n) {
    fail(`Expected BSC mainnet chain 56, got ${network.chainId}`);
  }

  const authorityArtifact = await hre.artifacts.readArtifact(
    "GenesisVerifierAuthority"
  );
  const escrowArtifact = await hre.artifacts.readArtifact(
    "GenesisDeliverableEscrow"
  );

  const authorityCode = await verifyRuntimeBytecode(
    "contracts/GenesisVerifierAuthority.sol:GenesisVerifierAuthority",
    record.authority.address
  );
  const escrowCode = await verifyRuntimeBytecode(
    "contracts/GenesisDeliverableEscrow.sol:GenesisDeliverableEscrow",
    record.escrow.address
  );

  const authority = new hre.ethers.Contract(
    record.authority.address,
    authorityArtifact.abi,
    hre.ethers.provider
  );

  const [policyHash, verifierSetHash, verifiers, threshold] = await Promise.all([
    authority.policyHash(),
    authority.verifierSetHash(),
    authority.verifiers(),
    authority.THRESHOLD(),
  ]);

  if (policyHash.toLowerCase() !== record.hashes.policy.toLowerCase()) {
    fail("Authority policyHash does not match deployment record");
  }
  if (threshold !== BigInt(record.verifiers.threshold)) {
    fail("Authority threshold does not match deployment record");
  }

  const expectedVerifiers = [
    record.verifiers.A,
    record.verifiers.B,
    record.verifiers.C,
  ];
  for (let i = 0; i < 3; i += 1) {
    if (!sameAddress(verifiers[i], expectedVerifiers[i])) {
      fail(`Authority verifier ${i} does not match deployment record`);
    }
  }

  const expectedVerifierSetHash = hre.ethers.keccak256(
    hre.ethers.AbiCoder.defaultAbiCoder().encode(
      ["bytes32", "uint256", "address", "address", "address"],
      [
        record.hashes.policy,
        BigInt(record.verifiers.threshold),
        record.verifiers.A,
        record.verifiers.B,
        record.verifiers.C,
      ]
    )
  );
  if (verifierSetHash.toLowerCase() !== expectedVerifierSetHash.toLowerCase()) {
    fail("Authority verifierSetHash does not match the recorded immutable set");
  }

  const escrow = new hre.ethers.Contract(
    record.escrow.address,
    escrowArtifact.abi,
    hre.ethers.provider
  );
  const qualified = await escrow.QUALIFIED_PROPOSAL();
  const finalist = await escrow.FINALIST();
  const selected = await escrow.SELECTED_COMPONENT();

  const [
    gcc,
    verifier,
    tenderHash,
    settlementDeadline,
    rewardCap,
    qualifiedRule,
    finalistRule,
    selectedRule,
  ] = await Promise.all([
    escrow.gcc(),
    escrow.verifier(),
    escrow.tenderHash(),
    escrow.settlementDeadline(),
    escrow.rewardCap(),
    escrow.rewardRule(qualified),
    escrow.rewardRule(finalist),
    escrow.rewardRule(selected),
  ]);

  if (!sameAddress(gcc, record.gccToken)) fail("Escrow GCC token mismatch");
  if (!sameAddress(verifier, record.authority.address)) {
    fail("Escrow verifier authority mismatch");
  }
  if (tenderHash.toLowerCase() !== record.hashes.tender.toLowerCase()) {
    fail("Escrow tender hash mismatch");
  }
  if (settlementDeadline !== BigInt(record.escrow.settlementDeadlineUnix)) {
    fail("Escrow settlement deadline mismatch");
  }
  if (rewardCap !== BigInt(record.escrow.rewardCapRaw)) {
    fail("Escrow reward cap mismatch");
  }

  const tenGcc = hre.ethers.parseUnits("10", 18);
  if (
    qualifiedRule[0] !== tenGcc ||
    qualifiedRule[1] !== 10n ||
    qualifiedRule[2] !== 0n
  ) {
    fail("QUALIFIED_PROPOSAL reward rule mismatch");
  }
  if (finalistRule[0] !== 0n || finalistRule[1] !== 0n || finalistRule[2] !== 0n) {
    fail("FINALIST must remain disabled");
  }
  if (selectedRule[0] !== 0n || selectedRule[1] !== 0n || selectedRule[2] !== 0n) {
    fail("SELECTED_COMPONENT must remain disabled");
  }

  const [authorityReceipt, escrowReceipt] = await Promise.all([
    hre.ethers.provider.getTransactionReceipt(record.authority.transactionHash),
    hre.ethers.provider.getTransactionReceipt(record.escrow.transactionHash),
  ]);
  if (!authorityReceipt || authorityReceipt.status !== 1) {
    fail("Authority deployment transaction is not successful");
  }
  if (!escrowReceipt || escrowReceipt.status !== 1) {
    fail("Escrow deployment transaction is not successful");
  }

  console.log(
    JSON.stringify(
      {
        status: "PASS",
        network: {
          name: "BNB Smart Chain Mainnet",
          chainId: 56,
        },
        authority: {
          ...authorityCode,
          deploymentTransactionStatus: "SUCCESS",
          policyHash,
          verifierSetHash,
          verifiers,
          threshold: threshold.toString(),
        },
        escrow: {
          ...escrowCode,
          deploymentTransactionStatus: "SUCCESS",
          gcc,
          verifier,
          tenderHash,
          settlementDeadline: settlementDeadline.toString(),
          rewardCapRaw: rewardCap.toString(),
          qualifiedProposal: {
            amountRaw: qualifiedRule[0].toString(),
            maxAwards: qualifiedRule[1].toString(),
            paidAwards: qualifiedRule[2].toString(),
          },
          finalistDisabled: true,
          selectedComponentDisabled: true,
        },
        conclusion:
          "Deployed runtime bytecode matches the locally compiled Solidity after masking compiler-declared immutable slots, and all Genesis I immutable/public bindings match the canonical deployment record.",
      },
      null,
      2
    )
  );
}

main().catch((error) => {
  console.error(error.message || error);
  process.exitCode = 1;
});
