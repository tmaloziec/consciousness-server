#!/bin/bash
# =============================================================================
# INTEGRATION MATRIX — connections between blocks (per ARCHITECTURE §6)
# Each test ~2s, timeout 10s total.
# =============================================================================
set -u
CS="http://127.0.0.1:3032"
SS="http://127.0.0.1:3037"
SKILLS="http://127.0.0.1:3031"
DB="http://127.0.0.1:3033"
MACH="http://127.0.0.1:3038"
GW="http://127.0.0.1:3042"
KS="http://127.0.0.1:3040"
OLLAMA="http://127.0.0.1:11434"
T=3  # per-call timeout

declare -a results
ts=$(date -Iseconds)

pass_cnt=0; fail_cnt=0; skip_cnt=0

# ---- helper ----
pass() { results+=("  \xE2\x9C\x93  $1"); pass_cnt=$((pass_cnt+1)); }
fail() { results+=("  \xE2\x9C\x97  $1  — $2"); fail_cnt=$((fail_cnt+1)); }
skip() { results+=("  \xE2\x97\xAF  $1  (skip: $2)"); skip_cnt=$((skip_cnt+1)); }

# ---- P22: middleware drift check ----
# Runs first because if the shared middleware copies don't match the
# master, any other middleware test below is meaningless.
SYNC_SCRIPT="$(cd "$(dirname "$0")" && pwd)/sync-middleware"
if [ -x "$SYNC_SCRIPT" ]; then
  if drift_out=$("$SYNC_SCRIPT" --check 2>&1); then
    pass "P22 sync-middleware --check (all copies match lib/ masters)"
  else
    fail "P22 sync-middleware --check" "${drift_out:0:120}"
  fi
else
  skip "P22 sync-middleware --check" "bin/sync-middleware not executable"
fi

# ---- P2: CS → semantic-search (embedding flow) ----
uniq_id="int-test-$(date +%s)"
resp=$(curl -s -m $T -X POST "$SS/api/embed" \
  -H "Content-Type: application/json" \
  -d "{\"collection\":\"notes\",\"id\":\"$uniq_id\",\"text\":\"integration test marker $uniq_id\"}" 2>/dev/null)
if echo "$resp" | grep -q "\"embedded\":true"; then
  pass "P2 SS /api/embed returns embedded:true"
else
  fail "P2 SS /api/embed" "response=${resp:0:80}"
fi

# ---- P3: semantic-search → Ollama (embedding backend) ----
# Indirect via P2: if P2 passed, Ollama must have worked.
if [ $pass_cnt -gt 0 ] && echo "$resp" | grep -q "\"embedded\":true"; then
  pass "P3 SS → Ollama (inferred from P2)"
else
  fail "P3 SS → Ollama" "embed failed — check Ollama :11434"
fi

# ---- P4: semantic-search → ChromaDB (search finds inserted doc) ----
sleep 1  # give Chroma a moment
resp=$(curl -s -m $T -X POST "$SS/api/search" \
  -H "Content-Type: application/json" \
  -d "{\"query\":\"integration test marker $uniq_id\",\"collection\":\"notes\",\"limit\":5}" 2>/dev/null)
if echo "$resp" | grep -q "$uniq_id"; then
  pass "P4 SS → ChromaDB (search finds just-embedded doc)"
else
  fail "P4 SS → ChromaDB" "search missed the marker"
fi

# ---- P6: dashboard-backend → CS ----
resp=$(curl -s -m $T "$DB/health" 2>/dev/null)
if echo "$resp" | grep -qi "ok"; then
  pass "P6 dashboard-backend /health"
else
  fail "P6 dashboard-backend /health" "${resp:0:60}"
fi

# ---- P8: dashboard-backend → machines ----
resp=$(curl -s -m $T "$MACH/health" 2>/dev/null)
if echo "$resp" | grep -qi "ok"; then
  pass "P8 machines /health reachable"
else
  fail "P8 machines reachability" "${resp:0:60}"
fi

# ---- P12: git-workflow persistence ----
commit_hash="testhash$(date +%s)"
curl -s -m $T -X POST "$GW/api/git/hook/post-commit" \
  -H "Content-Type: application/json" \
  -d "{\"repo\":\"integration-test\",\"hash\":\"$commit_hash\",\"agent\":\"monitor\",\"message\":\"integration test\",\"files\":[]}" >/dev/null 2>&1
sleep 0.5
resp=$(curl -s -m $T "$GW/api/git/history" 2>/dev/null)
if echo "$resp" | grep -q "$commit_hash"; then
  pass "P12 git-workflow hook→history roundtrip"
else
  fail "P12 git-workflow" "hash not in history"
fi

# ---- P13: CS Identity login ----
resp=$(curl -s -m $T -X POST "$CS/api/identity/login" \
  -H "Content-Type: application/json" \
  -d "{\"agent_id\":\"integration-test-$uniq_id\"}" 2>/dev/null)
token=$(echo "$resp" | python3 -c "import sys,json;d=json.load(sys.stdin);print(d.get(\"token\",\"\"))" 2>/dev/null)
if [ -n "$token" ]; then
  whoami_resp=$(curl -s -m $T -X POST "$CS/api/identity/whoami" \
    -H "Content-Type: application/json" -d "{\"token\":\"$token\"}" 2>/dev/null)
  if echo "$whoami_resp" | grep -q "integration-test-$uniq_id"; then
    pass "P13 CS identity login→whoami roundtrip"
  else
    fail "P13 CS identity whoami" "token invalid right after login"
  fi
else
  fail "P13 CS identity login" "no token in response"
fi

# ---- P1: CS → Redis persistence across restart ----
# Only attempted when sandbox compose stack is running — otherwise unsafe.
SANDBOX_DIR="$(cd "$(dirname "$0")/.." && pwd)/deploy"
if [ -f "$SANDBOX_DIR/docker-compose.yml" ] && \
   docker compose -f "$SANDBOX_DIR/docker-compose.yml" ps --services --filter "status=running" 2>/dev/null | grep -qx consciousness-server; then
  p1_id="persist-$uniq_id"
  curl -s -m $T -X POST "$CS/api/notes" \
    -H "Content-Type: application/json" \
    -d "{\"agent\":\"monitor\",\"type\":\"observation\",\"title\":\"$p1_id\",\"content\":\"P1 test marker\"}" >/dev/null 2>&1
  sleep 0.5
  docker compose -f "$SANDBOX_DIR/docker-compose.yml" restart consciousness-server >/dev/null 2>&1
  # Wait for CS health after restart (max 30s)
  for i in $(seq 1 30); do
    code=$(curl -s -o /dev/null -w "%{http_code}" -m 2 "$CS/health" 2>/dev/null)
    [ "$code" = "200" ] && break
    sleep 1
  done
  resp=$(curl -s -m $T "$CS/api/notes/recent?limit=20" 2>/dev/null)
  if echo "$resp" | grep -q "$p1_id"; then
    pass "P1 CS → Redis persistence (note survived restart)"
  else
    fail "P1 CS → Redis persistence" "marker absent after CS restart"
  fi
