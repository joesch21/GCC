const readline = require("node:readline");
const { spawnSync } = require("node:child_process");

function setEcho(enabled) {
  if (process.platform === "win32") {
    throw new Error("Hidden password prompting is currently supported on Unix-like terminals only.");
  }
  const result = spawnSync("stty", [enabled ? "echo" : "-echo"], {
    stdio: ["inherit", "ignore", "inherit"],
  });
  if (result.status !== 0) {
    throw new Error("Unable to change terminal echo state.");
  }
}

async function promptHidden(prompt) {
  if (!process.stdin.isTTY || !process.stderr.isTTY) {
    throw new Error("A local interactive terminal is required for password entry.");
  }

  process.stderr.write(prompt);
  setEcho(false);
  const rl = readline.createInterface({
    input: process.stdin,
    terminal: false,
  });

  try {
    const answer = await new Promise((resolve, reject) => {
      rl.once("line", resolve);
      rl.once("error", reject);
    });
    return String(answer);
  } finally {
    rl.close();
    setEcho(true);
    process.stderr.write("\n");
  }
}

module.exports = { promptHidden };
