# 작업 인계 (2026-11-26)

브랜치: `claude/affectionate-wright-xngnwh` (#29까지는 main에 머지됨. 썰매 낙하산 선물·눈사람 커밋 `bcf42b4`는 아직 이 브랜치에만 있음)

## 목표
12월 1일(한국 시간) 크리스마스 채널 오픈 준비. 기능은 다 들어갔고, 남은 큰 일은 서울 서버 이사와 실제 기기 점검.

## 완료한 것 (모두 main)
- 비공개 채널(6글자 코드), 관리자 모드(채팅 `/코드`, 해시만 `server.js` `ADMIN_HASHES`), 기기 단위 신고·차단 (`server.js` `report`, `checkDevice`)
- 접속 몰림 대비: 페이지 br/gzip+ETag, 20바이트 이진 위치 동기화(움직인 사람만, 90m 밖 초당 2번), 상한 2000명·IP당 10, `/api/stats`, `BAN_FILE`
- 크리스마스 채널 1~6단계 + 광장 전광판: 전체 목록은 `CHRISTMAS_PLAN.md`(체크 완료)와 `README.md`
- 서울 서버 이사 안내와 스크립트: `DEPLOY.md`, `deploy/setup.sh`, `deploy/update.sh` (실제 Lightsail에선 아직 미실행)

## 결정한 것
- 서버: AWS Lightsail 서울 + 가비아 .kr 도메인 + Cloudflare Tunnel (Render는 월 5GB 전송 한도라 비상용)
- 신고 차단은 IP 대신 서명된 기기 표(브라우저 localStorage `mongle-dev`). 신고자는 IP별 1명으로 셈
- 회원가입은 안 만듦 (만 14세 미만 보호자 동의 부담). 필요해지면 카카오 로그인 검토
- 크리스마스: 12월 한 달(KST), 크리스마스 채널 하나(20명 차면 2,3… 자동), 순록 이름 코코·솜이·방울·별이, 인사말은 「메리 크리스마스」(몽글 빼기)
- 캐롤은 멜로디를 확실히 아는 퍼블릭 도메인 4곡만 (징글벨·덱 더 홀스·우리 모두 즐거운 성탄·고요한 밤)
- 크리스마스 물체는 `THEME_HOOKS`로 켜고 끔. 하늘 물체 재질은 `{ cloud: false, snow: false }`
- 머지는 스쿼시. 그 뒤 같은 브랜치에 다시 쓸 땐 `git merge -s ours origin/main`로 기록 잇고 일반 push

## 남은 일
1. 사용자가 `DEPLOY.md`대로 가비아 도메인 → Lightsail 서울 → Cloudflare Tunnel 진행. 막히면 화면 보고 도와주기
2. 사용자가 실제 사이트에서 `?xmas=1`, `?xmas=1&eve=60`으로 점검한 피드백 반영 (트리 오르기, 얼음 미끄러짐, 캐롤, 썰매, 선물, 눈싸움, 피날레)
3. 이사 후 부하 시험(가짜 접속자 500~2000명)으로 상한·전송량 확인
4. 이 브랜치 PR 만들어 머지 (썰매 낙하산 선물 `DROP`, 눈사람 `SNOWMEN` + `server.js` `snowman`/`snowgone`). 서버가 바뀌었으니 재배포 필요
5. (선택) 「오 크리스마스 트리」·「기쁘다 구주」(정확한 악보 받으면)
6. (선택) 산타 웃음소리 녹음 파일 `public/airship/santa-laugh.mp3` 받으면 넣기

## 주의할 점
- 관리자 코드 원문은 저장소에 없음(사용자가 보관). 코드를 다시 만들면 `ADMIN_HASHES` 갱신
- 시험 환경: three.js r128을 scratchpad에 `npm i three@0.128.0`로 받아 Playwright가 가로채 넣어야 함. 브라우저 옵션 `--disable-features=LocalNetworkAccessChecks` 필수. 0.2fps라 실시간 연출(불꽃, 반짝이, 소리)은 못 봄 → 시험용 복사본에 `window.__t` 훅을 넣어 확인
- 시계 기반 효과는 `clock.elapsedTime`(실시간) 기준이라 느린 환경에서 수명이 짧은 입자는 안 보임
- `server.js`를 바꾸면 Render(또는 이사 후 `deploy/update.sh`) 재배포 필요하다고 사용자에게 알릴 것
- 낙하산 선물 자리는 고정된 것(길·물·트리)만으로 정함. 나무·덤불은 접속마다 무작위라 그걸로 정하면 사람마다 다른 곳에 떨어짐(`dropClear`가 각자 몇 m만 비켜 앉힘)
- 시험할 때 `page.goto`는 `waitUntil: 'domcontentloaded'`로. 브라우저 두 개는 느려서 안 열림 → 두 번째 사람은 `ws` 모듈로 `/ws`에 직접 접속
- 성능: 새 물체가 많으면 합치거나 인스턴싱, 삼각형 수 확인. 실제 휴대폰 프레임은 아직 미확인

## 관련 파일
- `public/index.html` : 게임 전체(약 7,600줄). 크리스마스 관련: `XTREE` `SLEIGH` `animDeer` `SONGS`/`carolStep` `XICE` `XLAMP` `XACTS` `openGift` `BALLS` `LOST` `FW` `tickEve` `BB`/`drawCountdown` `xmasFinale`
- `server.js` : 채널·비공개·크리스마스 방, 이진 스냅샷, 신고·차단, 관리자, 전광판 공유 권한
- `CHRISTMAS_PLAN.md` : 크리스마스 기획과 진행 체크
- `DEPLOY.md`, `deploy/` : 서울 서버 이사 안내와 스크립트
- `README.md` : 사용자용 설명(설정 환경 변수 표 포함)
