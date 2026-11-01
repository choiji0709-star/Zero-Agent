#!/usr/bin/env bash
# Run inside the user's GCP SSH session. No Google credentials are copied out.
set -euo pipefail
umask 077

task_root="${ZERO_AGENT_WORKSPACE:-$HOME/zero-agent-workspace}"
task_repo="$task_root/app"
task_source='https://github.com/choiji0709-star/Zero-Agent.git'
task_node_version='24.19.0'
task_start=0
task_check=0
for argument in "$@"; do
  case "$argument" in
    --start) task_start=1 ;;
    --check) task_check=1 ;;
    *) printf 'Unknown option: %s\n' "$argument" >&2; exit 2 ;;
  esac
done

log() { printf '\n[Zero Agent] %s\n' "$*"; }
fail() { printf '\n[Zero Agent] ERROR: %s\n' "$*" >&2; exit 1; }
[[ "$(uname -s)" == Linux ]] || fail 'This script needs Linux. Run it in the GCP VM SSH terminal.'
case "$(uname -m)" in
  x86_64) task_arch=x64 ;;
  aarch64|arm64) task_arch=arm64 ;;
  *) fail 'Only Linux x86_64 and arm64 are supported.' ;;
esac

log "Workspace: $task_root"
printf 'Host: %s | User: %s | Architecture: %s\n' "$(hostname)" "$(id -un)" "$task_arch"
if [[ -r /proc/meminfo ]]; then awk '/MemAvailable:/ {printf "Available RAM: %.0f MiB\n", $2/1024}' /proc/meminfo; fi

task_missing=()
for tool in curl git tar xz sha256sum; do
  if ! command -v "$tool" >/dev/null 2>&1; then task_missing+=("$tool"); fi
done
if (( task_check )); then
  printf 'Missing prerequisites: %s\n' "${task_missing[*]:-none}"
  if command -v node >/dev/null 2>&1; then node --version; else printf 'Node.js: not installed\n'; fi
  if [[ -d "$task_repo/.git" ]]; then git -C "$task_repo" status --short --branch; else printf 'Project checkout: not installed\n'; fi
  exit 0
