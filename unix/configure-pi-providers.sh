#!/usr/bin/env bash
set -euo pipefail

MODELS_PATH=""
AUTH_PATH=""
DEEPSEEK_BASE_URL_ARG=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --models-path) MODELS_PATH="${2:-}"; shift 2 ;;
    --auth-path) AUTH_PATH="${2:-}"; shift 2 ;;
    --deepseek-base-url) DEEPSEEK_BASE_URL_ARG="${2:-}"; shift 2 ;;
    *)
      echo "Unknown configure-pi-providers.sh option: $1" >&2
      exit 2
      ;;
  esac
done

PI_AGENT_DIR="${PI_CODING_AGENT_DIR:-$HOME/.pi/agent}"
if [[ -z "$MODELS_PATH" ]]; then
  MODELS_PATH="$PI_AGENT_DIR/models.json"
fi
if [[ -z "$AUTH_PATH" ]]; then
  AUTH_PATH="${DPI_AUTH_FILE:-$PI_AGENT_DIR/auth.json}"
fi

RESOLVED_DEEPSEEK_BASE="${DEEPSEEK_BASE_URL_ARG:-${DEEPSEEK_BASE_URL:-https://api.deepseek.com}}"

node - "$MODELS_PATH" "$AUTH_PATH" "$RESOLVED_DEEPSEEK_BASE" <<'NODE'
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");

const [, , modelsPath, authPath, rawDeepSeekBase] = process.argv;

function cleanUrl(raw, fallback, label) {
  const candidate = (raw || "").trim() || fallback;
  let parsed;
  try {
    parsed = new URL(candidate);
  } catch {
    throw new Error(`${label} must be a valid HTTP(S) URL.`);
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    throw new Error(`${label} must use http: or https:.`);
  }
  return candidate.replace(/\/+$/, "");
}

const deepseekBase = cleanUrl(rawDeepSeekBase, "https://api.deepseek.com", "DEEPSEEK_BASE_URL");
const dir = path.dirname(modelsPath);
fs.mkdirSync(dir, { recursive: true, mode: 0o700 });

let doc = {};
if (fs.existsSync(modelsPath)) {
  const raw = fs.readFileSync(modelsPath, "utf8").trim();
  if (raw) doc = JSON.parse(raw);
}
if (!doc.providers || typeof doc.providers !== "object" || Array.isArray(doc.providers)) {
  doc.providers = {};
}

const before = JSON.stringify(doc);

doc.providers.deepseek = {
  baseUrl: deepseekBase,
  api: "openai-completions",
  models: [
    {
      id: "deepseek-chat",
      name: "DeepSeek Chat",
      reasoning: false,
      input: ["text"],
      contextWindow: 128000,
      maxTokens: 8192,
    },
    {
      id: "deepseek-reasoner",
      name: "DeepSeek Reasoner",
      reasoning: true,
      input: ["text"],
      contextWindow: 128000,
      maxTokens: 64000,
    },
  ],
};

const after = JSON.stringify(doc);
let changed = false;
if (before !== after) {
  const tmp = path.join(dir, `.models.durable-pi.${crypto.randomUUID()}.tmp`);
  try {
    fs.writeFileSync(tmp, `${JSON.stringify(doc, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    fs.renameSync(tmp, modelsPath);
    changed = true;
  } finally {
    if (fs.existsSync(tmp)) fs.unlinkSync(tmp);
  }
}

const deepseekKey = (process.env.DEEPSEEK_API_KEY || "").trim();
if (deepseekKey && authPath) {
  const authDir = path.dirname(authPath);
  fs.mkdirSync(authDir, { recursive: true, mode: 0o700 });
  let authDoc = {};
  if (fs.existsSync(authPath)) {
    const rawAuth = fs.readFileSync(authPath, "utf8").trim();
    if (rawAuth) authDoc = JSON.parse(rawAuth);
  }
  const authBefore = JSON.stringify(authDoc);
  authDoc.deepseek = { type: "api_key", key: deepseekKey };
  const authAfter = JSON.stringify(authDoc);
  if (authBefore !== authAfter) {
    const tmpAuth = path.join(authDir, `.auth.durable-pi.${crypto.randomUUID()}.tmp`);
    try {
      fs.writeFileSync(tmpAuth, `${JSON.stringify(authDoc, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
      fs.renameSync(tmpAuth, authPath);
      changed = true;
    } finally {
      if (fs.existsSync(tmpAuth)) fs.unlinkSync(tmpAuth);
    }
  }
}

process.stdout.write(changed ? "true\n" : "false\n");
NODE