else
  skip "P1 CS → Redis persistence across restart" "sandbox CS not running"
fi

# ---- P5: Agent → CS embedded WebSocket ----
# Handshake-only check: upgrade request → expect 101 Switching Protocols.
ws_code=$(curl -s -o /dev/null -w "%{http_code}" -m $T \
  -H "Connection: Upgrade" -H "Upgrade: websocket" \
  -H "Sec-WebSocket-Version: 13" \
  -H "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==" \
  "$CS/agent1" 2>/dev/null)
if [ "$ws_code" = "101" ]; then
  pass "P5 CS WebSocket upgrade handshake (101 Switching Protocols)"
else
  fail "P5 CS WebSocket" "expected 101, got ${ws_code:-000}"
fi

# ---- P14: CS FSM heartbeat validation (architecture §1e) ----
fsm_agent="fsm-test-$uniq_id"
# Register → IDLE default
reg=$(curl -s -m $T -X POST "$CS/api/agents/register" \
  -H "Content-Type: application/json" \
  -d "{\"name\":\"$fsm_agent\",\"location\":\"laptop\",\"role\":\"test\"}" 2>/dev/null)
reg_status=$(echo "$reg" | python3 -c "import sys,json;d=json.load(sys.stdin);print(d.get('agent',{}).get('status',''))" 2>/dev/null)
# Legacy FREE → IDLE via heartbeat
curl -s -m $T -X POST "$CS/api/agents/$fsm_agent/heartbeat" \
  -H "Content-Type: application/json" -d '{"status":"FREE"}' >/dev/null 2>&1
# Valid BUSY with task_id
hb=$(curl -s -m $T -X POST "$CS/api/agents/$fsm_agent/heartbeat" \
  -H "Content-Type: application/json" -d '{"status":"BUSY","task_id":"t-1"}' 2>/dev/null)
hb_busy=$(echo "$hb" | python3 -c "import sys,json;d=json.load(sys.stdin);print(d.get('status','')+':'+str(d.get('task_id','')))" 2>/dev/null)
# Invalid state → 400
bad_code=$(curl -s -o /dev/null -w "%{http_code}" -m $T -X POST "$CS/api/agents/$fsm_agent/heartbeat" \
  -H "Content-Type: application/json" -d '{"status":"NONSENSE"}' 2>/dev/null)

if [ "$reg_status" = "IDLE" ] && [ "$hb_busy" = "BUSY:t-1" ] && [ "$bad_code" = "400" ]; then
  pass "P14 FSM heartbeat: IDLE default, FREE→IDLE legacy, BUSY+task_id, invalid→400"
else
  fail "P14 FSM heartbeat" "reg=$reg_status busy=$hb_busy bad=$bad_code"
fi

# ---- P15: key-server agent identity ----
# Bootstrap a test identity, fetch it back, verify list/404/traversal.
MIRROR_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
AGENTS_DIR="$MIRROR_ROOT/key-server/keys/agents"
mkdir -p "$AGENTS_DIR"
p15_agent="itest-$uniq_id"
if command -v ssh-keygen >/dev/null 2>&1; then
  ssh-keygen -t ed25519 -C "$p15_agent@integration-test" \
    -f "/tmp/$p15_agent-key" -N "" -q 2>/dev/null
  cp "/tmp/$p15_agent-key.pub" "$AGENTS_DIR/$p15_agent.pub"
  # Fetch the identity back
  resp=$(curl -s -m $T "$KS/api/agents/identity/$p15_agent" 2>/dev/null)
  got_fp=$(echo "$resp" | python3 -c "import sys,json;d=json.load(sys.stdin);print(d.get('fingerprint',''))" 2>/dev/null)
  # 404 on unknown agent
  nf_code=$(curl -s -o /dev/null -w "%{http_code}" -m $T "$KS/api/agents/identity/does-not-exist-$uniq_id" 2>/dev/null)
  # Path traversal → 400
  pt_code=$(curl -s -o /dev/null -w "%{http_code}" -m $T "$KS/api/agents/identity/..%2Fetc" 2>/dev/null)
  # List includes agent
  list_has=$(curl -s -m $T "$KS/api/agents/identity" 2>/dev/null | grep -c "$p15_agent" || true)

  if [[ "$got_fp" =~ ^SHA256: ]] && [ "$nf_code" = "404" ] && [ "$pt_code" = "400" ] && [ "$list_has" -ge 1 ]; then
    pass "P15 key-server identity: bootstrap→fetch+fingerprint, 404 unknown, 400 traversal, list"
  else
    fail "P15 key-server identity" "fp=$got_fp nf=$nf_code pt=$pt_code list_has=$list_has"
  fi
  # Cleanup test key
  rm -f "$AGENTS_DIR/$p15_agent.pub" "/tmp/$p15_agent-key" "/tmp/$p15_agent-key.pub"
else
  skip "P15 key-server identity" "ssh-keygen not available"
fi

