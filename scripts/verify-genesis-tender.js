const fs = require("fs");
const { keccak256, toUtf8Bytes } = require("ethers");

function canonical(value) {
  if (Array.isArray(value)) {
    return `[${value.map(canonical).join(",")}]`;
  }
  if (value && typeof value === "object") {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

const tenderPath = "tenders/GCC-GENESIS-001.json";
const hashPath = "tenders/GCC-GENESIS-001.keccak256";
const parsed = JSON.parse(fs.readFileSync(tenderPath, "utf8"));
const actual = keccak256(toUtf8Bytes(canonical(parsed))).toLowerCase();
const expected = fs.readFileSync(hashPath, "utf8").trim().toLowerCase();

if (actual !== expected) {
  console.error(`Genesis tender hash mismatch\nexpected: ${expected}\nactual:   ${actual}`);
  process.exit(1);
}

console.log(actual);
