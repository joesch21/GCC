const fs = require("fs");
const os = require("os");
const path = require("path");
const net = require("net");
const dns = require("dns").promises;
const { spawn } = require("node:child_process");
const { keccak256 } = require("ethers");
const {
  EXPECTED_OUTPUT,
  assertExpectedOutput,
  intakeError,
} = require("./submission");

const CANONICAL_DISCOVERY_URL =
  "https://www.goldcondor.info/.well-known/gcc-agent.json";
const MAX_ARTIFACT_BYTES = 512 * 1024;

function isPrivateIpv4(address) {
  const parts = address.split(".").map(Number);
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part))) {
    return false;
  }
  const a = parts[0];
  const b = parts[1];
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 100 && b >= 64 && b <= 127) ||
    a >= 224
  );
}

function isPrivateIp(address) {
  if (net.isIP(address) === 4) return isPrivateIpv4(address);
  if (net.isIP(address) !== 6) return false;
  const value = address.toLowerCase();
  return (
    value === "::1" ||
    value === "::" ||
    value.startsWith("fc") ||
    value.startsWith("fd") ||
    value.startsWith("fe8") ||
    value.startsWith("fe9") ||
    value.startsWith("fea") ||
    value.startsWith("feb") ||
    value.startsWith("::ffff:127.") ||
    value.startsWith("::ffff:10.") ||
    value.startsWith("::ffff:192.168.")
  );
}

async function assertPublicHttpsUrl(rawUrl) {
  let url;
  try {
    url = new URL(rawUrl);
  } catch (_error) {
    throw intakeError(
      "GENESIS_INTAKE_DELIVERABLE_URL_INVALID",
      "deliverable_url must be a valid HTTPS URL"
    );
  }
  if (url.protocol !== "https:") {
    throw intakeError(
      "GENESIS_INTAKE_DELIVERABLE_URL_INVALID",
      "deliverable_url must use HTTPS"
    );
  }
  if (url.username || url.password) {
    throw intakeError(
      "GENESIS_INTAKE_DELIVERABLE_URL_INVALID",
      "deliverable_url must not contain URL credentials"
    );
  }
  if (
    url.hostname.toLowerCase() === "localhost" ||
    url.hostname.endsWith(".localhost")
  ) {
    throw intakeError(
      "GENESIS_INTAKE_DELIVERABLE_URL_INVALID",
      "deliverable_url must resolve to a public host"
    );
  }
  const resolved = await dns.lookup(url.hostname, { all: true, verbatim: true });
  if (!resolved.length || resolved.some((entry) => isPrivateIp(entry.address))) {
    throw intakeError(
      "GENESIS_INTAKE_DELIVERABLE_URL_INVALID",
      "deliverable_url resolves to a private or reserved address"
    );
  }
  return url;
}

async function fetchArtifact(rawUrl, maxRedirects = 4) {
  let current = await assertPublicHttpsUrl(rawUrl);
  for (let redirect = 0; redirect <= maxRedirects; redirect += 1) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15000);
    let response;
    try {
      response = await fetch(current, {
        redirect: "manual",
        signal: controller.signal,
        headers: {
          "User-Agent": "gcc-genesis-intake/1.0",
          Accept: "application/octet-stream,text/plain,*/*",
        },
      });
    } catch (_error) {
      throw intakeError(
        "GENESIS_INTAKE_ARTIFACT_FETCH_FAILED",
        "Unable to fetch deliverable_url",
        true
      );
    } finally {
      clearTimeout(timeout);
    }

    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const location = response.headers.get("location");
      if (!location) {
        throw intakeError(
          "GENESIS_INTAKE_ARTIFACT_FETCH_FAILED",
          "deliverable_url redirect omitted Location"
        );
      }
      current = await assertPublicHttpsUrl(
        new URL(location, current).toString()
      );
      continue;
    }

    if (!response.ok) {
      throw intakeError(
        "GENESIS_INTAKE_ARTIFACT_FETCH_FAILED",
        "deliverable_url returned HTTP " + response.status,
        response.status >= 500
      );
    }

    const contentLength = Number(
      response.headers.get("content-length") || "0"
    );
    if (
      Number.isFinite(contentLength) &&
      contentLength > MAX_ARTIFACT_BYTES
    ) {
      throw intakeError(
        "GENESIS_INTAKE_ARTIFACT_TOO_LARGE",
        "Deliverable exceeds the intake byte limit"
      );
    }

    const bytes = Buffer.from(await response.arrayBuffer());
    if (bytes.length === 0 || bytes.length > MAX_ARTIFACT_BYTES) {
      throw intakeError(
        "GENESIS_INTAKE_ARTIFACT_TOO_LARGE",
        "Deliverable has an invalid byte length"
      );
    }
    return Object.freeze({
      bytes,
      finalUrl: current.toString(),
      hash: keccak256(bytes).toLowerCase(),
    });
  }

  throw intakeError(
    "GENESIS_INTAKE_ARTIFACT_FETCH_FAILED",
    "deliverable_url exceeded redirect limit"
  );
}

function dockerImageForRuntime(runtime) {
  const normalized = String(runtime || "").toLowerCase();
  if (normalized.includes("node") || normalized.includes("javascript")) {
    return "node:22-alpine";
  }
  if (normalized.includes("python")) {
    return "python:3.12-alpine";
  }
  if (
    normalized.includes("shell") ||
    normalized.includes("alpine") ||
    normalized === "sh"
  ) {
    return "alpine:3.20";
  }
  throw intakeError(
    "GENESIS_INTAKE_RUNTIME_UNSUPPORTED",
    "Supported Genesis I runtimes are Node/JavaScript, Python, and shell"
  );
}

