#!/usr/bin/env python3
"""Generate (do not execute) a narrowly scoped Google Cloud OIDC setup plan."""
import argparse
import json
from pathlib import Path
import re
import shlex
import sys
from urllib.parse import urlsplit


def build_plan(project, issuer, audience, subject):
    if not re.fullmatch(r'[a-z][a-z0-9-]{4,28}[a-z0-9]', project):
        raise ValueError('Invalid Google Cloud project ID.')
    url = urlsplit(issuer)
    if url.scheme != 'https' or not url.hostname or url.username or url.password or url.query or url.fragment:
        raise ValueError('Copy the HTTPS Issuer exactly from Codex Advanced > OIDC.')
    for value in [audience, subject]:
        if not value or any(c in value for c in ['\n', '\r', '\x00', '<', '>']):
            raise ValueError('Fill the actual Audience and exact Subject shown in Codex; placeholders are not valid.')
    if ',' in audience:
        raise ValueError('Supply one exact Audience, not a comma-separated audience list.')
    if '*' in subject or len(subject.encode()) > 127:
        raise ValueError('Use the exact subject, without wildcards, within the GCP subject length limit.')
    condition = 'assertion.sub == ' + json.dumps(subject)
    q = shlex.quote
    return '\n'.join([
        '#!/usr/bin/env bash', '# Review, then run in Google Cloud Shell as a project IAM administrator.',
        '# This creates keyless read-only GCP API access; SSH is configured separately.',
        'set -euo pipefail', f'project={q(project)}', f'issuer={q(issuer)}',
        f'audience={q(audience)}', f'subject={q(subject)}', f'condition={q(condition)}',
        'pool=codex-zero-agent', 'provider=codex',
        'service_account="zero-agent-codex@$project.iam.gserviceaccount.com"',
        'task_tmp="$(mktemp -d)"', 'trap \'rm -rf -- "$task_tmp"\' EXIT',
        'project_number="$(gcloud projects describe "$project" --format="value(projectNumber)")"',
        '[[ "$project_number" =~ ^[0-9]+$ ]] || { echo "Project number unavailable" >&2; exit 1; }',
        'gcloud services enable iam.googleapis.com iamcredentials.googleapis.com sts.googleapis.com compute.googleapis.com --project="$project"',
        'if ! gcloud iam workload-identity-pools describe "$pool" --location=global --project="$project" --format="value(name)" >/dev/null 2>&1; then',
        '  gcloud iam workload-identity-pools create "$pool" --location=global --project="$project" --display-name="Codex Zero Agent"',
        'fi',
        'state="$(gcloud iam workload-identity-pools describe "$pool" --location=global --project="$project" --format="value(state)")"',
        '[[ "$state" == ACTIVE ]] || { echo "Pool is not active; no existing pool was reconfigured" >&2; exit 1; }',
        'if gcloud iam workload-identity-pools providers describe "$provider" --workload-identity-pool="$pool" --location=global --project="$project" --format=json > "$task_tmp/provider.json" 2>/dev/null; then',
        '  python3 - "$task_tmp/provider.json" "$issuer" "$audience" "$condition" <<\'PY\'',
        'import json,sys',
        'with open(sys.argv[1]) as f: p=json.load(f)',
        'assert p.get("oidc",{}).get("issuerUri")==sys.argv[2], "Existing provider issuer differs; it was preserved"',
        'assert p.get("oidc",{}).get("allowedAudiences")==[sys.argv[3]], "Existing provider audience differs; it was preserved"',
        'assert p.get("attributeCondition")==sys.argv[4], "Existing provider subject condition differs; it was preserved"',
        'assert p.get("attributeMapping")=={"google.subject":"assertion.sub"}, "Existing subject mapping differs"',
        'assert not p.get("disabled",False), "Existing provider is disabled"',
        'PY',
        'else',
        '  gcloud iam workload-identity-pools providers create-oidc "$provider" --workload-identity-pool="$pool" --location=global --project="$project" --issuer-uri="$issuer" --allowed-audiences="$audience" --attribute-mapping="google.subject=assertion.sub" --attribute-condition="$condition"',
        'fi',
        'if ! gcloud iam service-accounts describe "$service_account" --project="$project" --format="value(email)" >/dev/null 2>&1; then',
        '  gcloud iam service-accounts create zero-agent-codex --project="$project" --display-name="Codex Zero Agent"',
        'fi',
        'label="$(gcloud iam service-accounts describe "$service_account" --project="$project" --format="value(displayName)")"',
        '[[ "$label" == "Codex Zero Agent" ]] || { echo "Existing service account has a different owner label; it was preserved" >&2; exit 1; }',
        'subject_path="$(python3 -c \'import sys,urllib.parse; print(urllib.parse.quote(sys.argv[1],safe=":@-._~"))\' "$subject")"',
        'member="principal://iam.googleapis.com/projects/$project_number/locations/global/workloadIdentityPools/$pool/subject/$subject_path"',
        'gcloud iam service-accounts add-iam-policy-binding "$service_account" --project="$project" --member="$member" --role=roles/iam.workloadIdentityUser',
        'gcloud projects add-iam-policy-binding "$project" --member="serviceAccount:$service_account" --role=roles/compute.viewer --condition=None',
        'printf "\\nService account: %s\\n" "$service_account"',
        'printf "Workload identity provider: projects/%s/locations/global/workloadIdentityPools/%s/providers/%s\\n" "$project_number" "$pool" "$provider"',
        'printf "Issuer/Audience/Subject must also match the connection in Codex. Save, publish, then test in a new task.\\n"', '',
    ])


def main():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument('--project', default='gen-lang-client-0320805195')
    p.add_argument('--issuer', required=True)
    p.add_argument('--audience', required=True)
    p.add_argument('--subject', required=True)
    p.add_argument('--output', type=Path, required=True)
    args = p.parse_args()
    result = build_plan(args.project, args.issuer, args.audience, args.subject)
    # Avoid overwriting a user's existing plan or following symlinks.
    with args.output.open('x') as f:
        f.write(result)
    args.output.chmod(0o700)
    print(f'Plan written to {args.output}. No GCP resources or IAM permissions were changed.')


if __name__ == '__main__':
    try:
        main()
    except (ValueError, OSError) as exc:
        print(f'OIDC plan: {exc}', file=sys.stderr)
        sys.exit(2)
