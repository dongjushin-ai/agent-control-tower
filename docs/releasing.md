# npm 배포 방법 (DockY용)

`v*` 태그가 생기면 GitHub Actions(`.github/workflows/release.yml`)가 테스트 후 npm에 **스테이징**해요.
스테이징된 버전은 npmjs.com에서 2FA로 승인해야 설치할 수 있게 돼요. CI가 혼자서 공개 배포하는 일은 없어요.
(npm은 2FA를 건너뛰는 토큰의 직접 배포를 2027년 1월쯤 막을 예정이라, 처음부터 이 방식으로 했어요.)

## 처음 한 번 (패키지가 아직 없을 때)

1. **2FA 켜기**: npmjs.com 프로필 > Account > Two-Factor Authentication.
2. **짧은 토큰 발급**: 프로필 > Access Tokens > Generate New Token > **Granular Access Token**.
   - 스테이징 전용(stage-only) 권한이 있으면 그걸 고르고, 없으면 Packages and scopes: Read and write
   - 대상: All packages (패키지가 아직 없어서), 만료: 7일
   - 2FA 우회(bypass) 옵션은 켜지 마세요. 스테이징은 2FA 없이 되고, 공개는 사람이 승인해요
3. **저장소에 등록**: Settings > Secrets and variables > Actions > New repository secret > 이름 `NPM_TOKEN`.
4. **릴리스 만들기**: Releases > Draft a new release > 태그 `v0.1.0` (Create new tag) > Publish release.
   `package.json`의 `version`과 태그가 같아야 해요.
5. **승인**: Actions의 Release가 초록이 되면 npmjs.com > 프로필 > Staged Packages(또는 `npm stage list`)에서
   내용을 확인하고 2FA로 **Approve**. 이때 https://www.npmjs.com/package/agent-control-tower 에 올라가요.
6. **토큰 없애기 → 신뢰할 수 있는 게시자로 전환**:
   - npmjs.com > agent-control-tower 패키지 > Settings > Trusted Publisher > GitHub Actions
     (owner `dongjushin-ai`, repo `agent-control-tower`, workflow `release.yml`, environment `npm`,
     허용 동작: stage publish)
   - npm Access Tokens에서 위 토큰을 지우고, GitHub Secrets의 `NPM_TOKEN`도 지워요.

## 다음 버전부터

`package.json` 버전과 `CHANGELOG.md`를 올려 커밋 → 같은 이름의 릴리스(`v0.1.1`) 만들기 → npmjs.com에서 Approve.
토큰은 필요 없어요. 태그와 버전이 다르면 워크플로가 일부러 실패해요. 이미 올라간 버전은 다시 올릴 수 없어요.
