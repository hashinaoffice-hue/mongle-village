# 작업 인계 (2026-11-18)

브랜치: `claude/affectionate-wright-xngnwh` (작업은 전부 main에 머지됨. 다음 세션은 main에서 시작하면 된다)

## 목표
몽글 마을(3D 멀티플레이 산책 게임)에 새 장소와 기능을 하나씩 더하고, 그때마다 PR로 main에 스쿼시 머지한다.

## 완료한 것 (이번 세션, 모두 main에 머지)
- #15 반딧불 동굴: 폭포 뒤 숨은 동굴, 폭신 버섯 점프, 박쥐 초롱 (`CAVE`, `tickCave`)
- #16·#17 별빛 언덕과 천문대: 동쪽 언덕, 망원경 깊은 우주와 별자리 8개, 두더지 두두 (`HILL`, `tickHill`)
- #18 너른 들판: 반지름 200(`RING`) 안 어디든 걸을 수 있게, 쉼터 3곳 (`SPOTS`: 꽃동산·연잎 연못·모닥불 야영지)
- #19·#20 화면 공유(빔 프로젝터): WebRTC로 허공에 홀로그램 화면, 크기 60~400% (`Beam`, `tickBeam`)
- #21·#23 비행선 전광판: 광장 위를 도는 곰돌이 비행선, 전광판은 환영 그림 한 장 (`SHIP`, `tickShip`)
- #22 렉 수정: 들꽃을 저해상도로, 40m 칸으로 나눠 가까운 칸만 그림 (`flowerGeo`, `FLOWER_SPH`)
- 맵 후보 기록: `MAP_IDEAS.md`

## 결정한 것
- 실내 공간은 맵 동쪽 멀리(x>1000)에 따로 둔다: 할아버지 나무 안 (1400,0), 동굴 (1400,400). `player.zone`, `portals`, `baseY`로 연결
- 앉는 자리는 `seats`에 넣는다. `fp`(1인칭), `up`(하늘 보기), `zoom`(망원경 FOV) 옵션이 있다
- 화면 공유: 영상은 사람끼리 직접(STUN만, TURN 없음). 서버는 `screen`·`rtc`·`scr` 메시지만 중계
- 비행선과 전광판은 서버 시계(`shipNow()` = Date.now()+WX.off)로 계산해 모두 같은 위치·같은 장면. 서버에 상태 없음
- 전광판 내용: `public/airship/playlist.json` (README에 형식). 서버가 `/airship/` 폴더만 안전하게 내보냄
- 진행(별사탕, 별자리)은 저장하지 않는다(README 방침). 바꾸려면 사용자에게 먼저 물을 것
- 머지는 스쿼시. 그 뒤 같은 브랜치에 다시 푸시할 땐 `git merge -s ours origin/claude/affectionate-wright-xngnwh`로 기록을 이은 뒤 일반 push (force push 안 씀)

## 남은 일
1. 사용자가 친구와 화면 공유를 시험해 보고, 다른 집 인터넷끼리 안 되면 TURN 서버 붙이기 (`Beam.ICE`)
2. 다음 맵: 추천은 구름 섬 (무지개 다리, 폭신 점프 재사용, 비 온 채널에만). 나머지 후보는 `MAP_IDEAS.md`
3. 지도에 쉼터 3곳 아이콘 추가 (`buildMapBg`)
4. 휴대폰에서 지도·망원경·비행선 점검

## 주의할 점
- 성능: 새 물체가 많으면 삼각형 수를 잴 것. 들꽃 하나로 프레임당 830만 개가 생겨 렉이 났었다. 많은 물체는 `grassChunks`에 넣으면 거리·시야 밖에서 안 그려진다
- 시험 환경: cdnjs가 막혀 있어 three.js r128을 npm(`three@0.128.0`)에서 받아 Playwright로 가로채 넣어야 한다. 헤드리스 swiftshader는 0.2fps로 매우 느리다
- 로컬 웹소켓 시험엔 `--disable-features=LocalNetworkAccessChecks` 플래그가 필요하다
- 확인 못 한 것: 실제 GPU·휴대폰 프레임, 화면 공유 소리와 다른 네트워크 연결, 비행선 밤 모습
- 서버(`server.js`)를 바꾸면 Render 재배포 후에 동작한다고 사용자에게 알릴 것

## 관련 파일
- `public/index.html` : 게임 전체(약 6,700줄, 섹션마다 `/* ---- 이름 ---- */` 머리글)
- `server.js` : 채널·위치·채팅·유성우·UFO·화면 공유 중계·`/airship/` 파일 서빙
- `public/airship/` : 전광판 재생 목록과 `welcome.png`
- `MAP_IDEAS.md` : 만든 곳과 다음 맵 후보
- `README.md` : 사용자용 설명(한국어)
