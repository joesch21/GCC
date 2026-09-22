#!/usr/bin/env bash
set -euo pipefail

EXPECTED_SOURCE_SHA="${GG7_EXPECTED_SOURCE_SHA:-}"
SOURCE_ROOT="${GG7_SOURCE_ROOT:-$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)}"
TOWER_USER="${GG7_TOWER_USER:-joseph}"
SERVICE_USER="gcc-gg7-relay"
SOCKET_GROUP="tower-gg7"
RUNTIME_ROOT="/var/lib/gcc-gg7-relay"
RUNTIME_APP="$RUNTIME_ROOT/app"
CONFIG_ROOT="/etc/gcc/gg7"
CREDENTIAL_ROOT="/etc/gcc/credentials"
CREDENTIAL_FILE="$CREDENTIAL_ROOT/gg7-relayer-password"
KEYSTORE_SOURCE="${GENESIS_RELAYER_KEYSTORE:-/home/$TOWER_USER/.config/gcc/genesis-relayer.keystore.json}"
KEYSTORE_RUNTIME="$CONFIG_ROOT/genesis-relayer.keystore.json"
ENV_FILE="$CONFIG_ROOT/relay.env"
UNIT_SOURCE="$SOURCE_ROOT/systemd/gcc-gg7-grant-relayer.service"
UNIT_TARGET="/etc/systemd/system/gcc-gg7-grant-relayer.service"
EXPECTED_RELAYER="381c2939c943c52d9260b0c635d2fd7b17fb1c21"
GG6_ESCROW="0xca458394e8C3137cE4984bDac6E615d08E2482F6"
STAMP="$(date +%Y%m%d-%H%M%S)"
RECOVERY="/var/lib/tower-recovery/gg7-relay-activation-$STAMP"

fail() {
  echo "FAIL: $*" >&2
  exit 1
}

pass() {
  echo "$1=PASS"
}

[[ "$(id -u)" -eq 0 ]] || fail "run with sudo"
[[ -n "$EXPECTED_SOURCE_SHA" ]] || fail "GG7_EXPECTED_SOURCE_SHA is required"
[[ -d "$SOURCE_ROOT/.git" ]] || fail "GG7 source is not a Git worktree: $SOURCE_ROOT"
[[ "$(git -C "$SOURCE_ROOT" rev-parse HEAD)" == "$EXPECTED_SOURCE_SHA" ]] ||
  fail "source HEAD does not match reviewed GG7_EXPECTED_SOURCE_SHA"
[[ -z "$(git -C "$SOURCE_ROOT" status --porcelain)" ]] ||
  fail "source worktree must be clean"
[[ -f "$KEYSTORE_SOURCE" ]] || fail "Genesis relayer keystore missing: $KEYSTORE_SOURCE"
[[ -f "$UNIT_SOURCE" ]] || fail "systemd unit missing: $UNIT_SOURCE"
id "$TOWER_USER" >/dev/null 2>&1 || fail "Tower user missing: $TOWER_USER"
command -v node >/dev/null 2>&1 || fail "node is required"
command -v npm >/dev/null 2>&1 || fail "npm is required"
command -v curl >/dev/null 2>&1 || fail "curl is required"
command -v systemctl >/dev/null 2>&1 || fail "systemctl is required"

KEYSTORE_ADDRESS="$(node - "$KEYSTORE_SOURCE" <<'NODE'
const fs=require("fs");
const file=process.argv[2];
const j=JSON.parse(fs.readFileSync(file,"utf8"));
const raw=String(j.address||"").replace(/^0x/i,"").toLowerCase();
if(!/^[0-9a-f]{40}$/.test(raw)) process.exit(2);
process.stdout.write(raw);
NODE
)" || fail "could not read relayer address from keystore"

[[ "$KEYSTORE_ADDRESS" == "$EXPECTED_RELAYER" ]] ||
  fail "keystore is not the canonical existing Genesis relayer"

