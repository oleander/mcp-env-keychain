#!/usr/bin/env node
import { appendFileSync } from "node:fs";
import { spawnSync } from "node:child_process";

const command = process.argv[2];
const maxBuffer = 10 * 1024 * 1024;

function info(message = "") {
  process.stdout.write(`${message}\n`);
}

function env(name) {
  return process.env[name] ?? "";
}

function requiredEnv(name) {
  const value = env(name);
  if (value === "") {
    fail(`${name} is required`);
  }
  return value;
}

function fail(message) {
  process.stderr.write(`::error::${message}\n`);
  process.exit(1);
}

function warning(message) {
  process.stderr.write(`::warning::${message}\n`);
}

function runGh(args) {
  const result = spawnSync("gh", args, {
    encoding: "utf8",
    maxBuffer,
  });

  if (result.status !== 0) {
    const detail = (result.stderr || result.stdout || "").trim();
    throw new Error(`gh ${args[0]} failed${detail ? `: ${detail}` : ""}`);
  }

  return result.stdout.trimEnd();
}

function writeOutputs(outputs) {
  const outputPath = requiredEnv("GITHUB_OUTPUT");

  for (const [name, rawValue] of Object.entries(outputs)) {
    const value = String(rawValue);
    let delimiter = `copilot_${name}_output`;
    while (value.includes(delimiter)) {
      delimiter += "_";
    }

    appendFileSync(outputPath, `${name}<<${delimiter}\n${value}\n${delimiter}\n`);
  }
}

function assertDigitsOnly(field, value) {
  if (!/^[0-9]+$/.test(value)) {
    fail(`${field} must be a positive integer (got: '${value}')`);
  }
}

function assertNoLeadingZero(field, value) {
  if (value.length > 1 && value.startsWith("0")) {
    fail(`${field} must not have leading zeros (got: '${value}')`);
  }
}

function assertSingleLine(field, value) {
  if (/[\r\n]/.test(value)) {
    fail(`${field} must be a single-line value`);
  }
}

function assertReviewUserType(value) {
  if (value !== "Bot" && value !== "User") {
    fail(`review_user_type must be Bot or User (got: '${value}')`);
  }
}

function normalizeLeadingZeros(value) {
  return value.replace(/^0+(?=\d)/, "");
}

function formatValue(value) {
  return JSON.stringify(value ?? "");
}

