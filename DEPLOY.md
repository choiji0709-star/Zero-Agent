# 웹 주소로 배포하기

이 문서는 휴대폰·PC에서 접근할 **HTTPS 주소**를 만드는 절차입니다. Codex의 개발 환경을 게시하는 것과 웹 서버를 배포하는 것은 별개이며, 클라우드 내부에서 확인한 3000번 포트는 사용자 기기의 주소가 아닙니다.

## Render로 첫 배포

1. [Render](https://dashboard.render.com/)에 로그인하고 GitHub 계정을 연결합니다.
2. **New → Blueprint**에서 `choiji0709-star/Zero-Agent` 저장소의 `main`을 선택합니다. 저장소가 비공개이면 GitHub 앱에 해당 저장소 접근을 허용해야 합니다.
3. `render.yaml` 설정으로 서비스를 생성합니다. 기본 플랜은 **Free**이며 유료 디스크나 유료 서비스를 자동으로 생성하지 않습니다.
4. 빌드·배포가 완료되고 서비스가 **Live**가 되면 Render가 표시하는 실제 `https://…onrender.com` 주소를 엽니다. 서비스 이름으로 주소를 추측하지 말고 대시보드에 표시된 값을 사용하세요.
5. 첫 로그인 사용자 이름은 **`zero`**입니다. 비밀번호는 Render가 자동 생성한 **`DASHBOARD_PASSWORD`**이며, 해당 서비스의 **Environment**에서 확인합니다. 비밀번호를 채팅이나 GitHub에 올리지 마세요.
6. AI 분석을 원하면 Render의 Environment에 `RESEARCH_API_KEY`를 비밀 값으로 등록하고 서비스를 다시 배포합니다. 없으면 규칙 기반 데모·실제 시세 모의투자가 작동합니다.

Render 계정에 로그인하거나 연결된 API 권한이 있어야 실제 서비스를 생성할 수 있습니다. 이 파일이나 개발 환경을 저장한 것만으로 공개 주소가 발급되지는 않습니다.

### Free 플랜의 범위

Render Free는 약 15분간 외부 요청이 없으면 중지되고, 다음 접속 시 다시 시작하는 데 약 1분이 걸릴 수 있습니다. SQLite 파일은 재시작·배포·중지 시 사라질 수 있습니다. 이 제한은 화면에도 표시됩니다. 따라서 **항상 켜진 운용과 거래 기록 보존을 위한 최종 호스팅은 아닙니다.**

24시간 운용에는 상시 실행되는 플랜과 영속 디스크 또는 외부 데이터베이스가 필요합니다. 유료 플랜은 비용을 확인한 뒤 별도로 선택하세요. 자동 분석은 프로세스 재시작 시 꺼집니다.

## GCP SSH에서 전용 작업환경 준비

GCP 콘솔에서 VM의 **SSH**를 열고 `scripts/setup-gcp.sh`를 실행할 수 있습니다. 기본 폴더는 `~/zero-agent-workspace`이며, Node.js가 없거나 버전이 낮으면 공식 체크섬을 확인한 Node.js 24를 이 폴더에 설치합니다. 프로젝트를 내려받고 잠금 파일로 의존성을 설치한 뒤 빌드와 테스트를 실행합니다.

```bash
# 저장소가 이미 있는 경우, 해당 디렉터리에서 실행
bash scripts/setup-gcp.sh --start
```

- `--check`: 현재 호스트와 필수 도구 상태만 확인합니다.
- 옵션 없음: 작업환경·의존성·빌드·테스트와 실행 도우미를 준비합니다.
- `--start`: 위 준비 후 VM의 루프백 주소에서 서버를 시작하고 상태 응답을 확인합니다. 기본 포트는 3000입니다. 이미 사용 중이면 `PORT=3001 bash scripts/setup-gcp.sh --start`처럼 다른 포트를 지정하세요.
- 재실행 시 `.env`와 모의 계좌 기록을 보존합니다. 추적 파일에 로컬 변경이 있거나 원격 저장소가 다르면 덮어쓰지 않고 중단합니다.
- 자신이 기록한 PID와 절대 경로의 실행 파일이 일치하는 서버만 재시작합니다. 다른 봇이나 프로세스를 종료하지 않습니다.

구성 후 사용할 명령:

```bash
source ~/zero-agent-workspace/activate
bash ~/zero-agent-workspace/start.sh
bash ~/zero-agent-workspace/stop.sh
```

설정은 `~/zero-agent-workspace/app/.env`, 시작 로그는 `~/zero-agent-workspace/logs/server.log`에 보관됩니다. 실행 도우미를 직접 실행하면 포그라운드로 실행되며, `--start`는 로그를 남기고 SSH 셸과 분리해 실행합니다. VM 재부팅 후 자동 실행은 이 스크립트에 포함하지 않습니다.

GCP 브라우저 SSH 인증은 그 브라우저 세션의 권한입니다. 이 스크립트는 이를 사용해 서버 안에서 작업하며, Codex 작업에 GCP 계정·SSH 권한을 전달하지 않습니다. 공개 HTTPS 주소, GCP 방화벽 변경, 재부팅 후 자동 실행은 별도 배포 단계입니다.

## 자신의 서버에서 Docker로 실행

Docker Engine와 Compose가 설치된 서버에서:

```bash
git clone https://github.com/choiji0709-star/Zero-Agent.git
cd Zero-Agent
docker compose up -d --build
docker compose logs --tail=60
```

기본 포트는 서버 자신의 루프백에만 연결됩니다. 외부 접속은 서버의 HTTPS 역방향 프록시와 도메인으로 연결하세요. 공개 운영 전 서버의 `.env`에 강한 `DASHBOARD_PASSWORD`를 설정하세요. 브라우저 로그인 사용자 이름은 `zero`입니다. `DASHBOARD_AUTH_REQUIRED=1`을 함께 설정하면 비밀번호 없이 서버가 시작되지 않습니다. Compose는 데이터 볼륨과 재시작 정책을 사용합니다.

```bash
# 컨테이너 상태 및 로그
docker compose ps
docker compose logs --tail=100

# 버전 업데이트
git pull --ff-only
docker compose up -d --build
```

Compose의 `zero-agent-data` 볼륨을 보존하세요. `docker compose down -v`는 기록을 삭제하므로 일반 업데이트에 사용하지 않습니다. 서버 재부팅 후에는 Docker 자체도 시작되어야 합니다.

## 배포 확인

실제 발급된 주소에서 다음을 확인합니다.

- `/api/health` 응답이 `status: ok`, `paperOnly: true`인지 확인합니다.
- 대시보드·계좌·주문 API는 로그인 전 `401`을 반환해야 합니다.
- 로그인 후 **데모 → 분석 실행**에서 의견과 모의 주문 기록이 생성되는지 확인합니다.
- 휴대폰과 PC에서 같은 HTTPS 주소로 로그인할 수 있는지 확인합니다.
- 분석이 실패하면 호스팅 서비스의 로그와 네트워크 접근을 확인하되, 비밀 키 값을 출력하지 마세요.

서버·컨테이너 내부 검증과 실제 공개 주소에서의 검증은 구분합니다. 공개 주소가 발급되기 전에는 배포가 완료된 것이 아닙니다.
