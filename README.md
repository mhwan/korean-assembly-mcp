# korean-assembly-mcp

국회 공개 데이터를 Claude 같은 MCP 클라이언트에서 바로 조회하는 stdio MCP 서버입니다.
의원·법안·표결·일정·회의록 발언·국정감사 보고서·소속기관 발간물을 찾고, 중계 중인 회의의 AI 자막을 녹화해 회의록이 나오기 전에도 발언을 정리할 수 있습니다.

- 도구 17개, 요약 프롬프트 3개
- 제22대 국회 기준
- 한 번 가져온 회의록·자막·보고서 본문은 로컬 SQLite 색인에 쌓여 날짜와 상관없이 다시 검색됩니다

## 데이터 원천

| 원천 | 쓰는 곳 |
|---|---|
| 열린국회정보 OpenAPI (`open.assembly.go.kr`) | 의원, 법안, 표결, 일정, 회의록 목록, 발언영상, 국감 보고서, 발간물 |
| 국회회의록 시스템 (`record.assembly.go.kr`) | 회의록 전문(의원별 발언 원문) |
| 의안정보시스템 (`likms.assembly.go.kr`) | 의안 첨부 문서(검토보고서·심사보고서 등) |
| 국회 의사중계 (`assembly.webcast.go.kr`) | 중계 목록, AI 자막 WebSocket |
| 국회도서관 발언 데이터 (`dataset.nanet.go.kr`) | 가져온 적 없는 회의까지 찾는 원격 전문 검색 |

국회 사이트들은 curl 같은 비브라우저 요청에 400을 돌려줍니다. 그래서 이 서버는 시스템 Chrome을 헤드리스로 띄우고, 대상 사이트 페이지 안에서 `fetch` 해 응답을 받습니다. User-Agent는 바꾸지 않습니다.

## 요구 사항

| 항목 | 용도 | 비고 |
|---|---|---|
| Node.js | 서버 실행 | 내장 `node:sqlite`·`WebSocket` 을 씁니다. v26.12.1 에서 확인했습니다. `node:sqlite` 를 플래그 없이 쓰려면 22.13 이상이 필요하지만, 그 버전에서는 돌려 보지 않았습니다 |
| Google Chrome | 국회 사이트 호출 | 설치된 Chrome 을 OS별 기본 위치에서 찾아 씁니다(브라우저를 따로 받지 않음) |
| pdftotext (poppler) | 검토보고서·국감 보고서 PDF 본문 추출 | 없어도 서버는 돌고, `assembly_bill_reports`·`assembly_audit_reports` 의 본문 읽기만 실패합니다 |
| 열린국회정보 인증키 | OpenAPI 호출 | 아래 "인증키" 참고 |

### 지원 OS

| OS | 상태 |
|---|---|
| macOS (Apple Silicon) | 테스트로 확인 |
| macOS (Intel), Windows, Linux | 경로와 프로세스 처리는 OS별로 맞춰 두었지만 실제로 돌려 보지는 않았습니다 |

Chrome 은 다음 위치에서 찾습니다. 다른 곳에 있으면 `ASSEMBLY_CHROME` 에 실행 파일 경로를 넣습니다.

- macOS: `/Applications/Google Chrome.app`
- Windows: `%LOCALAPPDATA%`, `%ProgramFiles%`, `%ProgramFiles(x86)%` 아래 `Google\Chrome\Application\chrome.exe`
- Linux: `/opt/google/chrome/chrome` (Google 이 배포하는 패키지 기준. 배포판 저장소의 Chromium 은 `ASSEMBLY_CHROME` 으로 지정)

## 설치

```bash
git clone https://github.com/mhwan/korean-assembly-mcp.git
```

```bash
cd korean-assembly-mcp
```

```bash
npm ci
```

### pdftotext

macOS:

```bash
brew install poppler
```

Ubuntu·Debian:

```bash
sudo apt install poppler-utils
```