fi
if (( ${#task_missing[@]} )); then
  command -v apt-get >/dev/null 2>&1 || fail "Install these prerequisites and rerun: ${task_missing[*]}"
  task_sudo=()
  if (( EUID != 0 )); then
    command -v sudo >/dev/null 2>&1 && sudo -n true 2>/dev/null || fail 'Passwordless sudo is needed to install missing OS packages.'
    task_sudo=(sudo -n)
  fi
  log 'Installing missing OS prerequisites using signed system packages.'
  "${task_sudo[@]}" apt-get update
  "${task_sudo[@]}" env DEBIAN_FRONTEND=noninteractive apt-get install -y ca-certificates curl git xz-utils
fi
mkdir -p "$task_root/tools" "$task_root/logs" "$task_root/run"
task_free_kib="$(df -Pk "$task_root" | awk 'NR==2 {print $4}')"
(( task_free_kib >= 524288 )) || fail 'At least 512 MiB of free disk space is required.'

# Check user-owned files before stopping a process or updating the checkout.
if [[ -e "$task_repo" ]]; then
  [[ -d "$task_repo/.git" ]] || fail "Existing path is not the expected Git checkout: $task_repo"
  task_origin="$(git -C "$task_repo" remote get-url origin)"
  [[ "$task_origin" == "$task_source" || "$task_origin" == "${task_source%.git}" ]] || fail 'The existing checkout has a different origin. Nothing was overwritten.'
  [[ -z "$(git -C "$task_repo" status --porcelain)" ]] || fail 'The checkout has local changes. Commit or preserve them before rerunning.'
  [[ "$(git -C "$task_repo" branch --show-current)" == main ]] || fail 'The checkout is not on main. Select the intended branch before rerunning.'
fi
for helper in activate start.sh stop.sh; do
  if [[ -e "$task_root/$helper" ]] && ! head -n 3 "$task_root/$helper" | grep -q 'Managed by Zero Agent setup'; then
    fail "An existing user file would be overwritten: $task_root/$helper"
  fi
done

# Match the exact absolute entrypoint, including across separate SSH sessions.
if [[ -f "$task_root/run/server.pid" ]]; then
  read -r task_old_pid < "$task_root/run/server.pid"
  if [[ "$task_old_pid" =~ ^[0-9]+$ ]] && kill -0 "$task_old_pid" 2>/dev/null && [[ "$(awk '{print $3}' "/proc/$task_old_pid/stat" 2>/dev/null || true)" != Z ]]; then
    grep -azFqx "$task_repo/dist/server/index.js" "/proc/$task_old_pid/cmdline" || fail 'The recorded PID belongs to another process. Nothing was stopped.'
    (( task_start )) || fail 'A workspace server is running. Rerun with --start to update and restart it.'
    kill -TERM "$task_old_pid"
    for (( attempt=0; attempt<30; attempt++ )); do
      kill -0 "$task_old_pid" 2>/dev/null || break
      # A terminated orphan can remain a zombie until its parent reaps it.
      [[ "$(awk '{print $3}' "/proc/$task_old_pid/stat" 2>/dev/null || true)" == Z ]] && break
      sleep 0.2
    done
    if kill -0 "$task_old_pid" 2>/dev/null && [[ "$(awk '{print $3}' "/proc/$task_old_pid/stat" 2>/dev/null || true)" != Z ]]; then
      fail 'The old workspace server did not stop. Inspect it before retrying.'
    fi
  fi
  rm -f -- "$task_root/run/server.pid"
fi

if [[ "${ZERO_AGENT_USE_BUNDLED_NODE:-0}" != 1 ]] && command -v node >/dev/null 2>&1 && node -e 'const [a,b]=process.versions.node.split(".").map(Number);process.exit(a>24||(a===24&&b>=5)?0:1)' && command -v npm >/dev/null 2>&1; then
  task_node_bin="$(dirname "$(command -v node)")"
  log "Using existing Node.js $(node --version)."
else
  task_node_dir="$task_root/tools/node-v$task_node_version-linux-$task_arch"
  if [[ ! -x "$task_node_dir/bin/node" ]]; then
    task_download="$(mktemp -d "$task_root/tools/download.XXXXXX")"
    trap 'rm -rf -- "$task_download"' EXIT
    task_archive="node-v$task_node_version-linux-$task_arch.tar.xz"
    task_download_base="https://nodejs.org/dist/v$task_node_version"
    log "Installing Node.js $task_node_version in the workspace."
    curl --fail --location --silent --show-error --retry 2 "$task_download_base/$task_archive" -o "$task_download/$task_archive"
    curl --fail --location --silent --show-error --retry 2 "$task_download_base/SHASUMS256.txt" -o "$task_download/SHASUMS256.txt"
    awk -v name="$task_archive" '$2 == name {print}' "$task_download/SHASUMS256.txt" > "$task_download/expected.sha256"
    [[ "$(wc -l < "$task_download/expected.sha256")" -eq 1 ]] || fail 'Official checksum entry not found.'
    (cd "$task_download" && sha256sum --check expected.sha256)
    tar -xJf "$task_download/$task_archive" -C "$task_download"
    mv "$task_download/node-v$task_node_version-linux-$task_arch" "$task_node_dir"
    rm -rf -- "$task_download"
    trap - EXIT
  fi
  task_node_bin="$task_node_dir/bin"
fi
export PATH="$task_node_bin:$PATH"
node -e 'const [a,b]=process.versions.node.split(".").map(Number);if(a<24||(a===24&&b<5))process.exit(1)'

if [[ -e "$task_repo" ]]; then
  [[ -d "$task_repo/.git" ]] || fail "Existing path is not the expected Git checkout: $task_repo"
  task_origin="$(git -C "$task_repo" remote get-url origin)"
  [[ "$task_origin" == "$task_source" || "$task_origin" == "${task_source%.git}" ]] || fail 'The existing checkout has a different origin. Nothing was overwritten.'
  [[ -z "$(git -C "$task_repo" status --porcelain)" ]] || fail 'The checkout has local changes. Commit or preserve them before rerunning.'
  [[ "$(git -C "$task_repo" branch --show-current)" == main ]] || fail 'The checkout is not on main. Select the intended branch before rerunning.'
  git -C "$task_repo" pull --ff-only origin main
else
  git clone --branch main --single-branch "$task_source" "$task_repo"
fi

for helper in activate start.sh stop.sh; do
  if [[ -e "$task_root/$helper" ]] && ! head -n 3 "$task_root/$helper" | grep -q 'Managed by Zero Agent setup'; then
    fail "An existing user file would be overwritten: $task_root/$helper"
  fi
done
if [[ ! -e "$task_repo/.env" ]]; then
  cp "$task_repo/.env.example" "$task_repo/.env"
  chmod 600 "$task_repo/.env"
fi

log 'Installing locked dependencies, compiling, and running isolated tests.'
(
  cd "$task_repo"
  export npm_config_cache="$task_root/tools/npm-cache"
  npm ci --no-audit --no-fund
  npm run build
  env -u RESEARCH_API_KEY -u OPENAI_API_KEY npm test
)

{
  printf '# Managed by Zero Agent setup\n'
  printf 'export PATH=%q:"$PATH"\n' "$task_node_bin"
  printf 'export ZERO_AGENT_WORKSPACE=%q\n' "$task_root"
} > "$task_root/activate"
{
  printf '#!/usr/bin/env bash\n# Managed by Zero Agent setup\nset -euo pipefail\n'
  printf 'cd %q\n' "$task_repo"
  printf 'exec %q --env-file-if-exists=.env --use-env-proxy %q\n' "$task_node_bin/node" "$task_repo/dist/server/index.js"
} > "$task_root/start.sh"
{
  printf '#!/usr/bin/env bash\n# Managed by Zero Agent setup\nset -euo pipefail\n'
  printf 'task_pid_file=%q\n' "$task_root/run/server.pid"
  printf 'task_expected=%q\n' "$task_repo"
  cat <<'STOP'
if [[ -f "$task_pid_file" ]]; then
  read -r task_pid < "$task_pid_file"
  if [[ "$task_pid" =~ ^[0-9]+$ ]] && grep -azFqx "$task_expected/dist/server/index.js" "/proc/$task_pid/cmdline" 2>/dev/null; then
    kill -TERM "$task_pid"
    printf 'Stopped the Zero Agent server started by setup.\n'
  fi
  rm -f -- "$task_pid_file"
fi
STOP
} > "$task_root/stop.sh"
chmod 700 "$task_root/start.sh" "$task_root/stop.sh"

if (( task_start )); then
  if [[ -f "$task_root/run/server.pid" ]]; then
    read -r task_pid < "$task_root/run/server.pid"
    if [[ "$task_pid" =~ ^[0-9]+$ ]] && kill -0 "$task_pid" 2>/dev/null; then
      fail "A recorded server is already running. Use $task_root/stop.sh before restarting."
    fi
  fi
  # Bind only to loopback. Public HTTPS deployment is a separate step.
  export HOST=127.0.0.1
  PORT="$(node --env-file-if-exists="$task_repo/.env" -e 'process.stdout.write(process.env.PORT || "3000")')"
  export PORT
  node -e 'const n=require("node:net"),p=Number(process.env.PORT);if(!Number.isInteger(p)||p<1||p>65535)process.exit(1);const s=n.createServer();s.once("error",()=>{console.error("Port is in use. Set another PORT and rerun with --start.");process.exit(1)});s.listen(p,"127.0.0.1",()=>s.close())'
  nohup "$task_root/start.sh" > "$task_root/logs/server.log" 2>&1 < /dev/null &
  task_pid=$!
  printf '%s\n' "$task_pid" > "$task_root/run/server.pid"
  task_ready=0
  for (( attempt=0; attempt<20; attempt++ )); do
    kill -0 "$task_pid" 2>/dev/null || break
    if node -e 'fetch("http://127.0.0.1:"+process.env.PORT+"/api/health",{signal:AbortSignal.timeout(1500)}).then(async r=>{const b=await r.json();process.exit(r.ok&&b.service==="zero-agent"&&b.paperOnly===true?0:1)}).catch(()=>process.exit(1))' 2>/dev/null; then
      task_ready=1; break
    fi
    sleep 1
  done
  (( task_ready )) || fail "Startup failed. Read $task_root/logs/server.log (do not share secret values)."
  log "Server verified on VM loopback port $PORT. This is not a public website address."
fi

log 'Workspace setup and tests completed.'
printf 'Activate: source %q\n' "$task_root/activate"
printf 'Start: bash %q\n' "$task_root/start.sh"
printf 'Stop setup server: bash %q\n' "$task_root/stop.sh"
printf 'Configuration: %s/.env (preserved on reruns)\n' "$task_repo"
printf 'This script does not grant this Codex session GCP access or enable startup after VM reboot.\n'
