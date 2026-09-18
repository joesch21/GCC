const { execFileSync } = require("node:child_process");

const OWNER = "joesch21";
const REPO = "GCC";
const API_ROOT = "https://api.github.com";

function githubError(message, retryable = false) {
  const error = new Error(message);
  error.code = "GENESIS_INTAKE_GITHUB_API_FAILED";
  error.retryable = retryable;
  return error;
}

function resolveToken() {
  const direct = process.env.GITHUB_TOKEN || process.env.GH_TOKEN;
  if (direct && direct.trim()) return direct.trim();

  try {
    return execFileSync("gh", ["auth", "token"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch (_error) {
    return null;
  }
}

async function request(method, endpoint, body) {
  const token = resolveToken();
  const headers = {
    Accept: "application/vnd.github+json",
    "User-Agent": "gcc-genesis-intake/1.0",
    "X-GitHub-Api-Version": "2022-11-28",
  };
  if (token) headers.Authorization = "Bearer " + token;
  if (body !== undefined) headers["Content-Type"] = "application/json";

  let response;
  try {
    response = await fetch(API_ROOT + endpoint, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch (_error) {
    throw githubError("GitHub API network request failed", true);
  }

  if (!response.ok) {
    const retryable = response.status >= 500 || response.status === 429;
    throw githubError(
      "GitHub API returned HTTP " + response.status + " for " + endpoint,
      retryable
    );
  }
  if (response.status === 204) return null;
  return response.json();
}

async function listGenesisIssues() {
  const issues = await request(
    "GET",
    "/repos/" +
      OWNER +
      "/" +
      REPO +
      "/issues?state=open&sort=created&direction=asc&per_page=100"
  );
  return issues
    .filter(
      (issue) =>
        !issue.pull_request &&
        String(issue.title || "").startsWith("[GCC-GENESIS-001]")
    )
    .sort((a, b) => {
      const time = Date.parse(a.created_at) - Date.parse(b.created_at);
      return time || a.number - b.number;
    });
}

async function getIssue(number) {
  return request(
    "GET",
    "/repos/" + OWNER + "/" + REPO + "/issues/" + Number(number)
  );
}

async function getIssueComments(number) {
  return request(
    "GET",
    "/repos/" +
      OWNER +
      "/" +
      REPO +
      "/issues/" +
      Number(number) +
      "/comments?per_page=100"
  );
}

async function postIssueComment(number, body) {
  if (!resolveToken()) {
    throw githubError(
      "GitHub authentication is required to post intake comments"
    );
  }
  return request(
    "POST",
    "/repos/" +
      OWNER +
      "/" +
      REPO +
      "/issues/" +
      Number(number) +
      "/comments",
    { body }
  );
}

module.exports = {
  getIssue,
  getIssueComments,
  listGenesisIssues,
  postIssueComment,
  resolveToken,
};
