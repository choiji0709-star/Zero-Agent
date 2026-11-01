# 모바일 Codex Cloud에서 zero-bybit 조작하기

목표는 **모바일 → Codex Cloud → VPN → GCP VM의 SSH**입니다. PC를 계속 켜둘 필요가 없습니다. 서버 내부의 코드·프로세스 작업은 VPN과 SSH로 수행합니다. VM 조회 등 Google Cloud 관리 API에 사용할 OIDC 자료도 아래에 준비되어 있습니다.

## 현재 준비된 것과 남은 것

| 항목                               | 상태                                                                                     |
| ---------------------------------- | ---------------------------------------------------------------------------------------- |
| 사용자 제공 공인 IP / VM 이름      | `34.64.162.16` / `zero-bybit`                                                            |
| 스크린샷의 프로젝트 ID             | `gen-lang-client-0320805195` — 해당 VM이 이 프로젝트 소속인지는 아직 API로 검증하지 못함 |
| 전용 SSH 키                        | 생성됨. 개인 키는 `.data/cloud-access/ssh/id_ed25519`에만 보관하며 Git에서 제외          |
| SSH 공개 키                        | `deploy/cloud-access/zero-bybit.pub`                                                     |
| TCP 프록시 도구                    | 공식 런타임 스킬의 체크섬 검증 설치기로 준비                                             |
| VM의 Tailscale 등록 / 공개 키 설치 | 사용자 VM에서 아래 명령 실행 필요                                                        |
| Codex 환경의 Tailscale 연결        | 사용자 계정에서 연결 키 등록 필요                                                        |
| VM의 VPN IP·사용자·호스트 공개 키  | VM 준비 명령의 결과로 확인 필요                                                          |
| 실제 SSH 접속                      | **미검증**. 위 연결과 TCP 허용이 적용된 새 환경에서 확인                                 |

## 1. GCP의 열린 SSH 창에서 VM 준비

이 작업 브랜치의 고정 커밋에서 아래 두 파일을 내려받습니다. 실행 전에 해당 커밋과 파일을 확인할 수 있습니다.

- `scripts/prepare-vm-access.sh`
- `deploy/cloud-access/zero-bybit.pub`

```bash
# 파일을 내려받은 디렉터리에서:
bash prepare-vm-access.sh --public-key-file zero-bybit.pub --expected-host zero-bybit --apply
```

스크립트는 Ubuntu/Debian에서 필요한 경우 공식 서명 APT 저장소로 Tailscale을 설치합니다. 처음에는 Tailscale 로그인 링크가 표시되므로 본인 계정으로 로그인하세요. 이미 연결되어 있으면 기존 tailnet을 유지합니다. 기존 SSH 키와 SSH 서버 설정은 보존하며, 제공한 공개 키 한 개를 현재 VM 사용자에게 추가합니다. 추가된 키는 Tailscale 주소에서만 사용할 수 있고, 포트·에이전트 포워딩과 PTY는 제한됩니다. 비대화형 명령 실행과 파일 작업용입니다.

OS Login/SSH 정책이 `authorized_keys`를 허용하지 않으면 스크립트가 중단합니다. 정책을 임의로 해제하지 말고 실제 메시지를 보고 허용된 인증 방법을 결정하세요. 관리형 Codex worker에서는 이 VM용 스크립트의 적용을 차단합니다.

완료되면 다음과 같은 **비밀 값이 아닌 JSON**이 표시됩니다.

```json
{
  "instance": "zero-bybit",
  "tailscale_ipv4": "VM에서 출력된 100.x 주소",
  "ssh_user": "VM에서 출력된 사용자",
  "host_key": "VM에서 출력된 ssh-ed25519 공개 호스트 키"
}
```

이 JSON을 채팅에 전달하면 대상 정보를 설정할 수 있습니다. Tailscale 로그인 토큰, 인증 키, SSH 개인 키는 전달하지 마세요.

## 2. Codex 환경에 같은 Tailscale 네트워크 연결