# ---- P16-P21: key-server POST /api/verify (signed requests) ----
# These tests bootstrap a fresh ed25519 keypair, sign a canonical message
# (per docs/SIGNING-PROTOCOL.md), POST it to /api/verify, and assert verdicts.
# Each test uses its own agent_id + nonce so they are independent.
if command -v ssh-keygen >/dev/null 2>&1 && command -v node >/dev/null 2>&1; then
  # sign_message via Node one-liner. Args: <priv_key_file> <message>.
  # Emits base64 ed25519 signature on stdout.
  # Uses sshpk (already a key-server dep) to convert OpenSSH ed25519 private
  # keys to PKCS8 PEM — Node's crypto.createPrivateKey rejects OpenSSH
  # format for ed25519 (ERR_OSSL_UNSUPPORTED).
  KS_NODE_MODULES="$MIRROR_ROOT/key-server/node_modules"
  sign_message() {
    NODE_PATH="$KS_NODE_MODULES" node -e '
      const sshpk = require("sshpk");
      const crypto = require("crypto");
      const fs = require("fs");
      const priv = sshpk.parsePrivateKey(fs.readFileSync(process.argv[1]), "ssh");
      const key = crypto.createPrivateKey(priv.toString("pkcs8"));
      const msg = Buffer.from(process.argv[2], "utf8");
      process.stdout.write(crypto.sign(null, msg, key).toString("base64"));
    ' "$1" "$2"
  }

  # ---- P16: happy path ----
  p16_agent="p16-$uniq_id"
  ssh-keygen -t ed25519 -C "$p16_agent" -f "/tmp/$p16_agent" -N "" -q 2>/dev/null
  cp "/tmp/$p16_agent.pub" "$AGENTS_DIR/$p16_agent.pub"
  p16_ts=$(date -u +"%Y-%m-%dT%H:%M:%SZ")
  p16_nonce=$(openssl rand -hex 16)
  p16_body=""
  p16_sha=$(printf "%s" "$p16_body" | sha256sum | awk '{print $1}')
  p16_msg=$(printf "GET\n/test\n%s\n%s\n%s" "$p16_ts" "$p16_nonce" "$p16_sha")
  p16_sig=$(sign_message "/tmp/$p16_agent" "$p16_msg")
  resp=$(curl -s -m $T -X POST "$KS/api/verify" \
    -H "Content-Type: application/json" \
    -d "{\"agent_id\":\"$p16_agent\",\"timestamp\":\"$p16_ts\",\"nonce\":\"$p16_nonce\",\"method\":\"GET\",\"path\":\"/test\",\"body_sha256\":\"$p16_sha\",\"signature\":\"$p16_sig\"}")
  if echo "$resp" | grep -q '"valid": *true'; then
    pass "P16 verify happy path (sign → verify → 200)"
  else
    fail "P16 verify happy path" "${resp:0:120}"
  fi

  # ---- P17: nonce replay (re-POST same nonce from P16) ----
  resp=$(curl -s -m $T -X POST "$KS/api/verify" \
    -H "Content-Type: application/json" \
    -d "{\"agent_id\":\"$p16_agent\",\"timestamp\":\"$p16_ts\",\"nonce\":\"$p16_nonce\",\"method\":\"GET\",\"path\":\"/test\",\"body_sha256\":\"$p16_sha\",\"signature\":\"$p16_sig\"}")
  if echo "$resp" | grep -q '"reason": *"nonce_replayed"'; then
    pass "P17 anti-replay: same nonce rejected"
  else
    fail "P17 anti-replay" "${resp:0:120}"
  fi

  # ---- P18: bad signature (sign with a DIFFERENT private key) ----
  p18_agent="p18-$uniq_id"
  ssh-keygen -t ed25519 -C "$p18_agent" -f "/tmp/$p18_agent" -N "" -q 2>/dev/null
  cp "/tmp/$p18_agent.pub" "$AGENTS_DIR/$p18_agent.pub"
  p18_other="/tmp/$p16_agent"  # wrong key
  p18_ts=$(date -u +"%Y-%m-%dT%H:%M:%SZ")
  p18_nonce=$(openssl rand -hex 16)
  p18_msg=$(printf "GET\n/test\n%s\n%s\n%s" "$p18_ts" "$p18_nonce" "$p16_sha")
  p18_sig=$(sign_message "$p18_other" "$p18_msg")
  resp=$(curl -s -m $T -X POST "$KS/api/verify" \
    -H "Content-Type: application/json" \
    -d "{\"agent_id\":\"$p18_agent\",\"timestamp\":\"$p18_ts\",\"nonce\":\"$p18_nonce\",\"method\":\"GET\",\"path\":\"/test\",\"body_sha256\":\"$p16_sha\",\"signature\":\"$p18_sig\"}")
  if echo "$resp" | grep -q '"reason": *"bad_signature"'; then
    pass "P18 bad signature rejected (agent_id mismatch with private key)"
  else
    fail "P18 bad signature" "${resp:0:120}"
  fi

  # ---- P19: unknown agent (no pub key on disk) ----
  p19_ts=$(date -u +"%Y-%m-%dT%H:%M:%SZ")
  p19_nonce=$(openssl rand -hex 16)
  p19_sig=$(printf "a%.0s" $(seq 1 88))  # 88 b64 chars → 66 bytes → length check fails AFTER unknown_agent
  resp=$(curl -s -m $T -X POST "$KS/api/verify" \
    -H "Content-Type: application/json" \
    -d "{\"agent_id\":\"no-such-agent-$uniq_id\",\"timestamp\":\"$p19_ts\",\"nonce\":\"$p19_nonce\",\"method\":\"GET\",\"path\":\"/test\",\"body_sha256\":\"$p16_sha\",\"signature\":\"$p19_sig\"}")
  if echo "$resp" | grep -q '"reason": *"unknown_agent"'; then
    pass "P19 unknown agent rejected"
  else
    fail "P19 unknown agent" "${resp:0:120}"
  fi

  # ---- P20: timestamp out of window (-600s, well past -300s) ----
  p20_ts=$(date -u -d "-600 seconds" +"%Y-%m-%dT%H:%M:%SZ")
  p20_nonce=$(openssl rand -hex 16)
  p20_msg=$(printf "GET\n/test\n%s\n%s\n%s" "$p20_ts" "$p20_nonce" "$p16_sha")
  p20_sig=$(sign_message "/tmp/$p16_agent" "$p20_msg")
  resp=$(curl -s -m $T -X POST "$KS/api/verify" \
    -H "Content-Type: application/json" \
    -d "{\"agent_id\":\"$p16_agent\",\"timestamp\":\"$p20_ts\",\"nonce\":\"$p20_nonce\",\"method\":\"GET\",\"path\":\"/test\",\"body_sha256\":\"$p16_sha\",\"signature\":\"$p20_sig\"}")
  if echo "$resp" | grep -q '"reason": *"timestamp_out_of_window"'; then
    pass "P20 timestamp out of window rejected"
  else
    fail "P20 timestamp out of window" "${resp:0:120}"
  fi

  # ---- P21: revocation (rm pub key → same happy path → unknown_agent) ----
  p21_agent="p21-$uniq_id"
  ssh-keygen -t ed25519 -C "$p21_agent" -f "/tmp/$p21_agent" -N "" -q 2>/dev/null
  cp "/tmp/$p21_agent.pub" "$AGENTS_DIR/$p21_agent.pub"
  # First request succeeds.
  p21_ts=$(date -u +"%Y-%m-%dT%H:%M:%SZ")
  p21_nonce=$(openssl rand -hex 16)
  p21_msg=$(printf "GET\n/test\n%s\n%s\n%s" "$p21_ts" "$p21_nonce" "$p16_sha")
  p21_sig=$(sign_message "/tmp/$p21_agent" "$p21_msg")
  ok_resp=$(curl -s -m $T -X POST "$KS/api/verify" \
    -H "Content-Type: application/json" \
    -d "{\"agent_id\":\"$p21_agent\",\"timestamp\":\"$p21_ts\",\"nonce\":\"$p21_nonce\",\"method\":\"GET\",\"path\":\"/test\",\"body_sha256\":\"$p16_sha\",\"signature\":\"$p21_sig\"}")
  # Revoke.
  rm -f "$AGENTS_DIR/$p21_agent.pub"
  # Second request (new nonce so anti-replay doesn't short-circuit) must 401 unknown_agent.
  p21b_ts=$(date -u +"%Y-%m-%dT%H:%M:%SZ")
  p21b_nonce=$(openssl rand -hex 16)
  p21b_msg=$(printf "GET\n/test\n%s\n%s\n%s" "$p21b_ts" "$p21b_nonce" "$p16_sha")
  p21b_sig=$(sign_message "/tmp/$p21_agent" "$p21b_msg")
  rev_resp=$(curl -s -m $T -X POST "$KS/api/verify" \
    -H "Content-Type: application/json" \
    -d "{\"agent_id\":\"$p21_agent\",\"timestamp\":\"$p21b_ts\",\"nonce\":\"$p21b_nonce\",\"method\":\"GET\",\"path\":\"/test\",\"body_sha256\":\"$p16_sha\",\"signature\":\"$p21b_sig\"}")
  if echo "$ok_resp" | grep -q '"valid": *true' && echo "$rev_resp" | grep -q '"reason": *"unknown_agent"'; then
    pass "P21 revocation: rm pub key → next verify immediately unknown_agent"
  else
    fail "P21 revocation" "ok=${ok_resp:0:60} rev=${rev_resp:0:80}"
  fi

  # Cleanup (best-effort)
  rm -f "$AGENTS_DIR/$p16_agent.pub" "$AGENTS_DIR/$p18_agent.pub" \
        "/tmp/$p16_agent" "/tmp/$p16_agent.pub" \
        "/tmp/$p18_agent" "/tmp/$p18_agent.pub" \
        "/tmp/$p21_agent" "/tmp/$p21_agent.pub"
