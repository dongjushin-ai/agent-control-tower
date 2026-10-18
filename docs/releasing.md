# npm 배포 방법 (DockY용, 5분)

이 저장소는 `v*` 태그를 push하면 GitHub Actions(`.github/workflows/release.yml`)가 테스트 후 npm에 올려요.
`NPM_TOKEN`이 없으면 테스트만 하고 배포는 건너뛰어요(실패하지 않아요).

1. **npm 계정 만들기**: https://www.npmjs.com/signup 에서 가입하고 이메일을 인증해요. 2FA를 켜 두세요.
2. **토큰 발급**: npm 로그인 후 프로필 > Access Tokens > Generate New Token > **Granular Access Token**.
   - Packages and scopes: Read and write
   - Bypass two-factor authentication(자동화용)을 허용해야 CI에서 쓸 수 있어요
   - 만료일은 짧게(예: 90일). 토큰 값은 한 번만 보이니 바로 다음 단계에서 써요
   - 처음 올리는 이름은 패키지가 아직 없으니 "All packages" 범위로 발급하고, 첫 배포 뒤 토큰 범위를 `agent-control-tower` 하나로 좁히면 더 안전해요
3. **저장소에 등록**: GitHub의 `dongjushin-ai/agent-control-tower` > Settings > Secrets and variables > Actions >
   New repository secret > 이름 `NPM_TOKEN`, 값은 위 토큰.
4. **태그 push**: `package.json`의 `version`과 태그가 같아야 해요(0.1.0이면 `v0.1.0`).
   ```bash
   git tag v0.1.0 && git push --tags
   ```
5. **확인**: Actions 탭의 Release 실행이 초록이면 https://www.npmjs.com/package/agent-control-tower 에 올라가 있어요.
   그다음 `npx agent-control-tower help`가 동작하는지 한 번 돌려 보세요.

다음 버전은 `package.json` 버전과 `CHANGELOG.md`를 올리고 커밋한 뒤 `git tag v0.1.1 && git push --tags`.
태그 이름과 버전이 다르면 워크플로가 일부러 실패해요. 이미 올라간 버전은 다시 올릴 수 없어요.
