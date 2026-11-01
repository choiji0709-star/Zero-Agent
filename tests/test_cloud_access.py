import base64
import importlib.util
import json
from pathlib import Path
import subprocess
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]


def module(name):
    spec = importlib.util.spec_from_file_location(name, ROOT / 'scripts' / (name + '.py'))
    value = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(value)
    return value


ssh = module('cloud_ssh')
oidc = module('gcp_oidc_plan')


class AccessTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(prefix='zero-access-')
        self.addCleanup(self.tmp.cleanup)
        self.state = Path(self.tmp.name)
        (self.state / 'ssh').mkdir()
        self.key = self.state / 'ssh/id_ed25519'
        subprocess.run(['ssh-keygen', '-q', '-t', 'ed25519', '-N', '', '-f', str(self.key)], check=True)
        pub = self.key.with_suffix('.pub').read_text().split()
        self.target = {'tailscale_ipv4': '100.100.10.20', 'ssh_user': 'vm_user', 'host_key': ' '.join(pub[:2])}
        socat = self.state / 'test-socat'
        socat.write_text('#!/bin/sh\nexit 1\n')
        socat.chmod(0o700)
        (self.state / 'tooling.json').write_text(json.dumps({'socat': str(socat)}))

    def test_policy_requires_vpn_and_destination_grant(self):
        p = {'version': 1, 'vpn_configured': False, 'tcp_network_access': {'ip_ranges': []}}
        with self.assertRaisesRegex(ValueError, 'VPN'):
            ssh.check_policy(p, self.target['tailscale_ipv4'])
        p['vpn_configured'] = True
        with self.assertRaisesRegex(ValueError, '/32'):
            ssh.check_policy(p, self.target['tailscale_ipv4'])
        p['tcp_network_access']['ip_ranges'] = ['100.100.10.20/32']
        ssh.check_policy(p, self.target['tailscale_ipv4'])
        with self.assertRaises(ValueError):
            ssh.check_policy(p, '100.100.10.21')

    def test_target_rejects_public_ips_injection_and_malformed_host_keys(self):
        for change in [{'tailscale_ipv4': '34.64.162.16'}, {'tailscale_ipv4': '::1'}, {'ssh_user': 'user\nProxyCommand evil'}, {'ssh_user': '-oProxyCommand=evil'}, {'host_key': 'ssh-ed25519 '+base64.b64encode(b'broken').decode()}]:
            with self.subTest(change=change), self.assertRaises(ValueError):
                ssh.validate_target({**self.target, **change})

    def test_config_pins_host_and_uses_proxy_and_one_identity(self):
        ssh.configure(self.target, self.state)
        config = self.state / 'ssh/config'
        result = subprocess.run(['ssh', '-G', '-F', str(config), ssh.ALIAS], capture_output=True, text=True, check=True)
        self.assertIn('hostname 100.100.10.20', result.stdout)
        self.assertIn('stricthostkeychecking true', result.stdout)
        self.assertIn('batchmode yes', result.stdout)
        self.assertIn('identitiesonly yes', result.stdout)
        self.assertIn('proxyport=8088', result.stdout)
        self.assertIn(ssh.HOST_ALIAS, (self.state / 'ssh/known_hosts').read_text())
        before = (self.state / 'ssh/known_hosts').read_bytes()
        ssh.configure(self.target, self.state)
        self.assertEqual(before, (self.state / 'ssh/known_hosts').read_bytes())

    def test_changed_host_key_and_user_config_are_preserved(self):
        ssh.configure(self.target, self.state)
        another = self.state / 'host2'
        subprocess.run(['ssh-keygen', '-q', '-t', 'ed25519', '-N', '', '-f', str(another)], check=True)
        other_pub = ' '.join(another.with_suffix('.pub').read_text().split()[:2])
        with self.assertRaisesRegex(ValueError, 'HOST key changed'):
            ssh.configure({**self.target, 'host_key': other_pub}, self.state)
        config = self.state / 'ssh/config'
        config.write_text('# User owned file\n')
        with self.assertRaisesRegex(ValueError, 'not managed'):
            ssh.configure(self.target, self.state)
        self.assertEqual(config.read_text(), '# User owned file\n')

    def test_missing_or_exposed_private_key_is_rejected(self):
        self.key.chmod(0o644)
        with self.assertRaisesRegex(ValueError, 'unsafe permissions'):
            ssh.configure(self.target, self.state)
        self.key.unlink()
        with self.assertRaisesRegex(ValueError, 'missing'):
            ssh.configure(self.target, self.state)

    def test_oidc_plan_is_exact_subject_keyless_and_read_only(self):
        plan = oidc.build_plan('gen-lang-client-0320805195', 'https://issuer.example.com', 'codex-test', 'exact-environment-subject')
        subprocess.run(['bash', '-n'], input=plan, text=True, check=True)
        self.assertIn('roles/compute.viewer', plan)
        self.assertIn('roles/iam.workloadIdentityUser', plan)
        self.assertNotIn('roles/owner', plan)
        self.assertNotIn('keys create', plan)
        self.assertIn('assertion.sub ==', plan)

    def test_oidc_placeholder_wildcard_and_insecure_issuer_fail(self):
        for issuer, audience, subject in [('http://issuer.example.com', 'aud', 'subject'), ('https://issuer.example.com', '<copy-me>', 'subject'), ('https://issuer.example.com', 'aud', '*'), ('https://issuer.example.com', 'aud', 'x'*128)]:
            with self.assertRaises(ValueError):
                oidc.build_plan('gen-lang-client-0320805195', issuer, audience, subject)


if __name__ == '__main__':
    unittest.main()