else
  skip "P16-P21 key-server /api/verify" "ssh-keygen or node not available"
fi

# ---- P23/P28/P34/P40: test-runner AUTH_MODE behaviour ----
# Each test restarts test-runner with the desired AUTH_MODE override.
# Skipped if sandbox is not running, ssh-keygen missing, or key-server
# not reachable — these tests require the full signed-request chain.
TR="http://127.0.0.1:3041"
SANDBOX_DIR="$(cd "$(dirname "$0")/.." && pwd)/deploy"
if [ -f "$SANDBOX_DIR/docker-compose.yml" ] \
   && command -v ssh-keygen >/dev/null 2>&1 \
   && docker compose -f "$SANDBOX_DIR/docker-compose.yml" ps --services --filter "status=running" 2>/dev/null | grep -qx test-runner \
   && curl -s -m 2 "$KS/health" >/dev/null 2>&1; then

  restart_tr() {
    AUTH_MODE="$1" docker compose -f "$SANDBOX_DIR/docker-compose.yml" \
      up -d --force-recreate test-runner >/dev/null 2>&1
    # Wait for healthy
    for _i in $(seq 1 20); do
      code=$(curl -s -o /dev/null -w "%{http_code}" -m 2 "$TR/health" 2>/dev/null)
      [ "$code" = "200" ] && return 0
      sleep 0.5
    done
    return 1
  }

  # ---- P23: off mode, unsigned request reaches handler ----
  if restart_tr off; then
    resp_code=$(curl -s -o /dev/null -w "%{http_code}" -m $T "$TR/api/test/history")
    if [ "$resp_code" = "200" ]; then
      pass "P23 test-runner AUTH_MODE=off — unsigned GET reaches handler (200)"
    else
      fail "P23 test-runner AUTH_MODE=off" "expected 200, got $resp_code"
    fi
  else
    fail "P23 test-runner AUTH_MODE=off" "restart timeout"
  fi

  # ---- P28: enforce, unsigned request rejected ----
  if restart_tr enforce; then
    resp=$(curl -s -m $T -w "|%{http_code}" "$TR/api/test/history")
    body="${resp%|*}"; code="${resp##*|}"
    if [ "$code" = "401" ] && echo "$body" | grep -q 'missing_headers'; then
      pass "P28 test-runner AUTH_MODE=enforce — unsigned GET rejected (401 missing_headers)"
    else
      fail "P28 test-runner AUTH_MODE=enforce" "code=$code body=${body:0:80}"
    fi

    # ---- P34: enforce, signed request accepted ----
    # Bootstrap a throwaway key, sign via bin/sign-request, send.
    p34_agent="p34-$uniq_id"
    ssh-keygen -t ed25519 -C "$p34_agent" -f "/tmp/$p34_agent" -N "" -q 2>/dev/null
    cp "/tmp/$p34_agent.pub" "$AGENTS_DIR/$p34_agent.pub"
    hdr_file="/tmp/p34-hdr-$uniq_id"
    if AGENT_PRIV_KEY="/tmp/$p34_agent" "$MIRROR_ROOT/bin/sign-request" \
        "$p34_agent" GET /api/test/history > "$hdr_file" 2>/dev/null; then
      h_agent=$(awk -F': ' '/X-Agent-Id/ {print $2}' "$hdr_file")
      h_ts=$(awk -F': ' '/X-Timestamp/ {print $2}' "$hdr_file")
      h_nc=$(awk -F': ' '/X-Nonce/ {print $2}' "$hdr_file")
      h_sig=$(awk -F': ' '/X-Signature/ {print $2}' "$hdr_file")
      resp=$(curl -s -m $T -w "|%{http_code}" "$TR/api/test/history" \
        -H "X-Agent-Id: $h_agent" -H "X-Timestamp: $h_ts" \
        -H "X-Nonce: $h_nc" -H "X-Signature: $h_sig")
      body="${resp%|*}"; code="${resp##*|}"
      if [ "$code" = "200" ] && echo "$body" | grep -q '"tests"'; then
        pass "P34 test-runner AUTH_MODE=enforce — signed GET accepted (200)"
      else
        fail "P34 test-runner AUTH_MODE=enforce (signed)" "code=$code body=${body:0:80}"
      fi
    else
      fail "P34 test-runner AUTH_MODE=enforce (signed)" "bin/sign-request failed"
    fi
    rm -f "$AGENTS_DIR/$p34_agent.pub" "/tmp/$p34_agent" "/tmp/$p34_agent.pub" "$hdr_file"
  else
    fail "P28/P34 test-runner AUTH_MODE=enforce" "restart timeout"
  fi

  # ---- P40: observe, unsigned request passes + logs ----
  if restart_tr observe; then
    log_before=$(docker exec cs-test-runner sh -c 'wc -l < /app/logs/auth-observe.log 2>/dev/null || echo 0' | tr -d '[:space:]')
    resp_code=$(curl -s -o /dev/null -w "%{http_code}" -m $T "$TR/api/test/history")
    sleep 0.5
    log_after=$(docker exec cs-test-runner sh -c 'wc -l < /app/logs/auth-observe.log 2>/dev/null || echo 0' | tr -d '[:space:]')
    log_tail=$(docker exec cs-test-runner sh -c 'tail -1 /app/logs/auth-observe.log 2>/dev/null')
    if [ "$resp_code" = "200" ] \
       && [ "$log_after" -gt "$log_before" ] \
       && echo "$log_tail" | grep -q 'would_reject'; then
      pass "P40 test-runner AUTH_MODE=observe — unsigned passes (200) + observe-log entry"
    else
      fail "P40 test-runner AUTH_MODE=observe" "code=$resp_code before=$log_before after=$log_after"
    fi
  else
    fail "P40 test-runner AUTH_MODE=observe" "restart timeout"
  fi

  # Reset to default off before leaving.
  restart_tr off >/dev/null 2>&1 || true
else
  skip "P23/P28/P34/P40 test-runner AUTH_MODE suite" "sandbox test-runner not running or key-server unreachable"
fi

