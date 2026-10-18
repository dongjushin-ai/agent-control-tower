# 지시문 조각: Claude Code (예약 작업 · 클라우드 세션 · `claude -p`)

사람 없이 도는 Claude Code 실행(클라우드 예약 작업, cron에서 부르는 `claude -p`, GitHub Actions 안의 Claude Code)의
프롬프트 **맨 끝**에 아래 블록을 붙이세요. 바꿀 곳은 `<작업-id>`와 `<OWNER>/<LOG-REPO>` 두 군데예요.

- **같은 저장소**: 에이전트가 `tower/`가 있는 저장소의 `main`에서 일하면 1번을 지우세요.
- **기록 전용 저장소 하나 (권장)**: `tower/`만 있는 작은 저장소(예: `agent-logs`)를 만들고, 모든 에이전트가 끝날 때
  얕게 클론해서 한 줄을 남겨요. 기능 브랜치에서 일하는 에이전트(Claude Code 클라우드 세션은 보통 그래요)도
  PR에 기록 커밋이 섞이지 않아요.

```text
## 마지막 단계: 관제탑에 이번 실행 기록하기
앞 단계가 실패했더라도 반드시 실행해. 작업-id: <작업-id>

1. 기록 저장소를 새 폴더에 클론해 (push 권한 필요):
   git clone --depth 1 https://github.com/<OWNER>/<LOG-REPO> /tmp/tower-logs && cd /tmp/tower-logs
   폴더가 이미 있으면: cd /tmp/tower-logs && git pull --ff-only
2. 한 줄을 기록하고 push 해:
   npx --yes agent-control-tower@0 log --task <작업-id> --status <ok|warn|fail> --summary "<결과 한 줄, 120자 이내>" --link "<결과 주소, 없으면 이 옵션 빼기>" --push
   - ok = 할 일을 다 함 / warn = 일부만 함(빠진 것을 요약에) / fail = 핵심 결과를 못 냄(멈춘 단계와 이유를 요약에)
   - 숫자가 있으면 --metric 이름=숫자 (여러 번 가능), 예: --metric added=3
   - 요약·링크에 비밀키, 토큰, 비밀번호, 개인정보, 고객 이름을 절대 넣지 마. CLI가 키처럼 보이는 값은 거절해.
3. node 나 npx 가 없으면 아래 JSON 한 줄을 tower/logs/<작업-id>.jsonl 맨 끝에 직접 추가하고 (at = 지금 UTC 시각) add, commit, push 해:
   {"v":1,"task":"<작업-id>","at":"2026-01-01T00:00:00Z","status":"ok","summary":"<결과 한 줄>"}
   push 가 거절되면 git pull --rebase 후 다시 push (최대 3번). 강제 push 금지.
4. 기록에 실패해도 원래 결과는 그대로 보고하고, 답변 마지막 줄에 덧붙여: tower: 기록 실패 (<이유 한 줄>)
```

- 마지막 단계 전에 죽은 실행은 아무것도 남기지 못해요. 그래서 감시 워크플로와 대시보드가
  주기 + 여유 시간(기본 `everyHours + max(1, everyHours/2)`, 또는 `graceHours`)이 지나면 **기록 끊김**으로 표시해요.
- 처음 보는 작업-id로 기록하면 `tower.config.json`에 주기 24시간으로 자동 추가돼요. 주기가 다르면 처음 한 번
  `--every 6 --name "PR 정리"`를 붙이거나 설정 파일을 고치세요.
