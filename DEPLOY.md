# 서울 서버로 이사하기 (Lightsail + .kr 도메인 + Cloudflare)

12월 크리스마스 이벤트 때 사람이 몰려도 버티도록, Render 무료 서버에서 서울 서버로 옮기는 안내예요.

```
접속자 ─ https://mongle.kr ─▶ Cloudflare (공짜: 압축·캐시·공격 막기·진짜 IP 알려 주기)
                                  │  Cloudflare Tunnel (서버가 먼저 Cloudflare로 연결해요. 서버 문은 SSH 말고 다 닫아요)
                                  ▼
                      AWS Lightsail 서울 (Ubuntu) ─ node server.js (127.0.0.1:8787)
```

## 왜 옮기나요

| | Render 무료 (지금) | Lightsail 서울 |
|---|---|---|
| 데이터 전송 | 한 달 5GB 포함, 넘으면 1GB에 0.15달러 | 요금제에 TB 단위로 포함 |
| 잠들기 | 15분 동안 아무도 없으면 잠들고, 깨는 데 30초~1분 | 늘 켜져 있어요 |
| 위치 | 미국 오리건 (한국에서 지연이 커요) | 서울 |
| 차단 기록 | 재시작하면 사라져요 | 파일로 남아요 (`BAN_FILE`) |

참고로 동시 접속 1,000명이면 위치 동기화만으로 시간당 수 GB가 나가요. 코드에서 많이 줄였지만, 포함량이 넉넉한 서버가 안전해요.

## 1. 도메인 사기 (가비아)

1. [가비아](https://www.gabia.com)에서 원하는 `.kr` 주소를 검색해서 사요. 예: `mongle.kr`, `monglemaeul.kr`
2. 아직 다른 설정은 하지 마세요. 3단계에서 Cloudflare가 알려 주는 「네임서버」로 바꿔요.

## 2. 서버 만들기 (AWS Lightsail 서울)

1. [AWS](https://aws.amazon.com/ko/lightsail/)에 가입하고 Lightsail 콘솔에 들어가요.
2. **인스턴스 생성**
   - 위치: **서울 (ap-northeast-2)**
   - 플랫폼: Linux/Unix, 블루프린트: **OS 전용 → Ubuntu 24.04 LTS**
   - 요금제: **메모리 1GB 이상**인 것 중 가장 싼 것 (요금 화면에서 「데이터 전송」 포함량도 확인해 주세요)
   - 이름: `mongle`
3. 만들어지면 인스턴스 → **네트워킹** 탭 → IPv4 방화벽에서 **HTTP(80) 규칙을 지워요**. SSH(22)만 남겨요.
   (Cloudflare Tunnel이 안쪽에서 바깥으로 연결하기 때문에 다른 문은 필요 없어요.)
4. 인스턴스의 **「SSH를 사용하여 연결」** 버튼을 누르면 브라우저에 검은 창(터미널)이 열려요. 아래 명령을 그대로 붙여 넣어요.

```bash
curl -fsSL https://raw.githubusercontent.com/hashinaoffice-hue/mongle-village/main/deploy/setup.sh -o setup.sh
```

```bash
sudo bash setup.sh
```

끝에 「서버가 켜졌어요」가 나오면 성공이에요.

## 3. Cloudflare 연결

1. [Cloudflare](https://dash.cloudflare.com/sign-up)에 가입하고 **사이트 추가**에서 산 도메인을 넣어요. 요금제는 **Free**.
2. Cloudflare가 네임서버 2개(예: `xxx.ns.cloudflare.com`)를 알려 줘요. 가비아 → My가비아 → 도메인 관리 → **네임서버 설정**에서 그 2개로 바꿔요.
   바뀌는 데 몇 분~하루쯤 걸려요. Cloudflare에서 「활성」이 되면 다음으로 가요.
3. Cloudflare 왼쪽 메뉴 **Zero Trust → 네트워크 → Tunnels → 터널 만들기**
   - 종류: **Cloudflared**, 이름: `mongle`
   - 「환경 선택」에서 **Debian / 64-bit**를 고르면 설치 명령이 나와요. 그 명령을 2단계의 서버 터미널에 붙여 넣어요.
     (마지막 줄이 `sudo cloudflared service install ...` 처럼 생겼어요. 이 안의 긴 토큰은 비밀번호와 같으니 남에게 보여 주지 마세요.)
   - **공개 호스트 이름**: 도메인에 산 주소(하위 도메인은 비워 둠), 서비스: **HTTP**, URL: **`localhost:8787`**
4. 브라우저에서 `https://산-주소`로 들어가 보세요. 마을이 뜨면 이사 끝이에요.

## 4. 이사 뒤

- **새 버전 올리기**: GitHub main에 합친 뒤 서버 터미널에서

```bash
sudo bash /opt/mongle-village/deploy/update.sh
```

  다시 켜는 순간 접속한 사람들은 채널 고르는 화면으로 돌아가요. 사람이 적은 시간에 해 주세요.
- **설정 바꾸기**: `sudo nano /etc/mongle.env`에서 고치고(예: `XMAS=1`) `sudo systemctl restart mongle`
- **운영 현황**: `https://산-주소/api/stats` (접속자 수, 채널별 인원, 초당 내보내는 양 KB/s, 차단 수)
- **서버 기록 보기**: `sudo journalctl -u mongle -f` (입장·퇴장·신고가 보여요. 나갈 땐 Ctrl+C)
- **Render**: 바로 지우지 말고 1~2주 비상용으로 남겨 두세요. 친구들에게는 새 주소를 알려 주세요.

## 사람이 아주 많이 몰리면

- `/api/stats`의 `players`가 `MAX_PLAYERS`(기본 2000)에 가까워지거나, Lightsail 화면의 CPU 그래프가 오래 높게 머무르면 더 큰 요금제로 올려요 (Lightsail 「스냅샷」으로 복제해서 큰 인스턴스로 만들 수 있어요).
- 한 대로도 모자라면 채널을 서버 여러 대에 나눠요. 채널끼리 서로 독립이라 나누기 쉬운 구조예요. 필요해지면 그때 만들어요.