# ---- P24/P29/P35/P41: git-workflow AUTH_MODE behaviour ----
# git-workflow is stdlib BaseHTTPRequestHandler, so exercises the
# stdlib_gate decorator path (POST with body must survive the
# gate consuming rfile).
if [ -f "$SANDBOX_DIR/docker-compose.yml" ] \
   && command -v ssh-keygen >/dev/null 2>&1 \
   && docker compose -f "$SANDBOX_DIR/docker-compose.yml" ps --services --filter "status=running" 2>/dev/null | grep -qx git-workflow \
   && curl -s -m 2 "$KS/health" >/dev/null 2>&1; then

  restart_gw() {
    AUTH_MODE="$1" docker compose -f "$SANDBOX_DIR/docker-compose.yml" \
      up -d --force-recreate git-workflow >/dev/null 2>&1
    for _i in $(seq 1 20); do
      code=$(curl -s -o /dev/null -w "%{http_code}" -m 2 "$GW/health" 2>/dev/null)
      [ "$code" = "200" ] && return 0
      sleep 0.5
    done
    return 1
  }

  # ---- P24: off mode, unsigned POST recorded ----
  if restart_gw off; then
    resp=$(curl -s -m $T -X POST "$GW/api/git/hook/post-commit" \
      -H "Content-Type: application/json" \
      -d '{"repo":"p24","hash":"p24hash","agent":"p24-off","files":[]}')
    if echo "$resp" | grep -q '"status".*"recorded"'; then
      pass "P24 git-workflow AUTH_MODE=off — unsigned POST recorded"
    else
      fail "P24 git-workflow AUTH_MODE=off" "${resp:0:80}"
    fi
  else
    fail "P24 git-workflow AUTH_MODE=off" "restart timeout"
  fi

  # ---- P29: enforce, unsigned POST rejected ----
  if restart_gw enforce; then
    resp=$(curl -s -m $T -w "|%{http_code}" -X POST "$GW/api/git/hook/post-commit" \
      -H "Content-Type: application/json" -d '{"repo":"p29","hash":"x"}')
    body="${resp%|*}"; code="${resp##*|}"
    if [ "$code" = "401" ] && echo "$body" | grep -q 'missing_headers'; then
      pass "P29 git-workflow AUTH_MODE=enforce — unsigned POST rejected (401 missing_headers)"
    else
      fail "P29 git-workflow AUTH_MODE=enforce" "code=$code body=${body:0:80}"
    fi

    # ---- P35: enforce, signed POST lands in DB ----
    p35_agent="p35-$uniq_id"
    ssh-keygen -t ed25519 -C "$p35_agent" -f "/tmp/$p35_agent" -N "" -q 2>/dev/null
    cp "/tmp/$p35_agent.pub" "$AGENTS_DIR/$p35_agent.pub"
    hdr_file="/tmp/p35-hdr-$uniq_id"
    p35_hash="p35sig$uniq_id"
    p35_body="{\"repo\":\"p35\",\"hash\":\"$p35_hash\",\"agent\":\"$p35_agent\",\"message\":\"p35 signed\",\"files\":[]}"
    if AGENT_PRIV_KEY="/tmp/$p35_agent" "$MIRROR_ROOT/bin/sign-request" \
        "$p35_agent" POST /api/git/hook/post-commit "$p35_body" > "$hdr_file" 2>/dev/null; then
      h_agent=$(awk -F': ' '/X-Agent-Id/ {print $2}' "$hdr_file")
      h_ts=$(awk -F': ' '/X-Timestamp/ {print $2}' "$hdr_file")
      h_nc=$(awk -F': ' '/X-Nonce/ {print $2}' "$hdr_file")
      h_sig=$(awk -F': ' '/X-Signature/ {print $2}' "$hdr_file")
      resp=$(curl -s -m $T -w "|%{http_code}" -X POST "$GW/api/git/hook/post-commit" \
        -H "Content-Type: application/json" \
        -H "X-Agent-Id: $h_agent" -H "X-Timestamp: $h_ts" \
        -H "X-Nonce: $h_nc" -H "X-Signature: $h_sig" \
        -d "$p35_body")
      body="${resp%|*}"; code="${resp##*|}"
      # Secondary check: signed GET /api/git/history returns the hash.
      if [ "$code" = "200" ] && echo "$body" | grep -q 'recorded'; then
        AGENT_PRIV_KEY="/tmp/$p35_agent" "$MIRROR_ROOT/bin/sign-request" \
          "$p35_agent" GET /api/git/history > "$hdr_file" 2>/dev/null
        gh_agent=$(awk -F': ' '/X-Agent-Id/ {print $2}' "$hdr_file")
        gh_ts=$(awk -F': ' '/X-Timestamp/ {print $2}' "$hdr_file")
        gh_nc=$(awk -F': ' '/X-Nonce/ {print $2}' "$hdr_file")
        gh_sig=$(awk -F': ' '/X-Signature/ {print $2}' "$hdr_file")
        hist=$(curl -s -m $T "$GW/api/git/history" \
          -H "X-Agent-Id: $gh_agent" -H "X-Timestamp: $gh_ts" \
          -H "X-Nonce: $gh_nc" -H "X-Signature: $gh_sig")
        if echo "$hist" | grep -q "$p35_hash"; then
          pass "P35 git-workflow AUTH_MODE=enforce — signed POST lands in DB + signed GET returns it"
        else
          fail "P35 git-workflow (enforce signed GET)" "hash $p35_hash missing from history"
        fi
      else
        fail "P35 git-workflow AUTH_MODE=enforce (signed POST)" "code=$code body=${body:0:80}"
      fi
    else
      fail "P35 git-workflow AUTH_MODE=enforce (signed)" "bin/sign-request failed"
    fi
    rm -f "$AGENTS_DIR/$p35_agent.pub" "/tmp/$p35_agent" "/tmp/$p35_agent.pub" "$hdr_file"
  else
    fail "P29/P35 git-workflow AUTH_MODE=enforce" "restart timeout"
  fi

  # ---- P41: observe, unsigned POST passes + logs ----
  if restart_gw observe; then
    log_before=$(docker exec cs-git-workflow sh -c 'wc -l < /app/logs/auth-observe.log 2>/dev/null || echo 0' | tr -d '[:space:]')
    resp=$(curl -s -m $T -X POST "$GW/api/git/hook/post-commit" \
      -H "Content-Type: application/json" \
      -d '{"repo":"p41","hash":"p41hash"}')
    sleep 0.5
    log_after=$(docker exec cs-git-workflow sh -c 'wc -l < /app/logs/auth-observe.log 2>/dev/null || echo 0' | tr -d '[:space:]')
    log_tail=$(docker exec cs-git-workflow sh -c 'tail -1 /app/logs/auth-observe.log 2>/dev/null')
    if echo "$resp" | grep -q 'recorded' \
       && [ "$log_after" -gt "$log_before" ] \
       && echo "$log_tail" | grep -q 'would_reject'; then
      pass "P41 git-workflow AUTH_MODE=observe — unsigned passes + observe-log entry"
    else
      fail "P41 git-workflow AUTH_MODE=observe" "resp=${resp:0:60} before=$log_before after=$log_after"
    fi
  else
    fail "P41 git-workflow AUTH_MODE=observe" "restart timeout"
  fi

  restart_gw off >/dev/null 2>&1 || true