Windows: [Scoop](https://scoop.sh) 을 쓰면 아래 명령으로 `pdftotext.exe` 가 `PATH` 에 들어갑니다. Scoop 없이 하려면 [poppler-windows](https://github.com/oschwartz10612/poppler-windows/releases) 릴리스 zip 을 풀고 `Library\bin` 폴더를 `PATH` 에 넣거나, `ASSEMBLY_PDFTOTEXT` 에 `pdftotext.exe` 경로를 넣습니다.

```powershell
scoop install poppler
```

`PATH` 를 바꿨다면 MCP 클라이언트를 다시 시작해야 반영됩니다.

### 인증키

[열린국회정보](https://open.assembly.go.kr)에 로그인한 뒤 "인증키 발급" 메뉴에서 받습니다. 키 없이도 응답은 오지만, 이 경우 받을 수 있는 행 수가 제한되는지는 확인하지 않았습니다.

키는 둘 중 한 곳에 둡니다. 환경 변수가 우선입니다.

1. 환경 변수 `ASSEMBLY_API_KEY`
2. 파일 `~/.config/assembly-data/credentials`

```bash
mkdir -p ~/.config/assembly-data
```

```bash
printf 'ASSEMBLY_API_KEY=발급받은키\n' > ~/.config/assembly-data/credentials
```

```bash
chmod 600 ~/.config/assembly-data/credentials
```

Windows(PowerShell)에서는 같은 파일을 `C:\Users\<이름>\.config\assembly-data\credentials` 에 만듭니다.

```powershell
New-Item -ItemType Directory -Force "$HOME\.config\assembly-data"
```

```powershell
Set-Content -Path "$HOME\.config\assembly-data\credentials" -Value "ASSEMBLY_API_KEY=발급받은키" -Encoding ascii
```

`>` 나 `Out-File` 로 만들면 Windows PowerShell 5.1 에서는 UTF-16 으로 저장돼 키를 읽지 못하니 `Set-Content` 를 씁니다.

## MCP 클라이언트에 등록

GUI 앱은 셸의 `PATH` 를 물려받지 않을 수 있으니 `node` 는 절대 경로로 적습니다. macOS·Linux 는 `which node`, Windows 는 `where.exe node` 로 확인합니다.

### Claude Code

macOS·Linux(아래는 Homebrew 의 node 경로입니다. `which node` 결과로 바꿉니다):

```bash
claude mcp add --scope user assembly -- /opt/homebrew/bin/node /절대경로/korean-assembly-mcp/src/server.js
```

Windows:

```powershell
claude mcp add --scope user assembly -- "C:\Program Files\nodejs\node.exe" C:\절대경로\korean-assembly-mcp\src\server.js
```

### Claude Desktop

설정 파일 위치:

- macOS: `~/Library/Application Support/Claude/claude_desktop_config.json`
- Windows: `%APPDATA%\Claude\claude_desktop_config.json`

macOS:

```json
{
  "mcpServers": {
    "assembly": {
      "command": "/opt/homebrew/bin/node",
      "args": ["/절대경로/korean-assembly-mcp/src/server.js"]
    }
  }
}
```

Windows(JSON 안에서는 `\` 를 `\\` 로 적습니다):

```json
{
  "mcpServers": {
    "assembly": {
      "command": "C:\\Program Files\\nodejs\\node.exe",
      "args": ["C:\\절대경로\\korean-assembly-mcp\\src\\server.js"]
    }
  }
}
```

인증키를 파일 대신 환경 변수로 넘기려면 `"env": { "ASSEMBLY_API_KEY": "..." }` 를 더합니다.

다른 MCP 클라이언트도 명령은 `node`, 인자는 `server.js` 의 절대 경로 하나로 등록하면 됩니다.

등록한 뒤 클라이언트를 다시 시작해야 도구가 보입니다.

## 도구

### 회의록·발언

| 도구 | 하는 일 | 주요 인자 |
|---|---|---|
| `assembly_committee_meetings` | 기간 안의 위원회 회의록·국감 회의록 목록. 회의번호(`confer_num`)와 안건을 줍니다 | `from`, `to`(최대 62일), `committee` |
| `assembly_meeting_speeches` | 회의록 전문을 의원별로 묶은 발언 원문. 정당·지역구 포함, 특정 의원을 고르면 장관·증인 답변도 붙습니다 | `confer_num`, `members`, `max_chars_per_member`, `with_replies`, `include_chair` |
| `assembly_speech_clips` | 의원 발언영상 목록. 누가 몇 번, 몇 분 질의했는지 줍니다. `member` 를 주면 그 의원의 영상 구간과 링크도 나옵니다(원문 없음) | `date`, `title`, `member` |
| `assembly_live` | 지금 의사중계 목록 | `only_live` |
| `assembly_live_captions_record` | AI 자막 녹화 시작·상태 확인. 인자 없이 부르면 상태만 봅니다 | `xcode`, `all` |
| `assembly_live_captions` | 녹화한 자막을 질의 의원 블록으로 묶어 줍니다(화자는 추정값) | `date`, `committee`, `member`, `from`·`to`(HH:MM) |

### 의원·법안·표결

| 도구 | 하는 일 | 주요 인자 |
|---|---|---|
| `assembly_members` | 의원 인적사항(정당·지역구·소속위원회·당선횟수·연락처). 조건 없으면 전원 | `name`, `party`, `committee`, `district` |
| `assembly_bills` | 법률안 검색, 제안일 최신순. 기본은 의원 발의안 | `name`, `proposer`, `proposer_kind`(의원·위원장·정부), `committee`, `result`, `from`, `to`, `limit` |
| `assembly_bill_detail` | 단계별 일자·결과, 제안이유, 제안자, 위원회 심사 회의, 대안과 원안 관계 | `bill_id` 또는 `bill_no` |
| `assembly_bill_reports` | 의안 첨부 문서 목록과 고른 문서의 본문(기본 검토보고서) | `bill_id`·`bill_no`, `doc`, `offset`, `max_chars` |
| `assembly_votes` | 본회의 표결: 찬반 집계, 정당별·의원별 표결 | `bill_id`, `member`, `party` |

### 국감·발간물·일정

| 도구 | 하는 일 | 주요 인자 |
|---|---|---|
| `assembly_audit_reports` | 국정감사 결과보고서(2000~)와 정부 처리결과보고서(2001~2015년도분). 목록 또는 본문, 본문 안 검색 | `kind`, `year`, `query`, `doc_id`, `section`, `find`, `offset` |
| `assembly_publications` | 법제실·입법조사처·예산정책처·미래연구원·국회도서관 발간물 검색 | `query`, `source`, `div`, `from`, `to` |
| `assembly_schedule` | 본회의·위원회·국회행사·세미나 일정 | `date`(YYYY-MM-DD, YYYY-MM, YYYY), `kind`, `committee` |

### 검색·범용

| 도구 | 하는 일 | 주요 인자 |
|---|---|---|
| `assembly_search` | 로컬 색인 전문 검색. 로컬에 없으면 국회도서관 원격 검색 | `query`, `sources`, `from`, `to`, `committee`, `speaker`, `remote` |
| `assembly_index` | 색인 상태 확인, 기간 회의록 일괄 색인, 자막 녹화 색인 | `action`(status·meetings·captions), `from`, `to`, `committee`, `force`, `date` |
| `assembly_openapi` | 열린국회정보 OpenAPI 범용 호출. 쓸 수 있는 서비스 ID와 요청 변수는 도구 설명에 나옵니다 | `service`, `params`, `page`, `size` |

검색어 규칙(`assembly_search`): 띄어쓰기는 무시하고(전세사기 = 전세 사기), 공백으로 나눈 낱말은 모두 들어 있어야 하며, `"따옴표"` 로 묶으면 한 낱말로 봅니다. 원격 검색은 형태소 검색이라 낱말이 나뉘어 걸린 결과가 섞일 수 있습니다.

## 프롬프트

| 프롬프트 | 하는 일 | 인자 |
|---|---|---|
| `summarize_committee_speeches` | 회의 하나를 의원별 질의 요지·답변·해시태그로 정리 | `confer_num`, `members` |
| `summarize_meeting` | 회의 하나를 개요·핵심 논의사항·안건 처리·주제 태그·참석자·분량으로 요약 | `confer_num`, `date`, `committee` |
| `summarize_live_captions` | 녹화한 당일 자막을 질의 의원별 요지로 정리 | `committee`, `date` |

## 사용 흐름

### 지난 회의를 의원별로 정리

1. `assembly_committee_meetings` 로 날짜·위원회의 `confer_num` 을 찾습니다.
2. `summarize_committee_speeches` 나 `summarize_meeting` 프롬프트에 그 번호를 넣습니다.

### 오늘 회의를 회의록 공개 전에 정리

1. `assembly_live` 로 중계 목록과 `xcode` 를 봅니다.
2. 회의가 끝나기 전에 `assembly_live_captions_record` 로 녹화를 겁니다. 자막 서버는 접속한 뒤의 문장만 보내므로, 지난 구간은 다시 받을 수 없습니다.
3. `summarize_live_captions` 프롬프트나 `assembly_live_captions` 로 정리합니다.

### 법안 하나를 끝까지 따라가기

`assembly_bills` → `assembly_bill_detail` → `assembly_bill_reports`(검토보고서) → `assembly_votes`

대안반영폐기된 법안은 `assembly_bill_detail` 이 붙여 주는 대안의 `bill_id` 로 표결을 찾습니다.

## 데이터 공개 시점

| 데이터 | 언제 볼 수 있나 | 도구 |
|---|---|---|
| AI 자막 | 중계 중에만. 녹화해 둔 것만 남습니다 | `assembly_live_captions` |
| 발언영상 목록 | 회의 당일 저녁~다음 날 | `assembly_speech_clips` |
| 회의록 전문 | 회의 후 약 1주(국감은 목록만 먼저 뜨고 전문은 늦게 열림) | `assembly_meeting_speeches` |
| 국회도서관 발언 데이터 | 회의 후 약 2주 | `assembly_search`(원격) |

공개 시점은 2026년 10월에 관찰한 값이라 달라질 수 있습니다.

## 환경 변수와 로컬 저장 위치

| 변수 | 기본값 | 설명 |
|---|---|---|
| `ASSEMBLY_API_KEY` | `~/.config/assembly-data/credentials` 에서 읽음 | 열린국회정보 인증키 |
| `ASSEMBLY_CHROME` | OS별 기본 설치 위치("지원 OS" 참고) | Chrome 실행 파일 |
| `ASSEMBLY_PDFTOTEXT` | `/opt/homebrew/bin`, `/usr/local/bin` 순으로 찾고, 없으면 `PATH` 의 `pdftotext` | pdftotext 실행 파일 |
| `ASSEMBLY_REPORT_DIR` | `~/.cache/assembly-mcp/reports` | 받은 PDF와 추출 텍스트 캐시 |
| `ASSEMBLY_CAPTION_DIR` | `~/.cache/assembly-mcp/captions` | 자막 녹화 파일(날짜별 폴더), 녹화기 로그 |
| `ASSEMBLY_INDEX_DB` | `~/.cache/assembly-mcp/index.db` | 로컬 검색 색인(SQLite FTS5) |
| `ASSEMBLY_INDEX` | (없음) | `off` 면 도구를 써도 색인에 저장하지 않습니다 |

`~` 는 Windows 에서 사용자 폴더(`C:\Users\<이름>`)입니다. 캐시를 지우려면 `~/.cache/assembly-mcp` 를 통째로 지우면 됩니다. 색인도 함께 사라집니다.

## 자막 녹화기를 따로 돌리기

`assembly_live_captions_record` 는 내부에서 녹화기를 별도 프로세스로 띄웁니다. 저장소 폴더에서 직접 돌릴 수도 있습니다.

```bash
node src/caption-recorder.js --all
```

```bash
node src/caption-recorder.js 63 25
```

- `--all`: 지금·앞으로 중계되는 자막 방송을 모두 녹화합니다. 중계가 모두 끝나고 30분 지나면 멈춥니다.
- `xcode` 지정: 그 방송만 녹화하고, 끝나고 5분 뒤 멈춥니다.
- 어느 쪽이든 최대 16시간 뒤에는 멈춥니다. 같은 대상으로 두 번 띄우면 뒤의 것은 바로 끝납니다.
- 로그: `~/.cache/assembly-mcp/captions/recorder.log`
- 녹화기가 강제 종료되거나 컴퓨터를 재시작한 뒤에 녹화기를 띄웠는데 "이미 녹화 중" 이 나오고 녹화가 되지 않으면, 남아 있는 잠금 파일 `~/.cache/assembly-mcp/captions/recorder-*.json` 을 지우고 다시 띄웁니다. 잠금 파일에 적힌 PID 를 다른 프로세스가 이어받은 경우입니다.

## 테스트

두 테스트 모두 실제 국회 사이트에 접속하고, 캐시·색인은 임시 폴더를 씁니다. 저장소 폴더에서 실행합니다.

```bash
node test/smoke.js 2026-10-14 행정안전 2026-10-27
```

도구를 실제로 불러 회의록 원문·OpenAPI 원본과 대조합니다. 인자는 회의일, 위원회, 발언영상 날짜이고, 빼면 위 값을 씁니다(`npm run smoke` 와 같음).

```bash
node test/index.js 2026-10-28
```

로컬 색인과 통합 검색을 검증합니다(`npm run test:index -- 2026-10-28` 와 같음). 인자는 자막 녹화가 있는 날짜입니다. 그날 녹화가 없으면 자막 색인 항목은 FAIL 로 나옵니다.

## 개발용 스크립트

| 스크립트 | 하는 일 |
|---|---|
| `node scripts/dump-meta.js` | 사용하는 OpenAPI 명세(서비스 ID·요청 변수·출력 필드)를 받아 `data/openapi-specs.json` 을 다시 만듭니다 |
| `node scripts/sample.js <서비스ID> [KEY=VALUE ...] [--size=N]` | OpenAPI 한 서비스를 불러 건수와 앞쪽 행을 출력합니다 |
| `node scripts/fetch.js <URL> [--chars=N]` | URL 하나를 실브라우저로 받아 앞부분을 출력합니다(응답 구조 확인용) |

## 파일 구조

```
src/
  server.js            MCP 서버: 도구·프롬프트 등록
  browser.js           헤드리스 Chrome 안에서 fetch
  openapi.js           열린국회정보 OpenAPI 호출·페이지 처리
  domains.js           법안·표결·일정·중계 목록
  members.js           의원 인적사항
  minutes.js           회의록 목록·전문 파싱, 발언영상
  reports.js           의안 첨부 문서, 국감 보고서, 발간물, PDF 텍스트 추출
  captions.js          자막 녹화 파일 관리, 화자 추정
  caption-recorder.js  자막 녹화기(별도 프로세스)
  search-index.js      로컬 SQLite FTS5 색인
  nanet.js             국회도서관 원격 검색
  search.js            로컬·원격 통합 검색
data/openapi-specs.json  OpenAPI 명세 덤프(서버 시작 때 읽음)
scripts/               개발용 스크립트
test/                  실사이트 대조 테스트
```

## 한계와 주의

- 제22대 국회만 조회합니다. 대수는 코드에 22로 들어 있습니다.
- 테스트는 Apple Silicon Mac 에서만 돌렸습니다. 다른 OS 는 "지원 OS" 를 참고하세요.
- OpenAPI 외에 회의록 HTML, 의안정보시스템 HTML, 국회도서관 HTML, 중계 자막 WebSocket을 직접 읽습니다. 이 경로들은 공개 API가 아니어서 사이트가 바뀌면 깨질 수 있습니다.
- 자막은 AI 음성인식이라 오인식이 있고, 화자는 위원장의 지명·자기소개 문장으로 추정한 값입니다. 공식 기록은 회의록입니다.
- 공공기관 사이트이니 짧은 시간에 많은 요청을 보내지 마세요.
- 국회와 관계없는 개인 프로젝트입니다. 데이터의 권리와 이용 조건은 각 제공 기관을 따릅니다.

## 라이선스

코드는 [MIT](LICENSE) 라이선스입니다. 이 서버로 받은 데이터에는 적용되지 않으며, 데이터는 각 제공 기관의 이용 조건을 따릅니다.