function artifactFilename(url) {
  const raw = path.basename(new URL(url).pathname) || "deliverable";
  return raw.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 120) || "deliverable";
}

function extractJsonOutput(stdout) {
  const lines = String(stdout || "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    try {
      const parsed = JSON.parse(lines[index]);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        return parsed;
      }
    } catch (_error) {
    }
  }
  throw intakeError(
    "GENESIS_INTAKE_OUTPUT_INVALID",
    "Sandbox execution did not print a JSON object"
  );
}

async function runSandboxArtifact(options) {
  const bytes = options.bytes;
  const deliverableUrl = options.deliverableUrl;
  const image = dockerImageForRuntime(options.runtime);
  const network = options.network || "bridge";
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), "gcc-genesis-intake-")
  );
  fs.chmodSync(directory, 0o755);
  const filename = artifactFilename(deliverableUrl);
  fs.writeFileSync(path.join(directory, filename), bytes, { mode: 0o444 });

  const args = [
    "run",
    "--rm",
    "--read-only",
    "--network",
    network,
    "--memory",
    "256m",
    "--cpus",
    "1",
    "--pids-limit",
    "64",
    "--cap-drop",
    "ALL",
    "--security-opt",
    "no-new-privileges",
    "--user",
    "65534:65534",
    "--tmpfs",
    "/tmp:rw,nosuid,nodev,size=32m",
    "--add-host",
    "host.docker.internal:host-gateway",
    "-v",
    directory + ":/work:ro",
    "-w",
    "/work",
  ];
  if (options.discoveryOverride) {
    args.push("-e", "GCC_DISCOVERY_URL=" + options.discoveryOverride);
  }
  args.push(image, "/bin/sh", "-lc", options.runCommand);

  return new Promise((resolve, reject) => {
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let finished = false;

    const child = spawn("docker", args, {
      env: {
        PATH: process.env.PATH,
        HOME: process.env.HOME,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });

    const cleanup = () => {
      fs.rmSync(directory, { recursive: true, force: true });
    };

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, 45000);

    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString("utf8");
      if (stdout.length > 1024 * 1024) child.kill("SIGKILL");
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString("utf8");
      if (stderr.length > 1024 * 1024) child.kill("SIGKILL");
    });

    child.once("error", (error) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      cleanup();
      if (error.code === "ENOENT") {
        reject(
          intakeError(
            "GENESIS_INTAKE_DOCKER_UNAVAILABLE",
            "Docker is required for Genesis intake sandboxing"
          )
        );
        return;
      }
      reject(error);
    });

    child.once("close", (code, signal) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      cleanup();
      resolve(
        Object.freeze({
          status: code,
          signal,
          stdout,
          stderr,
          timedOut,
        })
      );
    });
  });
}
function sourceHasCanonicalDiscoveryReference(bytes) {
  return bytes.toString("utf8").includes(CANONICAL_DISCOVERY_URL);
}

function outputLooksLikeSecretRequest(value) {
  return /(private\s*key|seed\s*phrase|mnemonic|aws\s*credential|api\s*secret|enter\s+password)/i.test(
    String(value || "")
  );
}

async function verifyNetworkedAndOfflineRuns(options) {
  const networked = await runSandboxArtifact({
    bytes: options.bytes,
    deliverableUrl: options.deliverableUrl,
    runtime: options.runtime,
    runCommand: options.runCommand,
    network: "bridge",
    discoveryOverride: options.discoveryOverride || null,
  });
  if (networked.timedOut || networked.status !== 0) {
    throw intakeError(
      "GENESIS_INTAKE_SANDBOX_RUN_FAILED",
      "Networked sandbox run failed"
    );
  }
  if (
    outputLooksLikeSecretRequest(networked.stdout) ||
    outputLooksLikeSecretRequest(networked.stderr)
  ) {
    throw intakeError(
      "GENESIS_INTAKE_SECRET_REQUEST_DETECTED",
      "Sandbox output appears to request a secret"
    );
  }
  const networkedOutput = extractJsonOutput(networked.stdout);
  assertExpectedOutput(networkedOutput, "sandbox_output");

  const offline = await runSandboxArtifact({
    bytes: options.bytes,
    deliverableUrl: options.deliverableUrl,
    runtime: options.runtime,
    runCommand: options.runCommand,
    network: "none",
  });
  let offlinePass = false;
  if (!offline.timedOut && offline.status === 0) {
    try {
      const output = extractJsonOutput(offline.stdout);
      offlinePass =
        output.status === EXPECTED_OUTPUT.status &&
        output.tender_id === EXPECTED_OUTPUT.tender_id;
    } catch (_error) {
      offlinePass = false;
    }
  }
  if (offlinePass) {
    throw intakeError(
      "GENESIS_INTAKE_FAILURE_MODE_INVALID",
      "Client still reports PASS with networking disabled"
    );
  }

  return Object.freeze({
    networked,
    offline,
    networkedOutput,
  });
}

module.exports = {
  CANONICAL_DISCOVERY_URL,
  MAX_ARTIFACT_BYTES,
  assertPublicHttpsUrl,
  extractJsonOutput,
  fetchArtifact,
  runSandboxArtifact,
  sourceHasCanonicalDiscoveryReference,
  verifyNetworkedAndOfflineRuns,
};