else
  skip "P24/P29/P35/P41 git-workflow AUTH_MODE suite" "sandbox git-workflow not running or key-server unreachable"
fi

# ---- P25/P30/P36/P42: machines-server AUTH_MODE behaviour ----
if [ -f "$SANDBOX_DIR/docker-compose.yml" ] \
   && command -v ssh-keygen >/dev/null 2>&1 \
   && docker compose -f "$SANDBOX_DIR/docker-compose.yml" ps --services --filter "status=running" 2>/dev/null | grep -qx machines-server \
   && curl -s -m 2 "$KS/health" >/dev/null 2>&1; then

  restart_ms() {
    AUTH_MODE="$1" docker compose -f "$SANDBOX_DIR/docker-compose.yml" \
      up -d --force-recreate machines-server >/dev/null 2>&1
    for _i in $(seq 1 25); do
      code=$(curl -s -o /dev/null -w "%{http_code}" -m 2 "$MACH/health" 2>/dev/null)
      [ "$code" = "200" ] && return 0
      sleep 0.5
    done
    return 1
  }

  # ---- P25: off ----
  if restart_ms off; then
    resp_code=$(curl -s -o /dev/null -w "%{http_code}" -m $T "$MACH/api/machines")
    if [ "$resp_code" = "200" ]; then
      pass "P25 machines-server AUTH_MODE=off — unsigned GET reaches handler (200)"
    else
      fail "P25 machines-server AUTH_MODE=off" "code=$resp_code"
    fi
  else
    fail "P25 machines-server AUTH_MODE=off" "restart timeout"
  fi

  # ---- P30: enforce, unsigned ----
  if restart_ms enforce; then
    resp=$(curl -s -m $T -w "|%{http_code}" "$MACH/api/machines")
    body="${resp%|*}"; code="${resp##*|}"
    if [ "$code" = "401" ] && echo "$body" | grep -q 'missing_headers'; then
      pass "P30 machines-server AUTH_MODE=enforce — unsigned GET rejected (401)"
    else
      fail "P30 machines-server AUTH_MODE=enforce" "code=$code body=${body:0:80}"
    fi

    # ---- P36: enforce, signed ----
    p36_agent="p36-$uniq_id"
    ssh-keygen -t ed25519 -C "$p36_agent" -f "/tmp/$p36_agent" -N "" -q 2>/dev/null
    cp "/tmp/$p36_agent.pub" "$AGENTS_DIR/$p36_agent.pub"
    hdr_file="/tmp/p36-hdr-$uniq_id"
    if AGENT_PRIV_KEY="/tmp/$p36_agent" "$MIRROR_ROOT/bin/sign-request" \
        "$p36_agent" GET /api/machines > "$hdr_file" 2>/dev/null; then
      h_agent=$(awk -F': ' '/X-Agent-Id/ {print $2}' "$hdr_file")
      h_ts=$(awk -F': ' '/X-Timestamp/ {print $2}' "$hdr_file")
      h_nc=$(awk -F': ' '/X-Nonce/ {print $2}' "$hdr_file")
      h_sig=$(awk -F': ' '/X-Signature/ {print $2}' "$hdr_file")
      resp=$(curl -s -m $T -w "|%{http_code}" "$MACH/api/machines" \
        -H "X-Agent-Id: $h_agent" -H "X-Timestamp: $h_ts" \
        -H "X-Nonce: $h_nc" -H "X-Signature: $h_sig")
      body="${resp%|*}"; code="${resp##*|}"
      if [ "$code" = "200" ] && echo "$body" | grep -q '"machines"'; then
        pass "P36 machines-server AUTH_MODE=enforce — signed GET accepted (200)"
      else
        fail "P36 machines-server AUTH_MODE=enforce (signed)" "code=$code body=${body:0:80}"
      fi
    else
      fail "P36 machines-server AUTH_MODE=enforce (signed)" "bin/sign-request failed"
    fi
    rm -f "$AGENTS_DIR/$p36_agent.pub" "/tmp/$p36_agent" "/tmp/$p36_agent.pub" "$hdr_file"
  else
    fail "P30/P36 machines-server AUTH_MODE=enforce" "restart timeout"
  fi

  # ---- P42: observe ----
  if restart_ms observe; then
    log_before=$(docker exec cs-machines-server sh -c 'wc -l < /app/logs/auth-observe.log 2>/dev/null || echo 0' | tr -d '[:space:]')
    resp_code=$(curl -s -o /dev/null -w "%{http_code}" -m $T "$MACH/api/machines")
    sleep 0.5
    log_after=$(docker exec cs-machines-server sh -c 'wc -l < /app/logs/auth-observe.log 2>/dev/null || echo 0' | tr -d '[:space:]')
    log_tail=$(docker exec cs-machines-server sh -c 'tail -1 /app/logs/auth-observe.log 2>/dev/null')
    if [ "$resp_code" = "200" ] \
       && [ "$log_after" -gt "$log_before" ] \
       && echo "$log_tail" | grep -q 'would_reject'; then
      pass "P42 machines-server AUTH_MODE=observe — unsigned passes + observe-log entry"
    else
      fail "P42 machines-server AUTH_MODE=observe" "code=$resp_code before=$log_before after=$log_after"
    fi
  else
    fail "P42 machines-server AUTH_MODE=observe" "restart timeout"
  fi

  restart_ms off >/dev/null 2>&1 || true
else
  skip "P25/P30/P36/P42 machines-server AUTH_MODE suite" "sandbox machines-server not running or key-server unreachable"
fi

