#!/usr/bin/env python3
"""Configure and use one verified SSH target via the managed TCP proxy."""
import argparse
import base64
import ipaddress
import json
import os
from pathlib import Path
import re
import shlex
import stat
import struct
import subprocess
import sys

ROOT = Path(__file__).resolve().parents[1]
STATE = Path(os.environ.get('ZERO_AGENT_CLOUD_ACCESS_DIR', str(ROOT / '.data/cloud-access')))
ALIAS = 'zero-bybit-cloud'
HOST_ALIAS = 'zero-bybit-verified'


def validate_target(data):
    address = ipaddress.ip_address(data.get('tailscale_ipv4', ''))
    if address.version != 4 or address not in ipaddress.ip_network('100.64.0.0/10'):
        raise ValueError('Use the VM Tailscale IPv4, not its public IP.')
    user = data.get('ssh_user', '')
    if not re.fullmatch(r'[A-Za-z_][A-Za-z0-9_.-]{0,63}', user):
        raise ValueError('Invalid Linux SSH username.')
    key = data.get('host_key', '').strip().split()
    if len(key) < 2 or key[0] != 'ssh-ed25519':
        raise ValueError('Supply the public ed25519 HOST key reported by the trusted VM SSH session.')
    try:
        blob = base64.b64decode(key[1], validate=True)
        length = struct.unpack('>I', blob[:4])[0]
        if blob[4:4+length] != b'ssh-ed25519' or len(blob) != 4+length+4+32 or struct.unpack('>I', blob[4+length:8+length])[0] != 32:
            raise ValueError()
    except Exception as exc:
        raise ValueError('Malformed SSH host public key.') from exc
    return {**data, 'tailscale_ipv4': str(address), 'ssh_user': user, 'host_key': ' '.join(key[:2])}


def check_policy(policy, address):
    if policy.get('version') != 1:
        raise ValueError('Network policy snapshot is missing or unsupported.')
    if policy.get('vpn_configured') is not True:
        raise ValueError('Tailscale VPN is not configured in this Codex environment.')
    ip = ipaddress.ip_address(address)
    if ip.version != 4 or ip not in ipaddress.ip_network('100.64.0.0/10'):
        raise ValueError('The SSH destination must be the VM Tailscale IPv4.')
    grants = policy.get('tcp_network_access', {}).get('ip_ranges', [])
    if not any(ip in ipaddress.ip_network(rule, strict=False) for rule in grants):
        raise ValueError(f'The TCP policy does not grant {address}/32. Update the supported environment configuration and replace the running environment.')


def write_private(path, text):
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    if path.is_symlink():
        raise ValueError(f'Refusing to overwrite a symlink: {path.name}')
    path.write_text(text)
    path.chmod(0o600)


def configure(data, state=STATE):
    target = validate_target(data)
    key = state / 'ssh/id_ed25519'
    if not key.is_file() or stat.S_IMODE(key.stat().st_mode) & 0o077:
        raise ValueError('The retained private SSH key is missing or has unsafe permissions. Do not generate a replacement silently.')
    tooling = json.loads((state / 'tooling.json').read_text())
    socat = Path(tooling['socat'])
    if not socat.is_file() or not os.access(socat, os.X_OK):
        raise ValueError('Run the checksum-verified runtime socat installer first.')
    hosts = state / 'ssh/known_hosts'
    line = f'{HOST_ALIAS} {target["host_key"]}'
    lines = hosts.read_text().splitlines() if hosts.exists() else []
    previous = [v for v in lines if v.split(' ', 1)[0] == HOST_ALIAS]
    if previous and any(v != line for v in previous):
        raise ValueError('SSH HOST key changed. Verify it through GCP browser SSH before replacing the saved pin.')
    if not previous:
        lines.append(line)
    config_path = state / 'ssh/config'
    if config_path.exists() and not config_path.read_text().startswith('# Managed by Zero Agent'):
        raise ValueError('Existing SSH configuration is not managed by this helper.')
    # Values with shell significance never come from the remote metadata.
    config = '\n'.join([
        '# Managed by Zero Agent', f'Host {ALIAS}',
        f'  HostName {target["tailscale_ipv4"]}', f'  User {target["ssh_user"]}',
        '  Port 22', f'  HostKeyAlias {HOST_ALIAS}',
        f'  IdentityFile {json.dumps(str(key))}',
        f'  UserKnownHostsFile {json.dumps(str(hosts))}',
        '  IdentitiesOnly yes', '  BatchMode yes', '  StrictHostKeyChecking yes',
        '  PasswordAuthentication no', '  KbdInteractiveAuthentication no',
        '  ForwardAgent no', '  ConnectTimeout 15',
        '  ServerAliveInterval 15', '  ServerAliveCountMax 2',
        f'  ProxyCommand {shlex.quote(str(socat))} STDIO PROXY:proxy:%h:%p,proxyport=8088,resolve=0', '',
    ])
    write_private(hosts, '\n'.join(lines) + '\n')
    write_private(config_path, config)
    write_private(state / 'target.json', json.dumps(target, indent=2) + '\n')
    return target


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest='command', required=True)
    configure_cmd = sub.add_parser('configure')
    configure_cmd.add_argument('metadata', type=Path)
    sub.add_parser('status')
    run = sub.add_parser('run')
    run.add_argument('remote', nargs=argparse.REMAINDER)
    args = parser.parse_args()
    if args.command == 'configure':
        target = configure(json.loads(args.metadata.read_text()))
        print(f'Profile prepared for {target["ssh_user"]}@{target["tailscale_ipv4"]}. No remote connection was attempted.')
        return
    policy_path = Path('/etc/codex/network-policy.json')
    policy = json.loads(policy_path.read_text()) if policy_path.exists() else {}
    if not (STATE / 'target.json').exists():
        raise ValueError('Waiting for the VM connection metadata. The SSH private key alone does not establish access.')
    target = validate_target(json.loads((STATE / 'target.json').read_text()))
    check_policy(policy, target['tailscale_ipv4'])
    if args.command == 'status':
        print('Saved profile and TCP policy are configured. Remote reachability/authentication have not been tested.')
        return
    remote = args.remote[1:] if args.remote[:1] == ['--'] else args.remote
    remote = remote or ['sh', '-lc', 'id -un && hostname && uname -sr']
    os.execvp('ssh', ['ssh', '-T', '-F', str(STATE / 'ssh/config'), ALIAS, shlex.join(remote)])


if __name__ == '__main__':
    try:
        main()
    except (ValueError, KeyError, OSError, TypeError) as exc:
        print(f'Cloud SSH: {exc}', file=sys.stderr)
        sys.exit(2)
