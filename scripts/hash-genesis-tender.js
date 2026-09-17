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

const path = process.argv[2] || "tenders/GCC-GENESIS-001.json";
const parsed = JSON.parse(fs.readFileSync(path, "utf8"));
console.log(keccak256(toUtf8Bytes(canonical(parsed))));