install -d -o root -g root -m 0700 "$RECOVERY"
for existing in "$UNIT_TARGET" "$ENV_FILE" "$KEYSTORE_RUNTIME" "$CREDENTIAL_FILE"; do
  if [[ -e "$existing" ]]; then
    cp -a "$existing" "$RECOVERY/$(basename "$existing").before"
  fi
done
{
  echo "DATE=$(date --iso-8601=seconds)"
  echo "SOURCE_ROOT=$SOURCE_ROOT"
  echo "SOURCE_SHA=$EXPECTED_SOURCE_SHA"
  echo "KEYSTORE_SOURCE=$KEYSTORE_SOURCE"
  echo "TOWER_USER=$TOWER_USER"
} > "$RECOVERY/metadata.txt"
chmod 0600 "$RECOVERY/metadata.txt"

if ! getent group "$SOCKET_GROUP" >/dev/null; then
  groupadd --system "$SOCKET_GROUP"
fi

if ! id "$SERVICE_USER" >/dev/null 2>&1; then
  useradd --system     --gid "$SOCKET_GROUP"     --home-dir "$RUNTIME_ROOT"     --create-home     --shell /usr/sbin/nologin     "$SERVICE_USER"
fi

CURRENT_PRIMARY_GROUP="$(id -gn "$SERVICE_USER")"
[[ "$CURRENT_PRIMARY_GROUP" == "$SOCKET_GROUP" ]] ||
  fail "$SERVICE_USER primary group must be $SOCKET_GROUP"

usermod -a -G "$SOCKET_GROUP" "$TOWER_USER"

install -d -o root -g "$SOCKET_GROUP" -m 0750   "$RUNTIME_ROOT" "$RUNTIME_APP" "$RUNTIME_APP/scripts"   "$RUNTIME_APP/src" "$RUNTIME_APP/src/genesisSettlement"
install -d -o root -g "$SOCKET_GROUP" -m 0750 "$CONFIG_ROOT"
install -d -o root -g root -m 0700 "$CREDENTIAL_ROOT"

install -o root -g "$SOCKET_GROUP" -m 0640 "$SOURCE_ROOT/package.json" "$RUNTIME_APP/package.json"
install -o root -g "$SOCKET_GROUP" -m 0640 "$SOURCE_ROOT/package-lock.json" "$RUNTIME_APP/package-lock.json"
install -o root -g "$SOCKET_GROUP" -m 0640 "$SOURCE_ROOT/src/gg7RelayCore.js" "$RUNTIME_APP/src/gg7RelayCore.js"
install -o root -g "$SOCKET_GROUP" -m 0640   "$SOURCE_ROOT/src/genesisSettlement/encryptedRelayer.js"   "$RUNTIME_APP/src/genesisSettlement/encryptedRelayer.js"
install -o root -g "$SOCKET_GROUP" -m 0640   "$SOURCE_ROOT/scripts/serve-gg7-grant-relayer.js"   "$RUNTIME_APP/scripts/serve-gg7-grant-relayer.js"

cd "$RUNTIME_APP"
npm ci --ignore-scripts >/dev/null

chown -R root:"$SOCKET_GROUP" "$RUNTIME_APP"
find "$RUNTIME_APP" -type d -exec chmod 0750 {} +
find "$RUNTIME_APP" -type f -exec chmod 0640 {} +

install -o root -g "$SOCKET_GROUP" -m 0640 "$KEYSTORE_SOURCE" "$KEYSTORE_RUNTIME"

tmp_password="$(mktemp)"
trap 'rm -f "$tmp_password"' EXIT
chmod 0600 "$tmp_password"

echo
read -r -s -p "GG-7 relayer keystore password (one-time service credential setup): " PASSWORD
echo
[[ -n "$PASSWORD" ]] || fail "password may not be empty"
printf '%s' "$PASSWORD" > "$tmp_password"
unset PASSWORD