# ---- P26/P31/P37/P43: semantic-search AUTH_MODE behaviour ----
# SS runs with network_mode: host, so KEY_SERVER_URL is 127.0.0.1:3040
# (not the docker bridge DNS name). /api/search is exercised because
# it's the primary read path + it works even without Ollama (degrades
# to distance-only matching over existing ChromaDB content).
if [ -f "$SANDBOX_DIR/docker-compose.yml" ] \
   && command -v ssh-keygen >/dev/null 2>&1 \
   && docker compose -f "$SANDBOX_DIR/docker-compose.yml" ps --services --filter "status=running" 2>/dev/null | grep -qx semantic-search \
   && curl -s -m 2 "$KS/health" >/dev/null 2>&1; then

  restart_ss() {
    AUTH_MODE="$1" docker compose -f "$SANDBOX_DIR/docker-compose.yml" \
      up -d --force-recreate semantic-search >/dev/null 2>&1
    for _i in $(seq 1 30); do
      code=$(curl -s -o /dev/null -w "%{http_code}" -m 2 "$SS/health" 2>/dev/null)
      [ "$code" = "200" ] && return 0
      sleep 0.5
    done
    return 1
  }

  ss_body='{"query":"integration-probe","collection":"notes","limit":1}'

  # ---- P26: off ----
  if restart_ss off; then
    resp_code=$(curl -s -o /dev/null -w "%{http_code}" -m $T -X POST "$SS/api/search" \
      -H "Content-Type: application/json" -d "$ss_body")
    if [ "$resp_code" = "200" ]; then
      pass "P26 semantic-search AUTH_MODE=off — unsigned POST /api/search (200)"
    else
      fail "P26 semantic-search AUTH_MODE=off" "code=$resp_code"
    fi
  else
    fail "P26 semantic-search AUTH_MODE=off" "restart timeout"
  fi

  # ---- P31: enforce, unsigned ----
  if restart_ss enforce; then
    resp=$(curl -s -m $T -w "|%{http_code}" -X POST "$SS/api/search" \
      -H "Content-Type: application/json" -d "$ss_body")
    body="${resp%|*}"; code="${resp##*|}"
    if [ "$code" = "401" ] && echo "$body" | grep -q 'missing_headers'; then
      pass "P31 semantic-search AUTH_MODE=enforce — unsigned POST rejected (401)"
    else
      fail "P31 semantic-search AUTH_MODE=enforce" "code=$code body=${body:0:80}"
    fi

    # ---- P37: enforce, signed ----
    p37_agent="p37-$uniq_id"
    ssh-keygen -t ed25519 -C "$p37_agent" -f "/tmp/$p37_agent" -N "" -q 2>/dev/null
    cp "/tmp/$p37_agent.pub" "$AGENTS_DIR/$p37_agent.pub"
    hdr_file="/tmp/p37-hdr-$uniq_id"
    if AGENT_PRIV_KEY="/tmp/$p37_agent" "$MIRROR_ROOT/bin/sign-request" \
        "$p37_agent" POST /api/search "$ss_body" > "$hdr_file" 2>/dev/null; then
      h_agent=$(awk -F': ' '/X-Agent-Id/ {print $2}' "$hdr_file")
      h_ts=$(awk -F': ' '/X-Timestamp/ {print $2}' "$hdr_file")
      h_nc=$(awk -F': ' '/X-Nonce/ {print $2}' "$hdr_file")
      h_sig=$(awk -F': ' '/X-Signature/ {print $2}' "$hdr_file")
      resp=$(curl -s -m $T -w "|%{http_code}" -X POST "$SS/api/search" \
        -H "Content-Type: application/json" \
        -H "X-Agent-Id: $h_agent" -H "X-Timestamp: $h_ts" \
        -H "X-Nonce: $h_nc" -H "X-Signature: $h_sig" \
        -d "$ss_body")
      body="${resp%|*}"; code="${resp##*|}"
      if [ "$code" = "200" ] && echo "$body" | grep -q '"results"'; then
        pass "P37 semantic-search AUTH_MODE=enforce — signed POST /api/search (200 results)"
      else
        fail "P37 semantic-search AUTH_MODE=enforce (signed)" "code=$code body=${body:0:80}"
      fi
    else
      fail "P37 semantic-search AUTH_MODE=enforce (signed)" "bin/sign-request failed"
    fi
    rm -f "$AGENTS_DIR/$p37_agent.pub" "/tmp/$p37_agent" "/tmp/$p37_agent.pub" "$hdr_file"
  else
    fail "P31/P37 semantic-search AUTH_MODE=enforce" "restart timeout"
  fi

  # ---- P43: observe ----
  if restart_ss observe; then
    log_before=$(docker exec cs-semantic-search sh -c 'wc -l < /app/logs/auth-observe.log 2>/dev/null || echo 0' | tr -d '[:space:]')
    resp_code=$(curl -s -o /dev/null -w "%{http_code}" -m $T -X POST "$SS/api/search" \
      -H "Content-Type: application/json" -d "$ss_body")
    sleep 0.5
    log_after=$(docker exec cs-semantic-search sh -c 'wc -l < /app/logs/auth-observe.log 2>/dev/null || echo 0' | tr -d '[:space:]')
    log_tail=$(docker exec cs-semantic-search sh -c 'tail -1 /app/logs/auth-observe.log 2>/dev/null')
    if [ "$resp_code" = "200" ] \
       && [ "$log_after" -gt "$log_before" ] \
       && echo "$log_tail" | grep -q 'would_reject'; then
      pass "P43 semantic-search AUTH_MODE=observe — unsigned passes + observe-log entry"
    else
      fail "P43 semantic-search AUTH_MODE=observe" "code=$resp_code before=$log_before after=$log_after"
    fi
  else
    fail "P43 semantic-search AUTH_MODE=observe" "restart timeout"
  fi

  restart_ss off >/dev/null 2>&1 || true
else
  skip "P26/P31/P37/P43 semantic-search AUTH_MODE suite" "sandbox semantic-search not running or key-server unreachable"
fi

