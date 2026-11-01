#!/usr/bin/env bash
# Run in the GCP VM's browser SSH session, not the Codex worker.
set -euo pipefail
umask 077
task_apply=0
task_key_file=''
task_expected_host=''
while (( $# )); do
  case "$1" in
    --apply) task_apply=1; shift ;;
    --public-key-file) [[ $# -ge 2 ]] || exit 2; task_key_file="$2"; shift 2 ;;
    --expected-host) [[ $# -ge 2 ]] || exit 2; task_expected_host="$2"; shift 2 ;;
    *) printf 'Usage: bash prepare-vm-access.sh --public-key-file FILE [--apply]\n' >&2; exit 2 ;;
  esac
done
fail() { printf 'Zero Agent access: %s\n' "$*" >&2; exit 1; }
[[ -n "$task_key_file" && -f "$task_key_file" ]] || fail 'Supply the Codex SSH public key file.'
task_public_key="$(cat "$task_key_file")"
[[ "$task_public_key" =~ ^ssh-ed25519[[:space:]][A-Za-z0-9+/=]+([[:space:]].*)?$ ]] || fail 'Expected one ed25519 PUBLIC key, not a private key.'
[[ "$(awk 'NF {n++} END {print n+0}' "$task_key_file")" -eq 1 ]] || fail 'Expected exactly one public key.'
ssh-keygen -lf "$task_key_file"
if (( ! task_apply )); then
  printf 'PLAN: install Tailscale if missing, join your tailnet, append this public key to the current SSH user, report non-secret connection metadata.\n'
  printf 'The key is restricted to Tailscale source addresses. Existing SSH keys are preserved.\n'
  exit 0
fi
[[ ! -r /etc/codex/network-policy.json ]] || fail 'Run this on the GCP VM. Never install Tailscale in the managed Codex worker.'
if [[ -n "$task_expected_host" && "$(hostname -s)" != "$task_expected_host" ]]; then
  fail 'This is not the expected VM hostname. Verify the GCP SSH target before proceeding.'
fi
(( EUID != 0 )) || fail 'Run as the normal user in GCP browser SSH, not as root.'
command -v sudo >/dev/null && sudo -n true 2>/dev/null || fail 'This VM user needs passwordless sudo for installing the VPN client.'
[[ ! -L "$HOME/.ssh" && ! -L "$HOME/.ssh/authorized_keys" ]] || fail 'SSH paths are symlinks; review them manually before changing access.'
command -v python3 >/dev/null || fail 'Python 3 is required for the non-secret connection report.'
task_sshd="$(command -v sshd || true)"
[[ -n "$task_sshd" ]] || task_sshd=/usr/sbin/sshd
[[ -x "$task_sshd" ]] || fail 'OpenSSH server is not installed.'
task_sshd_config="$(sudo -n "$task_sshd" -T -C "user=$(id -un),host=$(hostname),addr=100.64.0.1")"
grep -q '^pubkeyauthentication yes$' <<< "$task_sshd_config" || fail 'This SSH server does not permit public-key authentication.'
task_key_paths="$(awk '$1=="authorizedkeysfile" {$1=""; print}' <<< "$task_sshd_config")"
case " $task_key_paths " in
  *' .ssh/authorized_keys '*|*' %h/.ssh/authorized_keys '*|*" $HOME/.ssh/authorized_keys "*) ;;
  *) fail 'SSH policy does not read ~/.ssh/authorized_keys. Review OS Login/SSH policy before proceeding; it was not changed.' ;;
