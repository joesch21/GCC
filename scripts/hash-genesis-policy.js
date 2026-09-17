const fs = require("fs");
const { keccak256, toUtf8Bytes } = require("ethers");

function canonical(value) {
  if (Array.isArray(value)) {
    return "[" + value.map(canonical).join(",") + "]";
  }
  if (value && typeof value === "object") {
    const keys = Object.keys(value).sort();
    return "{" + keys.map((key) => JSON.stringify(key) + ":" + canonical(value[key])).join(",") + "}";
  }
  return JSON.stringify(value);
}

const path = process.argv[2] || "policies/GCC-GENESIS-001.verifier-policy.json";
const parsed = JSON.parse(fs.readFileSync(path, "utf8"));
const bytes = toUtf8Bytes(canonical(parsed));
console.log(keccak256(bytes));