1. [Tailscale 관리 화면](https://login.tailscale.com/admin/settings/keys)에서 이 환경용 인증 키를 만듭니다. 공식 런타임 지침에 따라 **Reusable**과 **Ephemeral**을 켭니다. 두 장비는 같은 tailnet에 있어야 합니다.
2. Codex의 **Settings → Codex Cloud → Environments → Zero-Agent** 설정에서 **Tailscale** 옆 편집 아이콘을 엽니다.
3. 인증 키를 그 설정의 비밀 입력란에 직접 입력합니다. 채팅이나 저장소에는 넣지 않습니다.
4. tailnet의 접근 규칙에서 Codex 환경의 장비가 VM의 **TCP 22**에 접근하도록 허용합니다. 전체 공개 SSH 방화벽을 추가할 필요는 없습니다.
5. 설정을 저장·게시하고 새 작업을 시작합니다. SSH 개인 키와 검증 도구를 포함한 준비된 파일 시스템을 유지해야 합니다.

인증 키가 저장되었다는 것과 실제 VPN 연결은 별개입니다. 새 환경에서 `/etc/codex/network-policy.json`의 `vpn_configured`와 해당 VM IP를 포함하는 TCP CIDR 허용을 확인합니다. TCP 허용이 없으면 지원되는 환경 설정 경로에서 추가해야 합니다. 에이전트는 이 정책 파일을 편집하거나 HTTP 규칙을 TCP 권한으로 대신하지 않습니다.

## 3. 신뢰한 호스트 키로 접속 확인

VM JSON을 `.data/cloud-access/vm-report.json`으로 저장한 뒤:

```bash
python3 scripts/cloud_ssh.py configure .data/cloud-access/vm-report.json
python3 scripts/cloud_ssh.py status
python3 scripts/cloud_ssh.py run -- sh -lc 'id -un && hostname && uname -sr'
```

SSH는 제공된 개인 키 하나와 고정된 VM 호스트 키를 사용합니다. 암호 입력, 새 호스트 키 자동 수락, 에이전트 포워딩은 허용하지 않습니다. 호스트 키가 바뀌면 GCP 브라우저 SSH에서 확인하기 전까지 기존 키를 대체하지 않습니다.

이 명령은 TCP 프록시 `proxy:8088`과 소켓 도구를 사용합니다. 서버로 직접 라우트를 만들거나 worker에 Tailscale을 설치하지 않습니다. VPN 설정과 CIDR 허용은 준비 상태일 뿐, 실제 SSH 명령이 성공해야 접속이 검증됩니다.

게시된 스냅샷의 보조 실행기는 `.data/cloud-access/connect.sh`에 보관합니다. 소스 브랜치가 달라도 보관된 개인 키와 실행기를 유지할 수 있습니다.

```bash
bash .data/cloud-access/connect.sh status
bash .data/cloud-access/connect.sh run -- sh -lc 'id -un && hostname'
```

## 4. GCP 관리 API용 OIDC 준비 (서버 SSH와 별도)

Codex 환경의 **Advanced → OIDC → Add → Create connection → Google Cloud**에서 실제 **Issuer / Audience / Subject**를 확인합니다. 이 값들은 현재 연결이 없어 아직 확인되지 않았으며 임의로 만들지 않습니다.

값을 전달받으면 다음 생성기로 Google Cloud Shell에서 실행할 신뢰 설정 계획을 만들 수 있습니다.

```bash
python3 scripts/gcp_oidc_plan.py \
  --project gen-lang-client-0320805195 \
  --issuer '화면의 실제 Issuer' \
  --audience '화면의 실제 Audience' \
  --subject '화면의 정확한 Subject' \
  --output /tmp/zero-agent-oidc-plan.sh
```

생성기는 계획 파일만 만들며 Google Cloud를 변경하지 않습니다. 예시 문자열로 실행하지 마세요. 계획을 검토한 뒤 해당 프로젝트의 IAM 관리 권한이 있는 사용자로 Google Cloud Shell에서 실행합니다. 실제 VM의 프로젝트가 다르면 프로젝트 ID부터 수정해야 합니다.

계획의 범위:

- 이 Codex Subject 하나로 제한한 Workload Identity Pool/Provider
- 전용 `zero-agent-codex` 서비스 계정
- 해당 Subject의 `roles/iam.workloadIdentityUser`와 서비스 계정의 `roles/compute.viewer`
- 서비스 계정 JSON 키를 만들지 않는 단기 자격 증명
- 기존 리소스의 신뢰 설정이 다르면 재설정하지 않고 중단

기존 서비스 계정에 이미 부여된 다른 권한은 제거하지 않습니다. 재사용하는 계정의 실제 IAM 권한을 별도로 확인해야 합니다.

출력된 Workload Identity Provider와 서비스 계정 정보를 Codex 연결에 입력하고, 저장·게시 후 새 작업에서 검증합니다. 기본 권한은 VM 조회용입니다. VM 생성·삭제·중지 권한, IAM 관리 권한, 결제 권한은 부여하지 않습니다. 서버 내부 작업 권한은 SSH 사용자 권한에 따릅니다.

## 검증과 보관

```bash
python3 -m unittest discover -s tests -p 'test_cloud_access.py' -v
bash -n scripts/prepare-vm-access.sh
bash scripts/prepare-vm-access.sh --public-key-file deploy/cloud-access/zero-bybit.pub
```

테스트는 임시 키와 임시 파일로 구성·정책 검사만 검증합니다. 실제 VM 설정이나 VPN 가입을 수행하지 않습니다. 현재 연결 전에는 이를 실제 SSH 접속 성공으로 표현하지 않습니다.

`.data/cloud-access`의 개인 키가 사라지면 같은 공개 키로 접속할 수 없습니다. 준비된 환경 스냅샷을 보존하세요. 키를 조용히 새로 만들거나 개인 키를 Git/채팅으로 옮기지 않습니다.

이 환경의 스냅샷에는 개인 키가 보관됩니다. 환경을 공유하면 그 사용자가 이 키를 사용할 수 있으므로 서버 접속을 허용할 사용자에게만 환경을 공유하세요.

공식 안내: [Codex Cloud 연결](https://learn.chatgpt.com/docs/environments/cloud-environments#connect-a-cloud-identity), [Tailscale 설치](https://tailscale.com/download/linux).