function parseJson(raw, fallback) {
  if (raw.trim() === "") {
    return fallback;
  }

  return JSON.parse(raw);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function validateToken() {
  if (env("HAS_COPILOT_REQUEST_PAT") !== "true") {
    info("COPILOT_REQUEST_PAT is required for this workflow.");
    info("GITHUB_TOKEN cannot request Copilot reviews via the GraphQL requestReviews mutation.");
    process.exit(1);
  }
}

function resolveEffectiveInputs() {
  const eventName = requiredEnv("EVENT_NAME");
  let prNumber;
  let prNodeId;
  let reviewUserType;
  let reviewUserId;
  let reviewUserLogin;

  if (eventName === "workflow_dispatch") {
    prNumber = env("INPUT_PR_NUMBER");
    reviewUserType = env("INPUT_REVIEW_USER_TYPE");
    reviewUserLogin = env("INPUT_REVIEW_USER_LOGIN");

    // Defense-in-depth: workflow_dispatch type:number rejects bad pr_number
    // client-side, and the choice type pins review_user_type to Bot/User —
    // but those are easily bypassed by a forked workflow_dispatch payload,
    // so re-validate every field here before anything touches GITHUB_OUTPUT
    // or a path interpolation.
    assertSingleLine("review_user_login", reviewUserLogin);
    assertReviewUserType(reviewUserType);
    assertDigitsOnly("pr_number", prNumber);
    assertNoLeadingZero("pr_number", prNumber);
    assertDigitsOnly("review_user_id", env("INPUT_REVIEW_USER_ID"));
    reviewUserId = normalizeLeadingZeros(env("INPUT_REVIEW_USER_ID"));

    prNodeId = runGh(["api", `repos/${requiredEnv("GH_REPO")}/pulls/${prNumber}`, "--jq", ".node_id"]);
  } else {
    prNumber = env("WEBHOOK_PR_NUMBER");
    prNodeId = env("WEBHOOK_PR_NODE_ID");
    reviewUserType = env("WEBHOOK_REVIEW_USER_TYPE");
    reviewUserId = env("WEBHOOK_REVIEW_USER_ID");
    reviewUserLogin = env("WEBHOOK_REVIEW_USER_LOGIN");
  }

  writeOutputs({
    pr_number: prNumber,
    pr_node_id: prNodeId,
    review_user_type: reviewUserType,
    review_user_id: reviewUserId,
    review_user_login: reviewUserLogin,
  });
}

function debugInputs() {
  const outReviewUserId = env("OUT_REVIEW_USER_ID");
  const outReviewUserType = env("OUT_REVIEW_USER_TYPE");
  const outReviewUserLogin = env("OUT_REVIEW_USER_LOGIN");
  const codeReviewerUserId = env("CODE_REVIEWER_USER_ID");

  info("=== raw webhook payload (pull_request_review only) ===");
  info(`  review.user.id          = ${formatValue(env("REVIEW_USER_ID"))}`);
  info(`  review.user.login       = ${formatValue(env("REVIEW_USER_LOGIN"))}`);
  info(`  review.user.type        = ${formatValue(env("REVIEW_USER_TYPE"))}`);
  info(`  review.user.node_id     = ${formatValue(env("REVIEW_USER_NODE_ID"))}`);
  info(`  review.state            = ${formatValue(env("REVIEW_STATE"))}`);
  info(`  review.id               = ${formatValue(env("REVIEW_ID"))}`);
  info(`  review.submitted_at     = ${formatValue(env("REVIEW_SUBMITTED_AT"))}`);
  info(`  review.author_assoc.    = ${formatValue(env("REVIEW_AUTHOR_ASSOCIATION"))}`);
  info(`  review.commit_id        = ${formatValue(env("REVIEW_COMMIT_ID"))}`);
  info(`  pull_request.number     = ${formatValue(env("PR_NUMBER_RAW"))}`);
  info(`  pull_request.node_id    = ${formatValue(env("PR_NODE_ID_RAW"))}`);
  info(`  pull_request.head.sha   = ${formatValue(env("PR_HEAD_SHA"))}`);
  info(`  pull_request.head.ref   = ${formatValue(env("PR_HEAD_REF"))}`);
  info(`  pull_request.draft      = ${formatValue(env("PR_DRAFT"))}`);
  info(`  pull_request.user.login = ${formatValue(env("PR_AUTHOR_LOGIN"))}`);
  info(`  github.actor            = ${formatValue(env("GH_ACTOR"))}`);
  info(`  github.triggering_actor = ${formatValue(env("GH_TRIGGERING_ACTOR"))}`);
  info(`  github.event_name       = ${formatValue(env("GH_EVENT_NAME"))}`);
  info(`  github.repository       = ${formatValue(env("GH_REPOSITORY"))}`);
  info(`  github.repository_owner = ${formatValue(env("GH_REPOSITORY_OWNER"))}`);
  info("");
  info("=== workflow_dispatch inputs (manual trigger only) ===");
  info(`  inputs.pr_number         = ${formatValue(env("INPUT_PR_NUMBER"))}`);
  info(`  inputs.review_user_type  = ${formatValue(env("INPUT_REVIEW_USER_TYPE"))}`);
  info(`  inputs.review_user_id    = ${formatValue(env("INPUT_REVIEW_USER_ID"))}`);
  info(`  inputs.review_user_login = ${formatValue(env("INPUT_REVIEW_USER_LOGIN"))}`);
  info("");
  info("=== resolver outputs - what step if-conditions read ===");
  info(`  steps.vars.outputs.pr_number         = ${formatValue(env("OUT_PR_NUMBER"))}`);
  info(`  steps.vars.outputs.pr_node_id        = ${formatValue(env("OUT_PR_NODE_ID"))}`);
  info(`  steps.vars.outputs.review_user_type  = ${formatValue(outReviewUserType)}`);
  info(`  steps.vars.outputs.review_user_id    = ${formatValue(outReviewUserId)}`);
  info(`  steps.vars.outputs.review_user_login = ${formatValue(outReviewUserLogin)}`);
  info("");
  info("=== env: constants that conditions compare against ===");
  info(`  env.CODE_REVIEWER_USER_ID = ${formatValue(codeReviewerUserId)}`);
  info(`  env.COPILOT_BOT_NODE_ID   = ${formatValue(env("COPILOT_BOT_NODE_ID"))}`);
  info(`  env.MAX_COPILOT_REVIEWS   = ${formatValue(env("MAX_COPILOT_REVIEWS"))}`);
  info("");
  info("=== derived booleans (mirrors step if-expressions) ===");
  info(`  outputs.review_user_id == CODE_REVIEWER_USER_ID    -> ${outReviewUserId === codeReviewerUserId}`);
  info(`  outputs.review_user_type == "Bot"                  -> ${outReviewUserType === "Bot"}`);
  info(
    `  outputs.review_user_login contains swe/cloud-agent -> ${
      outReviewUserLogin.includes("swe-agent") || outReviewUserLogin.includes("cloud-agent")
    }`,
  );
}

function resolveCloudAgentThreads() {
  info("Resolving review threads where cloud-agent replied...");

  const query = `
    query($owner: String!, $name: String!, $number: Int!) {
      repository(owner: $owner, name: $name) {
        pullRequest(number: $number) {
          reviewThreads(first: 100) {
            nodes {
              id
              isResolved
              comments(last: 1) {
                nodes {
                  author { login }
                  body
                  createdAt
                }
              }
            }
          }
        }
      }
    }
  `;

  const rawThreads = runGh([
    "api",
    "graphql",
    "-F",
    `owner=${requiredEnv("OWNER")}`,
    "-F",
    `name=${requiredEnv("REPO")}`,
    "-F",
    `number=${requiredEnv("PR_NUMBER")}`,
    "-f",
    `query=${query}`,
    "--jq",
    ".data.repository.pullRequest.reviewThreads.nodes",
  ]);
  const threads = parseJson(rawThreads, []);
  let count = 0;

  for (const thread of threads) {
    const threadId = thread.id;
    const isResolved = thread.isResolved === true;
    const author = thread.comments?.nodes?.[0]?.author?.login ?? "";
    const isCloudAgent = author.includes("swe-agent") || author.includes("cloud-agent");

    if (isCloudAgent && !isResolved) {
      info(`Resolving thread ${threadId}...`);
      runGh([
        "api",
        "graphql",
        "-F",
        `id=${threadId}`,
        "-f",
        "query=mutation($id: ID!) { resolveReviewThread(input: {threadId: $id}) { thread { id isResolved } } }",
      ]);
      count += 1;
    }
  }

  info(`Resolved ${count} thread(s).`);
}

function promptCloudAgent() {
  info("Code-reviewer submitted a review; prompting cloud-agent...");
  runGh([
    "pr",
    "comment",
    requiredEnv("PR_NUMBER"),
    "--repo",
    requiredEnv("GH_REPO"),
    "--body",
    "@copilot deal with ALL review comments",
  ]);
}

function countPriorCopilotReviewRequests() {
  const ghRepo = requiredEnv("GH_REPO");
  const prNumber = requiredEnv("PR_NUMBER");
  let count = 0;

  for (let page = 1; ; page += 1) {
    const rawPage = runGh(["api", `repos/${ghRepo}/issues/${prNumber}/timeline?per_page=100&page=${page}`]);
    const events = parseJson(rawPage, []);

    for (const event of events) {
      const login = String(event.requested_reviewer?.login ?? "").toLowerCase();
      if (event.event === "review_requested" && login === "copilot") {
        count += 1;
      }
    }

    if (!Array.isArray(events) || events.length < 100) {
      break;
    }
  }

  writeOutputs({ count });
  info(`Copilot has been requested ${count} time(s) (max: ${requiredEnv("MAX_COPILOT_REVIEWS")})`);
}

async function requestCopilotReview() {
  const prNodeId = requiredEnv("PR_NODE_ID");
  const botNodeId = requiredEnv("COPILOT_BOT_NODE_ID");
  const repoOwner = requiredEnv("REPO_OWNER");
  const repoName = requiredEnv("REPO_NAME");
  const prNumber = requiredEnv("PR_NUMBER");
  const mutation =
    "mutation($pr:ID!,$bot:ID!){requestReviews(input:{pullRequestId:$pr, botIds:[$bot]}){pullRequest{id}}}";
  const pendingQuery =
    "query($o:String!,$n:String!,$pr:Int!){repository(owner:$o,name:$n){pullRequest(number:$pr){reviewRequests(first:100){nodes{requestedReviewer{__typename ... on Bot{login}}}}}}}";

  info(`Requesting Copilot review for PR #${prNumber} (node ${prNodeId})...`);

  for (let attempt = 1; attempt <= 2; attempt += 1) {
    let response;
    try {
      response = runGh([
        "api",
        "graphql",
        "-f",
        `query=${mutation}`,
        "-f",
        `pr=${prNodeId}`,
        "-f",
        `bot=${botNodeId}`,
      ]);
    } catch (error) {
      fail(`GraphQL requestReviews failed (attempt ${attempt}): ${error.message}`);
    }

    info(`attempt ${attempt} mutation response: ${response}`);

    await sleep(15_000);
    const pendingResponse = parseJson(
      runGh([
        "api",
        "graphql",
        "-f",
        `query=${pendingQuery}`,
        "-f",
        `o=${repoOwner}`,
        "-f",
        `n=${repoName}`,
        "-F",
        `pr=${prNumber}`,
      ]),
      {},
    );
    const requests =
      pendingResponse.data?.repository?.pullRequest?.reviewRequests?.nodes?.map(
        (node) => node.requestedReviewer,
      ) ?? [];
    const pending = requests.filter((reviewer) => reviewer?.login === "copilot-pull-request-reviewer").length;

    if (pending > 0) {
      info(`Verified: Copilot is in reviewRequests (attempt ${attempt}).`);
      return;
    }

    warning(`Mutation succeeded but Copilot not in reviewRequests (attempt ${attempt}) - likely dedup window.`);
    if (attempt === 1) {
      info("Waiting 90s before retry...");
      await sleep(90_000);
    }
  }

  warning(
    "Copilot did not enter reviewRequests after 2 attempts (likely dedup window). Exiting 0; the next review submission will retry.",
  );
}

function postReviewLimitReached() {
  info(
    `Copilot review request limit (${requiredEnv(
      "MAX_COPILOT_REVIEWS",
    )}) reached. No further reviews will be requested automatically.`,
  );
}

const commands = {
  "validate-token": validateToken,
  "resolve-effective-inputs": resolveEffectiveInputs,
  "debug-inputs": debugInputs,
  "resolve-cloud-agent-threads": resolveCloudAgentThreads,
  "prompt-cloud-agent": promptCloudAgent,
  "count-prior-copilot-review-requests": countPriorCopilotReviewRequests,
  "request-copilot-review": requestCopilotReview,
  "post-review-limit-reached": postReviewLimitReached,
};

if (!command || !(command in commands)) {
  fail(`unknown command '${command ?? ""}'`);
}

await commands[command]();