esac
[[ -r /etc/ssh/ssh_host_ed25519_key.pub ]] || fail 'The public ed25519 SSH HOST key is needed for verified client connections.'
if ! command -v tailscale >/dev/null 2>&1; then
  command -v apt-get >/dev/null || fail 'Automatic VPN installation supports Ubuntu/Debian. Install Tailscale using its official instructions, then rerun.'
  # Distribution IDs are local OS metadata, never credentials.
  . /etc/os-release
  case "$ID" in ubuntu|debian) ;; *) fail 'Use the official Tailscale installer for this distribution, then rerun.' ;; esac
  [[ "${VERSION_CODENAME:-}" =~ ^[a-z0-9]+$ ]] || fail 'Distribution codename unavailable.'
  task_tmp="$(mktemp -d)"
  trap 'rm -rf -- "$task_tmp"' EXIT
  sudo -n apt-get update
  sudo -n env DEBIAN_FRONTEND=noninteractive apt-get install -y ca-certificates curl
  if ! grep -Rqs 'pkgs.tailscale.com' /etc/apt/sources.list /etc/apt/sources.list.d 2>/dev/null; then
  curl --fail --location --silent --show-error --proto '=https' --proto-redir '=https' \
    "https://pkgs.tailscale.com/stable/$ID/$VERSION_CODENAME.noarmor.gpg" -o "$task_tmp/tailscale.gpg"
  sudo -n install -d -m 755 /etc/apt/keyrings
  if [[ -e /etc/apt/keyrings/zero-agent-tailscale.gpg ]]; then
    cmp -s "$task_tmp/tailscale.gpg" /etc/apt/keyrings/zero-agent-tailscale.gpg || fail 'An existing signing key differs. Review the official key rotation before retrying.'
  else
    sudo -n install -m 644 "$task_tmp/tailscale.gpg" /etc/apt/keyrings/zero-agent-tailscale.gpg
  fi
  printf 'deb [signed-by=/etc/apt/keyrings/zero-agent-tailscale.gpg] https://pkgs.tailscale.com/stable/%s %s main\n' "$ID" "$VERSION_CODENAME" > "$task_tmp/tailscale.list"
  if [[ -e /etc/apt/sources.list.d/zero-agent-tailscale.list ]]; then
    cmp -s "$task_tmp/tailscale.list" /etc/apt/sources.list.d/zero-agent-tailscale.list || fail 'An existing Tailscale source differs. It was preserved.'
  else
    sudo -n install -m 644 "$task_tmp/tailscale.list" /etc/apt/sources.list.d/zero-agent-tailscale.list
  fi
  fi
  sudo -n apt-get update
  sudo -n env DEBIAN_FRONTEND=noninteractive apt-get install -y tailscale
  rm -rf -- "$task_tmp"
  trap - EXIT
fi
sudo -n systemctl enable --now tailscaled
task_status="$(tailscale status --json || true)"
task_state="$(python3 -c 'import json,sys; print(json.load(sys.stdin).get("BackendState", "unknown"))' <<< "$task_status")"
if [[ "$task_state" != Running ]]; then
  printf '\nOpen the Tailscale login link below and sign in to your own tailnet.\n'
  sudo -n tailscale up --timeout=5m
fi
task_ip="$(tailscale ip -4 | head -n 1)"
python3 - "$task_ip" <<'PY'
import ipaddress,sys
assert ipaddress.ip_address(sys.argv[1]) in ipaddress.ip_network('100.64.0.0/10'), 'Expected a Tailscale IPv4 address'
PY
mkdir -p "$HOME/.ssh"
chmod 700 "$HOME/.ssh"
touch "$HOME/.ssh/authorized_keys"
chmod 600 "$HOME/.ssh/authorized_keys"
task_blob="$(awk '{print $2}' "$task_key_file")"
task_entry="restrict,from=\"100.64.0.0/10\" $task_public_key"
if ! grep -Fqx -- "$task_entry" "$HOME/.ssh/authorized_keys"; then
  if grep -Fq -- "$task_blob" "$HOME/.ssh/authorized_keys"; then
    fail 'This public key already exists with different restrictions. Review the existing entry; it was not rewritten.'
  fi
  # Begin with a newline to avoid corrupting an existing final line without one.
  printf '\n%s\n' "$task_entry" >> "$HOME/.ssh/authorized_keys"
fi
printf '\nCopy only the JSON below back to the Codex chat. It contains public connection metadata, no private keys.\n'
python3 - "$task_ip" "$(id -un)" "$(hostname -s)" <<'PY'
import json,sys,pathlib
key=pathlib.Path('/etc/ssh/ssh_host_ed25519_key.pub').read_text().strip().split()
print(json.dumps({'instance':sys.argv[3],'tailscale_ipv4':sys.argv[1],'ssh_user':sys.argv[2],'host_key':' '.join(key[:2])},indent=2))
PY
printf '\nVM preparation is complete. Codex still needs the same tailnet configured, an allowed TCP destination, and a published replacement environment.\n'