if ! node - "$RUNTIME_APP" "$KEYSTORE_RUNTIME" "$tmp_password" "$EXPECTED_RELAYER" <<'NODE'
const fs=require("fs");
const path=require("path");
const [root, keystoreFile, passwordFile, expected]=process.argv.slice(2);
const {unlockRelayer}=require(path.join(root,"src/genesisSettlement/encryptedRelayer.js"));
(async()=>{
  const keystoreJson=fs.readFileSync(keystoreFile,"utf8");
  const password=fs.readFileSync(passwordFile,"utf8");
  const unlocked=await unlockRelayer({keystoreJson,password});
  if(unlocked.address.toLowerCase()!==("0x"+expected).toLowerCase()) process.exit(3);
})().catch(()=>process.exit(4));
NODE
then
  fail "relayer credential could not unlock canonical keystore"
fi

install -o root -g root -m 0600 "$tmp_password" "$CREDENTIAL_FILE"
: > "$tmp_password"

cat > "$ENV_FILE.tmp" <<EOF
NODE_ENV=production
GG7_RELAYER_LIVE=1
GG7_RELAY_SOCKET=/run/gcc/gg7-grant-relayer.sock
GENESIS_RELAYER_KEYSTORE=$KEYSTORE_RUNTIME
GG7_GRANT_ESCROW_ADDRESS=$GG6_ESCROW
GCC_BSC_RPC_URL=https://bsc-dataseed.binance.org/
GG7_RELAYER_MAX_GAS_LIMIT=500000
GG7_RELAYER_MAX_GAS_COST_WEI=5000000000000000
GG7_RELAYER_MAX_VALIDITY_SECONDS=1800
GG7_RELAYER_MAX_PAYOUT_BASE_UNITS=1000000000000000000000
EOF
install -o root -g "$SOCKET_GROUP" -m 0640 "$ENV_FILE.tmp" "$ENV_FILE"
rm -f "$ENV_FILE.tmp"

printf '%s\n' "$EXPECTED_SOURCE_SHA" > "$RUNTIME_ROOT/SOURCE_REVISION"
chown root:"$SOCKET_GROUP" "$RUNTIME_ROOT/SOURCE_REVISION"
chmod 0640 "$RUNTIME_ROOT/SOURCE_REVISION"

install -o root -g root -m 0644 "$UNIT_SOURCE" "$UNIT_TARGET"
systemctl daemon-reload
systemctl enable --now gcc-gg7-grant-relayer.service

for _ in {1..20}; do
  [[ -S /run/gcc/gg7-grant-relayer.sock ]] && break
  sleep 0.25
done
[[ -S /run/gcc/gg7-grant-relayer.sock ]] || {
  systemctl --no-pager --full status gcc-gg7-grant-relayer.service || true
  fail "GG-7 Unix socket did not appear"
}

HEALTH="$(runuser -u "$TOWER_USER" --   curl --silent --show-error --fail   --unix-socket /run/gcc/gg7-grant-relayer.sock   http://localhost/health)" || fail "Tower user cannot reach GG-7 relay socket"

node - "$HEALTH" <<'NODE' || fail "GG-7 relay health response is not accepted"
const x=JSON.parse(process.argv[2]);
if(x.status!=="READY" || x.liveEnabled!==true || x.chainId!==56 ||
   x.transport!=="unix_socket" || x.arbitraryTarget!==false ||
   x.arbitraryFunction!==false) process.exit(1);
NODE

systemctl is-active --quiet gcc-gg7-grant-relayer.service ||
  fail "GG-7 relay service is not active"

pass "GG7_KEYSTORE_ADDRESS"
pass "GG7_CREDENTIAL_UNLOCK"
pass "GG7_DEDICATED_SERVICE_IDENTITY"
pass "GG7_PROTECTED_CREDENTIAL_FILE"
pass "GG7_UNIX_SOCKET_REACHABLE_BY_TOWER_USER"
pass "GG7_SERVICE_ACTIVE"
echo "GG7_RELAY_HEALTH=$HEALTH"
echo "RECOVERY_PATH=$RECOVERY"
echo "GG7_RUNTIME_ACTIVATION=PASS"
echo "No grant payout was requested or submitted by this installer."
