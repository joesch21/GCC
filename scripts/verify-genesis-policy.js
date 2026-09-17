const fs = require("fs");
const { keccak256, toUtf8Bytes } = require("ethers");

function canonical(value) {
  if (Array.isArray(value)) return "[" + value.map(canonical).join(",") + "]";
  if (value && typeof value === "object") {
    const keys = Object.keys(value).sort();
    return "{" + keys.map((key) => JSON.stringify(key) + ":" + canonical(value[key])).join(",") + "}";
  }
  return JSON.stringify(value);
}

const policyPath = "policies/GCC-GENESIS-001.verifier-policy.json";
const hashPath = "policies/GCC-GENESIS-001.verifier-policy.keccak256";
const parsed = JSON.parse(fs.readFileSync(policyPath, "utf8"));
const actual = keccak256(toUtf8Bytes(canonical(parsed))).toLowerCase();
const expected = fs.readFileSync(hashPath, "utf8").trim().toLowerCase();

if (actual !== expected) {
  console.error(`Genesis verifier policy hash mismatch\nexpected: ${expected}\nactual:   ${actual}`);
  process.exit(1);
}

console.log(actual);