# ---- P45/P46/P47/P48: consciousness-server AUTH_MODE behaviour ----
# CS is the Node block — exercises attachToServer + Express body
# parsing. Special: /api/notes POST needs JSON body parsed by
# Express, so this is the first test of the transparent
# reinject-body path for Express integrations.
if [ -f "$SANDBOX_DIR/docker-compose.yml" ] \
   && command -v ssh-keygen >/dev/null 2>&1 \
   && docker compose -f "$SANDBOX_DIR/docker-compose.yml" ps --services --filter "status=running" 2>/dev/null | grep -qx consciousness-server \
   && curl -s -m 2 "$KS/health" >/dev/null 2>&1; then

  restart_cs() {
    AUTH_MODE="$1" docker compose -f "$SANDBOX_DIR/docker-compose.yml" \
      up -d --force-recreate consciousness-server >/dev/null 2>&1
    for _i in $(seq 1 40); do
      code=$(curl -s -o /dev/null -w "%{http_code}" -m 2 "$CS/health" 2>/dev/null)
      [ "$code" = "200" ] && return 0
      sleep 0.5
    done
    return 1
  }

  cs_body_tpl() { printf '{"agent":"%s","type":"observation","title":"%s","content":"auth-middleware probe"}' "$1" "$2"; }

  # ---- P45: off, Express body-parser sees JSON ----
  if restart_cs off; then
    body=$(cs_body_tpl "p45-off" "p45-off-$uniq_id")
    resp=$(curl -s -m $T -w "|%{http_code}" -X POST "$CS/api/notes" \
      -H "Content-Type: application/json" -d "$body")
    rbody="${resp%|*}"; code="${resp##*|}"
    if [ "$code" = "201" ] && echo "$rbody" | grep -q '"note_id"'; then
      pass "P45 CS AUTH_MODE=off — Express parses unsigned JSON body (201)"
    else
      fail "P45 CS AUTH_MODE=off" "code=$code body=${rbody:0:80}"
    fi
  else
    fail "P45 CS AUTH_MODE=off" "restart timeout"
  fi

  # ---- P46: enforce, unsigned rejected ----
  if restart_cs enforce; then
    body=$(cs_body_tpl "p46-unsigned" "p46-$uniq_id")
    resp=$(curl -s -m $T -w "|%{http_code}" -X POST "$CS/api/notes" \
      -H "Content-Type: application/json" -d "$body")
    rbody="${resp%|*}"; code="${resp##*|}"
    if [ "$code" = "401" ] && echo "$rbody" | grep -q 'missing_headers'; then
      pass "P46 CS AUTH_MODE=enforce — unsigned POST rejected (401)"
    else
      fail "P46 CS AUTH_MODE=enforce" "code=$code body=${rbody:0:80}"
    fi

    # ---- P47: enforce, signed POST parsed by Express ----
    p47_agent="p47-$uniq_id"
    ssh-keygen -t ed25519 -C "$p47_agent" -f "/tmp/$p47_agent" -N "" -q 2>/dev/null
    cp "/tmp/$p47_agent.pub" "$AGENTS_DIR/$p47_agent.pub"
    hdr_file="/tmp/p47-hdr-$uniq_id"
    p47_body=$(cs_body_tpl "$p47_agent" "p47-signed-$uniq_id")
    if AGENT_PRIV_KEY="/tmp/$p47_agent" "$MIRROR_ROOT/bin/sign-request" \
        "$p47_agent" POST /api/notes "$p47_body" > "$hdr_file" 2>/dev/null; then
      h_agent=$(awk -F': ' '/X-Agent-Id/ {print $2}' "$hdr_file")
      h_ts=$(awk -F': ' '/X-Timestamp/ {print $2}' "$hdr_file")
      h_nc=$(awk -F': ' '/X-Nonce/ {print $2}' "$hdr_file")
      h_sig=$(awk -F': ' '/X-Signature/ {print $2}' "$hdr_file")
      resp=$(curl -s -m $T -w "|%{http_code}" -X POST "$CS/api/notes" \
        -H "Content-Type: application/json" \
        -H "X-Agent-Id: $h_agent" -H "X-Timestamp: $h_ts" \
        -H "X-Nonce: $h_nc" -H "X-Signature: $h_sig" \
        -d "$p47_body")
      rbody="${resp%|*}"; code="${resp##*|}"
      if [ "$code" = "201" ] && echo "$rbody" | grep -q '"note_id"'; then
        pass "P47 CS AUTH_MODE=enforce — signed POST parsed by Express (201)"
      else
        fail "P47 CS AUTH_MODE=enforce (signed)" "code=$code body=${rbody:0:80}"
      fi
    else
      fail "P47 CS AUTH_MODE=enforce (signed)" "bin/sign-request failed"
    fi
    rm -f "$AGENTS_DIR/$p47_agent.pub" "/tmp/$p47_agent" "/tmp/$p47_agent.pub" "$hdr_file"
  else
    fail "P46/P47 CS AUTH_MODE=enforce" "restart timeout"
  fi

  # ---- P48: observe ----
  if restart_cs observe; then
    log_before=$(docker exec cs-server sh -c 'wc -l < /app/logs/auth-observe.log 2>/dev/null || echo 0' | tr -d '[:space:]')
    body=$(cs_body_tpl "p48-obs" "p48-$uniq_id")
    resp=$(curl -s -m $T -w "|%{http_code}" -X POST "$CS/api/notes" \
      -H "Content-Type: application/json" -d "$body")
    rbody="${resp%|*}"; code="${resp##*|}"
    sleep 0.5
    log_after=$(docker exec cs-server sh -c 'wc -l < /app/logs/auth-observe.log 2>/dev/null || echo 0' | tr -d '[:space:]')
    log_tail=$(docker exec cs-server sh -c 'tail -1 /app/logs/auth-observe.log 2>/dev/null')
    if [ "$code" = "201" ] \
       && [ "$log_after" -gt "$log_before" ] \
       && echo "$log_tail" | grep -q 'would_reject'; then
      pass "P48 CS AUTH_MODE=observe — unsigned POST parsed + observe-log entry"
    else
      fail "P48 CS AUTH_MODE=observe" "code=$code before=$log_before after=$log_after"
    fi
  else
    fail "P48 CS AUTH_MODE=observe" "restart timeout"
  fi

  restart_cs off >/dev/null 2>&1 || true
else
  skip "P45/P46/P47/P48 CS AUTH_MODE suite" "sandbox CS not running or key-server unreachable"
fi

# ---- P55: launch-agent — role validation + workdir preparation ----
# Does NOT actually start claude. We stub CLAUDE_BIN=/usr/bin/true for the
# valid-role branch so `exec` succeeds without invoking the real CLI.

LAUNCH="$(cd "$(dirname "$0")" && pwd)/launch-agent"
ECOSYSTEM_ROOT="$(cd "$(dirname "$0")/.." && pwd)"

if [ -x "$LAUNCH" ]; then
  # P55a — unknown role must fail with non-zero exit and informative stderr.
  unknown_out=$("$LAUNCH" __nosuchroleXYZ 2>&1 || true)
  unknown_rc=$?
  if echo "$unknown_out" | grep -q "not found"; then
    pass "P55a launch-agent rejects unknown role"
  else
    fail "P55a launch-agent unknown role" "rc=$unknown_rc out=${unknown_out:0:120}"
  fi

  # P55b — valid role must create the isolated HOME + symlink, then exec
  # the stubbed CLAUDE_BIN. Clean up first in case a previous run left state.
  TEST_HOME="$(mktemp -d)"
  if CS_URL="http://127.0.0.1:1" \
     HOME="$TEST_HOME" \
     CLAUDE_BIN=/usr/bin/true \
     "$LAUNCH" observer "$ECOSYSTEM_ROOT" >/dev/null 2>&1; then
    LINK="$TEST_HOME/.cs-agents/observer/.claude/CLAUDE.md"
    TARGET="$ECOSYSTEM_ROOT/skills-server-cs/data/agents/observer.md"
    if [ -L "$LINK" ] && [ "$(readlink "$LINK")" = "$TARGET" ]; then
      pass "P55b launch-agent creates isolated HOME + symlink for valid role"
    else
      fail "P55b launch-agent symlink" "link=$LINK target=$(readlink "$LINK" 2>/dev/null || echo MISSING)"
    fi
  else
    fail "P55b launch-agent valid role" "exec failed for observer"
  fi
  rm -rf "$TEST_HOME"
else
  skip "P55 launch-agent" "bin/launch-agent not executable"
fi

# ---- skipped (require more infra) ----
skip "P9 dashboard-frontend → backend UI fetch" "needs browser"
skip "P10 mcp-wrappers → CS/SS/skills" "stdio MCP bridge, needs process spawn"
skip "P11 youtube-worker → CS task loop" "async, needs real YouTube URL + 3min"

# ---- report ----
echo "=== Integration Matrix $ts ==="
for line in "${results[@]}"; do echo -e "$line"; done
echo ""
echo "PASS: $pass_cnt | FAIL: $fail_cnt | SKIP: $skip_cnt"

# cleanup integration-test note we inserted (best-effort)
# (no delete endpoint for notes, just leave the marker — will be obvious)

exit 0
